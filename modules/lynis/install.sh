# Weekly Lynis hardening audit (read-only); score and findings in the dashboard.
# Ubuntu's package enables a daily lynis.timer and starts a run right on
# install - mask both before installing. Without recommends (menu).
if ! dpkg-query -W -f='${Status}' lynis 2>/dev/null | grep -q "ok installed"; then
  systemctl mask -q lynis.timer lynis.service 2>/dev/null || true
fi
need --no-install-recommends lynis
put "$F/custom.prf" /etc/lynis/custom.prf
# Deliberate exceptions, one reason per test ID. Applied by the dashboard,
# not by Lynis: the report stays complete and the index comparable.
put "$F/exceptions.conf" "$KW_ETC/lynis-exceptions.conf"
put "$F/keepwatch-lynis" /usr/local/sbin/keepwatch-lynis 755
put "$F/keepwatch-lynis.service" /etc/systemd/system/keepwatch-lynis.service
sed "s|^OnCalendar=.*|OnCalendar=$(calendar "$KW_LYNIS_TIME")|" "$F/keepwatch-lynis.timer" \
  | write /etc/systemd/system/keepwatch-lynis.timer
unit_on keepwatch-lynis.timer
changed /etc/systemd/system/keepwatch-lynis.timer && systemctl restart keepwatch-lynis.timer
echo "  weekly: $KW_LYNIS_TIME ($KW_LOCAL_TZ); result $KW_STATE/lynis.json"
