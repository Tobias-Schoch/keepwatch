# Base system: shared packages, timezone, hostname, journal size, login banner.
# Always on (cannot be disabled), so it has no remove.sh.

# Only what several modules use. Everything else is installed by the module
# that needs it.
need ca-certificates curl gnupg jq rsync openssl python3 sqlite3 ncdu nftables tzdata

# The system clock stays in KW_TIMEZONE (UTC by default: logs stay
# unambiguous); schedules use KW_LOCAL_TZ through the OnCalendar timezone suffix.
if [[ ! -f /usr/share/zoneinfo/$KW_TIMEZONE ]]; then
  warn "KW_TIMEZONE=$KW_TIMEZONE is not a known timezone - left unchanged"
elif [[ $(timedatectl show -p Timezone --value 2>/dev/null) != "$KW_TIMEZONE" ]]; then
  timedatectl set-timezone "$KW_TIMEZONE"
  CHANGED+=("timezone: $KW_TIMEZONE")
  echo "  timezone: $KW_TIMEZONE"
fi
[[ -f /usr/share/zoneinfo/$KW_LOCAL_TZ ]] || warn "KW_LOCAL_TZ=$KW_LOCAL_TZ is not a known timezone - schedules fall back to UTC"

# Hostname, and cloud-init must not reset it on the next boot.
put "$F/cloud-hostname.cfg" /etc/cloud/cloud.cfg.d/99-keepwatch-hostname.cfg
if [[ -n $KW_HOSTNAME && $(hostnamectl --static) != "$KW_HOSTNAME" ]]; then
  if hostnamectl set-hostname "$KW_HOSTNAME"; then
    CHANGED+=("hostname: $KW_HOSTNAME")
    echo "  hostname: $KW_HOSTNAME"
  else
    warn "could not set the hostname to $KW_HOSTNAME"
  fi
fi
if [[ -n $KW_HOSTNAME ]] && ! grep -qE "^127\.0\.1\.1[[:space:]]+$KW_HOSTNAME\$" /etc/hosts; then
  if grep -q '^127\.0\.1\.1' /etc/hosts; then
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1 $KW_HOSTNAME/" /etc/hosts
  else
    echo "127.0.1.1 $KW_HOSTNAME" >> /etc/hosts
  fi
fi

put "$F/journald-size.conf" /etc/systemd/journald.conf.d/keepwatch-size.conf
changed /etc/systemd/journald.conf.d/ && systemctl restart systemd-journald

# Login banner: Keepwatch's instead of Ubuntu's help texts, ads and news.
for f in 10-help-text 50-landscape-sysinfo 50-motd-news 85-fwupd 91-contract-ua-esm-status 95-hwe-eol 97-overlayroot; do
  if [[ -x /etc/update-motd.d/$f ]]; then chmod -x "/etc/update-motd.d/$f"; fi
done
put "$F/motd-01-keepwatch" /etc/update-motd.d/01-keepwatch 755

# needrestart never restarts systemd-logind. If it still runs the binary
# from before an update, restart it now (sessions survive this).
if [[ $(readlink "/proc/$(pidof -s systemd-logind)/exe" 2>/dev/null) == *"(deleted)" ]]; then
  systemctl restart systemd-logind && echo "  systemd-logind restarted (was running a replaced binary)"
fi
echo "  ok"
