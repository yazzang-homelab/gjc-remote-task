#!/bin/bash
# 박스용 묶음을 원점(박스를 설정한 메인 호스트)에 만든다. 박스에는 잡마다 job.sh가 올리고 해시로 확인한다(rt-boxctl setup).
# 사용: deploy/stage-box.sh   (RT_TEST_HUB는 쓰지 않는다: 박스의 모델 주소는 늘 같은 scope의 relay다)
#   원격 agent 템플릿은 config.yml rtKey.allowedModels(<provider>/<model>)와 메인 models.yml(RT_MODELS_YML)에서 뽑는다.
#   투입 전 검사용 비밀 지문: $RT/fingerprints.jsonl, RT_FINGERPRINT_CMD, gh 토큰(gh가 있으면), $RT/keys/gjc-rt.key.
# 결과: ~/.gjc/agent/remote-task/box/{bundle-<판>.tar, rt-boxctl, job.sh.tmpl, rt-boxpump.py, rtlib.py, box.json, fingerprints.json,
#        drivers/rt-box-<driver>}
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
RT=${GJC_RT_HOME:-$HOME/.gjc/agent/remote-task}
. "$HERE/deploy/lib.sh"
umask 077
mkdir -p "$RT/box"
S=$(mktemp -d /tmp/rt-box-stage.XXXXXX)
trap 'rm -rf "$S"' EXIT
cp -a "$HERE/worker/bundle" "$S/bundle"
find "$S/bundle" -name __pycache__ -prune -exec rm -rf {} +
# 박스 gjc의 모델 주소는 relay(키 없음)다. 공급자 이름은 메인과 같게 둔다.
ALLOWED=$(rt_cfg "c.rtKey.allowedModels.join(',')")
[ -n "$ALLOWED" ] || { echo "config.yml rtKey.allowedModels가 비었다" >&2; exit 64; }
PROV=${ALLOWED%%/*}
IDS=$(python3 -c 'import sys; p=sys.argv[1]; ms=sys.argv[2].split(","); bad=[m for m in ms if not m.startswith(p+"/")]; sys.exit("한 공급자만 쓴다: "+",".join(bad)) if bad else print(",".join(m[len(p)+1:] for m in ms))' "$PROV" "$ALLOWED")
rt_render_template "$S/bundle" "$PROV" "$IDS" "http://127.0.0.1:10100/v1"
cat > "$S/bundle/paths.json" <<'JSON'
{"job_dir": "/data/workspace/rt/{job}/work", "repo_cache": "per_job", "gjc_dir": "/data/rt-pub/gjc",
 "key": "none", "relay": true, "relay_model_port": 10100, "relay_control_port": 10101}
JSON
# 박스에는 비밀 지문을 두지 않는다(키가 박스로 가지 않으므로 대조할 값도 없다).
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --mode='u+rwX,go+rX,go-w' -C "$S/bundle" -cf "$S/bundle.tar" .
TSHA=$(sha256sum "$S/bundle.tar" | cut -d' ' -f1)
BVER=${TSHA:0:12}
GJC_BIN=$(rt_cfg 'c.gjcBinary')
GJC_SHA=$(sha256sum "$GJC_BIN" | cut -d' ' -f1)
GJC_VER=$("$GJC_BIN" --version | sed 's#^gjc/##')
install -m 0600 "$S/bundle.tar" "$RT/box/bundle-$BVER.tar"
install -m 0700 "$HERE/worker/box/rt-boxctl" "$RT/box/rt-boxctl"
install -m 0600 "$HERE/worker/box/job.sh.tmpl" "$RT/box/job.sh.tmpl"
install -m 0700 "$HERE/worker/box/rt-boxpump.py" "$RT/box/rt-boxpump.py"
install -m 0600 "$HERE/worker/bundle/rtlib.py" "$RT/box/rtlib.py"
# 박스 드라이버(VM 종류별 접속·투입·회수). config.yml 박스 대상의 driver로 고른다.
install -d -m 0700 "$RT/box/drivers"
for drv in "$HERE"/worker/box/drivers/rt-box-*; do install -m 0700 "$drv" "$RT/box/drivers/$(basename "$drv")"; done
BSHA=$(sha256sum "$RT/box/rt-boxctl" | cut -d' ' -f1)
cat > "$RT/box/box.json.new" <<JSON
{"bundle_ver": "$BVER", "bundle_tar": "bundle-$BVER.tar", "tar_sha": "$TSHA", "boxctl_sha": "$BSHA",
 "gjc_ver": "$GJC_VER", "gjc_sha": "$GJC_SHA"}
JSON
mv "$RT/box/box.json.new" "$RT/box/box.json"
# 투입 전 검사용 실제 키 지문(원점에만 둔다. 박스로 보내지 않는다).
command -v gh >/dev/null 2>&1 && gh auth token > "$S/gh.tok" 2>/dev/null || true
rt_fingerprints gh="$S/gh.tok" hub="$RT/keys/gjc-rt.key" > "$RT/box/fingerprints.json"
rm -f "$S/gh.tok"
find "$RT/box" -name 'bundle-*.tar' ! -name "bundle-$BVER.tar" -delete
echo "staged box bundle=$BVER boxctl=${BSHA:0:12} gjc=$GJC_VER"
