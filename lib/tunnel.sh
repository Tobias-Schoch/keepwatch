# shellcheck shell=bash
# Sourced by ./keepwatch tunnel: forwards the admin UIs (all bound to 127.0.0.1 on
# the server) to this computer. Local port = 10000 + server port, like the macOS
# app, so browser logins (stored per origin) survive between the two.

UIS=$(python3 "$LIB/kwconf.py" desktop-json | python3 -c '
import json, sys
for u in json.load(sys.stdin)["uis"]:
    print(u["port"], u.get("path") or "/", u["name"])')
[[ -n $UIS ]] || { echo "No admin UI enabled (dashboard, proxy, portainer or KW_EXTRA_UIS)." >&2; exit 1; }

FWD=()
echo
while read -r port path name; do
  lp=$((10000 + port))
  if (exec 3<>"/dev/tcp/127.0.0.1/$lp") 2>/dev/null; then
    echo "  port $lp is in use on this computer (the macOS app or another tunnel?) - close it first." >&2
    exit 1
  fi
  FWD+=(-L "$lp:127.0.0.1:$port")
  [[ $path == / ]] && path=""
  printf '  %-16s http://localhost:%s%s\n' "$name" "$lp" "$path"
done <<<"$UIS"
echo
echo "  Tunnel open - Ctrl+C closes it."

first=$(head -1 <<<"$UIS" | awk '{print $1}')
( sleep 2
  url="http://localhost:$((10000 + first))"
  if command -v open >/dev/null; then open "$url"; elif command -v xdg-open >/dev/null; then xdg-open "$url" >/dev/null 2>&1; fi
) &
exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "${SSH_OPTS[@]}" "${FWD[@]}" "$TARGET"
