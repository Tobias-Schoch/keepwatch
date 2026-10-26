# shellcheck shell=bash
# Sourced by ./keepwatch deploy (configuration is loaded, remote/remote_tty exist, the SSH
# connection is shared and $TMP is a scratch directory that goes at exit).
# Copies the repository to /opt/keepwatch on the server and runs lib/apply.sh there.

MODE=apply APPLY_ARGS=() DRY=0
while (( $# )); do
  case $1 in
    --fresh) MODE=fresh ;;
    --dry-run) APPLY_ARGS+=(--dry-run); DRY=1 ;;
    --only)
      # Ends up in a command line on the server: module ids only.
      [[ ${2:-} =~ ^[a-z0-9,-]+$ ]] || { echo "--only needs module ids, e.g. --only firewall,fail2ban" >&2; exit 2; }
      APPLY_ARGS+=(--only "$2"); shift ;;
    *) echo "unknown option: $1 (see ./keepwatch help)" >&2; exit 2 ;;
  esac
  shift
done
# --fresh restores the backup for real - a dry run must not.
if (( DRY )) && [[ $MODE == fresh ]]; then echo "--fresh cannot be combined with --dry-run." >&2; exit 2; fi

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
cd "$ROOT" || exit 1

# --- Dashboard UI ------------------------------------------------------------------
# Built here, not on the server: no Node.js on the server.
if on dashboard; then
  WEB=dashboard/web
  newest_src=$(find "$WEB/src" "$WEB/index.html" "$WEB/package.json" "$WEB/package-lock.json" -type f -newer "$WEB/dist/index.html" 2>/dev/null | head -1 || true)
  if [[ ! -f $WEB/dist/index.html || -n $newest_src ]]; then
    if command -v npm >/dev/null; then
      step "Build the dashboard UI"
      # Again after a git pull that changed the dependencies, not only the first time.
      if [[ ! -f $WEB/node_modules/.package-lock.json || $WEB/package-lock.json -nt $WEB/node_modules/.package-lock.json ]]; then
        (cd "$WEB" && npm ci --silent --no-audit --no-fund)
      fi
      (cd "$WEB" && npm run build --silent >/dev/null)
      echo "  ok"
    elif [[ -f $WEB/dist/index.html ]]; then
      echo "  note: dashboard sources changed but npm is missing - deploying the existing build"
    else
      echo "The dashboard UI has to be built once on this computer: install Node.js 18+ (only here, the server" >&2
      echo "never needs it) and deploy again - or go without the dashboard: ./keepwatch disable dashboard" >&2
      exit 1
    fi
  fi
fi

# --- Connect -------------------------------------------------------------------------------
step "Connect to $TARGET"
if ! remote true; then
  p=""; [[ $KW_SSH_PORT == 22 ]] || p="-p $KW_SSH_PORT "
  # shellcheck disable=SC2153 # HOST is set by ./keepwatch
  kh=$HOST; [[ $KW_SSH_PORT == 22 ]] || kh="[$HOST]:$KW_SSH_PORT"
  cat >&2 <<EOF

