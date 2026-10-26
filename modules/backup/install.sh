# Backups: daily restic backup (databases dumped consistently), optional
# off-site copy, monthly test restore.
BK=$KW_ETC/backup
need restic
install -d -m 700 "$BK" /var/backups/keepwatch /var/cache/restic "$KW_STATE/backup"

# restic >= 0.14 is needed (copy --from-repo, init --copy-chunker-params).
# Ubuntu 22.04 ships 0.12 - then the official release binary goes to
# /usr/local/bin (before /usr/bin in PATH), checked against its SHA256SUMS.
RESTIC_VERSION=0.17.3
if dpkg --compare-versions "$(restic version 2>/dev/null | awk '{print $2}')" lt 0.14; then
  ARCH=$(dpkg --print-architecture)
  TMPD=$(mktemp -d)
  URL=https://github.com/restic/restic/releases/download/v$RESTIC_VERSION
  if curl -fsSL -o "$TMPD/restic_${RESTIC_VERSION}_linux_$ARCH.bz2" "$URL/restic_${RESTIC_VERSION}_linux_$ARCH.bz2" \
     && curl -fsSL -o "$TMPD/SHA256SUMS" "$URL/SHA256SUMS" \
     && (cd "$TMPD" && sha256sum -c --ignore-missing --quiet SHA256SUMS); then
    bunzip2 -c "$TMPD/restic_${RESTIC_VERSION}_linux_$ARCH.bz2" > "$TMPD/restic"
    install -m 755 "$TMPD/restic" /usr/local/bin/restic
    CHANGED+=(/usr/local/bin/restic)
    echo "  restic $RESTIC_VERSION installed to /usr/local/bin (the distribution's is too old)"
  else
    warn "restic is older than 0.14 and the official binary could not be downloaded - off-site copies will fail"
  fi
  rm -rf "$TMPD"
fi

# --- /etc/keepwatch/backup/env: written once, then the dashboard's ---------------
read -r KD KWK KM <<<"$KW_BACKUP_KEEP"
read -r RD RW RM <<<"$KW_BACKUP_REMOTE_KEEP"
sed -e "s/@KEEP_DAILY@/${KD:-7}/" -e "s/@KEEP_WEEKLY@/${KWK:-4}/" -e "s/@KEEP_MONTHLY@/${KM:-6}/" \
    -e "s/@REMOTE_KEEP_DAILY@/${RD:-14}/" -e "s/@REMOTE_KEEP_WEEKLY@/${RW:-13}/" -e "s/@REMOTE_KEEP_MONTHLY@/${RM:-24}/" \
    "$F/backup.env.example" | seed_text "$BK/env" 600

