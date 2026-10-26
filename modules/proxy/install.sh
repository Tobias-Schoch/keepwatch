# Reverse proxy: Nginx Proxy Manager on 80/443 with Let's Encrypt; its admin
# UI only on 127.0.0.1 (through the tunnel).
#
# Rule for ports: whatever the proxy serves is NOT published on the host.
# Your containers join $KW_PROXY_NETWORK and the proxy host's target is the
# CONTAINER NAME and the port INSIDE the container. Binding to the Docker
# bridge address (172.17.0.1) as a middle way does not work: Docker isolates
# its bridge networks from each other.
P=$KW_SRV/proxy
FRESH_PROXY=0
[[ -e $P/data/database.sqlite ]] || FRESH_PROXY=1
install -d -m 755 "$KW_SRV" "$P"
install -d -m 700 "$P/data" "$P/letsencrypt"
put "$F/docker-compose.yml" "$P/docker-compose.yml"
write "$P/.env" 600 <<CONF
# Written by Keepwatch from keepwatch.conf - edit that instead.
KW_PROXY_ADMIN_PORT=$KW_PROXY_ADMIN_PORT
KW_PROXY_NETWORK=$KW_PROXY_NETWORK
CONF
for net in "$KW_PROXY_NETWORK" proxy-portainer; do
  docker network inspect "$net" >/dev/null 2>&1 || { docker network create "$net" >/dev/null; echo "  network created: $net"; }
done

# --- Custom nginx rules (rate limit for all sites, Portainer webhooks) ----------
# Nginx Proxy Manager includes data/nginx/custom/http_top.conf at the top of
# the http block and server_proxy.conf in EVERY proxy host.
CUSTOM=$P/data/nginx/custom
SAVE=/var/backups/keepwatch/proxy-custom
install -d -m 755 "$P/data/nginx" "$CUSTOM"
install -d -m 700 /var/backups/keepwatch "$SAVE"
# Remember the previous version: if nginx -t fails with the new one, it comes
# back (otherwise the proxy would not start on its next restart - every site gone).
for f in http_top.conf server_proxy.conf; do
  if [[ -f $CUSTOM/$f ]]; then cp -a "$CUSTOM/$f" "$SAVE/$f"; else rm -f "$SAVE/$f"; fi
done

RATE=${KW_PROXY_RATE:-0} BURST=${KW_PROXY_BURST:-100}
[[ $RATE =~ ^[0-9]+$ && $BURST =~ ^[0-9]+$ ]] || { warn "KW_PROXY_RATE/KW_PROXY_BURST must be numbers - rate limit off"; RATE=0; }
{
  echo "# Written by Keepwatch (proxy module) from KW_PROXY_RATE / KW_PROXY_BURST - edit keepwatch.conf instead."
  if (( RATE > 0 )); then
    cat <<CONF
#
# Rate limit for all sites: at most $RATE requests per second per IP; short
# bursts up to $BURST (a page with many images and scripts over HTTP/2) pass
# without delay. Above that: 429. Apps may add stricter limits of their own
# (logins, admin areas).
#
# Not counted (empty key): Docker-internal traffic (health checks, the
# dashboard's checks), localhost, the tailnet and KW_TRUSTED_IPS.
geo \$keepwatch_limit_off {
    default         0;
    127.0.0.0/8     1;
    10.0.0.0/8      1;
    172.16.0.0/12   1;
    100.64.0.0/10   1;
CONF
    for ip in $KW_TRUSTED_IPS; do printf '    %-15s 1;\n' "$ip"; done
    cat <<CONF
}
map \$keepwatch_limit_off \$keepwatch_limit_key {
    1 "";
    0 \$binary_remote_addr;
}
limit_req_zone \$keepwatch_limit_key zone=keepwatch_all_sites:10m rate=${RATE}r/s;
limit_req_status 429;
CONF
  else
    echo "# Rate limit off (KW_PROXY_RATE=0)."
  fi
} | write "$CUSTOM/http_top.conf"

