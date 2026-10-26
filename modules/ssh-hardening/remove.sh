# Remove the drop-in: Ubuntu's (and your provider's) SSH defaults apply again.
if [[ -f /etc/ssh/sshd_config.d/00-keepwatch.conf ]]; then
  rm -f /etc/ssh/sshd_config.d/00-keepwatch.conf
  install -d -m 755 /run/sshd
  if sshd -t; then systemctl try-reload-or-restart ssh; else warn "sshd -t fails without the Keepwatch drop-in - check /etc/ssh"; fi
  echo "  removed /etc/ssh/sshd_config.d/00-keepwatch.conf"
fi
echo "  SSH back to the system defaults"
