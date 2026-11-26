#!/bin/bash
# 다른 메인 호스트를 작업 호스트의 원점으로 더 등록한다. 대상을 처음 설치한(stage-worker.sh) 원점에서 돌린다.
# 사용: deploy/add-origin.sh <원점 이름> <원점 root ssh 별칭> <대상 이름> <대상 root ssh 별칭>
#   RT_ORIGIN_FROM: authorized_keys from= 값(기본: 원점의 tailscale IPv4)
# - 원점의 ssh 키·등록 토큰은 원점에서 만든다(키는 원점 밖으로 나가지 않는다). 토큰은 이 호스트의 파이프만 지나 대상 root 600 파일로 간다.
# - 대상의 authorized_keys에서 이 원점 줄만 바꾼다(다른 원점 줄은 그대로).
# - 원점 설정(config.yml)에는 이 대상만 넣는다. 박스는 박스를 설정한 원점 전용이라 넣지 않는다.
# 되돌리기: deploy/add-origin.sh --remove <원점 이름> <원점 별칭> <대상 이름> <대상 별칭>
set -euo pipefail
REMOVE=0
if [ "${1:-}" = "--remove" ]; then REMOVE=1; shift; fi
ORIGIN=${1:?origin}; OSSH=${2:?origin ssh}; TARGET=${3:?target}; TSSH=${4:?target ssh}
[[ "$ORIGIN" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "origin must match [a-z][a-z0-9-]*" >&2; exit 64; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
RT_LOCAL=${GJC_RT_HOME:-$HOME/.gjc/agent/remote-task}
o() { ssh -o BatchMode=yes "$OSSH" "$@"; }
t() { ssh -o BatchMode=yes "$TSSH" "$@"; }

if [ "$REMOVE" = 1 ]; then
  t "set -e; f=/etc/ssh/authorized_keys/gjcrt-ctl; grep -v -- '--origin $ORIGIN\"' \$f > \$f.new || true; install -m 0644 -o root -g root \$f.new \$f; rm -f \$f.new /etc/gjc-rt/private/hosts/$ORIGIN.token"
  o "rm -f ~/.gjc/agent/remote-task/hosts/$TARGET.token"
  echo "removed origin=$ORIGIN target=$TARGET"
  exit 0
fi

# 1. 원점 준비물(키·토큰)
o 'set -e; RT=$HOME/.gjc/agent/remote-task; umask 077; mkdir -p "$RT/hosts"
[ -f "$RT/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "gjc-rt@'"$ORIGIN"'" -f "$RT/id_ed25519"
[ -s "$RT/hosts/'"$TARGET"'.token" ] || (head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > "$RT/hosts/'"$TARGET"'.token")'
PUB=$(o 'cat $HOME/.gjc/agent/remote-task/id_ed25519.pub')
FROM=${RT_ORIGIN_FROM:-$(o 'tailscale ip -4 | head -1')}
[[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+ ]] || { echo "bad pubkey" >&2; exit 1; }
[[ "$FROM" =~ ^[0-9A-Fa-f:.*%,a-z-]+$ ]] || { echo "bad from: $FROM" >&2; exit 1; }
# 원점과 대상이 같은 호스트면 대상 이름이 루프백(127.0.1.1)으로 풀린다. 같은 호스트이므로 루프백도 허용한다.
[ "$OSSH" = "$TSSH" ] && FROM="$FROM,127.0.0.1,127.0.1.1,::1"

# 2. 대상: 이 원점 줄만 바꾸고 토큰을 둔다.
LINE=$(printf 'restrict,from="%s",command="/usr/local/lib/gjc-rt/rt-dispatch --origin %s" %s' "$FROM" "$ORIGIN" "$PUB")
t "set -e; f=/etc/ssh/authorized_keys/gjcrt-ctl; cp -a \$f \$f.bak-add-origin-$ORIGIN; { grep -v -- '--origin $ORIGIN\"' \$f || true; printf '%s\n' '$LINE'; } > \$f.new; install -m 0644 -o root -g root \$f.new \$f; rm -f \$f.new"
o "cat \$HOME/.gjc/agent/remote-task/hosts/$TARGET.token" | t "install -d -m 0700 /etc/gjc-rt/private/hosts && install -m 0600 -o root -g root /dev/stdin /etc/gjc-rt/private/hosts/$ORIGIN.token"

# 3. 원점 설정과 known_hosts(이 대상만)
read -r TH TP < <(bun -e "
const {loadConfig}=await import('$HERE/extension/core/config.ts');
const c=loadConfig('$RT_LOCAL/config.yml'); const x=c.targets['$TARGET']; if (x.kind!=='ssh') throw new Error('ssh target only'); console.log(x.host+' '+x.port);")
KEYS=$(t 'cat /etc/ssh/ssh_host_ed25519_key.pub' | cut -d' ' -f1,2)
TCFG=$(bun -e "
const {loadConfig}=await import('$HERE/extension/core/config.ts');
const c=loadConfig('$RT_LOCAL/config.yml'); const x=c.targets['$TARGET'];
const out={origin:'$ORIGIN',targets:{'$TARGET':{host:x.host,user:x.user,port:x.port,maxSlots:x.maxSlots}},gjcVersion:c.gjcVersion,defaultModel:c.defaultModel,rtKey:c.rtKey};
console.log(Bun.YAML?.stringify ? Bun.YAML.stringify(out) : JSON.stringify(out));")
printf '%s\n' "# remote-task 설정($ORIGIN). deploy/add-origin.sh가 만든다. 박스는 박스를 설정한 원점 전용이라 없다." "$TCFG" | o 'umask 077; cat > $HOME/.gjc/agent/remote-task/config.yml'
if [ "$TP" = 22 ]; then KH="$TH $KEYS"; else KH="[$TH]:$TP $KEYS"; fi
printf '%s\n' "$KH" | o 'umask 077; f=$HOME/.gjc/agent/remote-task/known_hosts; touch $f; k=$(cat); grep -vF "${k%% *} " $f > $f.new || true; printf "%s\n" "$k" >> $f.new; mv $f.new $f'

# 4. 확인: 원점에서 probe(ssh 키·forced command·등록 토큰 인증까지)
o "cd /tmp && bun -e \"const {RemoteTasks}=await import(process.env.HOME+'/.gjc/agent/extensions/remote-task/jobs.ts'); const rt=new RemoteTasks(); const r=await rt.probe('$TARGET', rt.config.defaultModel); console.log(JSON.stringify({error:r.error??null,credential:r.credential,slots:[r.slots_used,r.slots_max],admission:r.admission}));\""
echo "added origin=$ORIGIN target=$TARGET from=$FROM"
