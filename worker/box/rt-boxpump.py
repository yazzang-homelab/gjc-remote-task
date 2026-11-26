#!/usr/bin/python3
"""gjc-rt 박스 pump. 원점(메인 호스트)에서 잡마다 systemd 유닛 gjc-rt-pump-<job>으로 돈다.

박스는 우리에게 연결하지 못한다. pump가 박스 드라이버의 forward(원점 127.0.0.1:lport → 박스 127.0.0.1:10101)로
박스 relay에 들어가서
- 모델 요청을 꺼내 정책(경로 2개·그 잡의 모델 1개·JSON·16 MiB·요청 수·마감)을 본 뒤 허브에 키를 붙여 보내고
  응답을 chunked로 돌려준다. 박스는 모델 출력만 받는다.
- 이벤트를 롱폴로 받아 로컬 spool의 events.jsonl에 쌓는다(seq 증가·크기 검사, 내용은 데이터로만 다룬다).
- 확장이 outbox/에 둔 메시지를 박스 inbox로 넣고 결과를 outbox/<id>.res에 쓴다.
- 드라이버 wait으로 작업 끝을 기다리다가(instabox는 이 동안 박스가 잠들지 않는다) out/을 드라이버 fetch로 가져오고
  rt-boxctl release-check 결과를 pump-state.json에 남긴다. 슬롯 반납은 확장이 이 증명을 보고 한다.

사용: rt-boxpump.py <spool_dir>   (spool_dir/pump.json에 설정)
키는 파일에서 읽고 argv·로그에 넣지 않는다.
"""
from __future__ import annotations

import http.client
import json
import resource
import os
import re
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import quote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtlib  # noqa: E402 — stage-box가 같은 폴더에 둔다(작업 호스트 러너와 같은 지문 검사)

ALLOW = {("POST", "/v1/responses"), ("GET", "/v1/models")}
MAX_BODY = 16 << 20
ID_RE = re.compile(r"[0-9a-f]{32}")
MSG_RE = re.compile(r"msg-[0-9a-z]{6,40}")
EVENT_LINE_MAX = 64 * 1024

SPOOL = sys.argv[1]
with open(os.path.join(SPOOL, "pump.json"), encoding="utf-8") as _f:
    CFG = json.load(_f)
JOB, GEN = CFG["job"], CFG["gen"]
# 박스 드라이버(worker/box/drivers/rt-box-<driver>)와 그 대상 설정. VM 종류의 차이는 드라이버가 맡는다.
DRIVER = CFG.get("driver", "")
DENV = {**os.environ, "RT_BOX_TARGET": json.dumps(CFG.get("target") or {})}
LPORT = CFG["lport"]
stop = threading.Event()
job_done = threading.Event()
# 대기줄 작업 감시(드라이버 wait: instabox는 10초마다 activity lease + 상태 조회)는 pump CPU의 절반쯤을 쓴다.
# 작업이 끝날 즈음에만 필요하므로 중계 끊김(러너는 gjc가 끝나면 relay를 먼저 닫는다 → 30초 뒤)·러너 ended(relay가 살아
# 있을 때만 받는다)·취소 표식(wait-now)·relay가 없을 때 1분마다 엿본 대기줄 종료 가운데 먼저 오는 때에 시작한다.
# 그런 신호가 없어도 WAIT_GUARD_S가 지나면 시작한다: 잠드는 박스(instabox 30분 idle pause)는 그 전에 lease를 잡고,
# 신호를 놓친 잡도 끝을 알아챈다.
# relay가 아직 안 떴거나 끊겨 있는 동안에는(대기줄 대기·설치 중 실패 등 ended가 올 수 없는 때) 1분마다 상태만 한 번 본다.
wait_go = threading.Event()
relay_up = threading.Event()
WAIT_GUARD_S = 600
RELAY_DOWN_S = 30
QUEUE_PEEK_S = 60
state_lock = threading.Lock()
state: dict = {"phase": "starting", "connected": False, "relay": None, "stats": {"ok": 0, "denied": 0, "err": 0},
               "last_seq": 0, "queue": None, "fetched": False, "release": None, "updated": 0}
