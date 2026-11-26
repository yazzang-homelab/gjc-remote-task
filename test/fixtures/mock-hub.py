#!/usr/bin/python3
"""시험용 가짜 모델 허브(OpenAI Responses 스트림). 실제 모델·키를 쓰지 않고 원격 경로 전체를 시험한다.

GET  /v1/models     → devin/swe-2
POST /v1/responses  → 대화 단계(입력의 function_call_output 수)에 따라 정해진 도구 호출을 흘린다.

시나리오(MOCK_SCENARIO)
- dialog: ask_main → (답의 파일 이름으로) 파일 작성·커밋 → final_report → 끝
- slow:   커밋 하나 → sleep 600(취소 시험용) → final_report
- secret: 비밀 모양 문자열을 커밋하려 한다 → final_report

요청마다 Authorization 헤더의 sha256 앞 12자, 모델, reasoning을 로그(JSONL)에 남긴다. 키 값은 남기지 않는다.
"""
import hashlib
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("MOCK_LOG", "/tmp/mock-hub.jsonl")
SCENARIO = os.environ.get("MOCK_SCENARIO", "dialog")


def log(rec):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def outputs(body):
    return [i for i in body.get("input", []) if isinstance(i, dict) and i.get("type") == "function_call_output"]


def output_text(item):
    out = item.get("output")
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        return "".join(p.get("text", "") for p in out if isinstance(p, dict))
    return ""


