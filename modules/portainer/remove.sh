# Stop Portainer. Your stacks keep running (they are ordinary compose
# projects). Kept: /srv/keepwatch/portainer (its database, users, stacks).
if [[ -f $KW_SRV/portainer/docker-compose.yml ]]; then
  (cd "$KW_SRV/portainer" && docker compose -p portainer down) || warn "portainer: docker compose down failed"
fi
echo "  Portainer stopped; your stacks keep running, data kept in $KW_SRV/portainer"
