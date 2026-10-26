# Stop the dashboard. Kept: its settings and secrets (/etc/keepwatch/dashboard:
# tokens, passkeys) and its history (/var/lib/keepwatch/dashboard).
unit_off keepwatch-dashboard.service
rm -f /usr/local/sbin/keepwatch-passkey "$KW_STATE/dashboard.sum"
echo "  stopped; kept $KW_ETC/dashboard and $KW_STATE/dashboard"
