#!/bin/bash
# 원점(메인 호스트)들에 로컬 확장 remote-task를 같은 판으로 깐다.
# 사용: deploy/sync.sh [--check] [호스트...]   (기본: 이 호스트만. 다른 호스트는 ssh 별칭으로 준다)
#   --check : 설치하지 않고 각 호스트의 판(sha256)만 대조한다.
# 확장 코드만 옮긴다. 호스트별 설정·ssh 키·등록 토큰(~/.gjc/agent/remote-task/)은 stage-worker.sh가 만든다.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
HOSTS=("$@"); [ ${#HOSTS[@]} -eq 0 ] && HOSTS=("$(hostname -s)")
SELF=$(hostname -s)
DEST=${RT_SYNC_DEST:-'$HOME/.gjc/agent/extensions/remote-task'}
. "$HERE/deploy/lib.sh"

# 판 = extension/ 아래 .ts 파일 목록과 내용의 sha256
WANT=$(rt_tree_hash "$HERE/extension" .ts | cut -c1-16)
remote_ver() { # 호스트
  local cmd="[ -d \"$DEST\" ] && python3 - \"$DEST\" .ts | cut -c1-16 || echo none"
  if [ "$1" = "$SELF" ]; then bash -c "$cmd" <<<"$RT_PY_TREEHASH"; else ssh -o BatchMode=yes "$1" "$cmd" <<<"$RT_PY_TREEHASH" 2>/dev/null; fi
}
install_to() { # 호스트
  local tarcmd="set -e; d=$DEST; rm -rf \"\$d.new\"; mkdir -p \"\$d.new\"; tar -C \"\$d.new\" -xf - --no-same-owner; chmod -R go-w \"\$d.new\"; rm -rf \"\$d.old\"; [ -d \"\$d\" ] && mv \"\$d\" \"\$d.old\"; mv \"\$d.new\" \"\$d\"; rm -rf \"\$d.old\""
  if [ "$1" = "$SELF" ]; then tar -C "$HERE/extension" -cf - --exclude='*.test.ts' . | bash -c "$tarcmd"
  else tar -C "$HERE/extension" -cf - --exclude='*.test.ts' . | ssh -o BatchMode=yes "$1" "$tarcmd"; fi
}
rc=0
for h in "${HOSTS[@]}"; do
  have=$(remote_ver "$h" | tail -1)
  if [ "$CHECK" = 0 ] && [ "$have" != "$WANT" ]; then install_to "$h"; have=$(remote_ver "$h" | tail -1); fi
  if [ "$have" = "$WANT" ]; then echo "OK   $h $have"; else echo "DIFF $h have=$have want=$WANT"; rc=1; fi
done
exit $rc
