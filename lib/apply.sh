#!/bin/bash
# Brings this server in line with keepwatch.conf. Runs on the server as root;
# `./keepwatch deploy` copies the repository to /opt/keepwatch and starts it.
#
#   bash /opt/keepwatch/lib/apply.sh               apply all enabled modules
#   bash /opt/keepwatch/lib/apply.sh --only a,b    only these modules
#   bash /opt/keepwatch/lib/apply.sh --dry-run     show what would run, change nothing
#
# Safe to run any number of times: every module only changes what differs and
# only restarts services whose configuration changed. Modules that were
# enabled on the last run and are no longer in KW_MODULES are uninstalled
# (their remove.sh); their data is kept. Add-ons switched in the dashboard
# (/etc/keepwatch/modules-override.json) count as if they were in KW_MODULES.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8

KW_ROOT=$(cd "$(dirname "$0")/.." && pwd)
ONLY="" DRY=0
while (( $# )); do
  case $1 in
    --only) ONLY=" ${2//,/ } "; shift ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

# One run at a time: ./keepwatch deploy from a computer, an update from the dashboard
# (keepwatch-self-update holds this lock itself around swapping /opt/keepwatch and runs
# us with KW_LOCKED=1), or this script by hand. A dry run changes nothing and needs no lock.
if (( ! DRY )) && [[ ${KW_LOCKED:-} != 1 ]]; then
  exec 9>>/run/keepwatch.lock
  if ! flock -n 9; then
    echo "  waiting for another Keepwatch run to finish (a deploy, or an update from the dashboard) ..."
    flock -w 1800 9 || { echo "Still busy after 30 minutes - try again later." >&2; exit 1; }
  fi
fi

source "$KW_ROOT/lib/common.sh"

# Defaults from the example, then the real configuration on top: a setting
# added in a newer Keepwatch version works without editing old configs.
# A dry run reads the new configuration where deploy put it and installs nothing.
CONF=$KW_ETC/keepwatch.conf
if (( DRY )); then
  [[ -f $KW_ROOT/keepwatch.conf ]] && CONF=$KW_ROOT/keepwatch.conf
else
  install -d -m 755 "$KW_ETC" "$KW_STATE"
  [[ -f $KW_ROOT/keepwatch.conf ]] && put "$KW_ROOT/keepwatch.conf" "$KW_ETC/keepwatch.conf"
fi
[[ -f $CONF ]] || { echo "No $CONF - run ./keepwatch setup on your computer first." >&2; exit 1; }
set -a
source "$KW_ROOT/keepwatch.conf.example"
source "$CONF"
set +a

. /etc/os-release
case "$ID $VERSION_ID" in
  "ubuntu 24.04"|"ubuntu 22.04") ;;
  *) warn "Keepwatch is tested on Ubuntu 24.04 and 22.04; this is $PRETTY_NAME." ;;
esac