budget = threading.Semaphore(CFG.get("max_requests", 600))
slots = threading.BoundedSemaphore(4)


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def save_state(**kw) -> None:
    with state_lock:
        state.update(kw)
        state["updated"] = time.time()
        tmp = os.path.join(SPOOL, "pump-state.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, os.path.join(SPOOL, "pump-state.json"))


def q(*args: str, timeout: float = 600) -> subprocess.CompletedProcess:
    """박스 드라이버 한 번 실행(동사부터)."""
    return subprocess.run([DRIVER, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=DENV, timeout=timeout)


def last_json(text: str) -> dict | None:
    for line in reversed(text.strip().splitlines()):
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if isinstance(v, dict):
            return v
    return None


def hub_key() -> str:
    with open(CFG["key_file"], encoding="utf-8") as f:
        return f.read().strip()


def load_fps() -> list[dict]:
    """상류 응답 검사용 지문(계획 §16.6): 메인 호스트 비밀 지문(box/fingerprints.json) + 허브 키 자신. 값은 메모리에만."""
    here = os.path.dirname(os.path.abspath(__file__))
    fps = rtlib.load_fingerprints(os.path.join(here, "fingerprints.json"), os.path.join(here, "fingerprints.local.json"))
    try:
        k = hub_key().encode()
        if k:
            fps.append({"name": "gjc-rt-hub-key", "len": len(k), "sha256": rtlib.hashlib.sha256(k).hexdigest()})
    except OSError:
        pass
    return fps


FPS = load_fps()
FPS_TABLE = rtlib.compile_fingerprints(FPS)
HOLD = max((fp["len"] for fp in FPS), default=1) - 1


class SecretHit(Exception):
    pass


def screened(chunks):
    """상류 본문을 박스로 넘기기 전에 지문 검사한다(자르기 전에 판정).
    가장 긴 지문 길이 - 1 바이트를 늘 붙잡아 두므로, 넘긴 바이트에서 시작하는 창은 넘기기 전에 모두 검사된다.
    맞으면 그 뒤로 아무것도 넘기지 않고 SecretHit를 던진다(스트림이 끊겨 박스는 오류로 본다)."""
    buf = b""
    for ch in chunks:
        buf += ch
        # 붙잡아 둔 앞부분 안의 창은 이미 검사했다. 새 바이트에서 끝나는 창만 본다.
        t0 = time.thread_time()
        hits = rtlib.fingerprint_hits(buf, FPS_TABLE, min_end=len(buf) - len(ch))
        with state_lock:
            st = state["stats"]
            st["screen_s"] = round(st.get("screen_s", 0) + time.thread_time() - t0, 4)
            st["bytes"] = st.get("bytes", 0) + len(ch)
        if hits:
            raise SecretHit(hits)
        if len(buf) > HOLD:
            cut = len(buf) - HOLD
            out, buf = buf[:cut], buf[cut:]
            yield out
    if buf:
        yield buf


# ---------------------------------------------------------------- 모델 요청

def reply(rid: str, status: int, ctype: str, chunks) -> None:
    c = http.client.HTTPConnection("127.0.0.1", LPORT, timeout=900)
    try:
        c.putrequest("POST", f"/resp/{rid}")
        c.putheader("X-Status", str(status))
        c.putheader("X-Content-Type", ctype)
        c.putheader("Transfer-Encoding", "chunked")
        c.endheaders()
        for ch in chunks:
            if ch:
                c.send(b"%x\r\n%s\r\n" % (len(ch), ch))
        c.send(b"0\r\n\r\n")
        c.getresponse().read()
    finally:
        c.close()


def deny(rid: str, why: str) -> None:
    with state_lock:
        state["stats"]["denied"] += 1
    log(f"deny {why}")
    reply(rid, 403, "application/json", [json.dumps({"error": {"message": f"relay policy: {why}"}}).encode()])


def handle(rid: str, method: str, path: str, body: bytes) -> None:
    try:
        if (method, path) not in ALLOW:
            return deny(rid, f"{method} {path[:60]!r}")
        if method == "POST":
            try:
                model = json.loads(body).get("model")
            except (ValueError, AttributeError):
                return deny(rid, "body is not a JSON object")
            if model not in CFG["models"]:
                return deny(rid, f"model {str(model)[:40]!r}")
        if time.time() > CFG["deadline"]:
            return deny(rid, "deadline")
        if not budget.acquire(blocking=False):
            return deny(rid, "request budget exhausted")
        hub = urlsplit(CFG["hub_base"])
        conn_cls = http.client.HTTPSConnection if hub.scheme == "https" else http.client.HTTPConnection
        up = conn_cls(hub.hostname, hub.port, timeout=900)
        try:
            up.request(method, hub.path.rstrip("/") + path.removeprefix("/v1"), body=body or None,
                       headers={"Content-Type": "application/json", "Accept": "*/*", "Authorization": f"Bearer {hub_key()}"})
            r = up.getresponse()

            def stream():
                while True:
                    ch = r.read1(65536)
                    if not ch:
                        return
                    yield ch
            reply(rid, r.status, r.getheader("Content-Type", "application/json"), screened(stream()))
            with state_lock:
                state["stats"]["ok"] += 1
        finally:
            up.close()
    except SecretHit as e:
        with state_lock:
            state["stats"]["secret_hit"] = state["stats"].get("secret_hit", 0) + 1
            state.setdefault("secret_hits", []).extend(sorted(set(e.args[0]))[:10])
        log(f"secret_hit {','.join(sorted(set(e.args[0])))[:200]} — 응답을 넘기지 않음")
    except Exception as e:  # noqa: BLE001 — 요청 하나의 실패가 pump를 멈추면 안 된다
        with state_lock:
            state["stats"]["err"] += 1
        log(f"error {type(e).__name__}")
    finally:
        slots.release()


def request_loop() -> None:
    while not stop.is_set():
        try:
            c = http.client.HTTPConnection("127.0.0.1", LPORT, timeout=40)
            c.request("GET", "/next")
            r = c.getresponse()
            if r.status == 204:
                r.read()
                continue
            rid, method, path = r.getheader("X-Id", ""), r.getheader("X-Method", ""), r.getheader("X-Path", "")
            n = int(r.getheader("Content-Length") or 0)
            if r.status != 200 or not ID_RE.fullmatch(rid) or n > MAX_BODY:
                r.close()
                time.sleep(1)
                continue
            body = r.read(n)
            c.close()
            slots.acquire()
            threading.Thread(target=handle, args=(rid, method, path, body), daemon=True).start()
        except (OSError, http.client.HTTPException, ValueError):
            time.sleep(2)


# ---------------------------------------------------------------- 이벤트·inbox

def control(method: str, path: str, body: bytes | None = None, timeout: float = 40) -> tuple[int, dict | None]:
    c = http.client.HTTPConnection("127.0.0.1", LPORT, timeout=timeout)
    try:
        c.request(method, path, body=body, headers={"Content-Type": "application/octet-stream"} if body is not None else {})
        r = c.getresponse()
        raw = r.read(4 << 20)
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, None
    finally:
        c.close()


def append_events(events: list) -> None:
    """seq가 커지는 JSON 객체만 받는다. 줄 크기를 넘는 이벤트는 자리표시로 바꾼다."""
    last = state["last_seq"]
    lines = []
    for e in events:
        if not isinstance(e, dict) or not isinstance(e.get("seq"), int) or e["seq"] <= last:
            continue
        if not isinstance(e.get("kind"), str) or not re.fullmatch(r"[a-z_]{1,32}", e["kind"]):
            continue
        line = json.dumps(e, ensure_ascii=False)
        if len(line.encode()) > EVENT_LINE_MAX:
            line = json.dumps({"seq": e["seq"], "ts": str(e.get("ts", ""))[:40], "kind": e["kind"], "data": {"truncated": True}})
        lines.append(line)
        last = e["seq"]
        if e["kind"] == "ended":
            wait_go.set()
    if lines:
        with open(os.path.join(SPOOL, "events.jsonl"), "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        save_state(last_seq=last)


def event_loop() -> None:
    hello_ok = False
    was_up, down_since = False, None
    while not stop.is_set():
        if was_up and down_since is not None and time.monotonic() - down_since >= RELAY_DOWN_S:
            wait_go.set()  # 붙어 있던 relay가 사라졌다: 박스 작업이 끝나는 중이거나 끝났다
        try:
            if not hello_ok:
                st, body = control("GET", "/rt/hello", timeout=10)
                if st != 200 or not body or body.get("job") != JOB or body.get("gen") != GEN:
                    save_state(connected=False, relay="wrong_job" if st == 200 else None)
                    time.sleep(3)
                    continue
                hello_ok = True
                relay_up.set()
                was_up, down_since = True, None
                save_state(connected=True, relay="up", phase="running")
            st, body = control("GET", f"/rt/events?after={state['last_seq']}&wait=20", timeout=40)
            if st == 200 and body:
                append_events(body.get("events") or [])
        except (OSError, http.client.HTTPException, ValueError):
            hello_ok = False
            relay_up.clear()
            if down_since is None:
                down_since = time.monotonic()
            save_state(connected=False)
            time.sleep(3)


def outbox_loop() -> None:
    d = os.path.join(SPOOL, "outbox")
    os.makedirs(d, mode=0o700, exist_ok=True)
    while not stop.is_set():
        if os.path.exists(os.path.join(SPOOL, "wait-now")):
            wait_go.set()  # 확장이 취소하면서 남긴 표식
        for name in sorted(os.listdir(d)):
            m = re.fullmatch(r"(msg-[0-9a-z]{6,40})\.json", name)
            if not m or os.path.exists(os.path.join(d, f"{m.group(1)}.res")):
                continue
            try:
                msg = json.load(open(os.path.join(d, name), encoding="utf-8"))
                body = msg["text"].encode()
                st, res = control("POST", f"/rt/inbox?msg={m.group(1)}&reply={quote(msg.get('reply_to') or '-')}", body)
                if st in (200, 409):
                    with open(os.path.join(d, f"{m.group(1)}.res"), "w", encoding="utf-8") as f:
                        json.dump({"status": st, **(res or {})}, f)
            except (OSError, http.client.HTTPException, ValueError, KeyError):
                pass
        time.sleep(0.5)


# ---------------------------------------------------------------- 연결·수명

def forward_loop() -> None:
    """port-forward는 끊기면 다시 띄운다(분리일 뿐 취소가 아니다)."""
    while not stop.is_set():
        p = subprocess.Popen([DRIVER, "forward", str(LPORT), "10101"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=DENV)
        while not stop.is_set() and p.poll() is None:
            time.sleep(1)
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        if not stop.is_set():
            time.sleep(3)


def queue_state() -> tuple[str | None, str | None]:
    """대기줄 작업 상태와 종료값(모르면 None). 드라이버 status 한 번: {"state": ..., "exit": ...}."""
    try:
        res = last_json(q("status", CFG["qid"], timeout=120).stdout.decode("utf-8", "replace"))
    except subprocess.TimeoutExpired:
        return None, None
    if not res:
        return None, None
    st, ec = res.get("state"), res.get("exit")
    return (st if isinstance(st, str) and st != "unknown" else None), (str(ec) if ec is not None else None)


def wait_loop() -> None:
    """드라이버 wait이 끝나면 상태를 확인한다. wait 자체의 실패(망)는 다시 붙는다."""
    started = peeked = time.monotonic()
    while not stop.is_set() and not wait_go.wait(1):
        now = time.monotonic()
        if now - started >= WAIT_GUARD_S:
            break
        if not relay_up.is_set() and now - peeked >= QUEUE_PEEK_S:
            peeked = now
            if queue_state()[0] in ("done", "failed", "cancelled"):
                break
    save_state(wait_started=round(time.monotonic() - started, 1))
    while not stop.is_set():
        p = subprocess.Popen([DRIVER, "wait", CFG["qid"]], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=DENV)
        p.wait()
        qstate, ec = queue_state()
        if qstate in ("done", "failed", "cancelled"):
            save_state(queue={"state": qstate, "exit": ec})
            job_done.set()
            return
        time.sleep(5)


def finish() -> None:
    """박스 작업이 끝난 뒤: out/ 가져오기 → 남은 이벤트 합치기 → 반납 판정."""
    save_state(phase="fetching")
    dest = os.path.join(SPOOL, "fetch")
    for _ in range(3):
        r = q("fetch", f"/data/workspace/rt/{JOB}/out", dest, str(700 << 20), timeout=1800)
        if r.returncode == 0:
            break
        time.sleep(10)
    src = os.path.join(dest, "out")
    if not os.path.isdir(src):
        src = dest
    fetched = os.path.isfile(os.path.join(src, "collect.json"))
    if fetched:
        os.makedirs(os.path.join(SPOOL, "out"), mode=0o700, exist_ok=True)
        for name in ("collect.json", "out.bundle", "logs.tar", "events.jsonl"):
            p = os.path.join(src, name)
            if os.path.isfile(p) and not os.path.islink(p):
                os.replace(p, os.path.join(SPOOL, "out", name))
        evs = []
        try:
            with open(os.path.join(SPOOL, "out", "events.jsonl"), encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        evs.append(json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass
        append_events(evs)
    save_state(fetched=fetched)
    release_check()


def unit_cpu_s() -> float | None:
    """원점 부하 측정용: 이 pump 유닛 cgroup 전체(아직 도는 드라이버 forward 포함)의 CPU 초.
    cgroup을 읽지 못하면 pump 자신과 거둔 자식의 rusage로 대신한다."""
    try:
        with open("/proc/self/cgroup", encoding="ascii") as f:
            rel = f.read().strip().split("::", 1)[1]
        with open(f"/sys/fs/cgroup{rel}/cpu.stat", encoding="ascii") as f:
            for line in f:
                if line.startswith("usage_usec "):
                    return round(int(line.split()[1]) / 1e6, 3)
    except (OSError, IndexError, ValueError):
        pass
    ru, rc = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return round(ru.ru_utime + ru.ru_stime + rc.ru_utime + rc.ru_stime, 3)


def release_check() -> None:
    r = q("exec", "--", "sudo", "-n", "/data/rt-ctl/bin/rt-boxctl", "release-check", JOB, str(GEN),
          timeout=180)
    res = last_json(r.stdout.decode("utf-8", "replace"))
    with state_lock:
        qs = (state.get("queue") or {}).get("state")
    if isinstance(res, dict) and not res.get("release") and res.get("reason") == "evidence_missing" and qs in ("done", "failed", "cancelled"):
        # 박스에 이 잡의 제어 표식이 아예 없다(job.sh가 setup/prepare 전에 끝남 또는 박스 초기화). 잡을 시작할 수 있는 것은
        # 대기줄의 job.sh뿐이고 그 작업이 끝났으므로, 이 잡은 앞으로도 시작될 수 없다 → 미시작으로 반납한다.
        res = {"release": True, "proof": "queue_ended_unprepared", "queue": qs}
    save_state(release=res if res is not None else {"release": False, "reason": "needs_reconcile"}, phase="done", cpu_s=unit_cpu_s())


def main() -> int:
    signal.signal(signal.SIGTERM, lambda *_: (stop.set(), save_state(phase="stopped"), os._exit(0)))
    save_state(phase="starting")
    for fn in (forward_loop, request_loop, event_loop, outbox_loop, wait_loop):
        threading.Thread(target=fn, daemon=True).start()
    while not job_done.wait(5):
        if time.time() > CFG["deadline"] + 3600:
            save_state(phase="deadline")
            break
    stop.set()
    finish()
    log(f"pump down: {state['stats']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
