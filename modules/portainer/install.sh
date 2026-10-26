# Portainer: web UI for Docker stacks, deploy from Git with webhooks; only
# through the tunnel (127.0.0.1:$KW_PORTAINER_PORT).
#
# Webhook quirks worth knowing:
#   - The stack webhook ignores variables in the query string (?IMAGE_TAG=...):
#     it redeploys with the stack's stored variables. A new image therefore
#     needs a new digest behind the same tag (e.g. :latest) to be recreated.
#   - It answers 204 before it has done anything. Whether it did: the log says
#     "Recreated" (deployed) or "Running" (looked at it, nothing changed):
#       docker logs --since 10m portainer-portainer-1 | grep -iE "pull|recreate|deployment"
#   - A release without a new commit can be a no-op for a Git stack:
#     Portainer sees the same Git state as before.
# Public webhook URLs: KW_PORTAINER_WEBHOOKS="<id>@<domain>" (the proxy module
# opens exactly those paths on exactly those domains).
P=$KW_SRV/portainer
install -d -m 755 "$KW_SRV" "$P"
install -d -m 700 "$P/data"
put "$F/docker-compose.yml" "$P/docker-compose.yml"
write "$P/.env" 600 <<CONF
# Written by Keepwatch from keepwatch.conf - edit that instead.
KW_PORTAINER_PORT=$KW_PORTAINER_PORT
CONF
docker network inspect proxy-portainer >/dev/null 2>&1 || { docker network create proxy-portainer >/dev/null; echo "  network created: proxy-portainer"; }

FIRST=0
[[ -e $P/data/portainer.db ]] || FIRST=1
if OUT=$(cd "$P" && docker compose -p portainer up -d --quiet-pull --remove-orphans 2>&1); then
  grep -vE "Running|up-to-date|Pulling|Pulled|Creating|Starting|Waiting" <<<"$OUT" | sed 's/^/  /' || true
else
  warn "portainer: docker compose up failed: $(tail -2 <<<"$OUT" | tr '\n' ' ' | cut -c1-300)"
fi
if (( FIRST )); then
  echo "  first start: create the admin user WITHIN 5 MINUTES (./keepwatch tunnel -> http://localhost:$((10000 + KW_PORTAINER_PORT)))"
  echo "  - after that Portainer locks itself for security; then: docker restart portainer-portainer-1"
  echo "  For the dashboard (stacks, redeploy): create an access token in Portainer and add it in the dashboard settings."
fi
echo "  ok"