def plan_step(body):
    outs = outputs(body)
    n = len(outs)
    if SCENARIO == "dialog":
        if n == 0:
            return ("call", "ask_main", {"question": "새 파일 이름을 무엇으로 할까요? 파일 이름만 답해 주세요."})
        if n == 1:
            ans = output_text(outs[0])
            m = re.search(r"<main-message[^>]*>\s*([A-Za-z0-9._-]{1,60})\s*</main-message>", ans)
            name = m.group(1) if m else "fallback.txt"
            cmd = f"printf 'remote hello\\n' > {name} && git add {name} && git commit -qm 'rt: add {name}' && git log --oneline -1"
            return ("call", "bash", {"command": cmd})
        if n == 2:
            return ("call", "final_report", {"summary": "메인이 정한 이름으로 파일을 만들고 커밋했다.", "open_questions": []})
        return ("text", "끝났다.")
    if SCENARIO in ("dialog_bun", "dialog_rust"):
        # 실키 전 종단 확인용: 답의 이름으로 실제 과제 모양의 변경(함수 + 그 함수를 부르는 시험)을 커밋한다.
        if n == 0:
            return ("call", "ask_main", {"question": "추가할 함수 이름을 정해 주세요."})
        if n == 1:
            ans = output_text(outs[0])
            m = re.search(r"<main-message[^>]*>\s*([A-Za-z0-9_]{1,60})\s*</main-message>", ans)
            name = m.group(1) if m else "fallback_fn"
            # 실제 과제 모양: packages/utils/src에 export 함수, 그 함수를 import하는 새 packages/utils/test 시험.
            src = f"export function {name}(s: string): number {{ return [...s].length; }}\\n"
            tst = (
                f"import {{ expect, test }} from 'bun:test';\\n"
                f"import {{ {name} }} from '../src/{name}';\\n"
                f"test('{name}', () => {{ expect({name}('가a')).toBe(2); }});\\n"
            )
            cmd = (
                f"printf \"{src}\" > packages/utils/src/{name}.ts && printf \"{tst}\" > packages/utils/test/{name}.test.ts && "
                f"git add packages/utils/src/{name}.ts packages/utils/test/{name}.test.ts && git commit -qm 'utils: {name}' && git log --oneline -1"
            )
            if os.environ.get("MOCK_DIALOG_BAD") == "1":
                # 음성 대조: 함수는 있지만 시험이 그 함수를 쓰지 않는다(bun: src에서 import하지 않고 자체 사본, rust: 다른 곳에서만 호출).
                tst = (
                    f"import {{ expect, test }} from 'bun:test';\\n"
                    f"function {name}(s: string): number {{ return [...s].length; }}\\n"
                    f"test('{name}', () => {{ expect({name}('가a')).toBe(2); }});\\n"
                )
                cmd = (
                    f"printf \"{src}\" > packages/utils/src/{name}.ts && printf \"{tst}\" > packages/utils/test/{name}.test.ts && "
                    f"git add packages/utils/src/{name}.ts packages/utils/test/{name}.test.ts && git commit -qm 'utils: {name}' && git log --oneline -1"
                )
            if SCENARIO == "dialog_rust":
                f = "gjcn/crates/gjc-unicode/src/lib.rs"
                cmd = (
                    f"printf '\\npub fn {name}(s: &str) -> usize {{\\n    s.chars().count()\\n}}\\n\\n#[cfg(test)]\\nmod {name}_tests {{\\n"
                    f"    #[test]\\n    fn counts() {{\\n        assert_eq!(super::{name}(\\\"\\uac00a\\\"), 2);\\n    }}\\n}}\\n' >> {f} && git add {f} && git commit -qm 'unicode: {name}' && git log --oneline -1"
                )
                if os.environ.get("MOCK_DIALOG_BAD") == "1":
                    cmd = (
                        f"printf '\\npub fn {name}(s: &str) -> usize {{\\n    s.chars().count()\\n}}\\n\\npub fn {name}_caller() -> usize {{\\n    {name}(\\\"x\\\")\\n}}\\n\\n#[cfg(test)]\\nmod {name}_tests {{\\n"
                        f"    #[test]\\n    fn counts() {{\\n        assert_eq!(\\\"\\uac00a\\\".chars().count(), 2);\\n    }}\\n}}\\n' >> {f} && git add {f} && git commit -qm 'unicode: {name}' && git log --oneline -1"
                    )
                if os.environ.get("MOCK_DIALOG_BAD") == "2":
                    # 음성 대조 2: 답을 부르는 시험은 #[ignore]로 건너뛰고(주석에서도 언급), 다른 시험만 통과한다.
                    cmd = (
                        f"printf '\\npub fn {name}(s: &str) -> usize {{\\n    s.chars().count()\\n}}\\n\\n#[cfg(test)]\\nmod {name}_tests {{\\n"
                        f"    #[test]\\n    #[ignore]\\n    fn counts() {{\\n        assert_eq!(super::{name}(\\\"\\uac00a\\\"), 2);\\n    }}\\n"
                        f"    #[test]\\n    fn other() {{\\n        // super::{name}(\\\"x\\\")\\n        assert_eq!(1, 1);\\n    }}\\n}}\\n' >> {f} && git add {f} && git commit -qm 'unicode: {name}' && git log --oneline -1"
                    )
            elif os.environ.get("MOCK_DIALOG_BAD") == "2":
                # 음성 대조 2: src에서 import는 하지만 답을 부르는 시험은 test.skip, 다른 시험만 통과한다.
                tst = (
                    f"import {{ expect, test }} from 'bun:test';\\n"
                    f"import {{ {name} }} from '../src/{name}';\\n"
                    f"test.skip('{name}', () => {{ expect({name}('가a')).toBe(2); }});\\n"
                    f"test('other', () => {{ expect(1).toBe(1); }});\\n"
                )
                cmd = (
                    f"printf \"{src}\" > packages/utils/src/{name}.ts && printf \"{tst}\" > packages/utils/test/{name}.test.ts && "
                    f"git add packages/utils/src/{name}.ts packages/utils/test/{name}.test.ts && git commit -qm 'utils: {name}' && git log --oneline -1"
                )
            return ("call", "bash", {"command": cmd})
        if n == 2:
            return ("call", "final_report", {"summary": "메인이 정한 이름으로 함수와 시험을 커밋했다.", "open_questions": []})
        return ("text", "끝났다.")
    if SCENARIO == "slow":
        if n == 0:
            return ("call", "bash", {"command": "printf 'partial\\n' > partial.txt && git add partial.txt && git commit -qm 'rt: partial' && echo ok"})
        if n == 1:
            return ("call", "bash", {"command": "sleep 600", "timeout": 900})
        if n == 2:
            return ("call", "final_report", {"summary": "느린 작업 끝"})
        return ("text", "끝났다.")
    if SCENARIO == "secret":
        if n == 0:
            fake = "sk-" + "A" * 40
            return ("call", "bash", {"command": f"printf 'KEY={fake}\\n' > leak.txt && git add leak.txt && git commit -qm 'rt: leak' && echo ok"})
        if n == 1:
            return ("call", "final_report", {"summary": "비밀 시험"})
        return ("text", "끝났다.")
    if SCENARIO == "escape":
        if n == 0:
            probe = (
                "{ echo \"uid=$(id -u) groups=$(id -G)\"; "
                "for p in /var/lib/gjc-rt/keys/gjc-rt.key /etc/gjc-rt/private/cap.key /var/lib/gjc-rt/slots.json /root/.ssh/id_ed25519; do "
                "if cat \"$p\" >/dev/null 2>&1; then echo \"READ $p\"; else echo \"DENY $p\"; fi; done; "
                "for p in /etc/rt-escape /usr/local/lib/gjc-rt/rt-escape /var/tmp/rt-escape /srv/gjc-rt/repos/rt-escape; do "
                "if touch \"$p\" 2>/dev/null; then echo \"WROTE $p\"; rm -f \"$p\"; else echo \"DENY-W $p\"; fi; done; "
                "if ls /var/lib/gjc-rt/jobs >/dev/null 2>&1; then echo 'READ jobs'; else echo 'DENY jobs'; fi; "
                "if sudo -n true 2>/dev/null; then echo 'SUDO yes'; else echo 'SUDO no'; fi; "
                "echo \"nnp=$(grep NoNewPrivs /proc/self/status | tr -s ' \t' ' ')\"; "
                "echo \"cred_dir=${CREDENTIALS_DIRECTORY:-none}\"; "
                "echo \"key_env_present=$([ -n \"$GJC_RT_KEY\" ] && echo yes || echo no)\"; "
                "echo \"cgroup=$(cat /proc/self/cgroup)\"; "
                "} > escape.txt 2>&1; git add escape.txt && git commit -qm 'rt: escape probe' && cat escape.txt"
            )
            return ("call", "bash", {"command": probe})
        if n == 1:
            return ("call", "final_report", {"summary": "탈출 시험"})
        return ("text", "끝났다.")
    if SCENARIO == "steady":
        # 장애 시험용: 커밋 하나 → 45초 일 → 커밋 하나 → 끝.
        if n == 0:
            return ("call", "bash", {"command": "printf 'a\\n' > a.txt && git add a.txt && git commit -qm 'rt: steady a' && echo ok"})
        if n == 1:
            return ("call", "bash", {"command": "sleep 45 && printf 'b\\n' > b.txt && git add b.txt && git commit -qm 'rt: steady b' && echo ok", "timeout": 120})
        if n == 2:
            return ("call", "final_report", {"summary": "꾸준한 작업 끝"})
        return ("text", "끝났다.")
    if SCENARIO == "bench":
        # 측정용: 로컬 실행과 같은 길이(MOCK_BENCH_SECS)만큼 일한 뒤 정해진 변경을 커밋한다.
        secs = int(os.environ.get("MOCK_BENCH_SECS", "60"))
        if n == 0 and os.environ.get("MOCK_BENCH_KIND") == "rust":
            # 실작업 흉내(Rust 저장소): 정해진 변경 + cargo 검사.
            edit = (
                f"sleep {secs} && cat >> gjcn/crates/gjc-unicode/src/lib.rs <<'EOF'\n\n"
                "pub fn char_count(s: &str) -> usize {\n    s.chars().count()\n}\n\n"
                "#[cfg(test)]\nmod char_count_tests {\n    #[test]\n    fn counts() {\n        assert_eq!(super::char_count(\"가a\"), 2);\n    }\n}\nEOF\n"
                "(cd gjcn && cargo test -q -p gjc-unicode -p gjc-ast) && git add gjcn/crates/gjc-unicode/src/lib.rs && git commit -qm 'unicode: char_count 추가' && echo ok"
            )
            return ("call", "bash", {"command": edit, "timeout": secs + 1800})
        if n == 0:
            edit = (
                f"sleep {secs} && cat >> calc.py <<'EOF'\n\n\ndef median(xs):\n    if not xs:\n        raise ValueError(\"empty\")\n"
                "    s = sorted(xs)\n    m = len(s) // 2\n    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2\nEOF\n"
                "{ python3 -m unittest -q; r=$?; [ $r = 0 ] || [ $r = 5 ]; } && git add calc.py && git commit -qm 'calc: median 추가' && echo ok"
            )
            return ("call", "bash", {"command": edit, "timeout": secs + 120})
        if n == 1:
            kind = os.environ.get("MOCK_BENCH_KIND", "synth")
            return ("call", "final_report", {"summary": "char_count를 추가했다." if kind == "rust" else "median을 추가했다."})
        return ("text", "끝났다.")
    if SCENARIO == "box_escape":
        if n == 0:
            probe = (
                "{ echo \"uid=$(id -un) groups=$(id -Gn)\"; "
                "for p in /data/rt-ctl /data/rt-ctl/bin/rt-boxctl /root /data/home/user /data/queue; do "
                "if ls \"$p\" >/dev/null 2>&1; then echo \"READ $p\"; else echo \"DENY $p\"; fi; done; "
                "for p in /data/rt-pub/bundle/x /data/rt-ctl/x /data/workspace/x /usr/local/bin/x /data/queue/x; do "
                "if touch \"$p\" 2>/dev/null; then echo \"WROTE $p\"; rm -f \"$p\"; else echo \"DENY-W $p\"; fi; done; "
                "if sudo -n true 2>/dev/null; then echo 'SUDO yes'; else echo 'SUDO no'; fi; "
                "if docker ps >/dev/null 2>&1; then echo 'DOCKER yes'; else echo 'DOCKER no'; fi; "
                "if systemd-run --user --quiet true >/dev/null 2>&1; then echo 'USERMGR yes'; else echo 'USERMGR no'; fi; "
                "echo \"nnp=$(grep NoNewPrivs /proc/self/status | tr -s ' \t' ' ')\"; "
                "echo \"key_env=$(env | grep -i 'key\\|token\\|secret' | sed 's/=.*//' | sort | tr '\\n' ,)\"; "
                "echo \"key_val=$GJC_RT_KEY\"; "
                "if cat /etc/sudoers >/dev/null 2>&1; then echo 'READ sudoers'; else echo 'DENY sudoers'; fi; "
                "setsid nohup sleep 900 >/dev/null 2>&1 < /dev/null & "
                "sleep 1; echo \"detached_cgroup=$(cat /proc/$(pgrep -u $(id -u) -n -f 'sleep 900')/cgroup)\"; "
                "echo \"cgroup=$(cat /proc/self/cgroup)\"; "
                "} > escape.txt 2>&1; git add escape.txt && git commit -qm 'rt: box escape probe' && cat escape.txt"
            )
            return ("call", "bash", {"command": probe})
        if n == 1:
            return ("call", "final_report", {"summary": "박스 탈출 시험"})
        return ("text", "끝났다.")
    if SCENARIO == "exfil":
        if n == 0:
            # 키를 결과물에 섞어 내보내려는 시도(지문 차단 확인용). 토큰 모양 규칙에 안 걸리게 앞뒤를 붙인다.
            return ("call", "bash", {"command": "printf 'x%sx\\n' \"$GJC_RT_KEY\" > exfil.txt && git add exfil.txt && git commit -qm 'rt: exfil' && echo done"})
        if n == 1:
            return ("call", "final_report", {"summary": "유출 시험"})
        return ("text", "끝났다.")
    return ("text", "알 수 없는 시나리오")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _auth(self):
        h = self.headers.get("Authorization", "")
        return hashlib.sha256(h.encode()).hexdigest()[:12] if h else None

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            body = json.dumps({"object": "list", "data": [{"id": "devin/swe-2", "object": "model"}]}).encode()
            log({"ts": time.time(), "path": self.path, "auth": self._auth()})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        kind, *rest = plan_step(body)
        log({"ts": time.time(), "path": self.path, "auth": self._auth(), "model": body.get("model"),
             "reasoning": body.get("reasoning"), "step": len(outputs(body)), "reply": kind,
             "tools": sorted(t.get("name", "") for t in body.get("tools", []) if isinstance(t, dict)),
             "instructions_has_role": "GJC-RT-ROLE-v1" in json.dumps(body.get("instructions", "")) or
             "GJC-RT-ROLE-v1" in json.dumps(body.get("input", []))})
        rid = f"resp_{int(time.time() * 1000)}"
        events = [{"type": "response.created", "response": {"id": rid, "status": "in_progress"}}]
        if kind == "call":
            name, args = rest
            cid = f"call_{rid}"
            item = {"type": "function_call", "id": f"fc_{rid}", "call_id": cid, "name": name, "arguments": ""}
            a = json.dumps(args, ensure_ascii=False)
            events += [
                {"type": "response.output_item.added", "output_index": 0, "item": item},
                {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": a},
                {"type": "response.output_item.done", "output_index": 0, "item": {**item, "arguments": a}},
            ]
        else:
            (text,) = rest
            mid = f"msg_{rid}"
            events += [
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {"type": "message", "id": mid, "role": "assistant", "status": "in_progress", "content": []}},
                {"type": "response.content_part.added", "item_id": mid, "output_index": 0, "content_index": 0,
                 "part": {"type": "output_text", "text": ""}},
                {"type": "response.output_text.delta", "item_id": mid, "output_index": 0, "content_index": 0, "delta": text},
                {"type": "response.output_text.done", "item_id": mid, "output_index": 0, "content_index": 0, "text": text},
                {"type": "response.output_item.done", "output_index": 0,
                 "item": {"type": "message", "id": mid, "role": "assistant", "status": "completed",
                          "content": [{"type": "output_text", "text": text, "annotations": []}]}},
            ]
        events.append({"type": "response.completed", "response": {
            "id": rid, "status": "completed",
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for e in events:
            self.wfile.write(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
        self.close_connection = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
