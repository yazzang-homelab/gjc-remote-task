#!/usr/bin/env python3
"""비밀 파일의 지문(name·len·sha256)을 한 줄 JSON으로 낸다. 원문도 원문 조각도 내지 않는다.

사용: fingerprint.py [--name 이름] 파일...        (파일 내용 앞뒤 공백·줄바꿈은 뗀다)
      fingerprint.py --env NAME...                 (환경 변수 값)
작업 호스트와 박스 투입 검사는 이 지문과 길이·sha256이 같은 문자열이 결과·로그·지시문에 있으면 막는다.
예: python3 scripts/fingerprint.py --name gh <(gh auth token) >> ~/.gjc/agent/remote-task/fingerprints.jsonl
"""
import argparse
import hashlib
import json
import os
import sys


def emit(name: str, value: str) -> None:
    value = value.strip()
    if len(value) < 12:
        return
    print(json.dumps({"name": name[:40], "len": len(value), "sha256": hashlib.sha256(value.encode()).hexdigest()}))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name")
    ap.add_argument("--env", action="store_true", help="인자를 환경 변수 이름으로 본다")
    ap.add_argument("items", nargs="+")
    a = ap.parse_args()
    for item in a.items:
        if a.env:
            v = os.environ.get(item)
            if v:
                emit(a.name or item, v)
            continue
        try:
            with open(item, encoding="utf-8") as f:
                emit(a.name or os.path.basename(item), f.read())
        except OSError as exc:
            print(f"fingerprint: {item}: {exc.strerror}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