Cannot log in to $TARGET with an SSH key (Keepwatch never uses passwords).
  - Your key is not on the server yet:      ssh-copy-id $p$TARGET
  - "REMOTE HOST IDENTIFICATION HAS CHANGED" after you (re)installed the server:
                                            ssh-keygen -R '$kh'
  - No answer at all: check KW_HOST and KW_SSH_PORT in ${CONF_FILE##*/}; with Tailscale as
    KW_HOST, this computer must be in the tailnet too.
  - A Keepwatch server bans an address after a failed login (fail2ban). If it worked before,
    unban yourself from the provider's web console: fail2ban-client unban <your IP>
EOF
  exit 1
fi
if [[ -n $SUDO ]] && ! remote "sudo -n true" 2>/dev/null; then
  echo "$KW_SSH_USER needs sudo without a password (or use root). On the server, as root:" >&2
  echo "  echo '$KW_SSH_USER ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/keepwatch && chmod 440 /etc/sudoers.d/keepwatch" >&2
  exit 1
fi
# The lock timeout: on a fresh server, cloud-init and the first automatic updates hold apt's lock for minutes.
remote "command -v rsync >/dev/null || { $SUDO apt-get -o DPkg::Lock::Timeout=600 update -q && $SUDO apt-get -o DPkg::Lock::Timeout=600 install -y -q rsync; } >/dev/null" \
  || { echo "Could not install rsync on the server." >&2; exit 1; }

# --- Copy ---------------------------------------------------------------------------------
# A dry run goes to a scratch copy: the dashboard runs from /opt/keepwatch and
# reads its keepwatch.conf, so the live copy must not change.
DEST=/opt/keepwatch
(( DRY )) && DEST=/var/tmp/keepwatch-dry-run
step "Copy Keepwatch to $TARGET:$DEST"
# For the dashboard timeline: which version was deployed.
INFO=$TMP/deploy-info
if git rev-parse --git-dir >/dev/null 2>&1; then
  python3 -c 'import json, sys; print(json.dumps({"commit": sys.argv[1], "subject": sys.argv[2], "dirty": sys.argv[3] == "1"}))' \
    "$(git rev-parse --short HEAD 2>/dev/null || echo none)" "$(git log -1 --format=%s 2>/dev/null || true)" \
    "$([[ -n $(git status --porcelain 2>/dev/null) ]] && echo 1 || echo 0)" > "$INFO"
else
  echo '{}' > "$INFO"
fi
RSYNC_PATH=rsync
[[ -n $SUDO ]] && RSYNC_PATH="sudo -n rsync"
RSH="ssh ${SSH_OPTS[*]}" RHOST=$TARGET
# rsync reads "host:path" up to the first colon, and macOS' openrsync cannot take [IPv6]:
# an IPv6 address goes to ssh as HostName instead.
if [[ $HOST == *:* ]]; then RSH+=" -o HostName=$HOST"; RHOST="$KW_SSH_USER@keepwatch-server"; fi
# -rlptz, not -a: no owner and group from this computer. Kept, your uid (501, 1000, ...)
# can belong to an ordinary user on the server, who could then change code that runs as root.
RSYNC=(rsync -rlptz --rsync-path="$RSYNC_PATH" -e "$RSH")
# /*.conf: keepwatch.conf goes separately (it may be KW_CONF_FILE), other servers' configs not at all.
"${RSYNC[@]}" --delete \
  --exclude .git --exclude .DS_Store --exclude node_modules --exclude '__pycache__' \
  --exclude 'dashboard/web/src' --exclude desktop --exclude docs --exclude '*.tmp' \
  --exclude '/*.conf' --exclude .deploy-info \
  ./ "$RHOST:$DEST/"
"${RSYNC[@]}" "$CONF_FILE" "$RHOST:$DEST/keepwatch.conf"
"${RSYNC[@]}" "$INFO" "$RHOST:$DEST/.deploy-info"
# Copies from before -rlptz still carry the old owner.
remote "$SUDO chown -R root:root $DEST && $SUDO chmod -R go-w $DEST"
echo "  ok"

# Writes the server's current host keys into known_hosts, read over the connection that is
# already open (and was verified with the keys from before).
trust_server_host_keys() {
  local keys g name port kh ktype key
  keys=$(remote "cat /etc/ssh/ssh_host_*_key.pub") || return 0
  # The name and file ssh looks the server up by (HostKeyAlias, ~/.ssh/config, port).
  g=$(ssh -G "${SSH_OPTS[@]}" "$TARGET" 2>/dev/null) || return 0
  # A HostKeyAlias is looked up as is, without the port; only a plain host name gets [host]:port.
  name=$(awk '$1 == "hostkeyalias" {print $2}' <<<"$g")
  if [[ -z $name ]]; then
    name=$(awk '$1 == "hostname" {print $2}' <<<"$g")
    port=$(awk '$1 == "port" {print $2}' <<<"$g")
    [[ -z $name || ${port:-22} == 22 ]] || name="[$name]:$port"
  fi
  kh=$(awk '$1 == "userknownhostsfile" {print $2}' <<<"$g")
  kh=${kh/#\~/$HOME}
  [[ -n $name && -n $kh ]] || return 0
  ssh-keygen -R "$name" -f "$kh" >/dev/null 2>&1 || true
  while read -r ktype key _; do
    if [[ -n $key ]]; then echo "$name $ktype $key"; fi
  done <<<"$keys" >> "$kh"
  echo "  known_hosts: $name now has the server's restored host keys"
}

APPLY="$SUDO bash $DEST/lib/apply.sh ${APPLY_ARGS[*]:-}"
case $MODE in
  apply)
    remote_tty "$APPLY"
    if (( DRY )); then remote "$SUDO rm -rf $DEST"; fi ;;
  fresh)
    remote_tty "$APPLY"
    remote_tty "$SUDO bash /opt/keepwatch/modules/backup/restore.sh"
    # The restore brought the old SSH host keys back: without this, every later
    # connection ends in "REMOTE HOST IDENTIFICATION HAS CHANGED".
    trust_server_host_keys
    # Keys and data are back now - this run brings everything up with them.
    remote_tty "$APPLY"
    ;;
esac

# --- After Tailscale is up: offer to deploy through it ---------------------------------
if on tailscale && (( ! DRY )); then
  TS_NAME=$(remote "tailscale status --json 2>/dev/null" 2>/dev/null | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("Self") or {}).get("DNSName", "").rstrip("."))
except ValueError:
    pass' || true)
  if [[ -n $TS_NAME && $TS_NAME != "$HOST" ]]; then
    echo
    echo "  Tailscale is up: this server is $TS_NAME in your tailnet."
    if [[ -t 0 ]] && read -rp "  Use it for deploy, tunnel and ssh from now on (KW_HOST)? [Y/n] " a && [[ ! $a =~ ^[nN] ]]; then
      python3 - "$TS_NAME" <<'PY'
import sys
sys.path.insert(0, "lib")
import kwconf
kwconf.save({"KW_HOST": sys.argv[1]})
PY
      echo "  KW_HOST=\"$TS_NAME\""
      [[ $KW_SSH_PUBLIC == yes ]] && echo "  Next: close port 22 to the internet - dashboard -> Settings -> Remote access, or KW_SSH_PUBLIC=\"no\" and deploy."
    fi
  fi
fi
