# Stop the proxy - every site it serves goes offline. Kept: everything under
# /srv/keepwatch/proxy (hosts, certificates, compose file) - start it again
# with: cd /srv/keepwatch/proxy && docker compose -p proxy up -d
if [[ -f $KW_SRV/proxy/docker-compose.yml ]]; then
  (cd "$KW_SRV/proxy" && docker compose -p proxy down) || warn "proxy: docker compose down failed"
fi
warn "proxy stopped: your sites are offline; data kept in $KW_SRV/proxy"
echo "  ok"
