# SSH: keys only, no root password login, no agent forwarding, only local tunnels.
DROPIN=/etc/ssh/sshd_config.d/00-keepwatch.conf

# Never switch off passwords for an account that cannot log in with a key:
# check the user running this deploy (root, or the sudo user), in the
# authorized-keys files sshd really reads for that user.
install -d -m 755 /run/sshd
DEPLOY_USER=${SUDO_USER:-root}
HOME_DIR=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
KEYS=0
for f in $(sshd -T -C "user=$DEPLOY_USER,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "authorizedkeysfile" {$1=""; print}'); do
  f=${f//%h/$HOME_DIR}; f=${f//%u/$DEPLOY_USER}; f=${f//%%/%}
  [[ $f == /* ]] || f=$HOME_DIR/$f
  if [[ -s $f ]] && grep -qE '(^|[ ,"])(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-(ssh|ecdsa))' "$f"; then KEYS=1; fi
done
if (( ! KEYS )); then
  warn "ssh-hardening skipped: $DEPLOY_USER has no SSH key that sshd accepts - add your key first, or you could lock yourself out"
  return 0
fi

put "$F/sshd-keepwatch.conf" "$DROPIN"
# Lynis FILE-7524: only sshd (root) reads it.
chmod 600 /etc/ssh/sshd_config
if changed "$DROPIN"; then
  # (sshd -t needs /run/sshd, created above: it only exists while
  # ssh.service runs, socket activation on Ubuntu 24.04.)
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