env_get() { (set +u; set -a; source "$BK/env" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\""); }
env_has() { grep -qE "^(export )?$1=" "$BK/env"; }
env_set() {  # env_set KEY VALUE: replace or append KEY="VALUE" (quoted for `source`)
  local v=$2 tmp
  v=${v//\\/\\\\}; v=${v//\"/\\\"}; v=${v//\$/\\\$}; v=${v//\`/\\\`}
  tmp=$(mktemp)
  grep -vE "^(export )?$1=" "$BK/env" > "$tmp" || true
  printf '%s="%s"\n' "$1" "$v" >> "$tmp"
  install -m 600 "$tmp" "$BK/env"
  rm -f "$tmp"
  CHANGED+=("$BK/env: $1")
}
cred() {  # cred VAR "Prompt" [secret]: ask for a missing credential
  local value
  env_has "$1" && return 0
  if [[ -t 0 ]]; then
    if [[ ${3:-} == secret ]]; then ask_secret value "$2"; else ask value "$2"; fi
    if [[ -n $value ]]; then env_set "$1" "$value"; env_key "$1"; return 0; fi
  fi
  MISSING+=("$1")
}
env_key() {  # env_key VAR: add VAR to REMOTE_ENV_KEYS (the dashboard lists credentials by it)
  local keys
  keys=" $(env_get REMOTE_ENV_KEYS) "
  # shellcheck disable=SC2086,SC2116 # joins the words
  [[ $keys == *" $1 "* ]] || env_set REMOTE_ENV_KEYS "$(echo $keys $1)"
}

# The off-site repository: KW_BACKUP_REMOTE wins when set; when it is empty,
# whatever the dashboard configured stays.
if [[ -n $KW_BACKUP_REMOTE && $KW_BACKUP_REMOTE != "$(env_get REMOTE_REPO)" ]]; then
  env_set REMOTE_REPO "$KW_BACKUP_REMOTE"
  echo "  off-site repository: $KW_BACKUP_REMOTE"
fi
REMOTE=$(env_get REMOTE_REPO)
MISSING=()
case $REMOTE in
  "") ;;
  s3:*)
    cred AWS_ACCESS_KEY_ID "S3 access key ID:"
    cred AWS_SECRET_ACCESS_KEY "S3 secret access key:" secret ;;
  b2:*)
    cred B2_ACCOUNT_ID "Backblaze B2 key ID:"
    cred B2_ACCOUNT_KEY "Backblaze B2 application key:" secret ;;
  azure:*)
    cred AZURE_ACCOUNT_NAME "Azure storage account name:"
    cred AZURE_ACCOUNT_KEY "Azure storage account key:" secret ;;
  gs:*)
    cred GOOGLE_PROJECT_ID "Google Cloud project ID:"
    cred GOOGLE_APPLICATION_CREDENTIALS "Path of the service account JSON key on this server (e.g. $BK/gcs.json):" ;;
  rest:*)
    # Credentials may be in the URL (rest:https://user:pass@host/); otherwise
    # ask once - an empty answer means "no login" and is remembered.
    if [[ $REMOTE != *@* ]] && ! env_has RESTIC_REST_USERNAME && [[ -t 0 ]]; then
      ask value "REST server user name (empty if none):"
      env_set RESTIC_REST_USERNAME "$value"
      if [[ -n $value ]]; then
        env_key RESTIC_REST_USERNAME
        ask_secret value "REST server password:"; env_set RESTIC_REST_PASSWORD "$value"; env_key RESTIC_REST_PASSWORD
      fi
    fi ;;
  sftp:*)
    # restic uses ssh as root: the target needs root's public key, and its
    # host key must be known (a timer cannot answer the question).
    [[ -f /root/.ssh/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N "" -C "keepwatch-backup@$KW_HOSTNAME" -f /root/.ssh/id_ed25519
    TARGET=${REMOTE#sftp:}; TARGET=${TARGET%%:*}; TARGET=${TARGET#//}; TARGET=${TARGET%%/*}
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$TARGET" true 2>/dev/null; then
      warn "backup: $TARGET does not accept root's key yet - add this line to its authorized_keys: $(cat /root/.ssh/id_ed25519.pub)"
    fi ;;
  rclone:*)
    need rclone
    env_has RCLONE_CONFIG || env_set RCLONE_CONFIG "$BK/rclone.conf"
    NAME=${REMOTE#rclone:}; NAME=${NAME%%:*}
    if ! RCLONE_CONFIG=$BK/rclone.conf rclone listremotes 2>/dev/null | grep -qx "$NAME:"; then
      ANSWER=n
      [[ -t 0 ]] && ask ANSWER "rclone remote '$NAME' is not configured yet. Run 'rclone config' now? [Y/n]" && ANSWER=${ANSWER:-y}
      if [[ $ANSWER == [Yy]* ]]; then
        RCLONE_CONFIG=$BK/rclone.conf rclone config
        chmod 600 "$BK/rclone.conf" 2>/dev/null || true
      fi
      RCLONE_CONFIG=$BK/rclone.conf rclone listremotes 2>/dev/null | grep -qx "$NAME:" \
        || warn "backup: rclone remote '$NAME' missing - on the server: RCLONE_CONFIG=$BK/rclone.conf rclone config"
    fi ;;
  /*|local:*) ;;
  *) warn "backup: unknown repository type in '$REMOTE' - set the credentials in $BK/env yourself" ;;
esac
if (( ${#MISSING[@]} )); then
  warn "backup: off-site credentials missing (${MISSING[*]}) - deploy again from a terminal, or add them to $BK/env"
fi

if [[ ! -s $BK/restic.pass ]]; then
  # A fresh server without a restore: a new password. A restore replaces it
  # with the old one from the backup.
  (umask 077; head -c 48 /dev/urandom | base64 | tr -d '\n' > "$BK/restic.pass")
  CHANGED+=("$BK/restic.pass")
  warn "new backup password created - put it into your password manager NOW (without it no backup can be read): ./keepwatch ssh cat $BK/restic.pass"
fi

# --- Scripts and timers ------------------------------------------------------------
put "$F/keepwatch-backup" /usr/local/sbin/keepwatch-backup 755
put "$F/keepwatch-backup-verify" /usr/local/sbin/keepwatch-backup-verify 755
put "$F/keepwatch-backup.service" /etc/systemd/system/keepwatch-backup.service
put "$F/keepwatch-backup-verify.service" /etc/systemd/system/keepwatch-backup-verify.service
put "$F/keepwatch-backup.timer" /etc/systemd/system/keepwatch-backup.timer
# seed, not put: the dashboard changes the time later (Settings -> Backup).
seed_text /etc/systemd/system/keepwatch-backup.timer.d/schedule.conf <<CONF
# Keepwatch: backup time (seeded from KW_BACKUP_TIME, changed by the dashboard).
[Timer]
OnCalendar=
OnCalendar=$(calendar "$KW_BACKUP_TIME")
CONF
TZV=${KW_LOCAL_TZ:-Etc/UTC}; [[ -f /usr/share/zoneinfo/$TZV ]] || TZV=Etc/UTC
sed "s|^OnCalendar=.*|& $TZV|" "$F/keepwatch-backup-verify.timer" | write /etc/systemd/system/keepwatch-backup-verify.timer
unit_on keepwatch-backup.timer keepwatch-backup-verify.timer
changed /etc/systemd/system/keepwatch-backup.timer && systemctl restart keepwatch-backup.timer  # also the .d drop-in
changed /etc/systemd/system/keepwatch-backup-verify.timer && systemctl restart keepwatch-backup-verify.timer
unset -f env_get env_has env_set env_key cred
echo "  daily at $KW_BACKUP_TIME ($KW_LOCAL_TZ) to /var/backups/keepwatch/restic${REMOTE:+ and $REMOTE}"
