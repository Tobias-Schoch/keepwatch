# Stop the dashboard. Kept: its settings and secrets (/etc/keepwatch/dashboard:
# tokens, passkeys) and its history (/var/lib/keepwatch/dashboard).
unit_off keepwatch-dashboard.service keepwatch-self-update-check.timer keepwatch-self-update-check.service \
  keepwatch-self-update@.service
rm -f /usr/local/sbin/keepwatch-passkey /usr/local/sbin/keepwatch-self-update "$KW_STATE/dashboard.sum" \
  "$KW_STATE/self-update-check" "$KW_STATE/update.json" "$KW_STATE/update.json.lock" "$KW_STATE/self-update.log"
echo "  stopped; kept $KW_ETC/dashboard and $KW_STATE/dashboard"
