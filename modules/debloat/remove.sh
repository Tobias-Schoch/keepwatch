# Unmask what debloat masked, so Ubuntu's defaults apply again.
# Purged packages (apport, sysstat, fwupd, compilers) are not reinstalled.
systemctl unmask -q ModemManager.service udisks2.service packagekit.service \
  apport.service apport-autoreport.path apport-autoreport.timer apport-forward.socket \
  ua-timer.timer ubuntu-advantage.service ua-reboot-cmds.service motd-news.timer \
  update-notifier-download.timer update-notifier-motd.timer fwupd-refresh.timer \
  lxd-installer.socket pollinate.service sysstat.service sysstat-collect.timer sysstat-summary.timer 2>/dev/null || true
systemctl daemon-reload
if [[ -f /etc/default/motd-news ]]; then sed -i 's/^ENABLED=0/ENABLED=1/' /etc/default/motd-news; fi
echo "  unmasked Ubuntu's services; purged packages were not reinstalled (apt install them if you need them)"
