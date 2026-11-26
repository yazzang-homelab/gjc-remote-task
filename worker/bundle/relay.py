#!/usr/bin/python3
"""박스 relay. 박스 잡 scope 안에서 러너(rtrun)의 자식으로 돈다. 키가 없고 우리 망으로 나가지 않는다.

- 모델 쪽(127.0.0.1:10100): 박스 gjc의 모델 엔드포인트. 요청을 보관했다가 메인 호스트 pump가 꺼내 가서
  대신 보내고 응답을 chunked로 돌려준다. 박스가 먼저 연결을 여는 일은 없다(pump가 port-forward로 들어온다).
- 제어 쪽(127.0.0.1:10101): pump만 쓴다.
  GET /next, POST /resp/<id>      모델 요청 꺼내기·응답 넣기(gjc-triage relay와 같은 규약)
  GET /rt/hello                    {"job","gen"} — pump가 맞는 잡에 붙었는지 확인
  GET /rt/events?after=N&wait=S    events.jsonl 롱폴(작업 도구와 같은 형식)
  POST /rt/inbox?msg=ID&reply=R    메인의 답·지시를 inbox.jsonl에 넣는다

사용: relay.py <job> <job_dir>
"""
from __future__ import annotations

import importlib.util
import json
import os
import queue
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtlib  # noqa: E402

ALLOW = {("POST", "/v1/responses"), ("GET", "/v1/models")}
MAX_BODY = 16 << 20
WAIT_S = 900
MSG_RE = re.compile(r"msg-[0-9a-z]{6,40}")
REPLY_RE = re.compile(r"q-[0-9a-z-]{3,40}|-")

JOB = sys.argv[1]
JOB_DIR = sys.argv[2]
_spec = importlib.util.spec_from_file_location("wt", os.path.join(os.path.dirname(os.path.abspath(__file__)), "rt-worktool.py"))
wt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wt)
with open(os.path.join(JOB_DIR, "job.json"), encoding="utf-8") as _f:
    GEN = json.load(_f)["gen"]

pending: queue.Queue = queue.Queue()
entries: dict = {}
lock = threading.Lock()


class Entry:
    def __init__(self, method: str, path: str, body: bytes):
        self.id = uuid.uuid4().hex
        self.method, self.path, self.body = method, path, body
        self.head: queue.Queue = queue.Queue(1)
        self.chunks: queue.Queue = queue.Queue(512)


class Model(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _go(self):
        path = self.path.split("?", 1)[0]
        if (self.command, path) not in ALLOW:
            return self.send_error(403)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self.send_error(413)
        e = Entry(self.command, path, self.rfile.read(n) if n else b"")
        with lock:
            entries[e.id] = e
        pending.put(e)
        try:
            try:
                status, ctype = e.head.get(timeout=WAIT_S)
            except queue.Empty:
                return self.send_error(504)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                try:
                    c = e.chunks.get(timeout=WAIT_S)
                except queue.Empty:
                    break
                if c is None:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(c), c))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        finally:
            with lock:
                entries.pop(e.id, None)
            self.close_connection = True

    do_GET = do_POST = _go

    def log_message(self, *a):
        pass


class Control(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlsplit(self.path)
        q = parse_qs(u.query)
        if u.path == "/rt/hello":
            return self._json(200, {"job": JOB, "gen": GEN})
        if u.path == "/rt/events":
            try:
                after = int(q.get("after", ["0"])[0])
                wait = min(25.0, max(0.0, float(q.get("wait", ["0"])[0])))
            except ValueError:
                return self._json(400, {"error": "bad_argument"})
            return self._json(200, wt.events_after(JOB, after, wait, 200))
        if u.path != "/next":
            return self.send_error(404)
        try:
            e = pending.get(timeout=25)
        except queue.Empty:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            return self.end_headers()
        self.send_response(200)
        self.send_header("X-Id", e.id)
        self.send_header("X-Method", e.method)
        self.send_header("X-Path", e.path)
        self.send_header("Content-Length", str(len(e.body)))
        self.end_headers()
        self.wfile.write(e.body)

    def do_POST(self):
        u = urlsplit(self.path)
        if u.path == "/rt/inbox":
            q = parse_qs(u.query)
            msg, reply = q.get("msg", [""])[0], q.get("reply", ["-"])[0]
            n = int(self.headers.get("Content-Length") or 0)
            if not MSG_RE.fullmatch(msg) or not REPLY_RE.fullmatch(reply) or n > rtlib.INBOX_MAX:
                return self._json(400, {"error": "bad_argument"})
            text = self.rfile.read(n).decode("utf-8", "replace")
            try:
                return self._json(200, wt.inbox_append(JOB, msg, reply, text))
            except wt.ToolError as exc:
                return self._json(409, {"error": exc.code})
        m = re.fullmatch(r"/resp/([0-9a-f]{32})", u.path)
        with lock:
            e = entries.get(m.group(1)) if m else None
        if not e:
            return self.send_error(404)
        try:
            status = int(self.headers.get("X-Status", "502"))
        except ValueError:
            status = 502
        e.head.put((status, self.headers.get("X-Content-Type", "application/json")))
        while True:  # pump가 보내는 chunked 본문
            size = int(self.rfile.readline().strip() or b"0", 16)
            if size == 0:
                self.rfile.readline()
                break
            data = self.rfile.read(size)
            self.rfile.readline()
            try:
                e.chunks.put(data, timeout=60)
            except queue.Full:
                break
        e.chunks.put(None)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


def main() -> None:
    mport = rtlib.PATHS.get("relay_model_port", 10100)
    cport = rtlib.PATHS.get("relay_control_port", 10101)
    ctl = ThreadingHTTPServer(("127.0.0.1", cport), Control)
    threading.Thread(target=ctl.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", mport), Model).serve_forever()


if __name__ == "__main__":
    main()
