# shellcheck shell=bash
# Sourced by ./keepwatch deploy (configuration is loaded, remote/remote_tty exist).
# Copies the repository to /opt/keepwatch on the server and runs lib/apply.sh there.

MODE=apply APPLY_ARGS=()
while (( $# )); do
  case $1 in
    --fresh) MODE=fresh ;;
    --dry-run) APPLY_ARGS+=(--dry-run) ;;
    --only) APPLY_ARGS+=(--only "$2"); shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
cd "$ROOT" || exit 1

# --- Dashboard UI ------------------------------------------------------------------
# Built here, not on the server: no Node.js on the server. Release archives ship it prebuilt.
if on dashboard; then
  WEB=dashboard/web
  newest_src=$(find "$WEB/src" "$WEB/index.html" "$WEB/package.json" -type f -newer "$WEB/dist/index.html" 2>/dev/null | head -1 || true)
  if [[ ! -f $WEB/dist/index.html || -n $newest_src ]]; then
    if command -v npm >/dev/null; then
      step "Build the dashboard UI"
      [[ -d $WEB/node_modules ]] || (cd "$WEB" && npm ci --silent --no-audit --no-fund)
      (cd "$WEB" && npm run build --silent >/dev/null)
      echo "  ok"
    elif [[ -f $WEB/dist/index.html ]]; then
      echo "  note: dashboard sources changed but npm is missing - deploying the existing build"
    else
      echo "The dashboard UI is not built and npm is missing. Install Node.js 18+, or use a release archive (it includes the build)." >&2
      exit 1
    fi
  fi
fi

# --- Copy ---------------------------------------------------------------------------------
# A dry run goes to a scratch copy: the dashboard runs from /opt/keepwatch and
# reads its keepwatch.conf, so the live copy must not change.
DEST=/opt/keepwatch
[[ " ${APPLY_ARGS[*]:-} " == *" --dry-run "* ]] && DEST=/var/tmp/keepwatch-dry-run
step "Copy Keepwatch to $TARGET:$DEST"
remote "command -v rsync >/dev/null || { $SUDO apt-get update -q && $SUDO apt-get install -y -q rsync; } >/dev/null" \
  || { echo "Cannot reach $TARGET over SSH (or no root / passwordless sudo)." >&2; exit 1; }
# For the dashboard timeline: which version was deployed.
INFO=$(mktemp)
trap 'rm -f "$INFO"' EXIT
if git rev-parse --git-dir >/dev/null 2>&1; then
  python3 -c 'import json, sys; print(json.dumps({"commit": sys.argv[1], "subject": sys.argv[2], "dirty": sys.argv[3] == "1"}))' \
    "$(git rev-parse --short HEAD 2>/dev/null || echo none)" "$(git log -1 --format=%s 2>/dev/null || true)" \
    "$([[ -n $(git status --porcelain 2>/dev/null) ]] && echo 1 || echo 0)" > "$INFO"
else
  echo '{}' > "$INFO"
fi
RSYNC_PATH=rsync
[[ -n $SUDO ]] && RSYNC_PATH="sudo -n rsync"
rsync -az --delete --rsync-path="$RSYNC_PATH" -e "ssh ${SSH_OPTS[*]}" \
  --exclude .git --exclude .DS_Store --exclude node_modules --exclude '__pycache__' \
  --exclude 'dashboard/web/src' --exclude desktop --exclude docs --exclude '*.tmp' \
  --exclude keepwatch.conf --exclude .deploy-info \
  ./ "$TARGET:$DEST/"
rsync -az --rsync-path="$RSYNC_PATH" -e "ssh ${SSH_OPTS[*]}" keepwatch.conf "$TARGET:$DEST/keepwatch.conf"
rsync -az --rsync-path="$RSYNC_PATH" -e "ssh ${SSH_OPTS[*]}" "$INFO" "$TARGET:$DEST/.deploy-info"
echo "  ok"

APPLY="$SUDO bash $DEST/lib/apply.sh ${APPLY_ARGS[*]:-}"
case $MODE in
  apply)
    remote_tty "$APPLY"
    if [[ $DEST != /opt/keepwatch ]]; then remote "$SUDO rm -rf $DEST"; fi ;;
  fresh)
    remote_tty "$APPLY"
    remote_tty "$SUDO bash /opt/keepwatch/modules/backup/restore.sh"
    # Keys and data are back now - this run brings everything up with them.
    remote_tty "$APPLY"
    ;;
esac

# --- After Tailscale is up: offer to deploy through it ---------------------------------
if on tailscale && [[ " ${APPLY_ARGS[*]:-} " != *" --dry-run "* ]]; then
  TS_NAME=$(remote "tailscale status --json 2>/dev/null" 2>/dev/null | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("Self") or {}).get("DNSName", "").rstrip("."))
except ValueError:
    pass' || true)
  if [[ -n $TS_NAME && $TS_NAME != "$KW_HOST" ]]; then
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
