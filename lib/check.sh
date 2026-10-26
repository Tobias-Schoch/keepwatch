# shellcheck shell=bash
# Sourced by ./keepwatch check. Two views, because each one lies on its own:
#   from the server   what is configured and running
#   from here         what the internet actually reaches. On the server itself
#                     everything answers, including ports the firewall drops.

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "On the server"
STATE=$(remote "$SUDO sh -s" <<'EOF'
. /etc/keepwatch/keepwatch.conf 2>/dev/null
SSH_PUBLIC=${KW_SSH_PUBLIC:-yes}
[ -f /etc/keepwatch/firewall.env ] && . /etc/keepwatch/firewall.env
echo "::ssh_public $SSH_PUBLIC"
SRC=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')
# Behind cloud NAT (AWS, GCP, ...) the interface only has a private address: ask once from outside.
case $SRC in (10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|"") SRC=$(curl -s -4 -m 5 https://api.ipify.org || true) ;; esac
echo "::public_ip $SRC"

printf '  listening on all addresses: '
ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[?fe80)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' '
echo
for u in keepwatch-firewall fail2ban docker tailscaled keepwatch-dashboard keepwatch-backup.timer keepwatch-log-archive; do
  systemctl cat "$u" >/dev/null 2>&1 || continue
  printf '  %-26s %s\n' "$u" "$(systemctl is-active "$u")"
done
if command -v fail2ban-client >/dev/null; then
  printf '  %-26s %s\n' "banned right now" "$(fail2ban-client banned 2>/dev/null | grep -oE '[0-9a-f.:]{7,}' | sort -u | wc -l | tr -d ' ') IPs"
fi
if command -v docker >/dev/null; then
  printf '  %-26s %s running, %s unhealthy\n' "containers" "$(docker ps -q | wc -l | tr -d ' ')" "$(docker ps -q -f health=unhealthy | wc -l | tr -d ' ')"
fi
Z=$(ps -eo stat | grep -c '^Z' || true)
[ "$Z" -gt 50 ] && printf '  %-26s %s (a container without a real init collects them)\n' "zombie processes" "$Z"
printf '  %-26s %s pending\n' "updates" "$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst')"
[ -f /var/run/reboot-required ] && printf '  %-26s %s\n' "reboot" "REQUIRED"
printf '  %-26s %s\n' "disk /" "$(df -h / | awk 'NR==2 {print $5 " used, " $4 " free"}')"
EOF
) || { echo "  could not reach $TARGET" >&2; exit 1; }
grep -v '^::' <<<"$STATE"
SSH_PUBLIC=$(sed -n 's/^::ssh_public //p' <<<"$STATE")
IP=$(sed -n 's/^::public_ip //p' <<<"$STATE")
# An IP in keepwatch.conf is the most reliable answer - unless it's a Tailscale address.
[[ $KW_HOST =~ ^[0-9.]+$ && ! $KW_HOST =~ ^100\. ]] && IP=$KW_HOST

step "From here, to $IP"
if [[ -z $IP ]]; then
  echo "  could not tell the server's public IP"
  exit 1
fi
# Common ports that tend to end up public by accident, plus whatever is configured.
PORTS="21 22 25 80 443 2375 2376 3000 3001 3002 3003 3306 5432 5678 6379 8000 8080 8443 9000 9001 9002 9003 9004 9090 9443 11211 27017 $KW_SSH_PORT $KW_PUBLIC_TCP $KW_DASHBOARD_PORT $KW_PROXY_ADMIN_PORT $KW_PORTAINER_PORT"
EXPECT=" $KW_PUBLIC_TCP "
[[ $SSH_PUBLIC == no ]] || EXPECT+=" $KW_SSH_PORT "
bad=0 missing=0
for p in $(tr ' ' '\n' <<<"$PORTS" | grep -E '^[0-9]+$' | sort -un); do
  # Never knock on a closed SSH port: fail2ban bans whoever tries (that would be you).
  if [[ $p == "$KW_SSH_PORT" && $SSH_PUBLIC == no ]]; then
    printf '  %-6s %s\n' "$p" "skipped (closed on purpose; knocking would get you banned)"
    continue
  fi
  if nc -z -w 3 "$IP" "$p" >/dev/null 2>&1; then
    if [[ $EXPECT == *" $p "* ]]; then printf '  %-6s \033[32mopen\033[0m (expected)\n' "$p"
    else printf '  %-6s \033[31mOPEN\033[0m - not in KW_PUBLIC_TCP\n' "$p"; bad=1; fi
  elif [[ $EXPECT == *" $p "* ]]; then
    printf '  %-6s \033[33mclosed\033[0m (expected open)\n' "$p"; missing=1
  fi
done
echo
if (( bad )); then echo "  Something is reachable that should not be. Run ./keepwatch deploy, or add the port to KW_PUBLIC_TCP if it is intended."
elif (( missing )); then echo "  Nothing unexpected is open, but an expected port does not answer (service down, or a firewall in front of the server)."
else echo "  Only the expected ports answer. (All other ports above: closed.)"; fi