{
  echo "# Written by Keepwatch (proxy module) - edit keepwatch.conf instead."
  echo "# Included in EVERY proxy host; a webhook rule below only answers on its own domain."
  if (( RATE > 0 )); then
    echo "# Rate limit for all sites (zone in http_top.conf), for every location without its own limit_req."
    echo "limit_req zone=keepwatch_all_sites burst=$BURST nodelay;"
  fi
  # Deploy webhooks (e.g. from GitHub Actions) to Portainer. Portainer itself
  # is not reachable from the internet (127.0.0.1 only) - through these doors
  # only POSTs to exactly these webhook IDs get in.
  if enabled portainer; then
    for hook in $KW_PORTAINER_WEBHOOKS; do
      id=${hook%%@*} host=${hook#*@}
      if [[ ! $id =~ ^[A-Za-z0-9-]+$ || $host == "$hook" || ! $host =~ ^[A-Za-z0-9.-]+$ ]]; then
        warn "KW_PORTAINER_WEBHOOKS: '$hook' is not <webhook-id>@<domain> - skipped"
        continue
      fi
      cat <<CONF

# Portainer webhook $id on $host
location = /api/stacks/webhooks/$id {
    if (\$host != "$host") { return 404; }
    limit_except POST { deny all; }
    # Resolve the name per request: if Portainer is ever missing, the proxy
    # still starts (otherwise EVERY site would be down).
    resolver 127.0.0.11 valid=30s ipv6=off;
    set \$keepwatch_portainer http://portainer:9000;
    proxy_pass \$keepwatch_portainer;
}
CONF
    done
  fi
} | write "$CUSTOM/server_proxy.conf"

C=$(docker ps -q --filter label=com.docker.compose.project=proxy --filter label=com.docker.compose.service=nginx-proxy-manager | head -1)
rollback() {
  local f
  for f in http_top.conf server_proxy.conf; do
    if [[ -f $SAVE/$f ]]; then cp -a "$SAVE/$f" "$CUSTOM/$f"; else rm -f "$CUSTOM/$f"; fi
  done
}
# Test new rules in the running proxy BEFORE anything restarts it.
if changed "$CUSTOM/" && [[ -n $C ]]; then
  if docker exec "$C" nginx -t >/dev/null 2>&1; then
    docker exec "$C" nginx -s reload && echo "  proxy: nginx reloaded"
  else
    warn "proxy: nginx -t fails with the new rules - previous version restored: $(docker exec "$C" nginx -t 2>&1 | grep -i emerg | head -1)"
    rollback
  fi
fi

# Idempotent: compose only recreates containers whose definition changed.
# Something else on 80/443 (a host nginx, apache, caddy)? Then the proxy
# cannot start - say so clearly instead of a Docker error.
BUSY=""
if [[ -z $C ]]; then
  BUSY=$(ss -tlnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v docker-proxy | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | sort -u | tr '\n' ' ' || true)
fi
STARTED=0
if [[ -n $BUSY ]]; then
  warn "proxy not started: ports 80/443 are used by: $BUSY- stop and disable it (e.g. systemctl disable --now nginx), then deploy again"
elif OUT=$(cd "$P" && docker compose -p proxy up -d --quiet-pull --remove-orphans 2>&1); then
  STARTED=1
  grep -vE "Running|up-to-date|Pulling|Pulled|Creating|Starting|Waiting" <<<"$OUT" | sed 's/^/  /' || true
else
  warn "proxy: docker compose up failed: $(tail -2 <<<"$OUT" | tr '\n' ' ' | cut -c1-300)"
fi
if (( STARTED )) && [[ -z $C && $FRESH_PROXY == 1 ]]; then
  echo "  first start: open the admin UI through the tunnel (./keepwatch tunnel -> http://localhost:$((10000 + KW_PROXY_ADMIN_PORT)))"
  echo "  and create the admin account right away (older images: admin@example.com / changeme - change it)"
fi
unset -f rollback
echo "  ok"
