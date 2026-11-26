#!/bin/bash
# gjc-rt 작업 호스트 롤백(§16.1 G1). 대상에서 root로 실행. 실행 중인 잡이 있으면 멈춘다.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "root only" >&2; exit 1; }
for u in $(systemctl list-units --all --plain --no-legend 'rt-*.service' | awk '{print $1}'); do
  systemctl stop "$u" || true
done
rm -f /etc/ssh/sshd_config.d/50-gjc-rt.conf /etc/ssh/authorized_keys/gjcrt-ctl
# 소켓 활성화면 연결마다 설정을 새로 읽는다.
sshd -t && { systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service 2>/dev/null || true; }
rm -f /etc/sudoers.d/gjc-rt
visudo -c >/dev/null
systemctl disable --now gjc-rt-gc.timer 2>/dev/null || true
rm -f /etc/systemd/system/gjc-rt-gc.timer /etc/systemd/system/gjc-rt-gc.service /etc/systemd/system/user-2201.slice.d/50-gjc-rt.conf
systemctl daemon-reload
userdel gjcrt-ctl 2>/dev/null || true
userdel gjcrt 2>/dev/null || true
groupdel gjcrt-ctl 2>/dev/null || true
groupdel gjcrt 2>/dev/null || true
rm -rf /usr/local/lib/gjc-rt /etc/gjc-rt /var/lib/gjc-rt /srv/gjc-rt
echo "rolled back"
