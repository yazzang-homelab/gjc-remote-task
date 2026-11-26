#!/bin/bash
# gjc-rt 전용 허브 키를 작업 호스트에 넣는다. 키는 stdin으로만 받는다(argv·로그에 남기지 않는다).
# 키를 넣으면서 그 지문(이름·길이·sha256, 원문 조각 없음)을 /etc/gjc-rt/fingerprints.local.json에 적는다.
# 그래야 작업 결과·로그·이벤트에 키가 섞이면 원격에서 차단된다(P-4).
# 사용: <키를 내는 명령> | deploy/install-key.sh <root ssh 별칭>
#       deploy/install-key.sh <root ssh 별칭> --remove
set -euo pipefail
ALIAS=${1:?ssh alias}
if [ "${2:-}" = "--remove" ]; then
  ssh -o BatchMode=yes "$ALIAS" 'rm -f /var/lib/gjc-rt/keys/gjc-rt.key /var/lib/gjc-rt/models-cache.json /etc/gjc-rt/fingerprints.local.json && echo removed'
  exit 0
fi
[ -t 0 ] && { echo "키를 stdin으로 넘긴다" >&2; exit 64; }
# 원격 set -e는 서브셸에 가둔다. 로그인 셸 .bashrc가 종료 처리를 거는 호스트에서는 바깥 셸의 set -e가
# 성공한 뒤에도 ssh 종료값을 1로 만든다.
ssh -o BatchMode=yes "$ALIAS" '( set -e; umask 077; install -d -m 0700 /var/lib/gjc-rt/keys
head -c 4096 | tr -d "\r\n" > /var/lib/gjc-rt/keys/.gjc-rt.key.new
[ -s /var/lib/gjc-rt/keys/.gjc-rt.key.new ]
mv /var/lib/gjc-rt/keys/.gjc-rt.key.new /var/lib/gjc-rt/keys/gjc-rt.key
rm -f /var/lib/gjc-rt/models-cache.json
python3 - <<PY
import hashlib, json, os
k = open("/var/lib/gjc-rt/keys/gjc-rt.key", "rb").read()
fp = [{"name": "gjc-rt-hub-key", "len": len(k), "sha256": hashlib.sha256(k).hexdigest()}]
tmp = "/etc/gjc-rt/.fingerprints.local.json.new"
with open(tmp, "w") as f:
    json.dump(fp, f)
os.chmod(tmp, 0o644)
os.replace(tmp, "/etc/gjc-rt/fingerprints.local.json")
PY
echo installed )'
