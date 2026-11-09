# shellcheck shell=bash
# Shared by install.sh (a drop left KW_UPLOAD_DROPS) and remove.sh (module off).

# forget_drop <name> <folder>: remove the drop's user and key. The folder and
# everything uploaded into it stay - they are handed to root, so a user created
# later with the same uid does not inherit write access to them.
forget_drop() {
  local name=$1 dir=$2 user=upload-$1
  rm -f "$UD_KEYS/$user.keys"
  if id "$user" >/dev/null 2>&1; then
    # An upload still running keeps the user busy: end it (its key is gone already).
    if ! userdel "$user" 2>/dev/null; then
      pkill -u "$user" 2>/dev/null || true
      sleep 1
      userdel "$user" 2>/dev/null || warn "upload-drop: could not remove user $user - remove it by hand: userdel $user"
    fi
    CHANGED+=("user: -$user")
    echo "  removed user $user and its key"
  fi
  if [[ -n $dir && -d $dir ]]; then
    chown -R -h root:root "$dir"
    echo "  kept $dir and its files (now owned by root)"
  fi
}

# sshd_apply: check the sshd drop-in that was just written (or removed) and
# reload sshd. A drop-in sshd rejects is put back the way it was - SSH is never
# left with a configuration it cannot start with. $1: the previous version (may be missing).
sshd_apply() {
  local previous=$1 err
  install -d -m 755 /run/sshd
  err=$(mktemp)
  if sshd -t 2>"$err"; then
    # Existing sessions (this deploy) survive a reload.
    systemctl try-reload-or-restart ssh
  else
    if [[ -f $previous ]]; then install -m 644 "$previous" "$UD_SSHD"; else rm -f "$UD_SSHD"; fi
    warn "upload-drop: sshd rejected the drop rules ($(head -1 "$err")) - put back the previous ones, SSH unchanged"
  fi
  rm -f "$err"
}
