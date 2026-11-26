"""gjc-rt 원격 공용 함수(러너·작업 도구가 함께 쓴다). 표준 라이브러리만 쓴다."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import time

EVENT_MAX = 16 * 1024
INBOX_MAX = 64 * 1024
FINGERPRINTS_PATH = "/etc/gjc-rt/fingerprints.json"

# 토큰 모양 규칙(값 자체는 몰라도 잡는다). 박스 투입 전 검사와 같은 계열.
TOKEN_RULES = [
    ("openai_like", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("ocx_key", re.compile(r"\bocx_[A-Za-z0-9_-]{16,}")),
    ("github_token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("google_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack_token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}")),
    ("telegram_bot", re.compile(r"\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


FINGERPRINTS_LOCAL_PATH = "/etc/gjc-rt/fingerprints.local.json"


def bundle_paths() -> dict:
    """묶음과 함께 배포되는 paths.json(root 소유, 불변). 신뢰 호스트 묶음에는 없고 박스 묶음에만 있다.
    환경변수가 아니라 파일로 받는다: 러너·작업 도구의 경로는 잡 쪽 프로세스가 바꿀 수 없어야 한다."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paths.json")
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


PATHS = bundle_paths()


def load_fingerprints(path: str = FINGERPRINTS_PATH, local_path: str = FINGERPRINTS_LOCAL_PATH) -> list[dict]:
    """지문 목록: [{"name","len","sha256"}]. 값도 원문 조각(앞 글자)도 없다(계획 §16.6).
    local 파일은 이 호스트에만 있는 비밀(전용 허브 키 등)의 지문이다."""
    data: list = []
    for p in (path, local_path):
        try:
            with open(p, "r", encoding="utf-8") as f:
                part = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(part, list):
            data.extend(part)
    out = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("len"), int) and isinstance(item.get("sha256"), str):
            out.append({"name": str(item.get("name", "fp")), "len": item["len"], "sha256": item["sha256"].lower()})
    return out


# 비밀 후보 구간: 공백·따옴표·역슬래시·괄호류·구분 기호가 없는 연속 바이트. API 키·토큰은 이런 문자를 담지 않는다.
# JSON·SSE 본문도 문자열 내용 단위로 잘려 창 수가 적다(pump가 모델 응답 전체를 검사한다).
_RUN = re.compile(rb"[^\s\"'\\`{}\[\](),;<>]+")
_SEP = frozenset(b" \t\n\r\f\v\"'\\`{}[](),;<>")  # _RUN이 끊는 바이트(정규식 \s의 바이트 공백 포함)


def compile_fingerprints(fps: list[dict]) -> dict[int, dict[str, str]]:
    """지문 목록을 길이별 sha256→이름 표로 바꾼다(반복 검사에서 한 번만 만든다)."""
    by_len: dict[int, dict[str, str]] = {}
    for fp in sorted(fps, key=lambda f: f["len"]):
        if fp["len"] > 0:
            by_len.setdefault(fp["len"], {})[fp["sha256"]] = fp["name"]
    return by_len


