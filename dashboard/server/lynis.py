"""Hardening audit with Lynis - add-on module of the Keepwatch dashboard (module "lynis").

The run itself is done by keepwatch-lynis (keepwatch-lynis.service, timer at KW_LYNIS_TIME
or "Check now"). It writes config.LYNIS_JSON: the last run (index, warnings, suggestions
per test ID with sub-findings) and the history.

Here it is only read and judged:
  - Exceptions from config.LYNIS_EXCEPTIONS (/etc/keepwatch/lynis-exceptions.conf, repository:
    modules/lynis/files/exceptions.conf): "TEST-ID[:sub-finding]  reason" -> "deliberate"
    instead of open. Takes effect at once, without a new run.
  - Short title and explanation (TITLES below), link to the CISOfy documentation per test ID.
  - New run -> one timeline event (warn when the index drops or a warning is new);
    health: open Lynis warnings, dropped index, audit not running.

Hooked into dashboard.py (import, route /api/lynis, thread, problems() in health()) like
updates.py; it gets the helpers from there at runtime through sys.modules["dashboard"].

To try it without the dashboard (read only):
  ssh root@server python3 /opt/keepwatch/dashboard/server/lynis.py   (judgement of the last run as text)
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import threading
import time
import traceback
from pathlib import Path

import config

UNIT = config.UNITS["lynis"] + ".service"
EXCEPTIONS = list(config.LYNIS_EXCEPTIONS)
STALE_AFTER = 15 * 86400  # two weeks without a run -> health reports it
WATCH_EVERY = 60
DOC = "https://cisofy.com/lynis/controls/{}/"
LINK = {"view": "security", "sel": ".s-fact-label", "text": "Hardening", "exact": True, "up": ".s-fact"}

# Short title and explanation per test ID. Anything missing shows the text from Lynis.
TITLES: dict[str, tuple[str, str]] = {
    "LYNIS": ("Lynis is outdated", "A newer Lynis version knows more tests."),
    "BOOT-5122": ("No password for the boot menu", "Anyone at the console can change the boot in the GRUB menu (e.g. single user without password)."),
    "BOOT-5264": ("Services without sandbox", "systemd can confine services (ProtectSystem, PrivateTmp, NoNewPrivileges ...). "
                  "Rating per service: systemd-analyze security <service>. Worth it mainly for your own units."),
    "KRNL-5820": ("Core dumps allowed", "A crashing process can write its memory - with keys and passwords - to disk. "
                  "Off: \"* hard core 0\" in /etc/security/limits.d, Storage=none in systemd-coredump, fs.suid_dumpable=0."),
    "KRNL-6000": ("Kernel settings (sysctl) looser than recommended", "Some sysctl values differ from the hardening baseline. Set them in a file in /etc/sysctl.d/."),
    "AUTH-9230": ("Password hashing rounds not set", "SHA_CRYPT_MIN/MAX_ROUNDS in /etc/login.defs."),
    "AUTH-9262": ("No password strength rules", "A PAM module such as pam_pwquality is missing."),
    "AUTH-9282": ("Passwords never expire", "Accounts with a password have no expiry date."),
    "AUTH-9286": ("No minimum/maximum password age", "PASS_MIN_DAYS / PASS_MAX_DAYS in /etc/login.defs."),
    "AUTH-9328": ("Default umask 022", "New files are readable by everyone; 027 would be stricter."),
    "FILE-6310": ("No separate partitions", "If /home, /tmp or /var fills up, the whole system is affected."),
    "FILE-7524": ("File permissions looser than recommended", "Some system files are readable by everyone that only root needs to read (chmod)."),
    "USB-1000": ("USB storage allowed", "The usb-storage driver is not blocked."),
    "NAME-4028": ("No DNS domain name", "The server has no fully qualified domain name."),
    "PKGS-7370": ("debsums missing", "Checks installed package files against their checksums."),
    "PKGS-7394": ("apt-show-versions missing", "Helper to compare package versions."),
    "NETW-3200": ("Rare network protocols can be loaded", "Nobody here needs DCCP, SCTP, RDS and TIPC, but they have had serious kernel bugs. "
                  "Block them with \"install <module> /bin/false\" in /etc/modprobe.d/."),
    "FIRE-4513": ("Firewall rules without hits", "Rules that never matched - unnecessary or for rare cases."),
    "SSH-7408": ("SSH settings looser than recommended", "Some sshd options differ from the hardening baseline."),
    "LOGG-2154": ("Logs only on the server", "Whoever becomes root can erase the traces. Remedy: ship logs off the server promptly "
                  "(remote syslog/log service) or at least back up /var/log/journal."),
    "LOGG-2190": ("Deleted files still in use", "Processes keep deleted files open - often old program versions after updates."),
    "BANN-7126": ("No warning text in /etc/issue", "Legal notice before login on the console."),
    "BANN-7130": ("No warning text in /etc/issue.net", "Legal notice before login over the network."),
    "ACCT-9622": ("No process accounting", "acct logs every command that is started."),
    "ACCT-9626": ("sysstat is not collecting", "Performance data via sysstat/sar."),
    "FINT-4350": ("No file integrity tool", "AIDE and similar tools regularly compare checksums of important files."),
    "TOOL-5002": ("No automation tool detected", "Lynis looks for Ansible, Puppet, Chef ..."),
    "HRDN-7222": ("Compilers executable by everyone", "gcc and friends help an intruder build their own code. Best removed "
                  "(build-essential, gcc, g++, make, dpkg-dev) if nothing is built on the host - builds happen in containers."),
    "HRDN-7230": ("No malware scanner", "Lynis expects rkhunter, chkrootkit, ClamAV or similar."),
    "PKGS-7392": ("Packages with vulnerabilities", "There are security updates that are not installed yet."),
    "SSH-7440": ("SSH: AllowUsers/AllowGroups missing", "Login is not restricted to specific users."),
    "AUTH-9308": ("Single-user mode without password", "The rescue mode does not ask for a password."),
    "MAIL-8818": ("Mail server reveals itself", "The SMTP banner shows software and version."),
    "FIRE-4512": ("iptables without rules", "The firewall is empty."),
    "NETW-2705": ("Only one DNS server", "If it fails, the server can no longer resolve names."),
}


def D():
    return sys.modules["dashboard"]


def _state_file() -> Path:
    return config.LYNIS_JSON


_CACHE: dict = {"data": (None, None), "exc": (None, None), "unit": (0.0, {})}
_LOCK = threading.Lock()


def _mtime(p: Path) -> float | None:
    try:
        return p.stat().st_mtime
    except OSError:
        return None


def load() -> dict | None:
    """lynis.json, read again only when the file changed."""
    p = _state_file()
    m = _mtime(p)
    with _LOCK:
        if m is None:
            _CACHE["data"] = (None, None)
            return None
        if _CACHE["data"][0] != m:
            try:
                _CACHE["data"] = (m, json.loads(p.read_text()))
            except (OSError, ValueError):
                _CACHE["data"] = (m, None)
        return _CACHE["data"][1]


def exceptions() -> tuple[dict[str, str], str | None]:
    """Key (TEST-ID or TEST-ID:sub, sub in lower case) -> reason."""
    path = next((p for p in EXCEPTIONS if p.exists()), None)
    if not path:
        return {}, None
    m = _mtime(path)
    with _LOCK:
        if _CACHE["exc"][0] != (str(path), m):
            out: dict[str, str] = {}
            try:
                for line in path.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    key, _, why = line.partition(" ")
                    tid, _, sub = key.partition(":")
                    out[f"{tid.upper()}:{sub.lower()}" if sub else tid.upper()] = why.strip() or "deliberate"
            except OSError:
                pass
            _CACHE["exc"] = ((str(path), m), out)
        return _CACHE["exc"][1], str(path)


def _reason(exc: dict[str, str], tid: str, key: str | None) -> str | None:
    return exc.get(tid) or (exc.get(key) if key else None)


def _is_more(key: str) -> bool:
    return key.endswith((":…", ":..."))  # "more" marker from keepwatch-lynis


def judge(f: dict, exc: dict[str, str]) -> dict:
    """One finding judged against the exceptions: open, otherwise deliberate (with reason)."""
    tid = f["id"]
    items = []
    for i in f.get("items") or []:
        why = None if _is_more(i["key"]) else _reason(exc, tid, i["key"])
        items.append({**i, "open": why is None and not _is_more(i["key"]), "reason": why})
    whole = exc.get(tid)
    real = [i for i in items if not _is_more(i["key"])]
    is_open = whole is None and (any(i["open"] for i in real) if real else True)
    reasons = sorted({i["reason"] for i in real if i["reason"]})
    title, hint = TITLES.get(tid, (None, None))
    return {"id": tid, "kind": f.get("kind", "suggestion"), "title": title or f.get("text") or tid, "hint": hint,
            "text": f.get("text"), "detail": f.get("detail"), "solution": f.get("solution"),
            "url": DOC.format(tid) if "-" in tid else None, "open": is_open,
            "reason": whole or ("; ".join(reasons) if reasons and not is_open else None),
            "items": items}


def _open_keys(fs: dict[str, list[str]] | None, exc: dict[str, str]) -> set[str]:
    """Open keys of a run from the history (TEST-ID for findings without sub-findings)."""
    out = set()
    for tid, keys in (fs or {}).items():
        if exc.get(tid):
            continue
        keys = [k for k in keys if not _is_more(k)]
        if not keys:
            out.add(tid)
        out.update(k for k in keys if k not in exc)
    return out


def _count_open(fs: dict[str, list[str]] | None, exc: dict[str, str]) -> int:
    return len({k.split(":", 1)[0] for k in _open_keys(fs, exc)})


def _unit() -> dict:
    """systemd state, queried at most every 2 s (the page polls often during a run)."""
    at, show = _CACHE["unit"]
    if time.time() - at > 2:
        show = D().systemd_show(UNIT, "LoadState", "ActiveState", "Result")
        _CACHE["unit"] = (time.time(), show)
    return show


def status() -> dict:
    if not config.enabled("lynis"):
        return {"enabled": False}
    data = load() or {}
    exc, exc_path = exceptions()
    show = _unit()
    last = data.get("last")
    hist = data.get("history") or []
    out = {"enabled": True, "installed": show.get("LoadState") == "loaded",
           "running": show.get("ActiveState") in ("activating", "active", "reloading"),
           "lastResult": show.get("Result") or None, "error": data.get("error"), "checkedAt": data.get("checkedAt"),
           "schedule": config.get("KW_LYNIS_TIME", "Sun 00:30"), "timezone": config.local_tz_name(), "exceptionsFile": exc_path, "exceptions": len(exc),
           "run": None, "previous": None, "counts": {"open": 0, "accepted": 0, "warnings": 0, "new": 0},
           "findings": [], "history": []}
    if not last:
        return out
    out["run"] = {k: last.get(k) for k in ("startedAt", "finishedAt", "index", "tests", "lynisVersion", "vulnerablePackages")}
    prev = next((h for h in hist if h.get("finishedAt") != last.get("finishedAt")), None)
    if prev:
        out["previous"] = {"finishedAt": prev.get("finishedAt"), "index": prev.get("index")}
    before = _open_keys(prev.get("warnings"), exc) | _open_keys(prev.get("suggestions"), exc) if prev else None
    findings = [judge(f, exc) for f in (last.get("warnings") or []) + (last.get("suggestions") or [])]
    for f in findings:
        keys = {i["key"] for i in f["items"] if i["open"]} or ({f["id"]} if f["open"] else set())
        f["new"] = bool(f["open"] and before is not None and keys - before)
    findings.sort(key=lambda f: (not f["open"], f["kind"] != "warning", not f["new"], f["id"]))
    out["findings"] = findings
    out["counts"] = {"open": sum(f["open"] for f in findings), "accepted": sum(not f["open"] for f in findings),
                     "warnings": sum(f["open"] and f["kind"] == "warning" for f in findings),
                     "new": sum(f["new"] for f in findings)}
    out["history"] = [{"finishedAt": h.get("finishedAt"), "index": h.get("index"),
                       "open": _count_open(h.get("warnings"), exc) + _count_open(h.get("suggestions"), exc),
                       "warnings": _count_open(h.get("warnings"), exc)} for h in hist]
    return out


def start() -> dict:
    d = D()
    d.require("lynis")
    show = d.systemd_show(UNIT, "LoadState", "ActiveState")
    if show.get("LoadState") != "loaded":
        raise d.ApiError(409, f"The hardening audit is not set up on the server ({UNIT} is missing - run ./keepwatch deploy).")
    if show.get("ActiveState") in ("activating", "active", "reloading"):
        return {"ok": True, "running": True}
    d.run(["systemctl", "start", "--no-block", UNIT], check=True)
    _CACHE["unit"] = (0.0, {})
    return {"ok": True, "running": True}


# --------------------------------------------------------------------------- Timeline, health

def _day(t: float | None) -> str:
    return dt.datetime.fromtimestamp(t, config.local_tz()).strftime("%b %d") if t else "?"


def _names(fs: list[dict], n: int = 3) -> str:
    s = ", ".join(f["title"] for f in fs[:n])
    return s + (f" and {len(fs) - n} more" if len(fs) > n else "")


def _event_for_last():
    """One event per run (key lynis:<end>) - not twice after a restart."""
    st = status()
    run = st["run"]
    if not run or not run.get("finishedAt"):
        return
    import timeline  # noqa: PLC0415
    key = f"lynis:{int(run['finishedAt'])}"
    if timeline.exists(key):
        return
    prev = st["previous"]
    idx, pidx = run.get("index"), (prev or {}).get("index")
    fresh = [f for f in st["findings"] if f["new"]]
    new_warn = [f for f in fresh if f["kind"] == "warning"]
    open_warn = [f for f in st["findings"] if f["open"] and f["kind"] == "warning"]
    parts = [f"Index {idx}" + (f" (before {pidx})" if pidx is not None else ""),
             f"{st['counts']['open']} open recommendations"]
    if fresh:
        parts.append("new: " + _names(fresh))
    level = "info"
    if prev is None:
        title = f"Hardening audit set up: index {idx}"
        if open_warn:
            level, title = "warn", f"Hardening audit: {len(open_warn)} Lynis warning{'s' if len(open_warn) > 1 else ''}"
    elif new_warn:
        level, title = "warn", f"New Lynis warning: {_names(new_warn, 1)}"
    elif idx is not None and pidx is not None and idx < pidx:
        level, title = "warn", f"Hardening index dropped: {pidx} -> {idx}"
    elif idx is not None and pidx is not None and idx > pidx:
        title = f"Hardening index rose: {pidx} -> {idx}"
    else:
        title = f"Hardening audit: index {idx} · {st['counts']['open']} recommendations"
    # Timeline kind "security" (4th of timeline.KINDS; by position as a fallback if it is named differently).
    kind = "security" if "security" in timeline.KINDS else timeline.KINDS[3]
    timeline.add(kind, title, detail=" · ".join(parts), level=level, source="lynis", key=key,
                 t=run["finishedAt"], link=LINK, weight=45 if level != "info" else 15,
                 meta={"index": idx, "previous": pidx, "new": [f["id"] for f in fresh]})


def problems() -> list[dict]:
    """For health: open Lynis warnings, dropped index, audit not running. From the file only."""
    if not config.enabled("lynis"):
        return []
    try:
        data = load()
        if not data:
            return []
        st = status_light(data)
    except Exception:  # noqa: BLE001 - health must not fail because of this
        traceback.print_exc()
        return []
    out = []
    for f in st["warnings"][:3]:
        out.append({"level": "warn", "area": "security", "title": f"Lynis warning: {f['title']}",
                    "detail": f"{f['id']}{' · ' + f['text'] if f['text'] and f['text'] != f['title'] else ''}. Security -> Hardening.",
                    "key": "lynis.warning"})
    if st["dropped"]:
        out.append({"level": "warn", "area": "security", "title": "Hardening index dropped",
                    "detail": f"{st['dropped'][0]} -> {st['dropped'][1]} in the audit on {_day(st['at'])}. Security -> Hardening.",
                    "key": "lynis.index-dropped"})
    if data.get("error") and (not st["at"] or time.time() - st["at"] > STALE_AFTER):
        out.append({"level": "warn", "area": "security", "title": "Hardening audit failed", "detail": str(data["error"])[:200],
                    "key": "lynis.failed"})
    elif st["at"] and time.time() - st["at"] > STALE_AFTER:
        out.append({"level": "warn", "area": "security", "title": "Hardening audit is not running",
                    "detail": f"Last run on {_day(st['at'])}. systemctl status {config.UNITS['lynis']}.timer",
                    "key": "lynis.stale"})
    return out


def status_light(data: dict) -> dict:
    """Like status(), but without systemd - health() runs every 5 s."""
    exc, _ = exceptions()
    last = data.get("last") or {}
    hist = data.get("history") or []
    prev = next((h for h in hist if h.get("finishedAt") != last.get("finishedAt")), None)
    warnings = [w for w in (judge(f, exc) for f in last.get("warnings") or []) if w["open"]]
    idx, pidx = last.get("index"), (prev or {}).get("index")
    dropped = (pidx, idx) if idx is not None and pidx is not None and idx < pidx else None
    return {"warnings": warnings, "dropped": dropped, "at": last.get("finishedAt")}


def loop():
    time.sleep(90)  # only after the other collectors (and the timeline) have started
    seen = None
    while True:
        try:
            m = _mtime(_state_file()) if config.enabled("lynis") else None
            if m and m != seen:
                seen = m
                _event_for_last()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(WATCH_EVERY)


def route(method: str, path: str, body: dict):
    d = D()
    if method == "GET" and path == "/api/lynis":
        return status()
    if method == "POST" and path == "/api/lynis/run":
        return start()
    raise d.ApiError(404, "Unknown endpoint.")


# --------------------------------------------------------------------------- Command line (read only)

if __name__ == "__main__":
    # python3 lynis.py [lynis.json] [--exceptions file] [--json]
    args = sys.argv[1:]
    stub = type("Dashboard", (), {"systemd_show": staticmethod(lambda unit, *props: {})})
    if "--exceptions" in args:
        i = args.index("--exceptions")
        EXCEPTIONS.insert(0, Path(args[i + 1]))
        del args[i:i + 2]
    files = [a for a in args if not a.startswith("--")]
    if files:
        _state_file = lambda: Path(files[0])  # noqa: E731
    sys.modules.setdefault("dashboard", stub)  # type: ignore[arg-type]
    config.enabled = lambda m: True  # read whatever file is given
    st = status()
    if "--json" in args:
        print(json.dumps(st, ensure_ascii=False, indent=1))
        sys.exit(0)
    r = st["run"] or {}
    print(f"Index {r.get('index')} · {st['counts']['open']} open · {st['counts']['accepted']} deliberate"
          f" · exceptions: {st['exceptionsFile']} ({st['exceptions']})")
    for f in st["findings"]:
        mark = "OPEN      " if f["open"] else "deliberate"
        items = [i["label"] + (f" ({i['detail']})" if i.get("detail") else "") for i in f["items"] if i["open"]]
        print(f"  {mark} {f['id']:10} {f['title']}" + (f"  -> {', '.join(items)}" if items and f["open"] else ""))
