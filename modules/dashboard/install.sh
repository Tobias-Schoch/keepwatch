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
# --- Keepwatch updates from the dashboard (lib/kwupdate.py) --------------------------
# The updater runs from /usr/local/sbin, not from the copy it replaces, and as its own unit:
# apply.sh restarts the dashboard halfway through an update.
put "$KW_ROOT/lib/kwupdate.py" /usr/local/sbin/keepwatch-self-update 755
# Add-ons switched on and off in the dashboard (lib/kwmodules.py): the same pattern, its own
# unit runs apply.sh so the switch survives the dashboard restarting.
put "$KW_ROOT/lib/kwmodules.py" /usr/local/sbin/keepwatch-modules 755
for u in keepwatch-self-update@.service keepwatch-self-update-check.service keepwatch-self-update-check.timer \
         keepwatch-modules-apply.service; do
  put "$F/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
# Automatic check every 6 h: KW_SELF_UPDATE_CHECK is an initial value. The dashboard switches the
# timer itself (Settings -> Keepwatch updates); a deploy only applies KW_SELF_UPDATE_CHECK again
# when it changed since the last deploy. No repository = no checks at all.
if [[ -z $KW_SELF_UPDATE_REPO ]]; then WANT=off; elif [[ $KW_SELF_UPDATE_CHECK == no ]]; then WANT=no; else WANT=yes; fi
SEEN=$(cat "$KW_STATE/self-update-check" 2>/dev/null || true)
if [[ $WANT != "$SEEN" ]]; then
  if [[ $WANT == yes ]]; then
    systemctl enable -q --now keepwatch-self-update-check.timer
  else
    systemctl disable -q --now keepwatch-self-update-check.timer 2>/dev/null || true
  fi
  echo "$WANT" > "$KW_STATE/self-update-check"
  CHANGED+=("self-update check: $WANT")
fi
# What runs changed with this deploy - look again (in the background, one request to GitHub).
if systemctl is-enabled -q keepwatch-self-update-check.timer 2>/dev/null; then
  systemctl start --no-block keepwatch-self-update-check.service
fi

echo "  on 127.0.0.1:$KW_DASHBOARD_PORT - on your computer: ./keepwatch tunnel"