def fingerprint_hits(text: str | bytes, fps: list[dict] | dict[int, dict[str, str]], min_end: int = 0) -> list[str]:
    """text 안에 지문과 길이·sha256이 같은 조각이 있는지 본다.
    fps는 지문 목록이나 compile_fingerprints 결과다. min_end를 주면 그 바이트 위치 뒤에서 끝나는 창만 본다
    (앞부분을 이미 검사한 스트림에 새 바이트를 붙여 다시 볼 때).
    비밀은 공백·따옴표·괄호류·구분 기호를 담지 않는다고 보고, 그런 문자 없이 이어진 구간(_RUN) 안에서만 창을 민다.
    일치한 지문 이름만 돌려준다(값은 돌려주지 않는다)."""
    if not fps or not text:
        return []
    raw = text if isinstance(text, bytes) else text.encode("utf-8", "surrogatepass")
    by_len = compile_fingerprints(fps) if isinstance(fps, list) else fps
    hits: set[str] = set()
    # min_end 뒤에서 끝나는 창은 min_end-1 바이트를 품은 구간이나 그 뒤 구간에만 있다. 그 구간 머리부터 본다.
    pos = min(min_end, len(raw))
    while pos > 0 and raw[pos - 1] not in _SEP:
        pos -= 1
    for m in _RUN.finditer(raw, pos):
        if m.end() <= min_end:
            continue
        run = m.group()
        n = len(run)
        for length, table in by_len.items():  # 길이 오름차순
            if length > n:
                break
            # min_end보다 앞에서 끝나는 창은 이미 검사했다(스트림 증분 검사). 창 [start+i, start+i+length)
            for i in range(max(0, min_end - m.start() - length + 1), n - length + 1):
                name = table.get(hashlib.sha256(run[i : i + length]).hexdigest())
                if name:
                    hits.add(name)
    return sorted(hits)


def scan_secrets(text: str, fps: list[dict]) -> list[str]:
    rules = [name for name, rx in TOKEN_RULES if rx.search(text)]
    return rules + fingerprint_hits(text, fps)


def redact_line(text: str, fps: list[dict]) -> tuple[str, list[str]]:
    """비밀이 보이면 그 줄 전체를 표지로 바꾼다. 원문은 어디에도 남기지 않는다."""
    hits = scan_secrets(text, fps)
    if hits:
        return f"[redacted:{','.join(sorted(set(hits)))}]", hits
    return text, []


def clean_text(text: str, limit: int) -> str:
    text = _CTRL.sub("", text)
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    cut = raw[:limit].decode("utf-8", "ignore")
    return cut + f"[잘림: {len(raw) - len(cut.encode('utf-8'))}바이트]"


class EventLog:
    """events.jsonl 추가 전용 기록. seq는 이 객체(러너) 하나만 매긴다."""

    def __init__(self, job_dir: str, fps: list[dict]):
        self.path = os.path.join(job_dir, "events.jsonl")
        self.lock = os.path.join(job_dir, "events.lock")
        self.fps = fps
        self.seq = 0
        try:
            with open(self.path, "rb") as f:
                for line in f:
                    try:
                        self.seq = max(self.seq, int(json.loads(line)["seq"]))
                    except (ValueError, KeyError, TypeError):
                        pass
        except FileNotFoundError:
            pass

    def _last_seq(self) -> int:
        """파일 끝의 마지막 완전한 줄에서 seq를 읽는다(다른 기록자와 겹치지 않게)."""
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 2 * EVENT_MAX))
                lines = f.read().split(b"\n")
        except FileNotFoundError:
            return 0
        for line in reversed(lines):
            try:
                return int(json.loads(line)["seq"])
            except (ValueError, KeyError, TypeError):
                continue
        return 0

    def emit(self, kind: str, data: dict) -> int:
        body = json.dumps(data, ensure_ascii=False)
        body, hits = redact_line(body, self.fps)
        if hits:
            data = {"redacted": True, "rules": sorted(set(hits))}
        else:
            data = json.loads(body)
        fd = os.open(self.lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.seq = max(self.seq, self._last_seq()) + 1
            rec = {"seq": self.seq, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind, "data": data}
            line = json.dumps(rec, ensure_ascii=False)
            if len(line.encode("utf-8")) > EVENT_MAX:
                rec["data"] = {"truncated": True, "preview": clean_text(json.dumps(data, ensure_ascii=False), EVENT_MAX - 512)}
                line = json.dumps(rec, ensure_ascii=False)
            wfd = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                os.write(wfd, (line + "\n").encode("utf-8"))
            finally:
                os.close(wfd)
            return self.seq
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def read_jsonl(path: str) -> list[dict]:
    out = []
    try:
        with open(path, "rb") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
    except FileNotFoundError:
        pass
    return out


def write_json_atomic(path: str, obj) -> None:
    tmp = f"{path}.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
