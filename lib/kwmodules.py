#!/usr/bin/env python3
"""Keepwatch add-on modules switched on and off from the dashboard.

Python 3.8+, standard library only. The dashboard module installs it on the server as
/usr/local/sbin/keepwatch-modules (run as root); lib/apply.sh runs it from the repository copy.

  keepwatch-modules list [--json]                    every module: on or off, from keepwatch.conf or the
                                                     dashboard, and whether the dashboard may switch it
  keepwatch-modules enable <id> [--by NAME] [--wait] [--json]
  keepwatch-modules disable <id> [--by NAME] [--wait] [--json]
                                                     switch an add-on and set the server up in the background
                                                     (keepwatch-modules-apply.service); --wait waits for it
  keepwatch-modules status [--json]                  the running or last switch
  keepwatch-modules sync-done <id>...                keepwatch.conf took these over: drop them from the override
  keepwatch-modules effective [--root DIR] <id>...   for lib/apply.sh: the modules to set up, given KW_MODULES
  keepwatch-modules run                              for keepwatch-modules-apply.service: lib/apply.sh, and on
                                                     failure the switch undone and lib/apply.sh again

Where things are on the server:
  /etc/keepwatch/modules-override.json   the switches (0600): {"on": [...], "off": [...], "log": [...]}
                                         effective modules = KW_MODULES + on - off; a deploy keeps them
  /var/lib/keepwatch/modules-apply.json  the running or last switch (read by the dashboard)
  /var/lib/keepwatch/modules-apply.log   output of the last switch
  /run/keepwatch.lock                    one deploy, update or switch at a time (flock)

Only add-ons the server works without can be switched here (TOGGLEABLE). SSH, the firewall,
fail2ban, Tailscale, Docker and what runs on it stay with keepwatch.conf on your computer: a
deploy from there can check that you still get in and that your sites keep running.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# From the repository (lib/apply.sh): that copy. Installed in /usr/local/sbin: the server copy.
ROOT = _HERE.parent if _HERE.name == "lib" and (_HERE.parent / "modules").is_dir() else Path("/opt/keepwatch")
ETC = Path("/etc/keepwatch")
ETC_CONF = ETC / "keepwatch.conf"
OVERRIDE = ETC / "modules-override.json"
STATE_DIR = Path("/var/lib/keepwatch")
STATUS = STATE_DIR / "modules-apply.json"
LOG = STATE_DIR / "modules-apply.log"
STATE_LOCK = STATE_DIR / "modules-apply.lock"
INSTALLED = STATE_DIR / "modules"
RUN_LOCK = "/run/keepwatch.lock"
UNIT = "keepwatch-modules-apply.service"

# Add-ons the dashboard may switch: each one only adds a check, a timer or a log, none decides
# whether you reach the server or whether your sites run.
TOGGLEABLE = ("lynis", "image-scan", "log-archive", "ban-history", "auditd", "auto-updates", "backup")
# Why the rest is not switchable here (the dashboard adds the command for your computer).
WHY = {
    "base": "Always on.",
    "debloat": "Removes and masks system packages - switched together with the rest of the base setup.",
    "ssh-hardening": "Changes how you log in - only from your computer, where a deploy checks that your key still works.",
    "kernel-hardening": "Changes kernel and network settings the other modules build on.",
    "fail2ban": "Decides who gets banned, which can include you - only from your computer, where a deploy keeps your address free.",
    "firewall": "Decides who reaches the server - only from your computer, where a deploy keeps your way in open.",
    "tailscale": "Can be your only way in - only from your computer.",
    "docker": "Your containers run on it - switching it off stops them.",
    "proxy": "Your websites go through it - switching it off takes them offline.",
    "portainer": "Manages your container stacks - switched on your computer together with Docker and the proxy.",
    "dashboard": "This dashboard itself.",
}
WHY_DEFAULT = "Only from your computer (KW_MODULES in keepwatch.conf)."

ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
LINE = re.compile(r'^\s*(?:export\s+)?(KW_[A-Z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|\'([^\']*)\'|([^\s#]*))')
META = re.compile(r'^\s*([A-Z_]+)="([^"]*)"')
LOG_TAIL = 40
LOG_KEEP = 200            # entries kept in the override's log
APPLY_TIMEOUT = 45 * 60
LOCK_WAIT = 30 * 60       # as lib/apply.sh waits for another run
STALE = 60                # seconds a "running" state may go without its unit (the unit is starting)
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
       "LC_ALL": "C.UTF-8", "TERM": "dumb"}


class Fail(Exception):
    """A refusal or failure with a message for the dashboard."""


# --------------------------------------------------------------------------- Reading

def conf_modules():
    """KW_MODULES as lib/apply.sh reads it: the example's default, the server's keepwatch.conf on
    top, base always first."""
    value = ""
    for p in (ROOT / "keepwatch.conf.example", ETC_CONF):
        try:
            text = p.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            m = LINE.match(line)
            if m and m.group(1) == "KW_MODULES":
                dq, sq, bare = m.group(2), m.group(3), m.group(4)
                value = re.sub(r"\\(.)", r"\1", dq) if dq is not None else sq if sq is not None else bare
    return _base_first(value.split())


def _base_first(words):
    out = ["base"]
    for w in words:
        if w not in out:
            out.append(w)
    return out


def catalog(root=None):
    """{id: {name, summary, requires, order}} of every module in the repository copy."""
    out = {}
    mods = Path(root or ROOT) / "modules"
    try:
        dirs = sorted(d for d in mods.iterdir() if (d / "module.conf").is_file())
    except OSError:
        dirs = []
    for d in dirs:
        meta = {}
        for line in (d / "module.conf").read_text(errors="replace").splitlines():
            m = META.match(line)
            if m:
                meta[m.group(1)] = m.group(2)
        try:
            order = int(meta.get("ORDER") or 50)
        except ValueError:
            order = 50
        out[d.name] = {"name": meta.get("NAME") or d.name, "summary": meta.get("SUMMARY") or "",
                       "requires": meta.get("REQUIRES", "").split(), "order": order}
    return out


def read_override(strict=True):
    """The switches; absent or empty = none. A file that is not valid JSON is an error (strict) -
    reading it as "no switches" would uninstall every add-on switched on in the dashboard."""
    try:
        text = OVERRIDE.read_text()
    except FileNotFoundError:
        text = ""
    except OSError as e:
        raise Fail(f"Cannot read {OVERRIDE}: {e.strerror}.")
    data = {}
    if text.strip():
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            if strict:
                raise Fail(f"{OVERRIDE} is not valid JSON - fix it, or delete it to drop the modules switched in the dashboard.")
            data = {}

    def ids(key):
        v = data.get(key)
        out = []
        for m in v if isinstance(v, list) else []:
            if isinstance(m, str) and ID.match(m) and m not in out:
                out.append(m)
        return out
    log = [e for e in data.get("log") or [] if isinstance(e, dict)] if isinstance(data.get("log"), list) else []
    return {"on": ids("on"), "off": ids("off"), "log": log}


def write_override(ov):
    ETC.mkdir(mode=0o755, parents=True, exist_ok=True)
    data = {"on": ov["on"], "off": ov["off"], "log": ov["log"][-LOG_KEEP:]}
    _write_json(OVERRIDE, data, 0o600)


def _write_json(path, data, mode):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    os.chmod(str(tmp), mode)
    os.replace(str(tmp), str(path))


def read_json(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def installed():
    try:
        return [m for m in INSTALLED.read_text().split() if ID.match(m)]
    except OSError:
        return []


# --------------------------------------------------------------------------- Effective modules

def effective(conf, ov, cat):
    """(modules, switched_on, switched_off, warnings): KW_MODULES + on - off.

    Only add-ons from TOGGLEABLE count. A switch whose dependencies changed since (keepwatch.conf
    switched off Docker under an image scan switched on here) is left out with a warning rather
    than failing the deploy."""
    warnings = []
    conf = _base_first(conf)

    def usable(m):
        if m not in cat:
            warnings.append(f"modules-override.json: unknown module {m} ignored")
            return False
        if m not in TOGGLEABLE:
            warnings.append(f"modules-override.json: {m} cannot be switched in the dashboard - ignored (KW_MODULES decides)")
            return False
        return True

    on = [m for m in ov["on"] if usable(m) and m not in conf]
    off = [m for m in ov["off"] if usable(m) and m in conf and m not in on]
    mods = [m for m in conf if m not in off] + on
    changed = True
    while changed:
        changed = False
        for m in list(on):
            missing = [r for r in cat[m]["requires"] if r not in mods]
            if m in mods and missing:
                mods.remove(m)
                warnings.append(f"{m} is switched on in the dashboard but needs {', '.join(missing)}, which is off - left off")
                changed = True
        for m in list(off):
            users = [u for u in mods if u in cat and m in cat[u]["requires"]]
            if m not in mods and users:
                mods.append(m)
                warnings.append(f"{m} is switched off in the dashboard but {', '.join(users)} needs it - left on")
                changed = True
    return (mods, [m for m in on if m in mods], [m for m in off if m not in mods], warnings)


def current(cat=None):
    cat = cat if cat is not None else catalog()
    conf = conf_modules()
    ov = read_override()
    mods, plus, minus, _ = effective(conf, ov, cat)
    return cat, conf, ov, mods, plus, minus


def blocked(m, action, mods, cat):
    """Why switching m now would be refused ("" if it would not)."""
    if action == "on":
        missing = [r for r in cat[m]["requires"] if r not in mods]
        if missing:
            names = ", ".join(cat[r]["name"] if r in cat else r for r in missing)
            return (f"{cat[m]['name']} needs {names}, which is off. That is switched on your computer: "
                    f"./keepwatch enable {' '.join(missing)}, then ./keepwatch deploy.")
    else:
        users = [u for u in mods if u in cat and m in cat[u]["requires"]]
        if users:
            names = ", ".join(cat[u]["name"] for u in users)
            return f"{names} needs {cat[m]['name']} - switch that off first."
    return ""


def listing():
    cat, conf, ov, mods, plus, minus = current()
    have = installed()
    out = []
    for m in sorted(cat, key=lambda k: (cat[k]["order"], k)):
        c = cat[m]
        on = m in mods
        tog = m in TOGGLEABLE
        out.append({"id": m, "name": c["name"], "summary": c["summary"], "requires": c["requires"],
                    "enabled": on, "inConf": m in conf,
                    "override": "on" if m in plus else "off" if m in minus else None,
                    "toggleable": tog, "why": "" if tog else WHY.get(m, WHY_DEFAULT),
                    "installed": m in have,
                    "blocked": blocked(m, "off" if on else "on", mods, cat) if tog else ""})
    return out


# --------------------------------------------------------------------------- State

class _Lock:
    """One switch at a time on the override and the state (enable, disable, sync-done, run)."""

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(str(STATE_LOCK), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        os.close(self.fd)


def update_status(**fields):
    with _Lock():
        st = read_json(STATUS)
        st.update(fields, updatedAt=int(time.time()))
        _write_json(STATUS, st, 0o644)
        return st


def unit_active():
    try:
        r = subprocess.run(["systemctl", "is-active", UNIT], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.stdout.strip() in ("active", "activating", "reloading")


def status():
    st = read_json(STATUS)
    out = {"state": "idle", "module": None, "action": None, "by": None, "startedAt": None, "endedAt": None,
           "log": [], "error": None, "rolledBack": False}
    out.update({k: v for k, v in st.items() if k in out or k == "updatedAt"})
    if out["state"] == "running" and not unit_active() and time.time() - (st.get("updatedAt") or 0) > STALE:
        # The unit is gone (a reboot, a kill) without writing its result.
        out.update(state="failed", error="The switch was interrupted before it finished (the server restarted?). "
                                         "Switch it again, or run ./keepwatch deploy from your computer.")
    return out


def run_lock():
    """/run/keepwatch.lock - the lock lib/apply.sh, ./keepwatch deploy and keepwatch-self-update take.
    The open file if it was free (held until it is closed), else None."""
    fd = os.open(RUN_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        os.close(fd)
        return None


# --------------------------------------------------------------------------- enable / disable

def switch(m, action, by, wait, as_json):
    want_on = action == "on"
    try:
        msg = _switch(m, want_on, by)
    except Fail as e:
        _say_result(as_json, False, str(e), False)
        return 1
    if msg:  # nothing to do
        _say_result(as_json, True, msg, False)
        return 0
    if not wait:
        _say_result(as_json, True, f"Switching {m} {action} - the server is being set up ({UNIT}).", True)
        return 0
    return _wait(as_json)


def _say_result(as_json, ok, message, started):
    if as_json:
        print(json.dumps({"ok": ok, "message": message, "started": started}))
    else:
        print(message, file=sys.stdout if ok else sys.stderr)


def _switch(m, want_on, by):
    if os.geteuid() != 0:
        raise Fail("Run as root.")
    if not ID.match(m or ""):
        raise Fail(f"Not a module id: {m!r}")
    action = "on" if want_on else "off"
    with _Lock():
        cat, conf, ov, mods, _, _ = current()
        if m not in cat:
            raise Fail(f"There is no module {m} (see keepwatch-modules list).")
        name = cat[m]["name"]
        if m not in TOGGLEABLE:
            users = [cat[u]["name"] for u in mods if u in cat and m in cat[u]["requires"]] if not want_on else []
            also = f" ({', '.join(users)} needs it and goes off with it.)" if users else ""
            raise Fail(f"{name} cannot be switched in the dashboard: {WHY.get(m, WHY_DEFAULT)} "
                       f"On your computer: ./keepwatch {'enable' if want_on else 'disable'} {m}, then ./keepwatch deploy.{also}")
        if (m in mods) == want_on:
            return f"{name} is already {action}."
        st = read_json(STATUS)
        if st.get("state") == "running" and (unit_active() or time.time() - (st.get("updatedAt") or 0) <= STALE):
            raise Fail(f"{st.get('module') or 'A module'} is being switched right now - wait until that is done.")
        fd = run_lock()
        if fd is None:
            raise Fail("Keepwatch is being set up right now (a deploy or an update from the dashboard). "
                       "Try again in a few minutes.")
        os.close(fd)
        why = blocked(m, action, mods, cat)
        if why:
            raise Fail(why)

        prev = "on" if m in ov["on"] else "off" if m in ov["off"] else None
        ov["on"] = [x for x in ov["on"] if x != m]
        ov["off"] = [x for x in ov["off"] if x != m]
        if want_on and m not in conf:
            ov["on"].append(m)
        if not want_on and m in conf:
            ov["off"].append(m)
        now = int(time.time())
        ov["log"].append({"module": m, "action": action, "at": now, "by": by})
        write_override(ov)

        LOG.parent.mkdir(parents=True, exist_ok=True)
        first = f"-- Switch {name} {action} (by {by})"
        LOG.write_text(first + "\n")
        st = {"state": "running", "module": m, "action": action, "by": by, "prev": prev, "startedAt": now,
              "endedAt": None, "log": [first], "error": None, "rolledBack": False, "updatedAt": now}
        _write_json(STATUS, st, 0o644)
        try:
            r = subprocess.run(["systemctl", "start", "--no-block", UNIT], capture_output=True, text=True, timeout=30)
            err = r.stderr.strip() if r.returncode else ""
        except (OSError, subprocess.TimeoutExpired) as e:
            err = str(e)
        if err:
            _revert(ov, m, prev)
            write_override(ov)
            st.update(state="failed", endedAt=int(time.time()), error=f"Could not start {UNIT}: {err}", updatedAt=int(time.time()))
            _write_json(STATUS, st, 0o644)
            raise Fail(f"Could not start {UNIT}: {err} - nothing was changed.")
    return ""


def _revert(ov, m, prev):
    """The switch of m undone - only m, so what sync-done or another switch did meanwhile stays."""
    ov["on"] = [x for x in ov["on"] if x != m]
    ov["off"] = [x for x in ov["off"] if x != m]
    if prev in ("on", "off"):
        ov[prev].append(m)
    for e in reversed(ov["log"]):
        if e.get("module") == m:
            e["ok"] = False
            break


def _wait(as_json):
    """Follow the switch until it is done: its output, then the result."""
    pos, deadline = 0, time.time() + APPLY_TIMEOUT + LOCK_WAIT + 300
    st = status()
    while time.time() < deadline:
        if not as_json:
            try:
                with open(str(LOG), "rb") as f:
                    f.seek(pos)
                    chunk = f.read()
                    pos += len(chunk)
                sys.stdout.write(chunk.decode("utf-8", "replace"))
                sys.stdout.flush()
            except OSError:
                pass
        st = status()
        if st["state"] != "running":
            break
        time.sleep(1)
    ok = st["state"] == "done"
    msg = "Done." if ok else (st.get("error") or "Still running - see keepwatch-modules status.")
    if as_json:
        print(json.dumps({"ok": ok, "message": msg, "started": True, "status": st}))
    elif not ok:
        print(msg, file=sys.stderr)
    return 0 if ok else 1


# --------------------------------------------------------------------------- run (the unit)

class Run:
    def __init__(self):
        self.tail, self.errors, self._last = [], [], 0.0
        LOG.parent.mkdir(parents=True, exist_ok=True)
        self.log = open(str(LOG), "a", encoding="utf-8", errors="replace")

    def say(self, line, flush=False):
        line = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line.rstrip("\n"))
        self.log.write(line + "\n")
        self.log.flush()
        print(line, flush=True)  # the journal of the unit
        if re.search(r"\berror\b|^Module .* needs |^Unknown module|^Still busy|^No /etc", line):
            self.errors.append(line.strip())
        self.tail = (self.tail + [line])[-LOG_TAIL:]
        if flush or time.time() - self._last > 1.5:
            self._last = time.time()
            update_status(log=self.tail)

    def apply_sh(self, env):
        p = subprocess.Popen(["bash", str(ROOT / "lib" / "apply.sh")], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, cwd="/", text=True, errors="replace", bufsize=1)
        killer = threading.Timer(APPLY_TIMEOUT, p.kill)
        killer.start()
        try:
            for line in p.stdout:
                self.say(line)
            return p.wait()
        finally:
            killer.cancel()
            update_status(log=self.tail)


def run():
    if os.geteuid() != 0:
        print(f"Run as root ({UNIT}).", file=sys.stderr)
        return 1
    st = read_json(STATUS)
    if st.get("state") != "running":
        print("Nothing to do: no switch is waiting (keepwatch-modules enable|disable starts this).", file=sys.stderr)
        return 0
    m, action, prev = st.get("module"), st.get("action"), st.get("prev")
    r = Run()
    update_status(startedAt=int(time.time()))

    # Held until this process ends; apply.sh runs with KW_LOCKED=1 under it.
    lock = run_lock()
    if lock is None:
        # A deploy or an update got in between: it sets the switch up as well (apply.sh always
        # reads the override), so waiting and then running again is safe.
        r.say("  waiting for another Keepwatch run to finish (a deploy, or an update from the dashboard) ...", flush=True)
        end = time.time() + LOCK_WAIT
        while lock is None:
            if time.time() > end:
                return _failed(r, m, prev, "Keepwatch was busy for 30 minutes (a deploy or an update). "
                                           "Nothing was switched - try again later.", rolled_back=False)
            time.sleep(2)
            lock = run_lock()

    env = dict(ENV, KW_LOCKED="1", KW_VIA="dashboard", KW_SWITCH=f"{'+' if action == 'on' else '-'}{m}")
    # The checks a deploy does for the user it logs in as (SSH keys) apply to that user here too.
    user = _conf_value("KW_SSH_USER") or "root"
    if user != "root" and re.match(r"^[a-z_][a-z0-9_-]*$", user):
        env["SUDO_USER"] = user
    r.say("-- Set up the server (lib/apply.sh)", flush=True)
    code = r.apply_sh(env)
    if code == 0:
        r.say("-- Done", flush=True)
        update_status(state="done", endedAt=int(time.time()), error=None, log=r.tail)
        return 0

    where = re.sub(r"^error:\s*", "", r.errors[-1]) if r.errors else f"lib/apply.sh ended with exit code {code}"
    r.say(f"-- Failed ({where}) - switching {m} back and setting the server up again", flush=True)
    with _Lock():
        ov = read_override(strict=False)
        _revert(ov, m, prev)
        write_override(ov)
    if action == "on":
        # Half installed: listed as installed, the run below uninstalls it (its remove.sh).
        have = installed()
        if m not in have:
            INSTALLED.write_text("\n".join(have + [m]) + "\n")
    again = r.apply_sh(dict(env, KW_VIA="rollback"))
    name = catalog().get(m, {}).get("name", m)
    if again == 0:
        msg = f"Switching {name} {action} failed, so it was switched back and the server set up again (rolled back). Where: {where}."
    else:
        msg = (f"Switching {name} {action} failed and it was switched back, but setting the server up again failed too - "
               f"run ./keepwatch deploy from your computer. Where: {where}.")
    return _failed(r, m, prev, msg, rolled_back=True, reverted=True)


def _failed(r, m, prev, msg, rolled_back, reverted=False):
    if not reverted:
        with _Lock():
            ov = read_override(strict=False)
            _revert(ov, m, prev)
            write_override(ov)
    r.say(f"-- {msg}", flush=True)
    update_status(state="failed", endedAt=int(time.time()), error=msg, rolledBack=rolled_back, log=r.tail)
    return 1


def _conf_value(key):
    value = ""
    for p in (ROOT / "keepwatch.conf.example", ETC_CONF):
        try:
            text = p.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            mm = LINE.match(line)
            if mm and mm.group(1) == key:
                dq, sq, bare = mm.group(2), mm.group(3), mm.group(4)
                value = re.sub(r"\\(.)", r"\1", dq) if dq is not None else sq if sq is not None else bare
    return value


# --------------------------------------------------------------------------- sync-done / effective

def sync_done(ids):
    if os.geteuid() != 0:
        print("Run as root.", file=sys.stderr)
        return 1
    if not OVERRIDE.exists():
        return 0
    with _Lock():
        ov = read_override(strict=False)
        dropped = [m for m in ids if m in ov["on"] or m in ov["off"]]
        if dropped:
            ov["on"] = [m for m in ov["on"] if m not in ids]
            ov["off"] = [m for m in ov["off"] if m not in ids]
            write_override(ov)
            print(f"taken over by keepwatch.conf: {' '.join(dropped)}")
    return 0


def effective_cmd(args):
    """For lib/apply.sh: one line "modules <ids>", then "switched +a -b" if anything is switched,
    then "warn <text>" per warning."""
    root = None
    if args[:1] == ["--root"] and len(args) > 1:
        root, args = args[1], args[2:]
    if args[:1] == ["--"]:
        args = args[1:]
    try:
        ov = read_override()
    except Fail as e:
        print(e, file=sys.stderr)
        return 1
    mods, plus, minus, warnings = effective(args, ov, catalog(root))
    print("modules " + " ".join(mods))
    if plus or minus:
        print("switched " + " ".join(["+" + m for m in plus] + ["-" + m for m in minus]))
    for w in warnings:
        print("warn " + w)
    return 0


# --------------------------------------------------------------------------- Command line

def _opt(args, name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            v = args[i + 1]
            del args[i:i + 2]
            return v
        del args[i]
    return None


def _flag(args, name):
    if name in args:
        args.remove(name)
        return True
    return False


def main(argv):
    cmd, args = (argv[0] if argv else ""), list(argv[1:])
    try:
        if cmd == "list":
            items = listing()
            if _flag(args, "--json"):
                print(json.dumps(items, ensure_ascii=False))
            else:
                for i in items:
                    state = "on " if i["enabled"] else "off"
                    src = " (dashboard)" if i["override"] else ""
                    tog = "" if i["toggleable"] else "  [keepwatch.conf]"
                    print(f"  {state} {i['id']:<17} {i['name']}{src}{tog}")
            return 0
        if cmd in ("enable", "disable"):
            by = _opt(args, "--by") or "cli"
            by = re.sub(r"[^\w .@+-]", "", by)[:60].strip() or "cli"
            wait, as_json = _flag(args, "--wait"), _flag(args, "--json")
            if len(args) != 1:
                print(f"usage: keepwatch-modules {cmd} <module> [--by NAME] [--wait] [--json]", file=sys.stderr)
                return 2
            return switch(args[0], "on" if cmd == "enable" else "off", by, wait, as_json)
        if cmd == "status":
            st = status()
            if _flag(args, "--json"):
                print(json.dumps(st, ensure_ascii=False))
            else:
                print(f"{st['state']}" + (f": {st['module']} {st['action']}" if st.get("module") else ""))
                if st.get("error"):
                    print(st["error"])
            return 0
        if cmd == "sync-done":
            return sync_done([a for a in args if ID.match(a)])
        if cmd == "effective":
            return effective_cmd(args)
        if cmd == "run":
            return run()
    except Fail as e:
        print(e, file=sys.stderr)
        return 1
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
