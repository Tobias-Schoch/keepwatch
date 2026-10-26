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
  warn "docker is installed but without the compose plugin - install docker-compose-plugin (or docker-compose-v2 for Ubuntu's docker.io)"
fi

# json-file logs rotated at 3 x 10 MB per container (the log-archive module
# keeps them longer, outside Docker). live-restore: containers keep running
# while dockerd restarts (updates). Address pools: /24 networks from 10/8
# instead of a /16 per network from 172.17-31 - room for many stacks.
# An existing daemon.json from before Keepwatch is kept next to it, once.
if [[ -s /etc/docker/daemon.json && ! -e $KW_STATE/docker-daemon-json ]] && ! cmp -s "$F/daemon.json" /etc/docker/daemon.json; then
  cp -a /etc/docker/daemon.json /etc/docker/daemon.json.before-keepwatch
  warn "replaced your /etc/docker/daemon.json - the old one is /etc/docker/daemon.json.before-keepwatch"
fi
put "$F/daemon.json" /etc/docker/daemon.json
touch "$KW_STATE/docker-daemon-json"
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
