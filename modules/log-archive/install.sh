# Container log archive: reads the json logs of all containers as they are
# written and keeps them for 14 days (/var/log/keepwatch/containers) - even
# when Docker recreates a container and deletes its logs. No change to Docker
# itself (daemon.json stays, no restart). Retention and limits: dashboard ->
# Settings -> Log archive (seeded once, never reverted).
put "$F/keepwatch-log-archive" /usr/local/sbin/keepwatch-log-archive 755
put "$F/keepwatch-log-archive.service" /etc/systemd/system/keepwatch-log-archive.service
seed "$F/log-archive.conf" "$KW_ETC/log-archive.conf"
install -d -m 755 /var/log/keepwatch
install -d -m 750 /var/log/keepwatch/containers
install -d -m 700 "$KW_STATE/log-archive"
systemctl daemon-reload
systemctl enable -q keepwatch-log-archive
# Restart only on change: it continues exactly where it stopped, nothing twice.
if changed /usr/local/sbin/keepwatch-log-archive || changed /etc/systemd/system/keepwatch-log-archive \
   || ! systemctl is-active -q keepwatch-log-archive; then
  systemctl restart keepwatch-log-archive
fi
echo "  ok"
