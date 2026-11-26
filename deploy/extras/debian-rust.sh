#!/bin/bash
# 선택 설치 예시: Debian 13(trixie) 작업 호스트에 cargo 검사용 Rust를 배포판 패키지로 넣는다(rustup 없음).
# trixie 기본 rustc(1.85)가 낮으면 같은 저장소의 rustc-web·cargo-web(보안 갱신 대상)이 /usr/bin/rustc·cargo를 대신한다.
# 쓰는 법: RT_EXTRA_SETUP=deploy/extras/debian-rust.sh deploy/stage-worker.sh ...
set -euo pipefail
RUST_MIN=${RUST_MIN:-1.90}
rust_ok() { command -v rustc >/dev/null 2>&1 && [ "$(printf '%s\n%s\n' "$RUST_MIN" "$(rustc --version | awk '{print $2}')" | sort -V | head -1)" = "$RUST_MIN" ]; }
if ! rust_ok || ! command -v cargo >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends rustc-web cargo-web >/dev/null
fi
rust_ok || { echo "rustc >= $RUST_MIN 필요: $(rustc --version 2>&1)" >&2; exit 1; }
