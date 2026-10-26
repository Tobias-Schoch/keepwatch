# Allow-list firewall that also covers ports Docker publishes (Docker bypasses ufw).
need iptables
ENV=$KW_ETC/firewall.env
ts_running() {
  command -v tailscale >/dev/null && [[ $(tailscale status --json 2>/dev/null | jq -r '.BackendState // empty' 2>/dev/null) == Running ]]
}
env_write() {  # env_write yes|no [marker line]
  { echo "SSH_PUBLIC=$1"
    [[ $1 == no ]] && echo "SSH_PUBLIC_SINCE=$(date +%s)"
    [[ -n ${2:-} ]] && echo "$2"
    true; } | write "$ENV"
}

# firewall.env is the runtime switch: the dashboard (Settings -> Remote
# access) and the SSH fallback write it, so it is only seeded from
# KW_SSH_PUBLIC. Closing SSH needs a working Tailscale - otherwise SSH stays
# open and the close waits ("pending") until a deploy finds Tailscale up.
CLOSE=0
if [[ $KW_SSH_PUBLIC == no ]]; then
  if enabled tailscale; then CLOSE=1; else warn "KW_SSH_PUBLIC=no needs the tailscale module - SSH stays open to the internet"; fi
fi
PENDING="# KEEPWATCH_PENDING_CLOSE=1 (KW_SSH_PUBLIC=no, waiting for Tailscale to be connected)"
if [[ ! -f $ENV ]] || grep -q '^# KEEPWATCH_PENDING_CLOSE' "$ENV"; then
  if (( CLOSE )) && ts_running; then
    env_write no
    echo "  SSH closed to the internet - from now on only over Tailscale"
    via_tailscale || warn "this deploy came in over the public address - use the Tailscale name as KW_HOST for the next one"
  elif (( CLOSE )); then
    env_write yes "$PENDING"
    warn "SSH stays open to the internet until Tailscale is connected - log in (tailscale up), then deploy again"
  else
    env_write yes
  fi
elif grep -q '^SSH_PUBLIC=no' "$ENV" && ! enabled tailscale; then
  env_write yes
  warn "SSH reopened to the internet: it was closed, but the tailscale module is off"
fi

put "$F/keepwatch-firewall" /usr/local/sbin/keepwatch-firewall 755
if enabled docker; then
  put "$F/keepwatch-firewall.service" /etc/systemd/system/keepwatch-firewall.service
else
  grep -vE '^(After=docker|Requires=docker|PartOf=docker|WantedBy=docker|# When Docker|# docker:|# The lines below)' "$F/keepwatch-firewall.service" \
    | write /etc/systemd/system/keepwatch-firewall.service
fi
systemctl daemon-reload
systemctl enable -q keepwatch-firewall
# The script reads keepwatch.conf (KW_PUBLIC_TCP) and firewall.env at runtime.
# Restarting is gapless (new rules first, then the old ones out).
if changed /usr/local/sbin/keepwatch-firewall || changed /etc/systemd/system/keepwatch-firewall \
   || changed "$ENV" || changed "$KW_ETC/keepwatch.conf" || ! systemctl is-active -q keepwatch-firewall; then
  if ! systemctl restart keepwatch-firewall; then
    warn "keepwatch-firewall failed: $(journalctl -u keepwatch-firewall -n 3 --no-pager -o cat 2>/dev/null | tail -1 || true)"
  fi
fi
journalctl -u keepwatch-firewall -n 20 -o cat --no-pager 2>/dev/null | grep "firewall set" | tail -1 | sed 's/^/  /' || true
unset -f ts_running env_write
echo "  ok"
