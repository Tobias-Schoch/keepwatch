# Stop the Lynis audits and remove Keepwatch's profile, exceptions and result.
# The lynis package stays installed (its own daily timer stays masked).
unit_off keepwatch-lynis.timer keepwatch-lynis.service
rm -f /usr/local/sbin/keepwatch-lynis /etc/lynis/custom.prf "$KW_ETC/lynis-exceptions.conf" "$KW_STATE/lynis.json"
echo "  removed (package lynis kept; apt purge lynis to remove it too)"
