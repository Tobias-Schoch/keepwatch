# Back to Ubuntu's defaults: unattended-upgrades stays installed and keeps
# installing security updates at Ubuntu's random daily time, without reboots.
rm -f /etc/systemd/system/apt-daily.timer.d/override.conf /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf
rmdir /etc/systemd/system/apt-daily.timer.d /etc/systemd/system/apt-daily-upgrade.timer.d 2>/dev/null || true
rm -f /etc/apt/apt.conf.d/52-auto-reboot
systemctl daemon-reload
systemctl restart apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
echo "  removed the fixed schedule and the automatic reboot; Ubuntu's own security updates stay on"
echo "  (to stop them as well: set APT::Periodic::Unattended-Upgrade \"0\" in /etc/apt/apt.conf.d/20auto-upgrades)"
