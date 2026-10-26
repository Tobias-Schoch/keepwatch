# Remove Keepwatch's kernel settings and put Ubuntu's cron permissions back.
rm -f /etc/sysctl.d/90-keepwatch-martians.conf /etc/sysctl.d/99-zz-keepwatch.conf \
  /etc/security/limits.d/90-keepwatch-no-core.conf /etc/systemd/coredump.conf.d/keepwatch-off.conf \
  /etc/profile.d/keepwatch-no-core.sh /etc/modprobe.d/keepwatch.conf
sysctl -q --system || true
if [[ -f /etc/crontab ]]; then chmod 644 /etc/crontab; fi
for d in /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly; do
  if [[ -d $d ]]; then chmod 755 "$d"; fi
done
echo "  removed; sysctl values that are no longer set anywhere return to the kernel default after a reboot"
