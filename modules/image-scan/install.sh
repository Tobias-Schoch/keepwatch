# Weekly Trivy scan of all running container images; results in the dashboard.
put "$F/keepwatch-image-scan" /usr/local/sbin/keepwatch-image-scan 755
put "$F/keepwatch-image-scan.service" /etc/systemd/system/keepwatch-image-scan.service
sed "s|^OnCalendar=.*|OnCalendar=$(calendar "$KW_IMAGE_SCAN_TIME")|" "$F/keepwatch-image-scan.timer" \
  | write /etc/systemd/system/keepwatch-image-scan.timer
unit_on keepwatch-image-scan.timer
changed /etc/systemd/system/keepwatch-image-scan.timer && systemctl restart keepwatch-image-scan.timer
echo "  weekly: $KW_IMAGE_SCAN_TIME ($KW_LOCAL_TZ); result $KW_STATE/image-scan.json"
