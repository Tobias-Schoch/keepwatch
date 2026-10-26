# Turn off Ubuntu extras a server does not need. Everything here is either
# masked (reversible, see remove.sh) or a package purge.

# Storage daemons for hardware most VPS do not have. Some clouds attach
# block volumes over iSCSI with multipath (Oracle Cloud): there they stay.
STORAGE_IN_USE=0
if command -v iscsiadm >/dev/null && iscsiadm -m session >/dev/null 2>&1; then STORAGE_IN_USE=1; fi
if [[ -d /etc/iscsi/nodes && -n $(ls -A /etc/iscsi/nodes 2>/dev/null) ]]; then STORAGE_IN_USE=1; fi
if command -v multipath >/dev/null && [[ -n $(multipath -l 2>/dev/null) ]]; then STORAGE_IN_USE=1; fi
if (( STORAGE_IN_USE )); then
  warn "debloat: iSCSI/multipath storage is in use - iscsid and multipathd stay on"
else
  systemctl disable -q --now multipathd.socket multipathd.service iscsid.socket open-iscsi.service 2>/dev/null || true
fi
systemctl mask -q --now ModemManager.service udisks2.service packagekit.service 2>/dev/null || true
# Crash reports to Canonical, Ubuntu Pro ads, news in the login banner,
# update notices, firmware updates (there is no firmware on a VM), the lxd
# installer, pollinate, sysstat (the dashboard measures load itself).
systemctl mask -q --now apport.service apport-autoreport.path apport-autoreport.timer apport-forward.socket \
  ua-timer.timer ubuntu-advantage.service ua-reboot-cmds.service motd-news.timer \
  update-notifier-download.timer update-notifier-motd.timer fwupd-refresh.timer \
  lxd-installer.socket pollinate.service sysstat.service sysstat-collect.timer sysstat-summary.timer 2>/dev/null || true
if [[ -f /etc/default/motd-news ]]; then sed -i 's/^ENABLED=1/ENABLED=0/' /etc/default/motd-news; fi
# A unit that had failed before it was masked would stay listed as failed.
systemctl reset-failed motd-news.timer apport.service fwupd-refresh.timer ua-timer.timer 2>/dev/null || true

installed() { dpkg-query -W -f='${Status}\n' "$@" 2>/dev/null | grep -c "ok installed" || true; }
PURGED=()
# purge_group PKG...: purge the installed ones - but never take other
# packages with them: if apt would also remove something that depends on
# them (something you installed), the whole group stays and you get a warning.
purge_group() {
  local p group=() extra
  for p in "$@"; do
    if [[ $(installed "$p") -gt 0 ]]; then group+=("$p"); fi
  done
  (( ${#group[@]} )) || return 0
  extra=$(apt-get -o DPkg::Lock::Timeout=600 purge -s "${group[@]}" 2>/dev/null | awk '/^Purg /{print $2}' | grep -vxF "$(printf '%s\n' "${group[@]}")" || true)
  if [[ -n $extra ]]; then
    # shellcheck disable=SC2086,SC2116 # one line
    warn "debloat: not purging ${group[*]} - apt would also remove: $(echo $extra)"
    return 0
  fi
  echo "  purging: ${group[*]}"
  apt-get -o DPkg::Lock::Timeout=600 purge -y -q "${group[@]}" >/dev/null 2>&1 || warn "apt-get purge ${group[*]} failed"
  PURGED+=("${group[@]}")
  CHANGED+=("purged: ${group[*]}")
}
# fwupd: even with its timer masked, fwupd-refresh.service was started by
# other units and kept the daemon alive over D-Bus - so it goes entirely.
purge_group apport
purge_group sysstat
purge_group fwupd
# Compilers and assemblers (Lynis HRDN-7222): nothing is built on the host
# (images build in containers), they usually stay only because apt recommends
# dpkg-dev. Kept when DKMS is installed - it needs them for kernel modules.
if [[ $KW_DEBLOAT_COMPILERS == yes && $(installed dkms) -eq 0 ]]; then
  purge_group build-essential gcc g++ make dpkg-dev binutils
fi

# Leftover config files ("rc") of OLD KERNELS ONLY. Never purge all rc
# packages: the postrm script of Ubuntu's docker.io package deletes
# /var/lib/docker - every image, container and volume - even when docker-ce
# from Docker's repository is the engine in use.
RC=$(dpkg -l | awk '/^rc/ && $2 ~ /^linux-(image|modules|headers)-[0-9]/ {print $2}')
if [[ -n $RC ]]; then
  # shellcheck disable=SC2086 # one package per word
  apt-get -o DPkg::Lock::Timeout=600 purge -y -q $RC >/dev/null 2>&1 || true
fi
if (( ${#PURGED[@]} )) || [[ -n $RC ]]; then
  # Same trap as above: an orphaned docker.io would wipe /var/lib/docker.
  if apt-get autoremove --purge -s 2>/dev/null | grep -qE '^(Purg|Remv) (docker\.io|containerd|docker-ce)'; then
    warn "debloat: skipped apt autoremove - it would remove a Docker package"
  else
    apt-get -o DPkg::Lock::Timeout=600 autoremove --purge -y -q >/dev/null 2>&1 || true
  fi
  apt-get clean
fi
unset -f installed purge_group
echo "  ok"
