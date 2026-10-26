#!/bin/bash
# Brings a server back from the restic backup: secrets and settings, the
# proxy and Portainer with their data and certificates, Docker volumes,
# Portainer stacks and their Postgres databases.
#
#   new server (from your computer):  ./keepwatch deploy --restore
#   by hand, on the server:           bash /opt/keepwatch/modules/backup/restore.sh
#   test only (changes nothing):      bash /opt/keepwatch/modules/backup/restore.sh --test
#
# It only asks for what cannot be in the backup: the restic password and -
# if there is no local repository - the off-site repository (its credentials
# come from /etc/keepwatch/backup/env, which deploy fills from KW_BACKUP_REMOTE).
#
# Options:
#   --test            restore into /var/restore-test and check it, replace nothing
#   --snapshot <id>   instead of the newest snapshot
#   --stacks-only     leave the data alone, only redeploy the Portainer stacks
#   --force           even if containers are running already (overwrites their data!)
set -euo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8 HOME=/root RESTIC_CACHE_DIR=/var/cache/restic

KW_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BK=/etc/keepwatch/backup
TEST=0 SNAP=latest ONLY_STACKS=0 FORCE=0
while (( $# )); do
  case $1 in
    --test) TEST=1 ;;
    --snapshot) SNAP=$2; shift ;;
    --stacks-only) ONLY_STACKS=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

# Ports and networks from keepwatch.conf (defaults from the example).
for f in "$KW_ROOT/keepwatch.conf.example" /etc/keepwatch/keepwatch.conf; do
  # shellcheck disable=SC1090
  [[ -f $f ]] && source "$f"
done
PORTAINER=http://127.0.0.1:${KW_PORTAINER_PORT:-9002}
TOKEN_FILE=/etc/keepwatch/dashboard/portainer.token

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
abort() { echo "ERROR: $*" >&2; exit 1; }
opens() { restic -r "$1" cat config >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Access to the backup
# ---------------------------------------------------------------------------
ask_password() {  # ask_password <repo>: only keep a password that opens the repository
  local p
  [[ -t 0 ]] || return 1
  read -rsp "  restic password for $1 (from your password manager): " p; echo
  # A typo must never replace restic.pass.
  if RESTIC_PASSWORD=$p RESTIC_PASSWORD_FILE='' restic -r "$1" cat config >/dev/null 2>&1; then
    (umask 077; printf '%s' "$p" > "$RESTIC_PASSWORD_FILE")
    return 0
  fi
  echo "  that password does not open $1"
  return 1
}

pick_repo() {
  install -d -m 700 "$BK" /var/cache/restic
  if [[ -f $BK/env ]]; then set -a; source "$BK/env"; set +a; fi
  export RESTIC_PASSWORD_FILE=${RESTIC_PASSWORD_FILE:-$BK/restic.pass}
  LOCAL_REPO=${LOCAL_REPO:-/var/backups/keepwatch/restic}

  # A local repository that does not open (e.g. a copy from your computer on
  # a fresh server, whose restic.pass deploy just generated): ask.
  if [[ -f $LOCAL_REPO/config ]]; then
    opens "$LOCAL_REPO" || (( TEST )) || ask_password "$LOCAL_REPO" || true
    if opens "$LOCAL_REPO"; then
      RESTORE_REPO=$LOCAL_REPO
      echo "  source: local repository $LOCAL_REPO"
      return
    fi
  fi

  echo "  no usable local repository - using the off-site one"
  if [[ -z ${REMOTE_REPO:-} ]]; then
    [[ -t 0 ]] || abort "no off-site repository set (KW_BACKUP_REMOTE in keepwatch.conf, then deploy)"
    read -rp "  restic repository (e.g. s3:https://..., b2:bucket:path, sftp:user@host:/path, rclone:remote:path): " REMOTE_REPO
    [[ -n $REMOTE_REPO ]] || abort "no repository given"
  fi
  opens "$REMOTE_REPO" || ask_password "$REMOTE_REPO" || true
  opens "$REMOTE_REPO" || abort "repository $REMOTE_REPO not readable - wrong password, or credentials missing in $BK/env (set KW_BACKUP_REMOTE and deploy from a terminal, it asks for them)"
  RESTORE_REPO=$REMOTE_REPO
  echo "  source: $REMOTE_REPO"
}

# ---------------------------------------------------------------------------
# Portainer stacks (rebuilt from Git) and Postgres dumps
# ---------------------------------------------------------------------------
portainer() {  # portainer <METHOD> <PATH> [JSON]
  curl -fsS -m 900 -X "$1" -H "X-API-Key: $(cat "$TOKEN_FILE")" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} "$PORTAINER$2"
}

