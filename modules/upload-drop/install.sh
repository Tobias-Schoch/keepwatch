# Upload drops: folders one SSH key may rsync into - and do nothing else.
#
# Every drop in KW_UPLOAD_DROPS ("name=/srv/folder") gets a system user of its
# own (upload-<name>: no password, no sudo, no other group) and the key in
# KW_UPLOAD_KEY_<name>. That key can only run rrsync for that one folder, and
# this is pinned twice: by the key's options (restrict,command=...) and by
# sshd itself (Match User ... ForceCommand), so a key line edited by hand or a
# forgotten option still gets no shell, no tunnel and no other folder.
UD_KEYS=/etc/ssh/keepwatch-upload
UD_SSHD=/etc/ssh/sshd_config.d/99-keepwatch-upload-drop.conf
UD_STATE=$KW_STATE/upload-drop
# shellcheck disable=SC1091 # shipped with the module
source "$F/forget.sh"

# rrsync ships with rsync >= 3.2.4 (Ubuntu 24.04) and is a Python script.
need rsync python3
RRSYNC=/usr/bin/rrsync
if [[ ! -x $RRSYNC ]]; then
  warn "upload-drop: $RRSYNC is missing (needs rsync 3.2.4 or newer, as in Ubuntu 24.04) - no drop set up"
  return 0
fi
install -d -m 755 "$UD_KEYS"
install -d -m 700 "$UD_STATE"
touch "$UD_STATE/drops"

# Where a drop key may log in from. With Tailscale only from the tailnet: a key
# that leaks is useless without a device in your tailnet, even while SSH is
# open to the internet (or reopened by the SSH fallback).
case ${KW_UPLOAD_FROM:-} in
  "") if enabled tailscale; then UD_FROM="100.64.0.0/10,fd7a:115c:a1e0::/48"; else UD_FROM=""; fi ;;
  any) UD_FROM="" ;;
  *) UD_FROM=$KW_UPLOAD_FROM ;;
