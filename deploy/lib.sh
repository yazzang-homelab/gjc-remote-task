# deploy/*.sh 공용 함수. source로 읽는다. HERE(저장소 루트)와 RT(원점 상태 dir)가 정해져 있어야 한다.

# 해시는 python3로 낸다(맥 원점에는 GNU sha256sum이 없을 수 있다).
rt_sha256() {
  python3 -c 'import hashlib,sys
h=hashlib.sha256()
with open(sys.argv[1],"rb") as f:
    for c in iter(lambda: f.read(1<<20), b""): h.update(c)
print(h.hexdigest())' "$1"
}

# 폴더 판: 파일(이름 접미사로 거를 수 있다)별 sha256과 상대 경로를 경로순으로 모아 다시 sha256. 사용: rt_tree_hash <dir> [접미사]
RT_PY_TREEHASH='import hashlib,os,sys
root, suf = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
rows = []
for d, _, fs in os.walk(root):
    for f in fs:
        if f.endswith(suf):
            p = os.path.join(d, f)
            with open(p, "rb") as fh:
                rows.append(("./" + os.path.relpath(p, root), hashlib.sha256(fh.read()).hexdigest()))
print(hashlib.sha256("".join(f"{h}  {r}\n" for r, h in sorted(rows)).encode()).hexdigest())'
rt_tree_hash() { python3 -c "$RT_PY_TREEHASH" "$@"; }

# 원점 설정(config.yml)의 값 하나를 읽는다. 사용: rt_cfg 'c.gjcBinary'
rt_cfg() {
  bun -e "const {loadConfig}=await import('$HERE/extension/core/config.ts');const c=loadConfig('$RT/config.yml');console.log(String($1 ?? ''))"
}

# 메인 models.yml에서 허용 모델만 골라 원격 agent 템플릿을 만든다(키·헤더는 옮기지 않는다).
# 사용: rt_render_template <bundle dir> <provider> <모델ID,...> [baseUrl]
rt_render_template() {
  local models_yml=${RT_MODELS_YML:-${GJC_CODING_AGENT_DIR:-$HOME/.gjc/agent}/models.yml}
  [ -f "$models_yml" ] || { echo "models.yml이 없다: $models_yml (RT_MODELS_YML로 지정)" >&2; return 1; }
  bun "$HERE/scripts/render-agent-template.ts" "$models_yml" "$1/agent-template" "$2" "$3" ${4:+"$4"} >/dev/null
}

# 비밀 지문 목록(JSON 배열: name·len·sha256, 원문 조각 없음)을 stdout으로 낸다.
# 입력: $RT/fingerprints.jsonl(scripts/fingerprint.py로 만든 줄), RT_FINGERPRINT_CMD(같은 형식을 내는 명령, 선택),
#       그리고 인자로 준 이름=파일 쌍(예: hub=$RT/keys/gjc-rt.key). 12자 미만 값은 버린다.
rt_fingerprints() {
  {
    cat "$RT/fingerprints.jsonl" 2>/dev/null || true
    if [ -n "${RT_FINGERPRINT_CMD:-}" ]; then bash -c "$RT_FINGERPRINT_CMD" || true; fi
    local pair
    for pair in "$@"; do
      if [ -s "${pair#*=}" ]; then python3 "$HERE/scripts/fingerprint.py" --name "${pair%%=*}" "${pair#*=}"; fi
    done
  } | python3 -c '
import json, sys
out, seen = [], set()
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if not isinstance(d, dict) or not isinstance(d.get("len"), int) or not isinstance(d.get("sha256"), str):
        continue
    if d["sha256"] in seen or d["len"] < 12:
        continue
    seen.add(d["sha256"])
    out.append({"name": str(d.get("name", "fp"))[:40], "len": d["len"], "sha256": d["sha256"].lower()})
json.dump(out, sys.stdout)
'
}
