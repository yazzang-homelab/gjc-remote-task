#!/usr/bin/python3
"""gjc-rt 러너. 잡 유닛(User=gjcrt)의 주 프로세스.

gjc -p --mode json을 띄우고, 출력은 지문 필터를 거친 요약 이벤트로만 남긴다(§18.6).
remote-worker 확장이 쓰는 worker-out.jsonl을 읽어 events.jsonl로 옮긴다(seq 소유자는 러너 하나).
"""
from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtlib  # noqa: E402

BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
FINAL_GRACE_S = 0.2
# final 뒤에도 실행 중인 도구(같은 묶음의 commit 등)가 있으면 끝날 때까지 기다린다. 끝나지 않는 도구는 이 시간 뒤 끊는다.
FINAL_TOOL_WAIT_S = 30.0
WORKER_KINDS = {"question", "final", "progress", "answer_consumed", "consumed", "role_check", "error"}


def load_tools() -> str:
    with open(os.path.join(BUNDLE_DIR, "tools.txt"), encoding="utf-8") as f:
        return ",".join(t.strip() for t in f.read().split() if t.strip())


def load_worktool():
    import importlib.util
    spec = importlib.util.spec_from_file_location("wt", os.path.join(BUNDLE_DIR, "rt-worktool.py"))
    wt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wt)
    return wt


