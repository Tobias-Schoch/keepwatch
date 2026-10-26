#!/bin/bash
# Pulls the server's backup to this computer as an independent restic copy.
#
#   ./keepwatch backup pull <folder>              fetch new snapshots, quick check
#   ./keepwatch backup pull <folder> --thorough   also read and verify all data
#
# Your computer pulls; the server never gets access to it. restic copy reads
# the server's local repository over SSH and keeps a complete repository of
# its own in <folder>, adding only new snapshots. Nothing is ever deleted
# here, not even when snapshots vanish on the server (pruned there, or deleted
# by an attacker). A plain rsync of the folder would mirror exactly that, and
# could hand you half a copy if it ran during a backup.
#
# Password (never printed or written to disk), first match wins:
#   KW_BACKUP_PASSWORD_COMMAND   any command that prints it (pass, op, bw, ...)
#   macOS keychain entry "Keepwatch backup" (create: security add-generic-password -s "Keepwatch backup" -a restic -w)
#   RESTIC_PASSWORD_FILE
#
# Needs restic and jq locally. The macOS app runs this script with KW_APP=1:
# then it also prints "::step ...", "::snapshot ..." and "::result ..." lines
# for its progress display; the human-readable output stays the same.
set -euo pipefail

DEST=${1:-}
[[ -n $DEST && $DEST != -* ]] || { sed -n '4,5p' "$0" | sed 's/^#  //'; exit 2; }
THOROUGH=0
[[ ${2:-} == --thorough ]] && THOROUGH=1
: "${KW_HOST:?KW_HOST missing - run through ./keepwatch}"
TARGET="${KW_SSH_USER:-root}@$KW_HOST"
SOURCE=${KW_BACKUP_SOURCE:-sftp:$TARGET:/var/backups/keepwatch/restic}
ENTRY=${KW_BACKUP_KEYCHAIN:-Keepwatch backup}
APP=${KW_APP:-0}
# restic's sftp backend runs plain ssh: pass the port through.
[[ ${KW_SSH_PORT:-22} == 22 ]] || export RESTIC_SFTP_ARGS="-o Port=$KW_SSH_PORT"
SFTP_OPT=()
[[ -n ${RESTIC_SFTP_ARGS:-} ]] && SFTP_OPT=(-o "sftp.args=$RESTIC_SFTP_ARGS")

step() { if [[ $APP == 1 ]]; then printf '\n== %s\n' "$*"; else printf '\n\033[1m== %s\033[0m\n' "$*"; fi; }
die() { echo "error: $*" >&2; exit 1; }
mark() { [[ $APP == 1 ]] && echo "::$*" || true; }
# A sentence a human understands when restic cannot reach the server or the password is wrong.
why() {
  grep -qi 'wrong password' "$1" && die "The password does not match the backup."
  grep -qiE 'permission denied|host key|could not resolve|connection (refused|timed out|closed)|no route|unable to start the sftp|ssh: ' "$1" \
    && die "No SSH connection to $TARGET. Does \"ssh $TARGET\" work in a terminal?"
  grep -qi 'locked' "$1" && die "The server is backing up or pruning right now (repository locked). Try again later."
  return 0
}

mark "step prepare"
command -v restic >/dev/null || die "restic is missing (macOS: brew install restic, Debian/Ubuntu: apt install restic)"
command -v jq >/dev/null || die "jq is missing (brew install jq / apt install jq)"

# Same password for both repositories (the copy gets the server's). Only in this run's environment.
if [[ -n ${KW_BACKUP_PASSWORD_COMMAND:-} ]]; then
  PW=$(eval "$KW_BACKUP_PASSWORD_COMMAND") || die "KW_BACKUP_PASSWORD_COMMAND failed."
elif command -v security >/dev/null && PW=$(security find-generic-password -s "$ENTRY" -w 2>/dev/null || security find-generic-password -l "$ENTRY" -w 2>/dev/null); then
  :
elif [[ -n ${RESTIC_PASSWORD_FILE:-} ]]; then
  PW=$(cat "$RESTIC_PASSWORD_FILE")
else
  die "No backup password. macOS: security add-generic-password -s \"$ENTRY\" -a restic -w   - or set KW_BACKUP_PASSWORD_COMMAND. Get it from the server: ./keepwatch ssh cat /etc/keepwatch/backup/restic.pass"
fi
export RESTIC_PASSWORD=$PW RESTIC_FROM_PASSWORD=$PW
unset PW RESTIC_PASSWORD_FILE

mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd)
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

if [[ ! -f $DEST/config ]]; then
  [[ -z $(ls -A "$DEST") ]] || die "$DEST is not empty and not a restic repository."
  step "Create a new copy in $DEST"
  mark "step init"
  # Same chunker parameters as the server, otherwise copy cannot deduplicate.
  restic -r "$DEST" "${SFTP_OPT[@]}" init --from-repo "$SOURCE" --copy-chunker-params >"$LOG" 2>&1 \
    || { tail -3 "$LOG" >&2; why "$LOG"; die "Could not create the copy."; }
  echo "  created"
fi

# Read the server's snapshots without a lock: shows early whether SSH and the
# password work and how many snapshots are new. Also used for the final comparison.
step "Read snapshots on the server"
mark "step connect"
SERVER=$(restic -r "$SOURCE" "${SFTP_OPT[@]}" snapshots --json --no-lock 2>"$LOG") \
  || { tail -3 "$LOG" >&2; why "$LOG"; die "Could not read the snapshots on the server."; }
HERE=$(restic -r "$DEST" snapshots --json --no-lock)
before=$(jq length <<<"$HERE")
missing=$(jq -n --argjson s "${SERVER:-[]}" --argjson h "${HERE:-[]}" \
  '[($h // [])[] | .id, (.original // empty)] as $have | [($s // [])[] | select(.id as $i | $have | index($i) | not)] | length')
echo "  $(jq 'length' <<<"${SERVER:-[]}") on the server, $missing new"

step "Fetch new snapshots"
mark "step fetch $missing"
if [[ $APP == 1 ]]; then
  # Progress (packs) without a terminal, for the app. restic reports "snapshot ... of ..."
  # when each snapshot starts, "... saved" only collected at the end.
  export RESTIC_PROGRESS_FPS=${RESTIC_PROGRESS_FPS:-1}
  restic -r "$DEST" "${SFTP_OPT[@]}" copy --from-repo "$SOURCE" 2>&1 | tee "$LOG" | tr -u '\r' '\n' \
    | sed -l -nE 's/^snapshot ([0-9a-f]+) of .*/::snapshot start \1/p; s/^snapshot ([0-9a-f]+) saved.*/::snapshot saved \1/p; s/^.*[[:space:]]([0-9.]+)%[[:space:]]+([0-9]+) \/ ([0-9]+) packs copied.*/::snapshot packs \1 \2 \3/p' \
    && ok=1 || ok=0
else
  restic -r "$DEST" "${SFTP_OPT[@]}" copy --from-repo "$SOURCE" >"$LOG" 2>&1 && ok=1 || ok=0
fi
if (( ! ok )); then
  tail -3 "$LOG" >&2
  why "$LOG"
  die "Copy failed."
fi
after=$(restic -r "$DEST" snapshots --json --no-lock | jq length)

step "Verify"
mark "step verify $THOROUGH"
if (( THOROUGH )); then
  restic -r "$DEST" check --read-data >"$LOG" 2>&1 || { tail -5 "$LOG" >&2; die "Check failed: the copy is damaged."; }
else
  restic -r "$DEST" check >"$LOG" 2>&1 || { tail -5 "$LOG" >&2; die "Check failed: the copy is damaged."; }
fi
# The server's newest snapshot must be here now (copy remembers the original id).
mark "step compare"
latest_id=$(jq -r '(max_by(.time) // {}) | .id // empty' <<<"${SERVER:-[]}")
latest_time=$(jq -r '(max_by(.time) // {}) | (.time // "")[0:16] | sub("T"; " ")' <<<"${SERVER:-[]}")
[[ -n $latest_id ]] || die "There is no snapshot on the server yet."
restic -r "$DEST" snapshots --json --no-lock | jq -e --arg id "$latest_id" 'any(.[]; .id == $id or .original == $id)' >/dev/null \
  || die "The server's newest snapshot ($latest_time UTC) is missing from the copy."
echo "  ok      structure$( (( THOROUGH )) && echo " and all data")"
echo "  ok      the server's newest snapshot ($latest_time UTC) is here"
echo "  $after snapshots here, $((after - before)) new · $(du -sh "$DEST" | awk '{print $1}') in $DEST"
mark "result snapshots=$after new=$((after - before)) kib=$(du -sk "$DEST" | awk '{print $1}') thorough=$THOROUGH latest=$(jq -r '(max_by(.time) // {}) | (.time // "") | sub("\\.[0-9]+"; "")' <<<"${SERVER:-[]}")"
