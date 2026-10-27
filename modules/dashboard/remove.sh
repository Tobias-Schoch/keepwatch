# Stop the dashboard. Kept: its settings and secrets (/etc/keepwatch/dashboard:
# tokens, passkeys) and its history (/var/lib/keepwatch/dashboard). Kept too: the add-ons
# switched in the dashboard (/etc/keepwatch/modules-override.json) - deploys still honor them.
unit_off keepwatch-dashboard.service keepwatch-self-update-check.timer keepwatch-self-update-check.service \
  keepwatch-self-update@.service keepwatch-modules-apply.service
rm -f /usr/local/sbin/keepwatch-passkey /usr/local/sbin/keepwatch-self-update /usr/local/sbin/keepwatch-modules \
  "$KW_STATE/dashboard.sum" "$KW_STATE/self-update-check" "$KW_STATE/update.json" "$KW_STATE/update.json.lock" \
  "$KW_STATE/self-update.log" "$KW_STATE/modules-apply.json" "$KW_STATE/modules-apply.log" "$KW_STATE/modules-apply.lock"
echo "  stopped; kept $KW_ETC/dashboard and $KW_STATE/dashboard"