def start_relay(job: str, d: str, log) -> subprocess.Popen | None | bool:
    """박스 묶음이면 relay.py를 띄우고 포트가 열릴 때까지 기다린다. 신뢰 호스트는 None."""
    if not rtlib.PATHS.get("relay"):
        return None
    import socket
    proc = subprocess.Popen([sys.executable, os.path.join(BUNDLE_DIR, "relay.py"), job, d],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if proc.poll() is not None:
            break
        try:
            socket.create_connection(("127.0.0.1", rtlib.PATHS.get("relay_model_port", 10100)), timeout=0.5).close()
            log.emit("progress", {"relay": "up"})
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    log.emit("error", {"code": "relay_failed"})
    return False


def kill_group(proc: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def summarize(ev: dict) -> tuple[str, dict] | None:
    t = ev.get("type")
    if t == "tool_execution_start":
        name = ev.get("toolName") or ev.get("name") or (ev.get("tool") or {}).get("name")
        return "progress", {"tool": name}
    if t == "message_end":
        msg = ev.get("message") or {}
        if msg.get("role") == "assistant":
            parts = msg.get("content") or []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
            if text.strip():
                return "progress", {"assistant": rtlib.clean_text(text, 2000)}
            if msg.get("stopReason") == "error" and msg.get("errorMessage"):
                # 모델 오류(요율 제한 등)는 stderr가 아니라 여기로 온다. 메인이 실패 원인을 알 수 있게 넘긴다.
                return "progress", {"model_error": rtlib.clean_text(str(msg["errorMessage"]), 500)}
    if t == "agent_end":
        return "progress", {"agent_end": True}
    return None


def main() -> int:
    job, gen = sys.argv[1], int(sys.argv[2])
    d = os.environ["GJC_RT_JOB_DIR"]
    fps = rtlib.load_fingerprints()
    log = rtlib.EventLog(d, fps)
    meta = json.load(open(os.path.join(d, "job.json"), encoding="utf-8"))
    cred = os.environ.get("CREDENTIALS_DIRECTORY")
    key = ""
    if cred:
        try:
            with open(os.path.join(cred, "gjc-rt-key"), encoding="utf-8") as f:
                key = f.read().strip()
        except OSError:
            key = ""
    if rtlib.PATHS.get("key") == "none":
        # 박스: 키가 없다. 모델 요청은 같은 scope의 relay로 가고, 키는 메인 호스트 pump가 붙인다.
        key = "rt-box-no-key"
    if not key:
        log.emit("error", {"code": "credential_missing"})
        load_worktool().finish(job, None, "credential_missing")
        return 2
    role = os.path.join(BUNDLE_DIR, "role.md")
    gjc = os.path.join(rtlib.PATHS.get("gjc_dir", "/usr/local/lib/gjc-rt/gjc"), meta["gjc_version"], "gjc")
    env = dict(os.environ)
    env["GJC_RT_KEY"] = key
    env.pop("CREDENTIALS_DIRECTORY", None)
    argv = [gjc, "-p", "--mode", "json", "--model", meta["model"], "--append-system-prompt", role,
            "--no-mcp", "--no-title", "--session-dir", os.path.join(d, "sessions"), "--tools", load_tools()]
    log.emit("started", {"job": job, "gen": gen, "model": meta["model"], "role_sha256": rtlib.sha256_file(role),
                         "gjc_version": meta["gjc_version"], "pid": os.getpid()})
    relay = start_relay(job, d, log)
    if relay is False:
        load_worktool().finish(job, None, "relay_failed")
        return 2
    task = open(os.path.join(d, "task.md"), "rb")
    try:
        proc = subprocess.Popen(argv, cwd=os.path.join(d, "repo"), env=env, stdin=task,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        log.emit("error", {"code": "gjc_spawn_failed", "detail": type(exc).__name__})
        load_worktool().finish(job, None, "gjc_failed")
        return 2
    finally:
        task.close()
    del key
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ, "out")
    sel.register(proc.stderr, selectors.EVENT_READ, "err")
    buf = {"out": b"", "err": b""}
    err_tail: list[str] = []
    worker_out = os.path.join(d, "worker-out.jsonl")
    worker_off = 0
    last_head = meta["base_sha"]
    last_head_check = 0.0
    open_streams = 2
    # final_report가 받아들여지면(로컬 실행자의 yield처럼) 남은 마무리 턴을 기다리지 않고 gjc를 끝낸다.
    final_at: float | None = None
    stop_at: float | None = None
    # 실행 중인 도구 호출(toolCallId). final 뒤 끊을 때 도구 한가운데(예: git commit의 index.lock)를 자르지 않게 본다.
    inflight: set[str] = set()
    while open_streams:
        now = time.monotonic()
        if (stop_at is None and final_at is not None and proc.poll() is None and now - final_at > FINAL_GRACE_S
                and (not inflight or now - final_at > FINAL_TOOL_WAIT_S)):
            stop_at = now
            kill_group(proc, signal.SIGTERM)
        elif stop_at is not None:
            if proc.poll() is None and now - stop_at > 5:
                kill_group(proc, signal.SIGKILL)
            elif proc.poll() is not None and now - stop_at > 0.5:
                # 도구가 남긴 자식이 파이프를 쥐고 있어도 기다리지 않는다(유닛이 끝나면 cgroup째 정리된다).
                break
        for keyobj, _ in sel.select(timeout=0.25):
            chunk = os.read(keyobj.fileobj.fileno(), 65536)
            name = keyobj.data
            if not chunk:
                sel.unregister(keyobj.fileobj)
                open_streams -= 1
                continue
            buf[name] += chunk
            while b"\n" in buf[name]:
                line, buf[name] = buf[name].split(b"\n", 1)
                text = line.decode("utf-8", "replace")
                if name == "err":
                    clean, _ = rtlib.redact_line(text, fps)
                    err_tail = (err_tail + [rtlib.clean_text(clean, 500)])[-20:]
                    continue
                try:
                    ev = json.loads(text)
                except ValueError:
                    continue
                if isinstance(ev, dict) and ev.get("type") in ("tool_execution_start", "tool_execution_end"):
                    cid = str(ev.get("toolCallId") or ev.get("toolName") or "")
                    if ev["type"] == "tool_execution_start":
                        inflight.add(cid)
                    else:
                        inflight.discard(cid)
                s = summarize(ev) if isinstance(ev, dict) else None
                if s:
                    log.emit(*s)
        # 원격 확장의 기록을 옮긴다.
        try:
            with open(worker_out, "rb") as f:
                f.seek(worker_off)
                data = f.read()
            if data:
                complete = data.rsplit(b"\n", 1)[0] + b"\n" if b"\n" in data else b""
                worker_off += len(complete)
                for line in complete.splitlines():
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(rec, dict) and rec.get("kind") in WORKER_KINDS:
                        log.emit(rec["kind"], rec.get("data") or {})
                        if rec["kind"] == "final" and final_at is None:
                            final_at = time.monotonic()
        except FileNotFoundError:
            pass
        now = time.monotonic()
        if now - last_head_check > 10:
            last_head_check = now
            r = subprocess.run(["git", "rev-parse", f"refs/heads/rt/{job}"], cwd=os.path.join(d, "repo"),
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            head = r.stdout.decode().strip()
            if head and head != last_head:
                last_head = head
                log.emit("commit", {"head": head})
    code = proc.wait()
    sel.close()
    proc.stdout.close()
    proc.stderr.close()
    if relay:
        relay.terminate()
    # 보고 뒤 우리가 끝낸 경우(SIGTERM)는 정상 완료다.
    stopped_after_final = stop_at is not None and code in (0, -signal.SIGTERM, -signal.SIGKILL, 128 + signal.SIGTERM)
    if code != 0 and not stopped_after_final:
        log.emit("error", {"code": "gjc_exit", "exit": code, "stderr_tail": err_tail[-5:]})
    ok = code == 0 or stopped_after_final
    load_worktool().finish(job, code, "completed" if ok else "gjc_failed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
