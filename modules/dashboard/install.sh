# The Keepwatch dashboard on 127.0.0.1:$KW_DASHBOARD_PORT. Runs straight from
# the repository copy ($KW_ROOT/dashboard/server, UI from dashboard/web/dist,
# built by deploy on your computer). Works with any set of modules: what is
# not installed, it does not show.
need python3-cryptography python3-maxminddb
SRV=$KW_ROOT/dashboard/server
[[ -f $SRV/dashboard.py ]] || { warn "dashboard: $SRV/dashboard.py missing - skipped"; return 0; }
[[ -d $KW_ROOT/dashboard/web/dist ]] || warn "dashboard: $KW_ROOT/dashboard/web/dist missing - deploy builds it on your computer (npm)"
install -d -m 700 "$KW_ETC/dashboard" "$KW_STATE/dashboard"

sed -e "s|@KW_ROOT@|$KW_ROOT|g" -e "s|@PORT@|$KW_DASHBOARD_PORT|g" "$F/keepwatch-dashboard.service" \
  | write /etc/systemd/system/keepwatch-dashboard.service
# Emergency exit when every passkey device is gone: keepwatch-passkey reset.
sed "s|@KW_ROOT@|$KW_ROOT|g" "$F/keepwatch-passkey" | write /usr/local/sbin/keepwatch-passkey 755

# The code is synced by deploy, not installed with put - so a fingerprint
# of server code and UI decides whether to restart.
SUM=$(cd "$KW_ROOT/dashboard" && find server web/dist -type f ! -path '*/__pycache__/*' -print0 2>/dev/null \
      | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 || true)
OLD=$(cat "$KW_STATE/dashboard.sum" 2>/dev/null || true)
systemctl daemon-reload
systemctl enable -q keepwatch-dashboard
if [[ $SUM != "$OLD" ]] || changed /etc/systemd/system/keepwatch-dashboard || ! systemctl is-active -q keepwatch-dashboard; then
  systemctl restart keepwatch-dashboard
  [[ $SUM == "$OLD" ]] || CHANGED+=("dashboard code")
  echo "$SUM" > "$KW_STATE/dashboard.sum"
fi
echo "  on 127.0.0.1:$KW_DASHBOARD_PORT - on your computer: ./keepwatch tunnel"