esac
if [[ -n $UD_FROM && ! $UD_FROM =~ ^[0-9A-Fa-f:.,/*?!]+$ ]]; then
  warn "upload-drop: KW_UPLOAD_FROM='$UD_FROM' is not a list of addresses/networks - no drop set up"
  return 0
fi

# AllowUsers / AllowGroups: once a server has either, every user not listed is
# refused - so a drop user needs an entry, but only then. Adding one where there
# was none would lock everybody else out. sshd adds up these lines (it does not
# keep the first), so ours only ever widen the list. Our own file does not count.
UD_ALLOW_USERS=0 UD_ALLOW_GROUPS=0
for f in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
  [[ -f $f && $f != "$UD_SSHD" ]] || continue
  # Global lines only (a Match block ends the global part of a file).
  g=$(awk 'tolower($1) == "match" {exit} {print tolower($1)}' "$f")
  if grep -qx allowusers <<<"$g"; then UD_ALLOW_USERS=1; fi
  if grep -qx allowgroups <<<"$g"; then UD_ALLOW_GROUPS=1; fi
done
unset g

# "type base64 [comment]" - a comment may have spaces, but no quotes or line breaks.
UD_KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+=*( [^"]*)?$'
UD_GLOBAL="" UD_MATCH="" UD_WANT=" "
UD_DROPS=$(mktemp)
for d in $KW_UPLOAD_DROPS; do
  name=${d%%=*} dir=${d#*=}
  dir=${dir%/}
  user=upload-$name
  if [[ $d != *=* || ! $name =~ ^[a-z][a-z0-9-]{0,24}$ ]]; then
    warn "upload-drop: '$d' is not name=/srv/folder (name: lowercase letters, digits, dashes) - skipped"
    continue
  fi
  # Under /srv only: it is in the backup, and it keeps a typo away from /etc or /home.
  # No spaces or quotes either - the path ends up in sshd's configuration.
  if [[ ! $dir =~ ^/srv/[A-Za-z0-9._/-]+$ || /$dir/ == */../* || /$dir/ == */./* || $dir == /srv/keepwatch || $dir == /srv/keepwatch/* ]]; then
    warn "upload-drop: folder '$dir' of drop '$name' must be under /srv (not /srv/keepwatch), letters, digits . _ - / only - skipped"
    continue
  fi
  if [[ $UD_WANT == *" $name "* ]]; then
    warn "upload-drop: drop '$name' is listed twice in KW_UPLOAD_DROPS - the second one is skipped"
    continue
  fi
  var=KW_UPLOAD_KEY_${name//-/_}
  key=${!var:-}
  # One public key, no options of its own (Keepwatch sets them).
  if [[ ! $key =~ $UD_KEY_RE ]] \
     || ! ssh-keygen -l -f /dev/stdin <<<"$key" >/dev/null 2>&1; then
    warn "upload-drop: $var is missing or not one public key (\"ssh-ed25519 AAAA... comment\") - drop '$name' skipped"
    continue
  fi
  # Never take over an account Keepwatch did not create.
  if id "$user" >/dev/null 2>&1 && ! grep -q "^$name " "$UD_STATE/drops"; then
    warn "upload-drop: user $user already exists and was not created by Keepwatch - drop '$name' skipped"
    continue
  fi

  # The same drop moved to another folder: the old one stays, handed to root.
  old=$(awk -v n="$name" '$1 == n {print $2}' "$UD_STATE/drops")
  if [[ -n $old && $old != "$dir" && -d $old ]]; then
    chown -R -h root:root "$old"
    echo "  drop $name moved: kept $old (now owned by root)"
  fi

  if ! id "$user" >/dev/null 2>&1; then
    # Remember it before anything else can fail: remove.sh must find it.
    grep -v "^$name " "$UD_STATE/drops" > "$UD_STATE/drops.tmp" || true
    echo "$name $dir" >> "$UD_STATE/drops.tmp"
    mv "$UD_STATE/drops.tmp" "$UD_STATE/drops"
    # A shell is needed: sshd runs the forced command through it. Home is "/"
    # (as systemd-sysusers does): never the drop folder - pam_motd writes
    # ~/.cache/motd.legal-displayed on every login, and that would be served.
    useradd --system --user-group --shell /bin/sh --home-dir / --no-create-home \
      --comment "Keepwatch upload drop $name" "$user"
    CHANGED+=("user: $user")
    echo "  created user $user"
  fi
  [[ $(getent passwd "$user" | cut -d: -f6) == / ]] || usermod --home / "$user"
  # No password at all - "*", not "!" (locked): with UsePAM no, sshd refuses
  # keys of locked accounts too.
  [[ $(getent shadow "$user" | cut -d: -f2) == '*' ]] || usermod -p '*' "$user"
  # Its own group only: never sudo, admin, docker (= root) or anything else.
  for grp in $(id -nG "$user"); do
    if [[ $grp != "$user" ]]; then
      gpasswd -d "$user" "$grp" >/dev/null
      warn "upload-drop: removed $user from group $grp - a drop user belongs to no other group"
    fi
  done

  # The folder: written by the drop user only, readable by everyone - a web
  # container (nginx runs as uid 101) reads it through a read-only bind mount.
  # Parents that exist keep their mode; new ones are root's, 755.
  parent=$(dirname "$dir")
  [[ -d $parent ]] || install -d -m 755 "$parent"
  if [[ ! -d $dir ]]; then
    install -d -m 755 -o "$user" -g "$user" "$dir"
    CHANGED+=("$dir")
    echo "  created $dir"
  fi
  # Restored from a backup (other uid), or created empty by Docker for a bind
  # mount (root) before this deploy: the drop user must own what it syncs.
  if [[ $(stat -c %U "$dir") != "$user" || -n $(find "$dir" -mindepth 1 ! -user "$user" -print -quit) ]]; then
    chown -R -h "$user:$user" "$dir"
    echo "  $dir: handed to $user"
  fi
  [[ $(stat -c %a "$dir") == 755 ]] || chmod 755 "$dir"
  p=$parent
  while [[ $p != / ]]; do
    if [[ -n $(find "$p" -maxdepth 0 -perm /022 ! -perm -1000) ]]; then
      warn "upload-drop: $p is writable by others than its owner - anyone who can write there can swap $dir"
    fi
    p=$(dirname "$p")
  done

  # -wo: upload only (nothing can be read back). -munge: an uploaded symlink
  # cannot point out of the folder - the web container would follow it.
  cmd="$RRSYNC -wo -munge $dir"
  opts="restrict,command=\"$cmd\""
  [[ -n $UD_FROM ]] && opts="from=\"$UD_FROM\",$opts"
  # Owned by root: the drop user cannot change its own key (sshd reads the file as that user).
  { echo "# Written by Keepwatch (upload-drop) on every deploy - set $var in keepwatch.conf instead."
    echo "$opts $key"; } | write "$UD_KEYS/$user.keys" 644

  if (( UD_ALLOW_USERS )); then UD_GLOBAL+="AllowUsers $user"$'\n'; fi
  if (( UD_ALLOW_GROUPS )); then UD_GLOBAL+="AllowGroups $user"$'\n'; fi
  UD_MATCH+="
Match User $user
    AuthorizedKeysFile $UD_KEYS/$user.keys
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ForceCommand $cmd
    DisableForwarding yes
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
    MaxSessions 1
"
  UD_WANT+="$name "
  echo "$name $dir" >> "$UD_DROPS"
done

# Drops that left KW_UPLOAD_DROPS: user and key go, the files stay.
while read -r name dir; do
  [[ -n $name && $UD_WANT != *" $name "* ]] || continue
  forget_drop "$name" "$dir"
done < "$UD_STATE/drops"
install -m 600 "$UD_DROPS" "$UD_STATE/drops"
rm -f "$UD_DROPS"

# --- sshd -------------------------------------------------------------------------
UD_PREV=$(mktemp)
if [[ -f $UD_SSHD ]]; then cp "$UD_SSHD" "$UD_PREV"; else rm -f "$UD_PREV"; fi
if [[ $UD_WANT == " " ]]; then
  if [[ -f $UD_SSHD ]]; then
    rm -f "$UD_SSHD"
    CHANGED+=("$UD_SSHD")
    sshd_apply "$UD_PREV"
  fi
  echo "  no drops (KW_UPLOAD_DROPS is empty)"
else
  write "$UD_SSHD" 644 <<CONF
# Written by Keepwatch (upload-drop) on every deploy - do not edit (KW_UPLOAD_DROPS in keepwatch.conf).
# A drop user only ever runs rrsync for its folder, whatever its key file says.
# Named 99-...: read after the other drop-ins. It ends with "Match all", so
# whatever sshd reads after it is not caught in a drop user's Match block.
${UD_GLOBAL}${UD_MATCH}
Match all
CONF
  if changed "$UD_SSHD"; then sshd_apply "$UD_PREV"; fi
  # Check what sshd really does for each drop user (another drop-in could have
  # its own Match block first - sshd keeps the first value it reads).
  for name in $UD_WANT; do
    user=upload-$name
    eff=$(sshd -T -C "user=$user,host=localhost,addr=100.64.0.1" 2>/dev/null || true)
    if ! grep -q "^forcecommand $RRSYNC " <<<"$eff" || ! grep -qx "disableforwarding yes" <<<"$eff"; then
      warn "upload-drop: sshd does not force rrsync for $user (another Match block wins?) - its key options still do; check: sshd -T -C user=$user,host=x,addr=100.64.0.1"
    fi
    echo "  $user -> $(awk -v n="$name" '$1 == n {print $2}' "$UD_STATE/drops")${UD_FROM:+ (from $UD_FROM)}"
  done
fi
rm -f "$UD_PREV"

if enabled backup; then
  echo "  drops are in the backup (/srv) - to leave one out: KW_BACKUP_EXCLUDE=\"... /srv/<folder>\""
fi
unset UD_KEYS UD_SSHD UD_KEY_RE UD_STATE UD_FROM UD_ALLOW_USERS UD_ALLOW_GROUPS UD_GLOBAL UD_MATCH UD_WANT UD_DROPS UD_PREV RRSYNC
unset d name dir user var key old grp parent p cmd opts eff f
unset -f forget_drop sshd_apply
echo "  ok"
