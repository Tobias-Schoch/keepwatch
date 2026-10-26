# Contributing

Thanks for helping! Keepwatch manages servers people care about, so the bar is: readable, idempotent,
and reversible.

## Layout

```
keepwatch                 CLI (runs on your computer)
keepwatch.conf.example    every setting, with defaults - the contract between all parts
lib/                      wizard, deploy, tunnel, check (your computer) · apply.sh + common.sh (server)
modules/<id>/             one module: module.conf, install.sh, remove.sh, files/
dashboard/server/         dashboard backend (Python, standard library only)
dashboard/web/            dashboard UI (Vite + React + TypeScript)
desktop/                  macOS app (Swift)
```

## Writing a module

1. `modules/<id>/module.conf`:
   ```sh
   NAME="Human name"
   SUMMARY="One sentence: what it does for the user."
   REQUIRES="docker"      # other module ids, space separated
   ORDER="80"             # position in the deploy run (base 10 ... dashboard 99)
   ```
2. `install.sh` is sourced by `lib/apply.sh` on every deploy. It must be **idempotent**: change only what
   differs (`put`, `seed`, `write` from `lib/common.sh`), restart only what changed (`changed`,
   `restart_if`). Files you ship go in `files/` (`$F`). Settings come from `KW_*` variables; add new
   ones to `keepwatch.conf.example` with a short comment.
3. `remove.sh` runs when the module is switched off. Undo everything `install.sh` installed (units,
   configs, firewall rules) and **never delete user data**. Say what was kept.
4. Never lock the user out: anything touching SSH or the firewall must keep a working way in.
5. If the dashboard should show it, the backend checks `config.enabled("<id>")` and the UI hides its
   parts when the module is off.

## Checks

```sh
shellcheck -x -S warning keepwatch lib/*.sh modules/*/*.sh
python3 -m py_compile lib/*.py dashboard/server/*.py
cd dashboard/web && npm ci && npm run build
```

Test on a throwaway VPS (or a local VM with Ubuntu 24.04) before opening a pull request that changes
`modules/`, and mention what you tested. `./keepwatch deploy --dry-run` shows the plan without changes.

## Style

English everywhere. Comments explain *why* (the trap, the incident, the trade-off), not what the next
line does. Keep dependencies at zero on the server: bash, coreutils, Python standard library.
