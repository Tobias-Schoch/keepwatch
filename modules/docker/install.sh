# Docker Engine from Docker's own repository, with log rotation, live-restore
# and the shared network the proxy reaches your containers through.
FRESH=0
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  APT_FRESH=0
  need docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  FRESH=1
elif ! docker compose version >/dev/null 2>&1; then
  # An existing Docker without compose (often Ubuntu's docker.io): the proxy
  # and Portainer need it - add the plugin that belongs to that Docker.
  if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q "ok installed"; then PLUGIN=docker-compose-v2; else PLUGIN=docker-compose-plugin; fi
  need "$PLUGIN" || true
  docker compose version >/dev/null 2>&1 \
    || warn "docker is installed but without the compose plugin, and $PLUGIN could not be installed - install it yourself (apt install $PLUGIN)"
fi

# Keepwatch's settings are MERGED into daemon.json - everything else you or
# your provider set there (data-root, dns, mtu, registry-mirrors, runtimes,
# userns-remap, ...) stays as it is.
#   log-driver/log-opts  json-file rotated at 3 x 10 MB per container (the
#                        log-archive module keeps them longer, outside Docker)
#   live-restore         containers keep running while dockerd restarts (updates)
#   default-address-pools only with KW_DOCKER_ADDRESS_POOL, and only if neither
#                        it nor bip is set already. Docker's own defaults
#                        (172.17-31.0.0/16, 192.168.0.0/16 in /20s) are safe;
#                        a pool from 10.0.0.0/8 would collide with the private
#                        networks of many providers (Hetzner, DigitalOcean, Oracle).
# The original file is kept once as daemon.json.before-keepwatch.
if [[ -s /etc/docker/daemon.json && ! -e /etc/docker/daemon.json.before-keepwatch ]]; then
  cp -a /etc/docker/daemon.json /etc/docker/daemon.json.before-keepwatch
fi
MERGED=$(python3 - "$F/daemon.json" /etc/docker/daemon.json "${KW_DOCKER_ADDRESS_POOL:-}" <<'PY2'
import json, sys
ours = json.load(open(sys.argv[1]))
try:
    cur = json.load(open(sys.argv[2]))
except FileNotFoundError:
    cur = {}
except ValueError as e:
    sys.exit(f"/etc/docker/daemon.json is not valid JSON ({e}) - fix it first")
cur.update(ours)
pool = sys.argv[3].strip()
if pool and "default-address-pools" not in cur and "bip" not in cur:
    base, _, size = pool.partition("@")
    cur["default-address-pools"] = [{"base": base, "size": int(size or 24)}]
print(json.dumps(cur, indent=2))
PY2
) || { warn "docker: $MERGED"; MERGED=""; }
[[ -z $MERGED ]] || write /etc/docker/daemon.json <<<"$MERGED"
systemctl enable -q --now docker
if changed /etc/docker/; then
  if (( FRESH )); then
    # Nothing runs yet: a restart applies everything, including the address pools.
    systemctl restart docker
  else
    # Reload, not restart: Docker applies live-restore and the log options on
    # SIGHUP, containers keep running. Whatever cannot change this way,
    # dockerd notes in the journal; it applies on the next restart.
    echo "  daemon.json changed - Docker reloads its settings (containers keep running)"
    systemctl reload docker
  fi
fi

for net in $KW_PROXY_NETWORK $KW_DOCKER_NETWORKS; do
  if ! docker network inspect "$net" >/dev/null 2>&1; then
    docker network create "$net" >/dev/null
    CHANGED+=("docker network: $net")
    echo "  network created: $net"
  fi
done
echo "  ok"
