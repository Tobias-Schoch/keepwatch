# Lift the ban history and remove its units. The list
# (/var/lib/keepwatch/ban-history.json) is kept.
unit_off keepwatch-ban-history.timer keepwatch-ban-history-refresh.service keepwatch-ban-history.service
nft delete table inet keepwatch_ban_history 2>/dev/null || true
rm -f /usr/local/sbin/keepwatch-ban-history
echo "  ban history lifted; the list stays in /var/lib/keepwatch/ban-history.json"
