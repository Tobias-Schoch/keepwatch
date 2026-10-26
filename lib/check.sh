# shellcheck shell=bash
# Sourced by ./keepwatch check. Two views, because each one lies on its own:
#   from the server   what is configured and running
#   from here         what the internet actually reaches. On the server itself
#                     everything answers, including ports the firewall drops.

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "On the server"
# SSH_CONNECTION before sudo (sudo drops it): the address this check came in through.
# No apostrophes or unbalanced parentheses in the script below: bash 3.2 misparses
# them in a here-document inside $( ).
STATE=$(remote "echo \"::conn \$SSH_CONNECTION\"; $SUDO sh -s" <<'EOF'
. /etc/keepwatch/keepwatch.conf 2>/dev/null
SSH_PUBLIC=${KW_SSH_PUBLIC:-yes}
[ -f /etc/keepwatch/firewall.env ] && . /etc/keepwatch/firewall.env
echo "::ssh_public $SSH_PUBLIC"
# The ports sshd really listens on (the firewall uses the same).
P=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}')
[ -n "$P" ] || P=$(cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk 'tolower($1) == "port" {print $2}')
echo "::ssh_ports" $P
SRC=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')
# Behind cloud NAT (AWS, GCP, ...) the interface only has a private address: ask once from outside.
case $SRC in (10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|"") SRC=$(curl -s -4 -m 5 https://api.ipify.org || true) ;; esac
# IPv6 only.
[ -n "$SRC" ] || SRC=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')
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
grep -v '^::' <<<"$STATE" || true
SSH_PUBLIC=$(sed -n 's/^::ssh_public //p' <<<"$STATE")
SSH_PORTS=$(sed -n 's/^::ssh_ports *//p' <<<"$STATE")
[[ -n $SSH_PORTS ]] || SSH_PORTS="22 $KW_SSH_PORT"
IP=$(sed -n 's/^::public_ip //p' <<<"$STATE")
# "client port server-address server-port" of this check's own SSH connection.
CONN=$(sed -n 's/^::conn //p' <<<"$STATE")
CONN_ADDR=$(awk '{print $3}' <<<"$CONN") CONN_PORT=$(awk '{print $4}' <<<"$CONN")
# An IP in keepwatch.conf is the most reliable answer - unless it is a Tailscale address.
if [[ $HOST =~ ^[0-9.]+$ && ! $HOST =~ ^100\. ]] || [[ $HOST == *:* && $HOST != fd7a:115c:a1e0:* ]]; then IP=$HOST; fi

step "From here, to $IP"
if [[ -z $IP ]]; then
  echo "  could not tell the server's public IP"
  exit 1
fi
# Common ports that tend to end up public by accident, plus whatever is configured.
PORTS="21 22 25 80 443 2375 2376 3000 3001 3002 3003 3306 5432 5678 6379 8000 8080 8443 9000 9001 9002 9003 9004 9090 9443 11211 27017 $KW_SSH_PORT $SSH_PORTS $KW_PUBLIC_TCP $KW_DASHBOARD_PORT $KW_PROXY_ADMIN_PORT $KW_PORTAINER_PORT"
PORTS=$(tr ' ' '\n' <<<"$PORTS" | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ')
EXPECT=" $KW_PUBLIC_TCP "
[[ $SSH_PUBLIC == no ]] || EXPECT+=" $SSH_PORTS "
# Never knock on SSH: fail2ban (aggressive mode) counts a connection that does not log in
# as an attack and bans whoever made it - that would be you, for a week.
PROBE=""
for p in $PORTS; do [[ " $SSH_PORTS " == *" $p "* ]] || PROBE+=" $p"; done
# All at once, 3 s each: the firewall drops closed ports silently, one by one would take minutes.
# (read -d "", not $(cat <<...): bash 3.2 misparses here-documents inside $( ).)
read -r -d '' PROBE_PY <<'PY' || true
import socket, sys
from concurrent.futures import ThreadPoolExecutor

ip, ports = sys.argv[1], [int(p) for p in sys.argv[2:]]


def is_open(port):
    try:
        socket.create_connection((ip, port), timeout=3).close()
        return True
    except OSError:
        return False


with ThreadPoolExecutor(max_workers=32) as ex:
    for port, ok in zip(ports, ex.map(is_open, ports)):
        if ok:
            print(port)
PY
# shellcheck disable=SC2086 # one port per word
OPEN=" $(python3 -c "$PROBE_PY" "$IP" $PROBE | tr '\n' ' ') "
bad=0 missing=0
for p in $PORTS; do
  if [[ " $SSH_PORTS " == *" $p "* ]]; then
    if [[ $SSH_PUBLIC == no ]]; then
      printf '  %-6s %s\n' "$p" "SSH, closed to the internet on purpose (not probed)"
    elif [[ $p == "$CONN_PORT" && -n $CONN_ADDR && ! $CONN_ADDR =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. && $CONN_ADDR != fd7a:115c:a1e0:* ]]; then
      printf '  %-6s \033[32mopen\033[0m (expected; this check logged in through it)\n' "$p"
    else
      printf '  %-6s %s\n' "$p" "SSH, not probed (a connection without login gets you banned)"
    fi
    continue
  fi
  if [[ $OPEN == *" $p "* ]]; then
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
