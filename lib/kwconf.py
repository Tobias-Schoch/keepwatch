"""keepwatch.conf and module metadata, shared by the CLI and the setup wizard.

Runs on your computer with any Python >= 3.8, standard library only.

    python3 lib/kwconf.py modules            list modules and whether they are on
    python3 lib/kwconf.py enable  <id>...    switch on (with everything they need)
    python3 lib/kwconf.py disable <id>...    switch off (and everything that needs them)
    python3 lib/kwconf.py get <KEY>          print one value (defaults from the example)
    python3 lib/kwconf.py desktop-json       config for the macOS app

Used by ./keepwatch deploy for module switches made in the dashboard (see README):

    python3 lib/kwconf.py take-over <override.json> <deployed.conf> --ask|--accept|--keep|--report
    python3 lib/kwconf.py override-synced <override.json> "<KW_MODULES as deployed>" [--remind]
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "keepwatch.conf.example"
CONF = Path(os.environ.get("KW_CONF_FILE", ROOT / "keepwatch.conf"))
LINE = re.compile(r'^(KW_[A-Z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|(\S*))(.*)$')


# --- Modules -----------------------------------------------------------------

def _meta(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r'^([A-Z_]+)="(.*)"\s*$', line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def modules() -> dict:
    """id -> {name, summary, requires: [...], order}, sorted by order."""
    found = {}
    for d in (ROOT / "modules").iterdir():
        if (d / "module.conf").is_file():
            m = _meta(d / "module.conf")
            found[d.name] = {"name": m.get("NAME", d.name), "summary": m.get("SUMMARY", ""),
                             "requires": m.get("REQUIRES", "").split(), "order": int(m.get("ORDER", "50"))}
    return dict(sorted(found.items(), key=lambda kv: kv[1]["order"]))


def with_requirements(wanted: set, mods: dict | None = None) -> set:
    """`wanted` plus everything it needs (transitively), always with base."""
    mods = mods or modules()
    out, todo = set(), list(wanted | {"base"})
    while todo:
        m = todo.pop()
        if m in out:
            continue
        if m not in mods:
            raise SystemExit(f"Unknown module: {m} (see ./keepwatch modules)")
        out.add(m)
        todo.extend(mods[m]["requires"])
    return out


def dependents(of: set, active: set, mods: dict | None = None) -> set:
    """Active modules that (transitively) need one of `of`."""
    mods = mods or modules()
    out, grew = set(of), True
    while grew:
        grew = False
        for m in active - out:
            if set(mods[m]["requires"]) & out:
                out.add(m)
                grew = True
    return out


def ordered(ids: set, mods: dict | None = None) -> list:
    mods = mods or modules()
    return [m for m in mods if m in ids]


# --- Configuration ----------------------------------------------------------------

def _unquote(s: str) -> str:
    return re.sub(r"\\(.)", r"\1", s)


def _quote(v: str) -> str:
    return '"' + re.sub(r'(["\\$`])', r"\\\1", str(v)) + '"'


def parse(path: Path) -> dict:
    out = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            m = LINE.match(line)
            if m:
                out[m.group(1)] = _unquote(m.group(2)) if m.group(2) is not None else m.group(3)
    return out


def load() -> dict:
    """Defaults from the example, the real configuration on top (same as on the server)."""
    return {**parse(EXAMPLE), **parse(CONF)}


def save(values: dict, path: Path = CONF) -> None:
    """Write `values` into the configuration, keeping every comment.

    An existing file keeps its layout and only changes the given keys; a new
    file starts from the example, so the documentation travels with it.
    """
    path = path.resolve()  # a symlink (dotfiles repo) stays a symlink; its target gets the change
    base = path if path.is_file() else EXAMPLE
    lines, seen = base.read_text().splitlines(), set()
    for i, line in enumerate(lines):
        m = LINE.match(line)
        if m and m.group(1) in values:
            key, rest = m.group(1), m.group(4)
            new = f"{key}={_quote(values[key])}"
            # Keep the inline comment in its column (or one space after a longer value).
            c = re.match(r"^\s*(#.*)$", rest)
            if c:
                new = new.ljust(line.index(c.group(1)) - 1) + " " + c.group(1)
            lines[i] = new
            seen.add(key)
    extra = [k for k in values if k not in seen]
    if extra:
        lines += ["", "# --- added by keepwatch ---"] + [f"{k}={_quote(values[k])}" for k in extra]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    if path.is_file():
        os.chmod(tmp, path.stat().st_mode & 0o7777)
    os.replace(tmp, path)


def active(conf: dict | None = None) -> set:
    conf = conf or load()
    return set(conf.get("KW_MODULES", "").split()) | {"base"}


def extra_uis(conf: dict) -> list:
    """KW_EXTRA_UIS="Name=port Other_name=port/start/path/": underscores become spaces; the optional
    path is where the UI opens (for UIs whose "/" redirects to an internal container port)."""
    out = []
    for item in conf.get("KW_EXTRA_UIS", "").split():
        name, _, rest = item.rpartition("=")
        port, slash, path = rest.partition("/")
        if name and port.isdigit():
            ui = {"name": name.replace("_", " "), "port": int(port)}
            if slash:
                ui["path"] = "/" + path
            out.append(ui)
    return out


def desktop_json(conf: dict) -> dict:
    on = active(conf)
    uis = []
    if "dashboard" in on:
        uis.append({"name": "Dashboard", "port": int(conf.get("KW_DASHBOARD_PORT", 9004))})
    if "portainer" in on:
        uis.append({"name": "Portainer", "port": int(conf.get("KW_PORTAINER_PORT", 9002))})
    if "proxy" in on:
        uis.append({"name": "Proxy Manager", "port": int(conf.get("KW_PROXY_ADMIN_PORT", 9001))})
    uis += extra_uis(conf)
    return {"host": conf.get("KW_HOST", ""), "user": conf.get("KW_SSH_USER", "root"),
            "sshPort": int(conf.get("KW_SSH_PORT", 22) or 22),
            "requireTailscale": "tailscale" in on, "uis": uis}


# --- Module switches from the dashboard ----------------------------------------------
# The dashboard switches add-ons on the server: /etc/keepwatch/modules-override.json,
# {"on": [...], "off": [...]}, and the server runs KW_MODULES + on - off. So a deploy cannot
# undo such a switch, but keepwatch.conf and the server would drift apart unnoticed. Deploy
# reads the file before it copies, says what was switched and offers to write it into
# keepwatch.conf - only you decide that. What keepwatch.conf agrees with after the deploy is
# cleared on the server (keepwatch-modules sync-done): keepwatch.conf is the one place again.

MODULE_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")  # ids end up in a command line on the server


def read_override(path: Path) -> tuple:
    """(on, off, problem) from the file deploy fetched. Absent or empty: no switches.
    Unreadable counts as none too - nothing is taken over or cleared because of it."""
    try:
        text = path.read_text()
    except (OSError, UnicodeDecodeError):
        text = ""
    if not text.strip():
        return [], [], ""
    try:
        data = json.loads(text)
    except ValueError:
        return [], [], "not valid JSON"
    if not isinstance(data, dict):
        return [], [], "not a JSON object"
    lists = []
    for key in ("on", "off"):
        v = data.get(key) or []
        if not isinstance(v, list):
            return [], [], f'"{key}" is not a list'
        ids = []
        for m in v:
            if isinstance(m, str) and m not in ids:
                ids.append(m)
        lists.append(ids)
    on, off = lists
    both = set(on) & set(off)
    problem = f"{', '.join(sorted(both))}: both on and off, ignored" if both else ""
    return [m for m in on if m not in both], [m for m in off if m not in both], problem


def _deployed_modules(path: Path):
    """KW_MODULES of the keepwatch.conf the last deploy copied; None on a first deploy."""
    v = parse(path).get("KW_MODULES")
    return None if v is None else set(v.split()) | {"base"}


def _show(m: str) -> str:
    """An id from the server's file, safe for the terminal (no escape sequences)."""
    return m if MODULE_ID.match(m) else ascii(m)


