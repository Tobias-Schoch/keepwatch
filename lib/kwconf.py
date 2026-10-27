"""keepwatch.conf and module metadata, shared by the CLI and the setup wizard.

Runs on your computer with any Python >= 3.8, standard library only.

    python3 lib/kwconf.py modules            list modules and whether they are on
    python3 lib/kwconf.py enable  <id>...    switch on (with everything they need)
    python3 lib/kwconf.py disable <id>...    switch off (and everything that needs them)
    python3 lib/kwconf.py get <KEY>          print one value (defaults from the example)
    python3 lib/kwconf.py desktop-json       config for the macOS app
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
    on = active()
    g, r, d, x = ("\033[32m", "\033[31m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("",) * 4
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
