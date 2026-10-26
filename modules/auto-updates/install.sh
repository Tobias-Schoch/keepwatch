# Automatic security updates (unattended-upgrades) at a fixed time, and an
# optional reboot right after them when an update needs one.
need unattended-upgrades

write /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
// Installed by Keepwatch (auto-updates module).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# Package lists 30 minutes before the updates, updates at KW_UPDATE_TIME,
# both in KW_LOCAL_TZ. Ubuntu's default is a random time - fine for a
# laptop, but on a server you want to know when it may reboot.
# seed, not put: the dashboard changes time and reboot later (Settings),
# a deploy never reverts that.
UPD=$KW_UPDATE_TIME
[[ $UPD =~ ^[0-9]{1,2}:[0-9]{2}$ ]] || { warn "KW_UPDATE_TIME=$UPD is not HH:MM - using 04:00"; UPD=04:00; }
LISTS=$(date -d "$UPD 30 minutes ago" +%H:%M)
seed_text /etc/systemd/system/apt-daily.timer.d/override.conf <<CONF
# Keepwatch: package lists 30 minutes before the security updates.
[Timer]
OnCalendar=
OnCalendar=$(calendar "$LISTS")
RandomizedDelaySec=0
Persistent=true
CONF
seed_text /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf <<CONF
# Keepwatch: security updates at a fixed time; a reboot follows right after
# when an update needs one (52-auto-reboot). Changed by the dashboard.
[Timer]
OnCalendar=
OnCalendar=$(calendar "$UPD")
RandomizedDelaySec=0
Persistent=true
CONF

# Kernel and libc security updates only take effect after a reboot.
# Reboot only when an update asks for it, right after the updates.
# "now", not a time: a fixed time would mean "tomorrow at that time" for
# shutdown when the updates finish after it.
if [[ $KW_AUTO_REBOOT == yes ]]; then REBOOT=true; else REBOOT=false; fi
seed_text /etc/apt/apt.conf.d/52-auto-reboot <<CONF
// Keepwatch: reboot right after the automatic updates if one of them needs it.
// Changed by the dashboard (Settings -> Updates).
Unattended-Upgrade::Automatic-Reboot "$REBOOT";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "now";
CONF

if changed /etc/systemd/system/apt-daily; then
  systemctl daemon-reload
  systemctl restart apt-daily.timer apt-daily-upgrade.timer
fi
systemctl enable -q --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service 2>/dev/null || true
echo "  updates daily at $UPD ($KW_LOCAL_TZ), reboot when needed: $KW_AUTO_REBOOT"
