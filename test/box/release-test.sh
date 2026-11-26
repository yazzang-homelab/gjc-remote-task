#!/bin/bash
# M3 첫 작업: 박스 반납 시험(계획 §20.4·§21.2·§22.3·§23.2·§24). 박스 user가 instabox-q 작업으로 실행한다.
# 업로드 영역: /data/workspace/rt-test/{rt-boxctl,fake-runner.py}. 가짜 러너는 sleep·자손 떼기만 한다(모델 없음).
# 결과: 줄마다 PASS/FAIL <사례> <관측>. 마지막 줄 SUMMARY pass=N fail=M.
set -uo pipefail
T=/data/workspace/rt-test
BIN=/data/rt-ctl/bin/rt-boxctl
VER=000000000000
PASS=0; FAIL=0
ok() { echo "PASS $1 $2"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $1 $2"; FAIL=$((FAIL + 1)); }
bx() { sudo -n "$BIN" "$@"; }
rel() { bx release-check "$1" 1 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(("1:"+d.get("proof","")) if d.get("release") else ("0:"+d.get("reason",d.get("error",""))))'; }
jid() { python3 -c 'import secrets,string; print("rt-"+"".join(secrets.choice(string.digits+string.ascii_lowercase) for _ in range(26)))'; }
unit() { echo "rt-${1#rt-}-g1"; }
wait_file() { for _ in $(seq 1 "$2"); do sudo -n test -e "$1" && return 0; sleep 1; done; return 1; }
wait_rel() { for _ in $(seq 1 "$2"); do [ "$(rel "$1")" = "$3" ] && return 0; sleep 1; done; return 1; }

# 설치: rt-boxctl(root 사본 해시 확인)과 가짜 러너 묶음.
sudo -n install -d -m 0700 -o root -g root /data/rt-ctl /data/rt-ctl/bin
sudo -n install -m 0700 -o root -g root "$T/rt-boxctl" "$BIN"
sudo -n python3 - "$T" "$VER" <<'PY'
import importlib.machinery, importlib.util, os, sys
src, ver = sys.argv[1], sys.argv[2]
loader = importlib.machinery.SourceFileLoader("bc", "/data/rt-ctl/bin/rt-boxctl")
spec = importlib.util.spec_from_loader("bc", loader)
bc = importlib.util.module_from_spec(spec); loader.exec_module(bc)
bc.ensure_dirs(); bc.ensure_account()
d = os.path.join(bc.PUB, "bundle", ver)
os.makedirs(d, mode=0o755, exist_ok=True)
data = open(os.path.join(src, "fake-runner.py"), "rb").read()
open(os.path.join(d, "rt-runner.py"), "wb").write(data)
os.chmod(os.path.join(d, "rt-runner.py"), 0o755)
PY

JOBS=""
mkjob() { # job mode → 가짜 잡 준비(표식 디렉터리·prepared·rtrun 작업 영역)
  sudo -n python3 - "$1" "$2" "$VER" <<'PY'
import json, os, pwd, sys
job, mode, ver = sys.argv[1:4]
assert len(job) == 29, job
ctl = f"/data/rt-ctl/{job}"
os.makedirs(ctl, mode=0o700, exist_ok=True)
open(f"{ctl}/prepared", "w").write(json.dumps({"gen": 1, "bundle": ver}))
u = pwd.getpwnam("rtrun")
w = f"/data/workspace/rt/{job}/work"
os.makedirs(w, mode=0o700, exist_ok=True)
for sub in ("", "home", "cache", "tmp"):
    p = os.path.join(w, sub)
    os.makedirs(p, mode=0o700, exist_ok=True)
    os.chown(p, u.pw_uid, u.pw_gid)
open(os.path.join(w, "mode"), "w").write(mode)
PY
  JOBS="$JOBS $1"
}
start_ctl() { # job [env...]
  local j=$1; shift
  sudo -n systemd-run --unit="$(unit "$j")-ctl" --collect --quiet -p KillMode=control-group "$@" -- "$BIN" start-inner "$j" 1
}
ran() { sudo -n test -e "/data/workspace/rt/$1/work/ran"; }

# T0 탈출 시험: 러너 신원(rtrun, setpriv no-new-privs)으로 권한 상승·관리 영역 접근·사용자 매니저가 막혀야 한다.
asr() { sudo -n /usr/bin/setpriv --reuid=rtrun --regid=rtrun --clear-groups --no-new-privs --reset-env -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent /bin/sh -c "$1"; }
asr 'sudo -n true' > /dev/null 2>&1 && bad T0-sudo "sudo=yes" || ok T0-sudo "sudo=no"
asr 'ls /data/rt-ctl' > /dev/null 2>&1 && bad T0-ctl-read "read" || ok T0-ctl-read "denied"
asr 'touch /data/rt-pub/x' > /dev/null 2>&1 && bad T0-pub-write "wrote" || ok T0-pub-write "denied"
asr 'systemd-run --user --quiet true' > /dev/null 2>&1 && bad T0-user-manager "ran" || ok T0-user-manager "denied"
g=$(asr 'id -G'); [ "$g" = "$(asr 'id -g')" ] && ok T0-groups "$g" || bad T0-groups "$g"
asr 'docker ps' > /dev/null 2>&1 && bad T0-docker "yes" || ok T0-docker "denied"

# T1 시작 전 취소 → 미시작 증명(조건 1)으로 반납 1, 뒤늦은 시작은 거부·실행 0.
J=$(jid); mkjob "$J" sleep
bx cancel "$J" 1 > /dev/null
r=$(rel "$J"); [ "$r" = "1:not_started" ] && ok T1-cancel-before-start "$r" || bad T1-cancel-before-start "$r"
start_ctl "$J"; sleep 4
if ! ran "$J" && [ "$(rel "$J")" = "1:not_started" ]; then ok T1-late-start-refused "ran=0"; else bad T1-late-start-refused "ran=$(ran "$J" && echo 1 || echo 0)"; fi

# T2 실행 중 → 반납 0, 취소(정리) 뒤 종료 증명으로 반납 1.
J=$(jid); mkjob "$J" sleep
start_ctl "$J"; wait_file "/data/workspace/rt/$J/work/ran" 20
r=$(rel "$J"); [ "${r%%:*}" = 0 ] && ok T2-running-no-release "$r" || bad T2-running-no-release "$r"
r=$(bx cancel "$J" 1 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(("1:"+d.get("proof","")) if d.get("release") else ("0:"+d.get("reason","")))')
[ "$r" = "1:ended" ] && ok T2-cancel-release "$r" || bad T2-cancel-release "$r"

# T3 starting 기록 직후 SIGSTOP → 봉인 → 반납 0 → SIGCONT → scope 안 재확인으로 즉시 종료 → 반납 1, 러너 실행 0.
J=$(jid); mkjob "$J" sleep
start_ctl "$J" -E RT_TEST_PAUSE_AFTER_STARTING=8
wait_file "/data/rt-ctl/$J/starting-g1" 20
sudo -n systemctl kill --signal=STOP "$(unit "$J")-ctl.service"
bx seal "$J" 1 > /dev/null
sleep 9
r=$(rel "$J"); [ "${r%%:*}" = 0 ] && ok T3-stopped-no-release "$r" || bad T3-stopped-no-release "$r"
sudo -n systemctl kill --signal=CONT "$(unit "$J")-ctl.service"
if wait_rel "$J" 30 "1:ended" && ! ran "$J"; then ok T3-cont-sealed-exit "ran=0"; else bad T3-cont-sealed-exit "$(rel "$J") ran=$(ran "$J" && echo 1 || echo 0)"; fi

# T4 start-inner(ctl 주 프로세스) SIGKILL, scope는 남음 → 반납 0 → 정리 뒤 1.
J=$(jid); mkjob "$J" sleep
start_ctl "$J"; wait_file "/data/workspace/rt/$J/work/ran" 20
sudo -n systemctl kill --signal=KILL --kill-whom=main "$(unit "$J")-ctl.service"
sleep 3
r=$(rel "$J"); [ "${r%%:*}" = 0 ] && ok T4-parent-killed-no-release "$r" || bad T4-parent-killed-no-release "$r"
bx cancel "$J" 1 > /dev/null
r=$(rel "$J"); [ "$r" = "1:ended" ] && ok T4-after-cleanup "$r" || bad T4-after-cleanup "$r"

# T5 잠금 경합 → 취소는 needs_reconcile, 봉인·반납 0.
J=$(jid); mkjob "$J" sleep
sudo -n flock "/data/rt-ctl/$J/lock" sleep 45 &
LOCKER=$!
sleep 1
out=$(bx cancel "$J" 1); code=$?
if [ "$code" = 3 ] && echo "$out" | grep -q needs_reconcile && ! sudo -n test -e "/data/rt-ctl/$J/sealed-g1"; then ok T5-lock-contention "needs_reconcile"; else bad T5-lock-contention "code=$code"; fi
r=$(rel "$J"); [ "${r%%:*}" = 0 ] && ok T5-no-release "$r" || bad T5-no-release "$r"
wait "$LOCKER" 2>/dev/null

# T6 증거 유실: 실행 중 starting 표식 삭제 + 봉인 → 반납 0(needs_reconcile). 정리 뒤 실행 그룹이 비면 1.
J=$(jid); mkjob "$J" sleep
start_ctl "$J"; wait_file "/data/workspace/rt/$J/work/ran" 20
sudo -n rm -f "/data/rt-ctl/$J/starting-g1"
bx seal "$J" 1 > /dev/null
r=$(rel "$J"); [ "$r" = "0:needs_reconcile" ] && ok T6-evidence-lost "$r" || bad T6-evidence-lost "$r"
sudo -n systemctl stop "$(unit "$J").scope" "$(unit "$J")-ctl.service"
r=$(rel "$J"); [ "$r" = "1:not_started" ] && ok T6-after-stop "$r" || bad T6-after-stop "$r"

# T7 떼어 낸 자손: 러너는 setsid nohup sleep을 남기고 끝남 → scope 정지 전 반납 0 → 정지 뒤 1, 자손 0.
J=$(jid); mkjob "$J" detach
start_ctl "$J" -E RT_TEST_PAUSE_BEFORE_SCOPE_STOP=10
wait_file "/data/rt-ctl/$J/start-exited-g1" 30
r=$(rel "$J"); [ "${r%%:*}" = 0 ] && ok T7-detached-no-release "$r" || bad T7-detached-no-release "$r"
if wait_rel "$J" 40 "1:ended" && ! pgrep -u rtrun -f 'sleep 777' > /dev/null; then ok T7-after-stop "descendants=0"; else bad T7-after-stop "$(rel "$J") left=$(pgrep -u rtrun -fc 'sleep 777')"; fi

# T8 반납 판정 중복 호출 → 같은 결과(원장 전이 1회는 원점 단위 시험이 본다).
r1=$(rel "$J"); r2=$(rel "$J"); [ "$r1" = "$r2" ] && ok T8-idempotent "$r1" || bad T8-idempotent "$r1/$r2"

# T9 7일 gc(AC-9): 반납 증명이 있는 8일 지난 잡은 지우고, 실행 중인 8일 지난 잡은 남긴다.
J=$(jid); mkjob "$J" sleep; bx cancel "$J" 1 > /dev/null
K=$(jid); mkjob "$K" sleep; start_ctl "$K"; wait_file "/data/workspace/rt/$K/work/ran" 20
sudo -n touch -h -d '8 days ago' "/data/workspace/rt/$J" "/data/workspace/rt/$K"
bx gc > /dev/null
if ! sudo -n test -e "/data/workspace/rt/$J" && sudo -n test -e "/data/workspace/rt/$K"; then ok T9-gc-7days "released=gone running=kept"; else bad T9-gc-7days "J=$(sudo -n test -e /data/workspace/rt/$J && echo kept || echo gone) K=$(sudo -n test -e /data/workspace/rt/$K && echo kept || echo gone)"; fi

# 시험 잡 정리: 만든 잡마다 봉인·정지 뒤 cleanup(반납 증명이 있어야 지워진다).
for d in $JOBS; do
  bx cancel "$d" 1 > /dev/null 2>&1
  bx cleanup "$d" 1 > /dev/null || echo "WARN cleanup $d"
  sudo -n rm -rf "/data/rt-ctl/$d"
done
sudo -n rm -rf "/data/rt-pub/bundle/$VER"
echo "SUMMARY pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
