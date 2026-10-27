# Tailscale: private access to the server. Lets the firewall close SSH to
# the internet; the SSH fallback reopens it by itself if Tailscale breaks.
if ! command -v tailscale >/dev/null; then
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  APT_FRESH=0
fi
need tailscale
systemctl enable -q --now tailscaled

ts_up() { tailscale status >/dev/null 2>&1; }
# Log in once. A restored server gets its identity back from the backup
# (/var/lib/tailscale) and is in the tailnet again under the same name.
if ! ts_up && [[ -t 0 ]]; then
  ask ANSWER "Tailscale is not logged in. Log in now (opens a link to confirm)? [Y/n]"
  if [[ ${ANSWER:-y} == [Yy]* ]]; then
    tailscale up --hostname="${KW_HOSTNAME:-$(hostname)}" --timeout=5m || warn "tailscale up did not finish - run it on the server later"
  fi
fi
if ts_up; then
  echo "  connected: $(tailscale ip -4 2>/dev/null) ($(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//'))"
  # Tailscale updates itself: the way in should not get stale.
  tailscale set --auto-update >/dev/null 2>&1 || true
  echo "  tip: disable key expiry for this machine in the Tailscale admin console - otherwise it drops out of the tailnet after 180 days"
else
  echo "  not logged in - run 'tailscale up' on the server (or use the dashboard)"
fi

# Never publish an admin UI into the tailnet with `tailscale serve`: the
# dashboard, the proxy admin and Portainer have no login of their own worth
# the name, and every device in the tailnet (a NAS, a shared machine) would
# reach them without an SSH key. They go through the SSH tunnel only
# (Tailscale AND SSH key). The serve config lives in /var/lib/tailscale and
# would even come back with a restore, so it is checked on every run.
UI_PORTS="$KW_DASHBOARD_PORT $KW_PROXY_ADMIN_PORT $KW_PORTAINER_PORT"
for ui in $KW_EXTRA_UIS; do p=${ui##*=}; UI_PORTS+=" ${p%%/*}"; done
serve_has() {  # serve_has <port>...: does tailscale serve publish one of these ports?
  tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
try:
    tcp = json.load(sys.stdin).get("TCP") or {}
except ValueError:
    tcp = {}
sys.exit(0 if any(p in tcp for p in sys.argv[1:]) else 1)' "$@" 2>/dev/null
}
if ts_up; then
  for p in $UI_PORTS; do
    if serve_has "$p"; then
      tailscale serve --https="$p" off >/dev/null 2>&1 || tailscale serve --http="$p" off >/dev/null 2>&1 || true
      echo "  tailscale serve: port $p no longer published in the tailnet"
    fi
  done
  # Older Tailscale without "off": reset everything - but only if nothing
  # else is published (that would be yours).
  # shellcheck disable=SC2086 # one port per word
  if serve_has $UI_PORTS && ! tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
tcp = json.load(sys.stdin).get("TCP") or {}
sys.exit(0 if set(tcp) - set(sys.argv[1:]) else 1)' $UI_PORTS 2>/dev/null; then
    tailscale serve reset >/dev/null 2>&1 || true
    echo "  tailscale serve: reset"
  fi
  # shellcheck disable=SC2086
  if serve_has $UI_PORTS; then
    warn "tailscale serve still publishes an admin UI - check: tailscale serve status"
  fi
fi

# SSH fallback: reopens the SSH port when Tailscale is down for ~15 minutes.
put "$F/keepwatch-ssh-fallback" /usr/local/sbin/keepwatch-ssh-fallback 755
put "$F/keepwatch-ssh-fallback.service" /etc/systemd/system/keepwatch-ssh-fallback.service
put "$F/keepwatch-ssh-fallback.timer" /etc/systemd/system/keepwatch-ssh-fallback.timer
unit_on keepwatch-ssh-fallback.timer
unset -f ts_up serve_has
echo "  ok"
