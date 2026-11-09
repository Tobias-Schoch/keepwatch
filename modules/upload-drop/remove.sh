# Remove the upload drops: their users, keys and sshd rules. Kept: every drop
# folder with everything uploaded into it (handed to root) - a web container
# that serves one keeps working, only nothing new can be uploaded.
UD_KEYS=/etc/ssh/keepwatch-upload
UD_SSHD=/etc/ssh/sshd_config.d/99-keepwatch-upload-drop.conf
UD_STATE=$KW_STATE/upload-drop
# shellcheck disable=SC1091 # shipped with the module
source "$F/forget.sh"

UD_KEPT=""
if [[ -f $UD_STATE/drops ]]; then
  while read -r name dir; do
    [[ -n $name ]] || continue
    forget_drop "$name" "$dir"
    if [[ -d $dir ]]; then UD_KEPT+=" $dir"; fi
  done < "$UD_STATE/drops"
fi
if [[ -f $UD_SSHD ]]; then
  UD_PREV=$(mktemp)
  cp "$UD_SSHD" "$UD_PREV"
  rm -f "$UD_SSHD"
  sshd_apply "$UD_PREV"
  rm -f "$UD_PREV"
  echo "  removed $UD_SSHD"
fi
rm -rf "$UD_KEYS" "$UD_STATE"
echo "  upload drops removed (users, keys, sshd rules); kept the folders and their files:${UD_KEPT:- none}"
echo "  to delete one for good: rm -r <folder> (and take it out of any container that mounts it first)"
unset UD_KEYS UD_SSHD UD_STATE UD_KEPT UD_PREV name dir
unset -f forget_drop sshd_apply
