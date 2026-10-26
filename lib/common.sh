# shellcheck shell=bash
# Helpers for module scripts. Sourced by lib/apply.sh on the server - module
# install.sh / remove.sh files can use everything in here.
#
#   step "Title"              print a section header
#   put SRC DST [MODE]        install SRC as DST only if it differs; remembers DST as changed
#   seed SRC DST [MODE]       install only if DST does not exist yet (files the dashboard edits)
#   write DST [MODE] <<EOF    like put, but the content comes from stdin (generated files)
#   changed PREFIX            true if any file under PREFIX was changed in this run
#   unit_on UNIT...           daemon-reload, enable --now (timers, services)
#   unit_off UNIT...          disable --now and remove the unit files Keepwatch installed
#   restart_if PREFIX UNIT    restart UNIT if something under PREFIX changed or it is not running
#   enabled MODULE            true if MODULE is in KW_MODULES
#   warn "text"               print a warning (collected and repeated at the end)
#   ask VAR "Prompt"          read a value from the terminal (empty if there is none)
#   ask_secret VAR "Prompt"   like ask, without echo
#   seed_text DST [MODE] <<EOF  like seed, but the content comes from stdin
#   need [--opt] PKG...       apt-get install the packages that are missing (one apt-get update per run;
#                             set APT_FRESH=0 after adding an apt repository)
#   calendar "Sun 01:30"      systemd OnCalendar value in KW_LOCAL_TZ: "Sun *-*-* 01:30:00 Europe/Paris"
#   via_tailscale             true if the SSH session running this deploy comes in over Tailscale
#   deploy_client_ip          the address the deploy's SSH session comes from (also under sudo)

# `generate | write DST` must record DST in CHANGED: run the last command of a
# pipeline in this shell, not in a subshell (works because apply.sh is not interactive).
shopt -s lastpipe

KW_ETC=/etc/keepwatch
KW_STATE=/var/lib/keepwatch
KW_SRV=/srv/keepwatch
CHANGED=()
WARNINGS=()

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { WARNINGS+=("$*"); printf '  \033[33mwarning:\033[0m %s\n' "$*" >&2; }

put() {
  local src=$1 dst=$2 mode=${3:-644}
  if ! cmp -s "$src" "$dst" 2>/dev/null; then
    [[ -d $(dirname "$dst") ]] || mkdir -p "$(dirname "$dst")"
    install -m "$mode" "$src" "$dst"
    CHANGED+=("$dst")
    echo "  updated: $dst"
  fi
}

seed() {
  local src=$1 dst=$2 mode=${3:-644}
  if [[ ! -e $dst ]]; then
    [[ -d $(dirname "$dst") ]] || mkdir -p "$(dirname "$dst")"
    install -m "$mode" "$src" "$dst"
    CHANGED+=("$dst")
    echo "  created: $dst"
  fi
}

write() {
  local dst=$1 mode=${2:-644} tmp
  tmp=$(mktemp)
  cat > "$tmp"
  put "$tmp" "$dst" "$mode"
  rm -f "$tmp"
}

seed_text() {
  local dst=$1 mode=${2:-644} tmp
  tmp=$(mktemp)
  cat > "$tmp"
  seed "$tmp" "$dst" "$mode"
  rm -f "$tmp"
}

changed() { local p; for p in "${CHANGED[@]}"; do [[ $p == "$1"* ]] && return 0; done; return 1; }

unit_on() {
  systemctl daemon-reload
  systemctl enable -q --now "$@"
}

unit_off() {
  local u
  for u in "$@"; do
    systemctl disable -q --now "$u" 2>/dev/null || true
    if [[ -f /etc/systemd/system/$u ]]; then rm -f "/etc/systemd/system/$u"; echo "  removed: $u"; fi
    rm -rf "/etc/systemd/system/$u.d"
  done
  systemctl daemon-reload
}

restart_if() {
  local prefix=$1 unit=$2
  if changed "$prefix" || ! systemctl is-active -q "$unit"; then systemctl restart "$unit"; fi
}

enabled() { [[ " $KW_MODULES " == *" $1 "* ]]; }

# The locals have odd names on purpose: `ask value ...` must not set a local
# of ask itself (printf -v would write into it, not into the caller's variable).
ask() {
  local __kw_var=$1 __kw_prompt=$2 __kw_answer=""
  if [[ -t 0 ]]; then read -rp "  $__kw_prompt " __kw_answer; fi
  printf -v "$__kw_var" '%s' "$__kw_answer"
}

ask_secret() {
  local __kw_var=$1 __kw_prompt=$2 __kw_answer=""
  if [[ -t 0 ]]; then read -rsp "  $__kw_prompt " __kw_answer; echo; fi
  printf -v "$__kw_var" '%s' "$__kw_answer"
}

# apt is slow: only touch it when a package is actually missing.
APT_FRESH=0
need() {
  local p opts=() missing=()
  for p in "$@"; do
    if [[ $p == -* ]]; then opts+=("$p"); continue; fi
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || missing+=("$p")
  done
  (( ${#missing[@]} )) || return 0
  echo "  installing: ${missing[*]}"
  if (( ! APT_FRESH )); then
    apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null 2> >(grep -v UnitMasked >&2)
    APT_FRESH=1
  fi
  # Wait for a running unattended-upgrades instead of failing on the lock.
  apt-get -o DPkg::Lock::Timeout=600 install -y -q "${opts[@]}" "${missing[@]}" >/dev/null 2> >(grep -v UnitMasked >&2)
  CHANGED+=("apt: ${missing[*]}")
}

# systemd accepts a timezone after the time (systemd >= 235), so schedules
# follow KW_LOCAL_TZ including daylight saving time, while the clock stays UTC.
calendar() {
  local t=$1 day="" tz=${KW_LOCAL_TZ:-Etc/UTC}
  if [[ $t == *" "* ]]; then day="${t%% *} "; t=${t##* }; fi
  if [[ ! $t =~ ^[0-9]{1,2}:[0-9]{2}$ ]]; then
    echo "  warning: invalid time '$1', using 03:00" >&2
    t=03:00
  fi
  # An unknown zone would make systemd reject the whole timer. "UTC" needs no
  # zoneinfo file, "Etc/UTC" does.
  [[ -f /usr/share/zoneinfo/$tz ]] || tz=UTC
  printf '%s*-*-* %02d:%02d:00 %s' "$day" "$((10#${t%%:*}))" "$((10#${t##*:}))" "$tz"
}

# SSH_CONNECTION of the session running this deploy. sudo (non-root
# KW_SSH_USER) drops it from the environment - then it is read from the
# environment of the parent processes (the user's shell under sshd).
ssh_connection() {
  if [[ -n ${SSH_CONNECTION:-} ]]; then printf '%s' "$SSH_CONNECTION"; return 0; fi
  local pid=$PPID i v
  for i in 1 2 3 4 5 6 7 8; do
    [[ $pid -gt 1 && -r /proc/$pid/environ ]] || break
    v=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -1 || true)
    if [[ -n $v ]]; then printf '%s' "$v"; return 0; fi
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null || echo 1)
  done
  return 0
}

deploy_client_ip() { ssh_connection | awk '{print $1}'; }

via_tailscale() {
  local server
  server=$(ssh_connection)
  server=$(awk '{print $3}' <<<"$server")
  [[ $server == 100.* || $server == fd7a:115c:a1e0:* ]] || return 1
  # 100.64.0.0/10 only (100.64.x - 100.127.x), not all of 100/8.
  [[ $server == fd7a:* ]] && return 0
  local second=${server#100.}; second=${second%%.*}
  (( second >= 64 && second <= 127 ))
}