def _switches(on: list, off: list) -> str:
    return ", ".join([f"{_show(m)} on" for m in on] + [f"{_show(m)} off" for m in off])


def _yes(prompt: str) -> bool:
    try:
        a = input(prompt)
    except EOFError:
        print()
        return False
    return not a.strip().lower().startswith("n")


def take_over(override: Path, deployed: Path, how: str) -> int:
    """Before deploy copies keepwatch.conf. how: ask (a terminal), accept (--take-over-modules),
    keep (no terminal, --yes: keepwatch.conf stays as it is), report (--dry-run)."""
    mods = modules()
    on, off, problem = read_override(override)
    if problem and not (on or off):
        print(f"  note: the dashboard's module switches on the server are unreadable ({problem});"
              " nothing taken over.")
        return 0
    if not (on or off):
        return 0
    local, before = active(), _deployed_modules(deployed)

    print("\n\033[1m== Module switches from the dashboard\033[0m")
    print(f"  Switched in the dashboard since your last deploy: {_switches(on, off)}.")
    if problem:
        print(f"  note: {problem}")
    unknown = [m for m in on + off if m not in mods or not MODULE_ID.match(m)]
    if unknown:
        print(f"  {', '.join(map(_show, unknown))}: unknown to this copy of Keepwatch (git pull?)"
              " - stays as it is on the server.")
    if "base" in off:
        print("  base cannot be switched off - ignored.")
    on = [m for m in on if m not in unknown]
    off = [m for m in off if m not in unknown and m != "base"]
    take_on = [m for m in on if m not in local]
    take_off = [m for m in off if m in local]
    same = [m for m in on + off if m not in take_on + take_off]
    if same:
        later = "" if how == "report" else " - cleared on the server after this deploy"
        print(f"  keepwatch.conf already says the same for {', '.join(same)}{later}.")
    # Changed in keepwatch.conf since the last deploy, the other way round than the dashboard.
    for m in take_on + take_off:
        if before is not None and (m in before) != (m in local):
            here, there = ("off", "on") if m in take_on else ("on", "off")
            print(f"  Conflict: you switched {m} {here} in keepwatch.conf since the last deploy, the dashboard"
                  f" switched it {there}. The dashboard's choice stays in effect on the server until"
                  " keepwatch.conf agrees.")
    if not (take_on or take_off):
        return 0

    new = with_requirements(local | set(take_on), mods)
    new -= dependents(set(take_off), new, mods)
    if not set(on) <= new or new & set(off):
        print("  These switches contradict each other here (one needs what another switches off)"
              " - keepwatch.conf unchanged.")
        return 0
    extra_on = ordered(new - local - set(take_on), mods)
    extra_off = ordered(local - new - set(take_off), mods)
    extra = [f"switches on {m} (needed by {', '.join(n for n in take_on if m in with_requirements({n}, mods))})"
             for m in extra_on]
    extra += [f"switches off {m} (it needs {', '.join(n for n in take_off if n in with_requirements({m}, mods))})"
              for m in extra_off]
    also = "; it also ".join(extra)
    keep = (f"keepwatch.conf unchanged: the dashboard's choice ({_switches(take_on, take_off)}) stays in effect"
            " on the server, the next deploy asks again.")

    if how == "report":
        print("  Dry run: keepwatch.conf stays as it is; a deploy asks whether to take this over.")
        if extra:
            print(f"  Taking it over also {also}.")
        return 0
    if how == "keep":
        print(f"  \033[33mwarning:\033[0m {keep} To take it over: ./keepwatch deploy --take-over-modules")
        return 0
    if how == "ask":
        if not _yes("  Take this over into keepwatch.conf? [Y/n] ") or \
                (extra and not _yes(f"  That also {also}. Go ahead? [Y/n] ")):
            print(f"  {keep}")
            return 0
    elif extra_off:  # accept: switching off more than the dashboard did needs a person to say so
        print(f"  \033[33mwarning:\033[0m taking this over also {also} - not without asking. {keep}")
        return 0

    save({"KW_MODULES": " ".join(ordered(new, mods))})
    g, r, x = ("\033[32m", "\033[31m", "\033[0m") if sys.stdout.isatty() else ("",) * 3
    for m in ordered(new - local, mods):
        print(f"  {g}+ {m}{x}{'' if m in take_on else '  (needed)'}")
    for m in ordered(local - new, mods):
        print(f"  {r}- {m}{x}{'' if m in take_off else '  (needs a disabled module)'}")
    print(f"  written to {CONF.name}")
    return 0


