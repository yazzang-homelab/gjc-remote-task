#!/bin/bash
# gjc-rt 작업 호스트 root 1회 설치(G1). 대상 호스트에서 root로 실행한다.
# 사용: provision-worker.sh <스테이징 dir>
#   스테이징 dir: rt-helper rt-dispatch rt-login bundle/ bundle.version config.json slice.conf
#                 trusted-gjc.sha256 fingerprints.json authorized_keys private/{cap.key?,hosts/<origin>.token}
#                 extra-setup.sh(선택)
# 멱등이다. 기존 계정·설정은 내용만 맞춘다. 롤백: deploy/rollback-worker.sh
set -euo pipefail
S=${1:?staging dir}
[ "$(id -u)" = 0 ] || { echo "root only" >&2; exit 1; }
umask 022
RUN_UID=2201
CTL_UID=2202
LIB=/usr/local/lib/gjc-rt
BVER=$(cat "$S/bundle.version")

# 1. 계정: 실행 계정 gjcrt(로그인 불가), 진입 계정 gjcrt-ctl(rt-login 셸)
getent group gjcrt >/dev/null || groupadd -g $RUN_UID gjcrt
getent passwd gjcrt >/dev/null || useradd -u $RUN_UID -g gjcrt -M -d /srv/gjc-rt -s /usr/sbin/nologin gjcrt
getent group gjcrt-ctl >/dev/null || groupadd -g $CTL_UID gjcrt-ctl
install -d -m 0755 -o root -g root $LIB
install -m 0755 -o root -g root "$S/rt-login" $LIB/rt-login
getent passwd gjcrt-ctl >/dev/null || useradd -u $CTL_UID -g gjcrt-ctl -M -d $LIB -s $LIB/rt-login gjcrt-ctl
usermod -s $LIB/rt-login -d $LIB gjcrt-ctl
usermod -s /usr/sbin/nologin gjcrt
passwd -l gjcrt >/dev/null 2>&1 || true
# ssh 공개키 인증은 잠긴 비밀번호(!)를 막지 않지만 '*'는 막을 수 있다. 계정 만료도 확인한다.
usermod -p '*' gjcrt-ctl
chage -E -1 gjcrt-ctl

# 2. 실행 파일(root 소유 불변)
install -m 0755 -o root -g root "$S/rt-helper" $LIB/rt-helper
install -m 0755 -o root -g root "$S/rt-dispatch" $LIB/rt-dispatch
install -d -m 0755 -o root -g root $LIB/bundle $LIB/gjc
if [ ! -d "$LIB/bundle/$BVER" ]; then
  tmp=$(mktemp -d $LIB/bundle/.new.XXXX)
  cp -a "$S/bundle/." "$tmp/"
  chown -R root:root "$tmp"
  find "$tmp" -type d -exec chmod 0755 {} +
  find "$tmp" -type f -exec chmod 0644 {} +
  chmod 0755 "$tmp/rt-runner.py" "$tmp/rt-worktool.py"
  mv "$tmp" "$LIB/bundle/$BVER"
fi

# 3. 설정(/etc/gjc-rt 읽기 가능, private는 root 0700)
install -d -m 0755 -o root -g root /etc/gjc-rt
install -d -m 0700 -o root -g root /etc/gjc-rt/private /etc/gjc-rt/private/hosts
python3 - "$S/config.json" "$BVER" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["bundle_version"] = sys.argv[2]
json.dump(cfg, open("/etc/gjc-rt/config.json.new", "w"), indent=1)
PY
mv /etc/gjc-rt/config.json.new /etc/gjc-rt/config.json
chmod 0644 /etc/gjc-rt/config.json
install -m 0644 -o root -g root "$S/trusted-gjc.sha256" /etc/gjc-rt/trusted-gjc.sha256
install -m 0644 -o root -g root "$S/fingerprints.json" /etc/gjc-rt/fingerprints.json
[ -s /etc/gjc-rt/private/cap.key ] || (head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /etc/gjc-rt/private/cap.key)
chmod 0600 /etc/gjc-rt/private/cap.key
for t in "$S"/private/hosts/*.token; do
  [ -e "$t" ] || continue
  install -m 0600 -o root -g root "$t" /etc/gjc-rt/private/hosts/
done

# 4. 상태·작업 경로
install -d -m 0700 -o root -g root /var/lib/gjc-rt /var/lib/gjc-rt/jobs /var/lib/gjc-rt/keys
install -d -m 0755 -o root -g root /srv/gjc-rt /srv/gjc-rt/work
install -d -m 0700 -o gjcrt -g gjcrt /srv/gjc-rt/repos /srv/gjc-rt/cache

# 5. sudoers: 진입 계정은 rt-helper 한 줄만(인자 패턴 고정, sudo 1.9.10+ 정규식)
cat > /etc/sudoers.d/gjc-rt.new <<'EOF'
Defaults:gjcrt-ctl !requiretty, env_reset, !lecture, !mail_badpass
gjcrt-ctl ALL=(root) NOPASSWD: /usr/local/lib/gjc-rt/rt-helper ^--origin [a-z][a-z0-9-]* [a-z-]+( [A-Za-z0-9._\:/@+-]+)*$
EOF
chmod 0440 /etc/sudoers.d/gjc-rt.new
visudo -cf /etc/sudoers.d/gjc-rt.new >/dev/null
mv /etc/sudoers.d/gjc-rt.new /etc/sudoers.d/gjc-rt

# 6. sshd: 진입 계정 제한 + root 소유 authorized_keys
install -d -m 0755 -o root -g root /etc/ssh/authorized_keys
install -m 0644 -o root -g root "$S/authorized_keys" /etc/ssh/authorized_keys/gjcrt-ctl
cat > /etc/ssh/sshd_config.d/50-gjc-rt.conf.new <<'EOF'
Match User gjcrt-ctl
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTTY no
    PermitUserRC no
    PermitTunnel no
    GatewayPorts no
EOF
mv /etc/ssh/sshd_config.d/50-gjc-rt.conf.new /etc/ssh/sshd_config.d/50-gjc-rt.conf
sshd -t
systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service 2>/dev/null || true  # 소켓 활성화면 연결마다 새로 읽는다

# 7. slice와 gc 타이머
install -d -m 0755 /etc/systemd/system/user-$RUN_UID.slice.d
install -m 0644 -o root -g root "$S/slice.conf" /etc/systemd/system/user-$RUN_UID.slice.d/50-gjc-rt.conf
cat > /etc/systemd/system/gjc-rt-gc.service <<'EOF'
[Unit]
Description=gjc-rt 미회수 잡 정리(7일)
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/gjc-rt/rt-helper --internal gc
EOF
cat > /etc/systemd/system/gjc-rt-gc.timer <<'EOF'
[Unit]
Description=gjc-rt 미회수 잡 정리(하루 1회)
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now gjc-rt-gc.timer >/dev/null 2>&1

# 8. 작업 도구(선택): 스테이징에 extra-setup.sh가 있으면 root로 돌린다(예: deploy/extras/debian-rust.sh).
#    작업 검사에 쓰는 빌드 도구(cargo·bun·node 등)는 gjcrt 계정 PATH(/usr/local/bin·/usr/bin)에 있어야 한다.
if [ -f "$S/extra-setup.sh" ]; then bash "$S/extra-setup.sh"; fi
echo "provisioned bundle=$BVER"
