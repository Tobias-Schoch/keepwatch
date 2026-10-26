# Kernel hardening: sysctl, no core dumps, rare network protocols blocked,
# tight permissions on cron.
put "$F/sysctl-90-martians.conf" /etc/sysctl.d/90-keepwatch-martians.conf
put "$F/sysctl-99-keepwatch.conf" /etc/sysctl.d/99-zz-keepwatch.conf
changed /etc/sysctl.d/ && sysctl -q --system
put "$F/limits-no-core.conf" /etc/security/limits.d/90-keepwatch-no-core.conf
put "$F/coredump-off.conf" /etc/systemd/coredump.conf.d/keepwatch-off.conf
put "$F/profile-no-core.sh" /etc/profile.d/keepwatch-no-core.sh
# Blocks new load attempts immediately; a module already loaded stays until reboot.
put "$F/modprobe-keepwatch.conf" /etc/modprobe.d/keepwatch.conf
# Lynis FILE-7524: cron reads its files as root, nobody else needs them.
if [[ -f /etc/crontab ]]; then chmod 600 /etc/crontab; fi
for d in /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly; do
  if [[ -d $d ]]; then chmod 700 "$d"; fi
done
echo "  ok"