def override_synced(override: Path, deployed_modules: str, remind: bool) -> int:
    """After a successful deploy: prints the switches keepwatch.conf (as deployed) agrees with,
    for keepwatch-modules sync-done. Read again after the apply, so a switch made meanwhile stays."""
    mods = modules()
    on, off, _ = read_override(override)
    sent = set(deployed_modules.split()) | {"base"}
    done = [m for m in on if m in sent] + [m for m in off if m not in sent]
    done = [m for m in done if m in mods and MODULE_ID.match(m)]
    left_on = [m for m in on if m not in done]
    left_off = [m for m in off if m not in done]
    if remind and (left_on or left_off):
        print(f"  note: the dashboard's module switches stay in effect on the server ({_switches(left_on, left_off)});"
              " the next deploy asks whether keepwatch.conf takes them over.", file=sys.stderr)
    print(" ".join(done))
    return 0


# --- CLI ----------------------------------------------------------------------------

def _cli(argv: list) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    mods = modules()
    if cmd == "get" and args:
        print(load().get(args[0], ""))
        return 0
    if cmd == "desktop-json":
        print(json.dumps(desktop_json(load()), indent=2))
        return 0
    if not CONF.is_file():
        print("No keepwatch.conf yet - run ./keepwatch setup first.", file=sys.stderr)
        return 1
    if cmd == "take-over" and len(args) == 3 and args[2] in ("--ask", "--accept", "--keep", "--report"):
        return take_over(Path(args[0]), Path(args[1]), args[2][2:])
    if cmd == "override-synced" and len(args) in (2, 3):
        return override_synced(Path(args[0]), args[1], args[2:] == ["--remind"])
    on = active()
    g, r, d, x =("\033[32m", "\033[31m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("",) * 4
    if cmd == "modules":
        width = max(len(m) for m in mods)
        for m, info in mods.items():
            mark = f"{g} on{x}" if m in on else f"{d}off{x}"
            need = f"  {d}(needs {', '.join(info['requires'])}){x}" if info["requires"] else ""
            print(f"  {mark}  {m:<{width}}  {info['summary']}{need}")
        print("\n  ./keepwatch enable <module> / disable <module>, then ./keepwatch deploy")
        return 0
    if cmd == "validate":
        # Before deploy connects: a hand-edited KW_MODULES with an unknown
        # module or a missing requirement is refused here, not on the server.
        for m in sorted(on):
            if m not in mods:
                print(f"Unknown module in KW_MODULES: {m} (see ./keepwatch modules)", file=sys.stderr)
                return 1
        for m in ordered(on, mods):
            for need in mods[m]["requires"]:
                if need not in on:
                    print(f"Module {m} needs {need}: ./keepwatch enable {need}  (or ./keepwatch disable {m})",
                          file=sys.stderr)
                    return 1
        return 0
    if cmd in ("enable", "disable"):
        if not args:
            print(f"usage: ./keepwatch {cmd} <module>...", file=sys.stderr)
            return 2
        for m in args:
            if m not in mods:
                print(f"Unknown module: {m}", file=sys.stderr)
                return 1
        if cmd == "enable":
            new = with_requirements(on | set(args), mods)
        else:
            if "base" in args:
                print("base cannot be disabled.", file=sys.stderr)
                return 1
            new = on - dependents(set(args), on, mods)
        added, removed = new - on, on - new
        if not added and not removed:
            print("  nothing to change")
            return 0
        save({"KW_MODULES": " ".join(ordered(new, mods))})
        for m in ordered(added, mods):
            print(f"  {g}+ {m}{x}{'' if m in args else '  (needed)'}")
        for m in ordered(removed, mods):
            print(f"  {r}- {m}{x}{'' if m in args else '  (needs a disabled module)'}")
        print("\n  Apply with: ./keepwatch deploy")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