# --- Which modules, in which order -----------------------------------------
meta() { (source "$KW_ROOT/modules/$1/module.conf"; eval "printf '%s' \"\$$2\""); }
ALL=$(for d in "$KW_ROOT"/modules/*/; do m=$(basename "$d"); printf '%s %s\n' "$(meta "$m" ORDER)" "$m"; done | sort -n | awk '{print $2}')
# Word by word: a substring replacement would also cut "base" out of other names.
_mods=" base "
for m in $KW_MODULES; do [[ $m == base || $_mods == *" $m "* ]] || _mods+="$m "; done
KW_MODULES=$_mods
unset _mods
# Add-ons switched on or off in the dashboard (keepwatch-modules, lib/kwmodules.py):
# KW_MODULES + on - off. A deploy keeps them until keepwatch.conf takes them over - without
# this, the next deploy would uninstall what the dashboard switched on.
if [[ -s $KW_ETC/modules-override.json ]]; then
  command -v python3 >/dev/null || { echo "$KW_ETC/modules-override.json needs python3 - apt-get install python3" >&2; exit 1; }
  # shellcheck disable=SC2086 # one module per word
  _eff=$(python3 "$KW_ROOT/lib/kwmodules.py" effective --root "$KW_ROOT" -- $KW_MODULES) || exit 1
  while IFS= read -r _l; do
    case $_l in
      "modules "*) KW_MODULES=" ${_l#modules } " ;;
      "switched "*) echo "  modules switched in the dashboard: ${_l#switched }" ;;
      "warn "*) warn "${_l#warn }" ;;
    esac
  done <<<"$_eff"
  unset _eff _l
fi
for m in $KW_MODULES; do
  [[ -d $KW_ROOT/modules/$m ]] || { echo "Unknown module in KW_MODULES: $m (see ./keepwatch modules)" >&2; exit 1; }
  for r in $(meta "$m" REQUIRES); do
    enabled "$r" || { echo "Module $m needs $r - add it to KW_MODULES or remove $m." >&2; exit 1; }
  done
done
# (|| true: on the first run the file does not exist, and pipefail would end the run here)
PREVIOUS=" $(cat "$KW_STATE/modules" 2>/dev/null | tr '\n' ' ' || true) "
# shellcheck disable=SC2086 # one module per word
REMOVE=$(printf '%s\n' $PREVIOUS | tac | while read -r m; do [[ -n $m ]] && ! enabled "$m" && [[ -d $KW_ROOT/modules/$m ]] && echo "$m"; done || true)
RUN=$(for m in $ALL; do enabled "$m" && [[ -z $ONLY || $ONLY == *" $m "* ]] && echo "$m"; done || true)

if (( ! DRY )); then
  # A fresh cloud server may still be installing packages from cloud-init
  # (and holding the apt lock) right after the first boot.
  if command -v cloud-init >/dev/null; then
    timeout 600 cloud-init status --wait >/dev/null 2>&1 || true
  fi
  # An interrupted dpkg run (e.g. a reboot during updates) blocks every apt call.
  if [[ -n $(dpkg --audit 2>/dev/null) ]]; then
    echo "  dpkg was interrupted earlier - finishing it first (dpkg --configure -a)"
    dpkg --configure -a >/dev/null 2>&1 || warn "dpkg --configure -a failed - check: dpkg --audit"
  fi
fi

if (( DRY )); then
  echo "would apply:  $(tr '\n' ' ' <<<"$RUN")"
  echo "would remove: $(tr '\n' ' ' <<<"${REMOVE:-nothing}")"
  exit 0
fi

# --- Remove what was switched off, newest first ------------------------------
# A command that fails inside a module ends the run (set -e) - say where.
CURRENT=""
trap 'echo "  error: module ${CURRENT:-?} stopped at a failing command (line $LINENO) - nothing after it ran" >&2' ERR
for m in $REMOVE; do
  [[ -z $ONLY || $ONLY == *" $m "* ]] || continue
  CURRENT="$m (remove)"
  step "Remove: $(meta "$m" NAME)"
  MOD=$KW_ROOT/modules/$m F=$MOD/files
  if [[ -f $MOD/remove.sh ]]; then source "$MOD/remove.sh"; else echo "  nothing to undo"; fi
  PREVIOUS=${PREVIOUS// $m / }
done

# --- Apply ----------------------------------------------------------------------
APPLIED=()
for m in $RUN; do
  CURRENT=$m
  step "$(meta "$m" NAME)"
  MOD=$KW_ROOT/modules/$m F=$MOD/files
  source "$MOD/install.sh"
  APPLIED+=("$m")
done

trap - ERR

# Remember what is installed: the next run uninstalls whatever leaves KW_MODULES.
{ for m in $ALL; do enabled "$m" || [[ $PREVIOUS == *" $m "* ]] && echo "$m"; done; } > "$KW_STATE/modules" || true

# --- Summary ----------------------------------------------------------------------
step "Done"
if (( ${#CHANGED[@]} )); then printf '  changed: %s\n' "${CHANGED[@]}"; else echo "  nothing changed - the server matches the configuration"; fi
for w in "${WARNINGS[@]}"; do printf '  \033[33mwarning:\033[0m %s\n' "$w"; done

# One line per deploy for the dashboard timeline (the version from VERSION.json, written by
# deploy or by an update from the dashboard - KW_VIA=dashboard). A module switched in the
# dashboard runs with KW_VIA=dashboard too (no SSH session either) and adds "switch": "+lynis".
KW_VIA=${KW_VIA:-deploy} python3 - "$KW_ROOT/VERSION.json" "$KW_STATE/deploys.jsonl" "${CHANGED[@]}" <<'PY' || true
import json, os, sys, time
info, out = {}, sys.argv[2]
try:
    info = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    pass
rec = {"t": time.time(), "commit": (info.get("commit") or "")[:7] or None, "subject": info.get("subject"),
       "dirty": info.get("dirty"), "changed": sys.argv[3:], "via": os.environ.get("KW_VIA")}
if os.environ.get("KW_SWITCH"):
    rec["switch"] = os.environ["KW_SWITCH"]
line = json.dumps(rec, ensure_ascii=False)
try:
    old = open(out).read().splitlines()[-999:]
except OSError:
    old = []
with open(out + ".tmp", "w") as f:
    f.write("\n".join(old + [line]) + "\n")
os.replace(out + ".tmp", out)
PY
