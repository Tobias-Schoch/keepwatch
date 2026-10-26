# Ban history: past SSH attackers stay banned on all ports for
# KW_BANHISTORY_DAYS after their last attempt - also after a reboot and on a
# restored server (the list is in the backup).
put "$F/keepwatch-ban-history" /usr/local/sbin/keepwatch-ban-history 755
put "$F/keepwatch-ban-history.service" /etc/systemd/system/keepwatch-ban-history.service
put "$F/keepwatch-ban-history-refresh.service" /etc/systemd/system/keepwatch-ban-history-refresh.service
sed "s|^OnCalendar=.*|OnCalendar=$(calendar "05:15")|" "$F/keepwatch-ban-history.timer" \
  | write /etc/systemd/system/keepwatch-ban-history.timer
systemctl daemon-reload
systemctl enable -q keepwatch-ban-history.service
systemctl enable -q --now keepwatch-ban-history.timer
changed /etc/systemd/system/keepwatch-ban-history.timer && systemctl restart keepwatch-ban-history.timer
# Rebuild now: picks up KW_TRUSTED_IPS / KW_BANHISTORY_* changes right away.
if OUT=$(/usr/local/sbin/keepwatch-ban-history refresh 2>&1); then
  echo "  $(tail -1 <<<"$OUT")"
else
  warn "keepwatch-ban-history refresh failed: $(tail -1 <<<"$OUT")"
fi
