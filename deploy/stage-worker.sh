#!/bin/bash
# 원점(메인 호스트)에서 작업 호스트용 스테이징을 만들고 root ssh로 provision-worker.sh를 돌린다.
# 사용: deploy/stage-worker.sh <대상 이름> <root ssh 별칭> <profile>
#   대상 이름: 원점 config.yml targets의 ssh 대상 이름
#   profile  : deploy/profiles/<profile>.config.json 과 <profile>.slice.conf (example을 복사해 만든다)
# 환경 변수(선택):
#   RT_ORIGIN       원점 이름(기본: config.yml origin = 이 호스트 이름)
#   RT_FROM         authorized_keys from= 값. 기본: 대상이 링크로컬(fe80::…%iface)이면 이 호스트 그 인터페이스의
#                   링크로컬 주소, 아니면 tailscale IPv4. 둘 다 아니면 반드시 준다(예: 203.0.113.5 또는 10.0.0.*).
#   RT_MODELS_YML   원격 agent 템플릿을 뽑을 메인 models.yml(기본 ~/.gjc/agent/models.yml)
#   RT_EXTRA_SETUP  작업 호스트에서 root로 한 번 돌릴 추가 설치 스크립트(예: deploy/extras/debian-rust.sh)
#   RT_TEST_HUB     host:port. 시험 모드: 모델 허브를 대상 호스트의 가짜 허브로 바꾼다(실제 키·모델을 쓰지 않는다).
# 로컬 준비물(없으면 만든다): ~/.gjc/agent/remote-task/{id_ed25519,known_hosts,hosts/<대상>.token}
set -euo pipefail
TARGET=${1:?target}; SSH_ALIAS=${2:?ssh alias}; PROFILE=${3:?profile}
HERE=$(cd "$(dirname "$0")/.." && pwd)
RT=${GJC_RT_HOME:-$HOME/.gjc/agent/remote-task}
. "$HERE/deploy/lib.sh"
ORIGIN=${RT_ORIGIN:-$(rt_cfg 'c.origin')}
[[ "$ORIGIN" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "원점 이름이 규칙([a-z][a-z0-9-]*)에 맞지 않는다: $ORIGIN" >&2; exit 64; }
PCFG="$HERE/deploy/profiles/$PROFILE.config.json"
[ -f "$PCFG" ] && [ -f "$HERE/deploy/profiles/$PROFILE.slice.conf" ] || { echo "profile이 없다: $PROFILE" >&2; exit 64; }
umask 077
mkdir -p "$RT/hosts"
[ -f "$RT/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "gjc-rt@$ORIGIN" -f "$RT/id_ed25519"
[ -s "$RT/hosts/$TARGET.token" ] || (head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$RT/hosts/$TARGET.token")

S=$(mktemp -d /tmp/rt-stage.XXXXXX)
trap 'rm -rf "$S"' EXIT
cp "$HERE/worker/rt-helper" "$HERE/worker/rt-dispatch" "$HERE/worker/rt-login" "$S/"
cp -a "$HERE/worker/bundle" "$S/bundle"
find "$S/bundle" -name __pycache__ -prune -exec rm -rf {} +
python3 - "$PCFG" "${RT_TEST_HUB:-}" "$S/config.json" "$S/template.args" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
hub = sys.argv[2]
prov = cfg["provider"]
ids = []
for m in cfg["allowed_models"]:
    if not m.startswith(prov + "/"):
        sys.exit(f"allowed_models 항목은 '{prov}/'로 시작해야 한다: {m}")
    ids.append(m[len(prov) + 1:])
base = ""
if hub:
    base = f"http://{hub}/v1"
    cfg["hub_models_url"] = f"{base}/models"
json.dump(cfg, open(sys.argv[3], "w"), indent=1)
open(sys.argv[4], "w").write(f"{prov}\n{','.join(ids)}\n{base}\n")
PY
{ read -r PROV; read -r IDS; read -r BASE; } < "$S/template.args"
rm -f "$S/template.args"
rt_render_template "$S/bundle" "$PROV" "$IDS" "$BASE"
BVER=$(cd "$S/bundle" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
echo "$BVER" > "$S/bundle.version"
cp "$HERE/deploy/profiles/$PROFILE.slice.conf" "$S/slice.conf"
GJC_BIN=$(rt_cfg 'c.gjcBinary')
GJC_SHA=$(sha256sum "$GJC_BIN" | cut -d' ' -f1)
GJC_VER=$("$GJC_BIN" --version | sed 's#^gjc/##')
echo "$GJC_VER $GJC_SHA" > "$S/trusted-gjc.sha256"
# 비밀 지문(이름·길이·sha256). 값도 원문 조각도 보내지 않는다. 결과·로그·이벤트에 이 값이 섞이면 원격에서 막는다.
rt_fingerprints > "$S/fingerprints.json"
[ -n "${RT_EXTRA_SETUP:-}" ] && cp "$RT_EXTRA_SETUP" "$S/extra-setup.sh"
THOST=$(rt_cfg "c.targets['$TARGET']?.host")
[ -n "$THOST" ] || { echo "config.yml에 ssh 대상이 없다: $TARGET" >&2; exit 64; }
if [ -z "${RT_FROM:-}" ] && [[ "$THOST" == fe80:*%* ]]; then
  LL=$(ip -6 -o addr show dev "${THOST##*%}" scope link | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$LL" ] || { echo "링크로컬 주소를 못 찾았다: ${THOST##*%}" >&2; exit 1; }
  RT_FROM="$LL*"
fi
if [ -z "${RT_FROM:-}" ] && command -v tailscale >/dev/null 2>&1; then RT_FROM=$(tailscale ip -4 | head -1); fi
FROM=${RT_FROM:?RT_FROM(이 원점이 대상에 접속하는 주소)을 정해야 한다}
# 다른 원점(add-origin.sh로 넣은 줄)은 그대로 두고 이 원점 줄만 바꾼다.
{ ssh -o BatchMode=yes "$SSH_ALIAS" 'cat /etc/ssh/authorized_keys/gjcrt-ctl 2>/dev/null' | grep -v -- "--origin $ORIGIN\"" || true
  printf 'restrict,from="%s",command="/usr/local/lib/gjc-rt/rt-dispatch --origin %s" %s\n' \
    "$FROM" "$ORIGIN" "$(cat "$RT/id_ed25519.pub")"; } > "$S/authorized_keys"
mkdir -p "$S/private/hosts"
cp "$RT/hosts/$TARGET.token" "$S/private/hosts/$ORIGIN.token"
cp "$HERE/deploy/provision-worker.sh" "$S/"

REMOTE=/root/gjc-rt-stage
ssh -o BatchMode=yes "$SSH_ALIAS" "rm -rf $REMOTE && mkdir -m 700 $REMOTE"
tar -C "$S" -cf - . | ssh -o BatchMode=yes "$SSH_ALIAS" "tar -C $REMOTE -xf - --no-same-owner"
ssh -o BatchMode=yes "$SSH_ALIAS" "bash $REMOTE/provision-worker.sh $REMOTE; rc=\$?; rm -rf $REMOTE; exit \$rc"

# 대상 호스트 키를 고정한다(root ssh로 이미 신뢰한 키를 그대로 옮긴다).
TP=$(rt_cfg "c.targets['$TARGET'].port")
TH=$THOST
KEYS=$(ssh -o BatchMode=yes "$SSH_ALIAS" 'cat /etc/ssh/ssh_host_ed25519_key.pub' | cut -d' ' -f1,2)
touch "$RT/known_hosts"
grep -v "^\[$TH\]:$TP \|^$TH " "$RT/known_hosts" > "$RT/known_hosts.new" || true
if [ "$TP" = 22 ]; then echo "$TH $KEYS" >> "$RT/known_hosts.new"; else echo "[$TH]:$TP $KEYS" >> "$RT/known_hosts.new"; fi
mv "$RT/known_hosts.new" "$RT/known_hosts"
echo "staged target=$TARGET bundle=$BVER gjc=$GJC_VER fingerprints=$(python3 -c "import json;print(len(json.load(open('$S/fingerprints.json'))))" 2>/dev/null || echo ?)"