import_dumps() {  # import_dumps <stage-dir>
  local stage=$1 dump name user project others db log
  for dump in "$stage"/postgres/*.sql; do
    [[ -e $dump ]] || continue
    name=$(basename "$dump" .sql)
    docker inspect "$name" >/dev/null 2>&1 || { echo "  $name: no such container, dump left in place ($dump)"; continue; }
    echo "  $name: importing the database"
    for _ in $(seq 60); do docker exec "$name" pg_isready -q 2>/dev/null && break; sleep 2; done
    # shellcheck disable=SC2016 # expanded inside the container
    user=$(docker exec "$name" sh -c 'echo ${POSTGRES_USER:-postgres}')
    # Stop the other containers of the stack, so nobody writes into a half-imported database.
    project=$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project"}}')
    others=""
    [[ -n $project ]] && others=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}' | grep -vx "$name" || true)
    # shellcheck disable=SC2086 # one container per word
    [[ -n $others ]] && docker stop $others >/dev/null
    for db in $(grep -oP '^CREATE DATABASE \K"?[^" ]+' "$dump" | tr -d '"'); do
      docker exec "$name" psql -q -U "$user" -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null
    done
    # Errors like "role already exists" are expected - pg_dumpall creates everything.
    log=/var/log/keepwatch-restore-$name.log
    docker exec -i "$name" psql -q -U "$user" -d postgres < "$dump" > "$log" 2>&1 || true
    echo "    $(grep -c ERROR "$log" || true) messages, log: $log"
    # shellcheck disable=SC2086
    [[ -n $others ]] && docker start $others >/dev/null
  done
  return 0
}

redeploy_stacks() {
  if ! docker ps --format '{{.Image}}' 2>/dev/null | grep -q '^portainer/'; then
    echo "  Portainer is not running - no stacks to redeploy"
    return 0
  fi
  if [[ ! -s $TOKEN_FILE ]]; then
    echo "  No Portainer API token in the backup. Start the stacks in Portainer:"
    echo "    ./keepwatch tunnel  ->  http://localhost:$((10000 + ${KW_PORTAINER_PORT:-9002}))"
    echo "  or save a token as $TOKEN_FILE and run"
    echo "    bash $KW_ROOT/modules/backup/restore.sh --stacks-only"
    return 1
  fi
  for _ in $(seq 60); do curl -fs -m 3 -o /dev/null "$PORTAINER/api/system/status" && break; sleep 2; done
  local list n
  list=$(portainer GET /api/stacks) || abort "Portainer does not answer or rejects the token."
  n=$(jq length <<<"$list")
  echo "  $n stacks"
  for i in $(seq 0 $((n - 1))); do
    local s id name ep body
    s=$(jq ".[$i]" <<<"$list")
    id=$(jq -r .Id <<<"$s"); name=$(jq -r .Name <<<"$s"); ep=$(jq -r .EndpointId <<<"$s")
    if [[ $(jq -r '.GitConfig != null' <<<"$s") == true ]]; then
      # Always send the stack's variables along: Portainer empties them otherwise.
      body=$(jq -c '{env: (.Env // []), prune: false, pullImage: true,
                     repositoryReferenceName: (.GitConfig.ReferenceName // ""),
                     repositoryAuthentication: (.GitConfig.Authentication != null),
                     repositoryUsername: (.GitConfig.Authentication.Username // ""),
                     repositoryPassword: "",
                     repositoryGitCredentialID: (.GitConfig.Authentication.GitCredentialID // 0)}' <<<"$s")
      printf '  %-24s Git, building/pulling ... ' "$name"
      portainer PUT "/api/stacks/$id/git/redeploy?endpointId=$ep" "$body" >/dev/null && echo ok || echo "FAILED"
    else
      printf '  %-24s file stack ... ' "$name"
      portainer POST "/api/stacks/$id/start?endpointId=$ep" >/dev/null && echo ok || echo "FAILED"
    fi
  done
}

# ---------------------------------------------------------------------------
step "Finding the backup"
pick_repo
restic -r "$RESTORE_REPO" snapshots --compact --no-lock | tail -n 6

if (( ONLY_STACKS )); then
  step "Redeploying stacks"
  redeploy_stacks
  exit 0
fi

TARGET=/var/restore
(( TEST )) && TARGET=/var/restore-test

if (( ! TEST && ! FORCE )) && [[ -n $(docker ps -q 2>/dev/null) ]]; then
  abort "Containers are running here - this is not a fresh server. To check the backup: --test, to overwrite: --force"
fi

step "Restoring snapshot $SNAP to $TARGET"
rm -rf "$TARGET"
restic -r "$RESTORE_REPO" restore "$SNAP" --target "$TARGET" --no-lock
STAGE=$TARGET/var/backups/keepwatch/stage

step "Checking"
fail=0
for f in etc/keepwatch/backup/env etc/keepwatch/backup/restic.pass; do
  if [[ -e $TARGET/$f ]]; then echo "  ok      /$f"; else echo "  MISSING /$f"; fail=1; fi
done
# Whatever this server had: checked if it is in the snapshot.
for f in root/.ssh/authorized_keys srv/keepwatch/proxy/data/database.sqlite srv/keepwatch/proxy/letsencrypt \
         var/lib/tailscale var/lib/keepwatch; do
  [[ -e $TARGET/$f ]] && echo "  ok      /$f"
done
for dump in "$STAGE"/postgres/*.sql; do
  [[ -e $dump ]] || continue
  if tail -n 3 "$dump" | grep -q "PostgreSQL database cluster dump complete"; then
    echo "  ok      dump $(basename "$dump") ($(du -h "$dump" | cut -f1), complete)"
  else
    echo "  BROKEN  dump $(basename "$dump") ends midway"; fail=1
  fi
done
while IFS= read -r -d '' db; do
  r=$(sqlite3 "$db" "PRAGMA quick_check;" 2>&1 | head -1)
  if [[ $r == ok ]]; then echo "  ok      SQLite ${db#"$STAGE"/sqlite}"; else echo "  BROKEN  SQLite ${db#"$STAGE"/sqlite}: $r"; fail=1; fi
done < <(find "$STAGE/sqlite" -type f -print0 2>/dev/null)
while IFS= read -r -d '' db; do
  echo "  ok      Portainer ${db#"$STAGE"/bolt} ($(du -h "$db" | cut -f1), copied while paused)"
done < <(find "$STAGE/bolt" -name portainer.db -print0 2>/dev/null)

if (( TEST )); then
  du -sh "$TARGET" | sed 's/^/  size: /'
  rm -rf "$TARGET"
  (( fail )) && abort "Test restore found problems."
  echo; echo "Test restore passed: the backup is complete and readable."
  exit 0
fi
(( fail )) && abort "The backup is incomplete - stopped, nothing replaced."

step "Secrets and settings"
rsync -a "$TARGET/etc/keepwatch/backup/" "$BK/"
[[ -d $TARGET/etc/keepwatch/dashboard ]] && rsync -a "$TARGET/etc/keepwatch/dashboard/" /etc/keepwatch/dashboard/
# keepwatch.conf comes from your computer (deploy), not from the backup.
# firewall.env deliberately not either: a new server starts with SSH open
# until you close it again in the dashboard - you can always get in.
[[ -f $TARGET/etc/keepwatch/log-archive.conf ]] && install -m 644 "$TARGET/etc/keepwatch/log-archive.conf" /etc/keepwatch/log-archive.conf
# What the dashboard set under Settings (modules only seed these):
for f in etc/fail2ban/jail.d/zz-keepwatch-dashboard.local etc/apt/apt.conf.d/52-auto-reboot \
         etc/systemd/system/apt-daily-upgrade.timer.d/override.conf etc/systemd/system/apt-daily.timer.d/override.conf; do
  if [[ -f $TARGET/$f ]]; then install -D -m 644 "$TARGET/$f" "/$f"; echo "  /$f"; fi
done
if [[ -d $TARGET/etc/systemd/system/keepwatch-backup.timer.d ]]; then
  rsync -a "$TARGET/etc/systemd/system/keepwatch-backup.timer.d/" /etc/systemd/system/keepwatch-backup.timer.d/
fi
systemctl daemon-reload
fail2ban-client reload >/dev/null 2>&1 || true
# The same host keys as before: no "REMOTE HOST IDENTIFICATION HAS CHANGED".
if compgen -G "$TARGET/etc/ssh/ssh_host_*" >/dev/null; then
  cp -a "$TARGET"/etc/ssh/ssh_host_* /etc/ssh/ && systemctl try-reload-or-restart ssh || true
fi
# /root back, but authorized_keys merged instead of replaced - otherwise the
# key your provider just installed would lock itself out.
if [[ -d $TARGET/root ]]; then
  AK=$(mktemp)
  cat /root/.ssh/authorized_keys "$TARGET/root/.ssh/authorized_keys" 2>/dev/null | awk 'NF && !seen[$0]++' > "$AK" || true
  rsync -a --exclude .ssh/authorized_keys --exclude .cache "$TARGET/root/" /root/
  install -d -m 700 /root/.ssh
  install -m 600 "$AK" /root/.ssh/authorized_keys
  rm -f "$AK"
fi
echo "  ok"

step "Data: /opt, /srv, Keepwatch state"
[[ -d $TARGET/opt ]] && rsync -a --exclude /keepwatch "$TARGET/opt/" /opt/
[[ -d $TARGET/srv ]] && rsync -a "$TARGET/srv/" /srv/
# Tailscale identity: the new server is in the tailnet again under the same
# name. SSH stays open to the internet anyway (firewall.env is not restored).
if [[ -d $TARGET/var/lib/tailscale ]] && systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
  systemctl stop tailscaled
  rsync -a --delete "$TARGET/var/lib/tailscale/" /var/lib/tailscale/
  systemctl start tailscaled
  echo "  Tailscale: $(tailscale ip -4 2>/dev/null || echo 'not connected yet')"
fi
# Dashboard history, ban history, results.
[[ -d $TARGET/var/lib/keepwatch ]] && rsync -a "$TARGET/var/lib/keepwatch/" /var/lib/keepwatch/
echo "  ok"

if command -v docker >/dev/null && [[ -d $TARGET/var/lib/docker/volumes ]]; then
  step "Docker volumes"
  systemctl stop docker.socket docker
  rsync -a "$TARGET/var/lib/docker/volumes/" /var/lib/docker/volumes/
  # Data directories of running Postgres containers are not in the backup
  # (the dump is). Docker still needs the empty directory.
  for v in /var/lib/docker/volumes/*/; do mkdir -p "$v/_data"; done
  systemctl start docker
  systemctl restart keepwatch-firewall 2>/dev/null || true
  echo "  ok"
fi
# The consistent copies (SQLite via .backup, Portainer paused) over the raw files.
for d in sqlite bolt; do
  [[ -d $STAGE/$d ]] || continue
  # Keep the owner of the raw file: the copies were made as root.
  (cd "$STAGE/$d" && find . -type f -print0 | while IFS= read -r -d '' f; do
    t="/${f#./}"; o=$(stat -c %u:%g "$t" 2>/dev/null || true)
    mkdir -p "$(dirname "$t")"
    cp -a "$f" "$t"; if [[ -n $o ]]; then chown "$o" "$t"; fi
  done)
done

if command -v docker >/dev/null; then
  step "Proxy and Portainer"
  for net in $KW_PROXY_NETWORK $KW_DOCKER_NETWORKS proxy-portainer; do
    docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
  done
  for p in proxy portainer; do
    if [[ -f /srv/keepwatch/$p/docker-compose.yml ]]; then
      (cd "/srv/keepwatch/$p" && docker compose -p "$p" up -d)
    fi
  done

  step "Redeploying stacks"
  redeploy_stacks || true

  step "Importing databases"
  import_dumps "$STAGE"
fi

step "Services"
systemctl daemon-reload
systemctl restart keepwatch-dashboard 2>/dev/null || true
systemctl enable -q --now keepwatch-backup.timer 2>/dev/null || true
rm -rf "$TARGET"

step "Done - what is still left"
IP=$(ip route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')
if [[ -f /srv/keepwatch/proxy/data/database.sqlite ]]; then
  echo "  DNS: these domains must point to $IP (A record):"
  sqlite3 /srv/keepwatch/proxy/data/database.sqlite \
    "SELECT domain_names FROM proxy_host WHERE is_deleted=0 AND enabled=1" | jq -r '.[]' | sed 's/^/    /' || true
  echo "  The certificates came back and renew themselves as soon as DNS is right."
fi
OTHER=$(find /srv /opt -maxdepth 3 \( -name docker-compose.yml -o -name compose.yaml -o -name compose.yml -o -name docker-compose.yaml \) \
          -not -path '/srv/keepwatch/*' -not -path '/opt/keepwatch/*' 2>/dev/null || true)
if [[ -n $OTHER ]]; then
  echo "  Compose projects outside Portainer - start them yourself (docker compose up -d in their directory):"
  while IFS= read -r line; do echo "    $line"; done <<<"$OTHER"
fi
if command -v docker >/dev/null; then
  echo "  Containers:"
  docker ps --format '    {{.Names}}  {{.Status}}'
fi
echo "  Then run ./keepwatch deploy once more, so every module picks up the restored data."
