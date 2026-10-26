# SSH: keys only, no root password login, no agent forwarding, only local tunnels.
DROPIN=/etc/ssh/sshd_config.d/00-keepwatch.conf

# Never switch off passwords on a server nobody can log in to with a key.
KEYS=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  if [[ -s $f ]] && grep -qE '(^|[ ,"])(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-(ssh|ecdsa))' "$f"; then KEYS=1; fi
done
if (( ! KEYS )); then
  warn "ssh-hardening skipped: no authorized_keys with a key found - add your key first, or you could lock yourself out"
  return 0
fi

put "$F/sshd-keepwatch.conf" "$DROPIN"
# Lynis FILE-7524: only sshd (root) reads it.
chmod 600 /etc/ssh/sshd_config
if changed "$DROPIN"; then
  # sshd -t needs its privilege separation directory, which only exists
  # while ssh.service runs (socket activation on Ubuntu 24.04).
  install -d -m 755 /run/sshd
  ERR=$(mktemp)
  if sshd -t 2>"$ERR"; then
    # Existing sessions (this deploy) survive a reload.
    systemctl try-reload-or-restart ssh
  else
    rm -f "$DROPIN"
    warn "sshd rejected the hardening ($(head -1 "$ERR")) - removed it again, SSH unchanged"
  fi
  rm -f "$ERR"
fi
echo "  ok"
