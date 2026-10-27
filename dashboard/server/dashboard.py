#!/usr/bin/env python3
"""Keepwatch dashboard: backend.

Runs as root on the server (keepwatch-dashboard.service), listens on 127.0.0.1
only (KW_DASHBOARD_PORT) and is reached through an SSH tunnel. Serves the UI
from web/ and answers /api/* (contract: ../API.md).

Python standard library only, so a fresh server needs nothing extra. Expensive
queries (docker stats, certificates, restic, apt) run in background threads;
requests only read the latest result. Everything that belongs to an optional
module (config.py, KW_MODULES) is skipped while that module is off.
"""
from __future__ import annotations

import collections
import datetime as dt
import glob
import ipaddress
import json
import os
import re
import shlex
import sqlite3
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sys
# Add-on modules (updates.py, ...) reach this module through sys.modules["dashboard"],
# also when it runs as __main__, without loading it twice.
sys.modules.setdefault("dashboard", sys.modules[__name__])
import config  # noqa: E402  keepwatch.conf, feature flags, paths
import updates  # noqa: E402  updates & rollback, cleanup
import hosts  # noqa: E402  "New site" wizard (proxy host via the Proxy Manager API)
import uptime  # noqa: E402  availability per site (every minute, uptime.db)
import sitegrade  # noqa: E402  security grade per site (A-F, every 6 h)
import timeline  # noqa: E402  timeline "What happened?" (timeline.db, 120 days)
import ctwatch  # noqa: E402  certificate watch (CT logs, every 6 h)
import secrets_check  # noqa: E402  secrets check (stack environment variables, hashes only)
import lynis  # noqa: E402  hardening audit (reads keepwatch-lynis results)
import touchid  # noqa: E402  dangerous actions need a passkey (list DANGER, signature check)
import selfupdate  # noqa: E402  Keepwatch updates from the dashboard (keepwatch-self-update)

BIND = os.environ.get("DASHBOARD_BIND", "127.0.0.1")
PORT = config.ports()["dashboard"]
WEB_DIR = Path(os.environ.get("DASHBOARD_WEB") or config.ROOT / "dashboard" / "web" / "dist")
STATE_DIR = config.STATE_DIR
CONF_DIR = config.CONF_DIR
NPM_DIR = config.PROXY_DATA
LE_DIR = config.PROXY_LE
BACKUP_ENV = config.BACKUP_ENV
F2B_DB = "/var/lib/fail2ban/fail2ban.sqlite3"
AUDIT_LOG = Path("/var/log/audit/audit.log")
ALLOWED_TCP_FALLBACK = [22, 80, 443]

IPV4 = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}  # more fields for the response (e.g. touchid on 428)


def module_off(module: str) -> ApiError:
    return ApiError(404, f"The {config.MODULE_NAMES.get(module, module)} module is not enabled "
                         f"(KW_MODULES in keepwatch.conf).", {"module": module, "enabled": False})


def require(*modules: str):
    """404 unless every module is enabled - for endpoints of optional modules."""
    for m in modules:
        if not config.enabled(m):
            raise module_off(m)


def problem(level: str, area: str, title: str, detail: str, key: str, target: str | None = None) -> dict:
    """One entry of /api/overview health. `key` is stable for the UI, `target` (optional)
    names the settings row that fixes it ("settings/<row>")."""
    p = {"level": level, "area": area, "title": title, "detail": detail, "key": key}
    if target:
        p["target"] = target
    return p


# --------------------------------------------------------------------------- Helpers

def run(cmd: list[str] | str, timeout: float = 20, env: dict | None = None, check: bool = False) -> str:
    """Run a command and return stdout. Errors give '' (unless check=True)."""
    if isinstance(cmd, str):
        cmd = shlex.split(cmd)
    try:
        full_env = {**os.environ, "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", **(env or {})}
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=full_env)
    except FileNotFoundError:
        if check:
            raise ApiError(503, f"{cmd[0]} is not installed on this server.")
        return ""
    except (OSError, subprocess.TimeoutExpired) as e:
        if check:
            raise ApiError(504 if isinstance(e, subprocess.TimeoutExpired) else 503, f"{cmd[0]} did not finish: {e}")
        return ""
    if check and p.returncode != 0:
        msg = (p.stderr or p.stdout).strip().splitlines()
        raise ApiError(502, f"{cmd[0]} failed: {msg[-1] if msg else 'exit code ' + str(p.returncode)}")
    return p.stdout


def now() -> float:
    return time.time()


def npm_db(write: bool = False) -> sqlite3.Connection:
    """The Proxy Manager's database. 503 with a clear message while it does not exist yet
    (proxy container never started, or data elsewhere) instead of a bare sqlite error."""
    path = NPM_DIR / "database.sqlite"
    if not path.is_file():
        raise ApiError(503, f"The Proxy Manager database is missing ({path}) – is the proxy container running?")
    if write:
        return sqlite3.connect(str(path), timeout=10)
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)


HUMAN = {"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12,
         "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4}


def parse_size(s: str) -> float | None:
    m = re.match(r"^\s*([\d.]+)\s*([A-Za-z]*)", s or "")
    if not m:
        return None
    unit = m.group(2).lower() or "b"
    return float(m.group(1)) * HUMAN.get(unit, 1)


def systemd_show(unit: str, *props: str) -> dict[str, str]:
    out = run(["systemctl", "show", unit, "--timestamp=unix", *[f"-p{p}" for p in props]])
    res = {}
    for line in out.splitlines():
        k, _, v = line.partition("=")
        res[k] = v
    return res


def ts_unix(v: str | None) -> float | None:
    """systemctl --timestamp=unix gives '@1792771941' or ''."""
    if v and v.startswith("@"):
        try:
            return float(v[1:])
        except ValueError:
            return None
    # Some properties (NextElapseUSecRealtime) ignore --timestamp=unix.
    m = re.match(r"^\w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC$", v or "")
    if m:
        return dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()
    return None


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=value file (shell syntax, as `source` reads it)."""
    return config.parse_file(path)


def tail_bytes(path: Path, max_bytes: int) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[1:] if size > max_bytes else lines


# --------------------------------------------------------------------------- Background

class Collector:
    """Keeps the latest result of an expensive query and refreshes it on a fixed interval.
    `module`: skipped (value {"enabled": False}) while that module is off."""

    def __init__(self, name: str, fn, interval: float, module: str | None = None):
        self.name, self.fn, self.interval, self.module = name, fn, interval, module
        self.value = None
        self.error: str | None = None
        self.at = 0.0
        self.lock = threading.Lock()

    def refresh(self):
        with self.lock:
            if self.module and not config.enabled(self.module):
                self.value, self.error, self.at = {"enabled": False}, None, now()
                return
            try:
                self.value = self.fn()
                self.error = None
            except ApiError as e:  # expected (e.g. the proxy database does not exist yet): no traceback
                self.error = e.message
            except Exception as e:  # noqa: BLE001 - an error must not end the thread
                self.error = str(e)
                traceback.print_exc()
            self.at = now()

    def get(self):
        if self.value is None:
            self.refresh()
        if self.value is None:
            raise ApiError(503, f"{self.name} is not available right now: {self.error}")
        return self.value

    def loop(self):
        while True:
            self.refresh()
            time.sleep(self.interval)


# --------------------------------------------------------------------------- Host

def default_iface() -> str:
    out = run(["ip", "route", "get", "1.1.1.1"])
    m = re.search(r"\bdev (\S+)", out)
    return m.group(1) if m else "eth0"


def public_ip() -> str:
    out = run(["ip", "route", "get", "1.1.1.1"])
    m = re.search(r"\bsrc (\S+)", out)
    return m.group(1) if m else ""


class Sampler:
    """Samples CPU, RAM and network every 5 s. Keeps 15 min at full resolution and 24 h per minute."""

    LIVE = 180
    HIST = 1440

    def __init__(self):
        self.iface = default_iface()
        self.live = collections.deque(maxlen=self.LIVE)
        self.hist = collections.deque(maxlen=self.HIST)
        self.minute: list[tuple] = []
        self.minute_key = int(now() // 60)
        self.prev_cpu = self._cpu_times()
        self.prev_net = self._net()
        self.prev_t = now()
        self.cur = {"cpu": 0.0, "mem": 0.0, "rx": 0.0, "tx": 0.0}
        self.lock = threading.Lock()
        self._load_history()

    @staticmethod
    def _cpu_times():
        with open("/proc/stat") as f:
            vals = [int(x) for x in f.readline().split()[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle

    def _net(self):
        try:
            with open("/proc/net/dev") as f:
                for line in f:
                    if line.strip().startswith(self.iface + ":"):
                        parts = line.split(":", 1)[1].split()
                        return int(parts[0]), int(parts[8])
        except OSError:
            pass
        return 0, 0

    @staticmethod
    def meminfo() -> dict[str, int]:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        return info

    def sample(self):
        t = now()
        total, idle = self._cpu_times()
        dt_total = total - self.prev_cpu[0]
        cpu = 100.0 * (1 - (idle - self.prev_cpu[1]) / dt_total) if dt_total > 0 else 0.0
        self.prev_cpu = (total, idle)
        rx, tx = self._net()
        span = max(t - self.prev_t, 0.001)
        rxb = max(0.0, (rx - self.prev_net[0]) / span)
        txb = max(0.0, (tx - self.prev_net[1]) / span)
        self.prev_net, self.prev_t = (rx, tx), t
        mi = self.meminfo()
        mem = 100.0 * (mi["MemTotal"] - mi["MemAvailable"]) / mi["MemTotal"]
        load1 = os.getloadavg()[0]
        with self.lock:
            self.cur = {"cpu": cpu, "mem": mem, "rx": rxb, "tx": txb}
            self.live.append((int(t), round(cpu, 1), round(mem, 1), round(rxb), round(txb)))
            key = int(t // 60)
            if key != self.minute_key and self.minute:
                n = len(self.minute)
                avg = [sum(s[i] for s in self.minute) / n for i in range(5)]
                self.hist.append((self.minute_key * 60, round(avg[0], 1), round(avg[1], 1),
                                  round(avg[2]), round(avg[3]), round(avg[4], 2)))
                self.minute = []
                if key % 5 == 0:
                    self._save_history()
            self.minute_key = key
            self.minute.append((cpu, mem, rxb, txb, load1))

    def _load_history(self):
        try:
            data = json.loads((STATE_DIR / "history.json").read_text())
            cutoff = now() - 86400
            for row in data:
                if row[0] >= cutoff:
                    self.hist.append(tuple(row))
        except (OSError, ValueError):
            pass

    def _save_history(self):
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = STATE_DIR / "history.json.tmp"
            tmp.write_text(json.dumps(list(self.hist)))
            tmp.replace(STATE_DIR / "history.json")
        except OSError:
            pass

    def loop(self):
        while True:
            time.sleep(5)
            try:
                self.sample()
            except Exception:  # noqa: BLE001
                traceback.print_exc()

    def series(self):
        with self.lock:
            live = list(self.live)
            hist = list(self.hist)
            cur = dict(self.cur)
        return cur, {
            "t": [r[0] for r in live], "cpu": [r[1] for r in live], "mem": [r[2] for r in live],
            "rx": [r[3] for r in live], "tx": [r[4] for r in live],
        }, {
            "t": [r[0] for r in hist], "cpu": [r[1] for r in hist], "mem": [r[2] for r in hist],
            "rx": [r[3] for r in hist], "tx": [r[4] for r in hist], "load1": [r[5] for r in hist],
        }


def collect_updates():
    out = run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], timeout=120)
    inst = [line for line in out.splitlines() if line.startswith("Inst ")]
    security = sum(1 for line in inst if "-security" in line)
    last = None
    try:
        hist = Path("/var/log/apt/history.log").read_text(errors="replace")
        dates = re.findall(r"^End-Date: (.+)$", hist, re.M)
        if dates:
            last = dt.datetime.strptime(dates[-1].strip(), "%Y-%m-%d  %H:%M:%S").replace(
                tzinfo=dt.timezone.utc).timestamp()
    except (OSError, ValueError):
        pass
    release = ""
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                release = line.split("=", 1)[1].strip('"')
    except OSError:
        pass
    new_release = None
    try:
        txt = Path("/var/lib/ubuntu-release-upgrader/release-upgrade-available").read_text()
        m = re.search(r"New release '([^']+)'", txt)
        new_release = m.group(1) if m else None
    except OSError:
        pass
    return {"pending": len(inst), "security": security,
            "rebootRequired": Path("/var/run/reboot-required").exists(),
            "lastUpgrade": last, "release": release, "newRelease": new_release}


def host_info():
    uptime = float(Path("/proc/uptime").read_text().split()[0])
    mi = Sampler.meminfo()
    return {
        "hostname": os.uname().nodename, "ip": public_ip(),
        "os": collect_updates_cached().get("release", ""), "kernel": os.uname().release,
        "uptimeSec": int(uptime), "bootTime": int(now() - uptime),
        "cpus": os.cpu_count() or 1, "memTotal": mi["MemTotal"],
    }


def disks():
    res = []
    for mount in ("/", "/boot"):
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        if mount != "/" and total < 2e9:
            continue
        res.append({"mount": mount, "total": total, "used": used})
    return res


# --------------------------------------------------------------------------- Security

SSH_END = re.compile(r"^(Connection closed by|Connection reset by|Disconnected from (authenticating|invalid) user|"
                     r"Timeout before authentication)")
SSH_OK = re.compile(r"^Accepted (\S+) for (\S+) from (\S+) port \d+(?: ssh2(?:: (\S+))?)?")


# --------------------------------------------------------------------------- Country of an IP
#
# Looked up locally in the free country database from DB-IP (CC BY 4.0, "IP Geolocation
# by DB-IP") - no IP leaves the server. Downloaded again every month.

GEO_DB = STATE_DIR / "dbip-country-lite.mmdb"
GEO = {"reader": None, "cache": {}, "lock": threading.Lock()}
TAILNET4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def geo_update():
    """Download the database when it is missing or older than 35 days."""
    import gzip
    try:
        if GEO_DB.exists() and now() - GEO_DB.stat().st_mtime < 35 * 86400:
            return
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        today = dt.date.today()
        months = [today.strftime("%Y-%m"), (today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")]
        for m in months:
            try:
                # DB-IP rejects Python's default user agent (403).
                req = urllib.request.Request(f"https://download.db-ip.com/free/dbip-country-lite-{m}.mmdb.gz",
                                             headers={"User-Agent": config.USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = gzip.decompress(r.read())
                tmp = GEO_DB.with_suffix(".tmp")
                tmp.write_bytes(data)
                tmp.replace(GEO_DB)
                with GEO["lock"]:
                    GEO["reader"], GEO["cache"] = None, {}
                return
            except (urllib.error.URLError, OSError, EOFError):
                continue
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def geo(ip: str) -> dict:
    """{"cc": "DE", "name": "Germany"} - or Tailnet/internal/unknown."""
    c = GEO["cache"].get(ip)
    if c is not None:
        return c
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return {"cc": None, "name": "?"}
    if a in TAILNET4 or a in TAILNET6:
        res = {"cc": None, "name": "Tailnet"}
    elif a.is_private or a.is_loopback:
        res = {"cc": None, "name": "internal"}
    else:
        res = {"cc": None, "name": "unknown"}
        with GEO["lock"]:
            if GEO["reader"] is None and GEO_DB.exists():
                try:
                    import maxminddb
                    GEO["reader"] = maxminddb.open_database(str(GEO_DB))
                except Exception:  # noqa: BLE001
                    GEO["reader"] = False
            reader = GEO["reader"]
        if reader:
            try:
                rec = reader.get(ip) or {}
                country = rec.get("country") or {}
                names = country.get("names") or {}
                if country.get("iso_code"):
                    res = {"cc": country["iso_code"], "name": names.get("en") or country["iso_code"]}
            except Exception:  # noqa: BLE001
                pass
    if len(GEO["cache"]) > 50000:
        GEO["cache"].clear()
    GEO["cache"][ip] = res
    return res


def countries(ip_counts: dict) -> list[dict]:
    """Attempts and addresses per country, most first."""
    agg: dict[str, dict] = {}
    for ip, n in ip_counts.items():
        g = geo(ip)
        key = g["cc"] or g["name"]
        e = agg.setdefault(key, {"cc": g["cc"], "name": g["name"], "attempts": 0, "ips": 0})
        e["attempts"] += n
        e["ips"] += 1
    return sorted(agg.values(), key=lambda e: -e["attempts"])


KNOCK = re.compile(r"SRC=(\S+) .*SPT=(\d+) DPT=\d+\b")  # the firewall only logs SSH ports with this prefix


def knocks(since: list[str]) -> list[tuple[float, str]]:
    """Rejected connection attempts on a closed port 22 (firewall log prefix config.FW_LOG_PREFIX).
    A client sends its SYN several times - counted once per IP and source port."""
    if not config.enabled("firewall"):
        return []
    proc = subprocess.Popen(["nice", "-n", "15", "journalctl", "-k", *since, "-o", "short-unix", "-q", "--no-pager",
                             "--grep", config.FW_LOG_PREFIX], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, errors="replace")
    seen, out = set(), []
    for line in proc.stdout:
        m = KNOCK.search(line)
        if not m:
            continue
        key = (m.group(1), m.group(2))
        if key in seen:
            continue
        seen.add(key)
        try:
            out.append((float(line.split(" ", 1)[0]), m.group(1)))
        except ValueError:
            continue
    proc.wait()
    return out


_BAN_HISTORY = {"mtime": None, "ips": frozenset(), "read": 0.0}


def ban_history_ips() -> frozenset:
    """Addresses banned by the ban-history module (empty when expired, off or not set up).
    config.BAN_HISTORY_JSON: {"ips": {ip: banned_until_unix}, ...}."""
    if not config.enabled("ban-history"):
        return frozenset()
    p = config.BAN_HISTORY_JSON
    try:
        m = p.stat().st_mtime
    except OSError:
        return frozenset()
    # re-read when the list changes, otherwise hourly (addresses expire one by one)
    if _BAN_HISTORY["mtime"] != m or time.time() - _BAN_HISTORY["read"] > 3600:
        try:
            t = time.time()
            ips = json.loads(p.read_text()).get("ips") or {}
            _BAN_HISTORY.update(mtime=m, ips=frozenset(ip for ip, until in ips.items() if until > t), read=t)
        except (OSError, ValueError, AttributeError):
            _BAN_HISTORY.update(mtime=m, ips=frozenset(), read=time.time())
    return _BAN_HISTORY["ips"]


def ban_history_status() -> dict | None:
    """Status of the ban-history module (past SSH attackers banned again), None when off."""
    if not config.enabled("ban-history"):
        return None
    try:
        r = subprocess.run([str(config.BAN_HISTORY_BIN), "status"], capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


BAN_KINDS = ("ssh", "web", "repeat")


# Bans by kind: web (scanners, app logins), repeat offenders (recidive), everything else SSH.
def ban_kind(jail: str) -> str:
    return "web" if jail in config.JAILS_WEB else "repeat" if jail == config.JAIL_RECIDIVE else "ssh"


def fail2ban_state(t0: float) -> tuple[list, dict, list, collections.Counter, dict]:
    """(jails, banned IPs per jail, bans of the last 7 days, bans per hour, bans per kind and hour)."""
    jails = []
    banned_now: dict[str, set[str]] = {}
    status = run(["fail2ban-client", "status"])
    m = re.search(r"Jail list:\s*(.*)", status)
    for name in [j.strip() for j in (m.group(1).split(",") if m else []) if j.strip()]:
        s = run(["fail2ban-client", "status", name])

        def num(label):
            mm = re.search(label + r":\s*(\d+)", s)
            return int(mm.group(1)) if mm else 0
        ips = re.search(r"Banned IP list:\s*(.*)", s)
        banned_now[name] = set(ips.group(1).split()) if ips else set()
        jails.append({"name": name, "currentlyFailed": num("Currently failed"), "totalFailed": num("Total failed"),
                      "currentlyBanned": num("Currently banned"), "totalBanned": num("Total banned")})

    bans = []
    ban_hours = collections.Counter()
    ban_kinds: dict[str, collections.Counter] = {k: collections.Counter() for k in BAN_KINDS}
    try:
        con = sqlite3.connect(f"file:{F2B_DB}?mode=ro", uri=True, timeout=5)
        rows = con.execute("SELECT jail, ip, timeofban, bantime, bancount FROM bans WHERE timeofban > ? "
                           "ORDER BY timeofban DESC LIMIT 500", (int(t0 - 7 * 86400),)).fetchall()
        con.close()
    except sqlite3.Error:
        rows = []
    seen = set()
    for jail, ip, tob, bantime, count in rows:
        key = (jail, ip, tob)
        if key in seen:
            continue
        seen.add(key)
        if tob > t0 - 86400:
            ban_hours[int(tob // 3600)] += 1
            ban_kinds[ban_kind(jail)][int(tob // 3600)] += 1
        bans.append({"ip": ip, "jail": jail, "bannedAt": tob,
                     "expiresAt": None if bantime < 0 else tob + bantime, "banCount": count,
                     "active": ip in banned_now.get(jail, set()) and (bantime < 0 or tob + bantime > t0)})
    # active bans older than 7 days (recidive) are shown too
    listed = {(b["jail"], b["ip"]) for b in bans if b["active"]}
    for jail, ips in banned_now.items():
        for ip in ips - {i for j, i in listed if j == jail}:
            bans.insert(0, {"ip": ip, "jail": jail, "bannedAt": None, "expiresAt": None, "banCount": 1, "active": True})
    return jails, banned_now, bans, ban_hours, ban_kinds


def collect_security():
    t0 = now()
    f2b = config.enabled("fail2ban")
    jails, banned_now, bans, ban_hours, ban_kinds = fail2ban_state(t0) if f2b else ([], {}, [], None, None)
    all_banned = set().union(*banned_now.values()) if banned_now else set()

    # SSH from the journal
    out = run(["journalctl", "_SYSTEMD_UNIT=ssh.service", "--since", "-24h", "-o", "short-unix", "-q", "--no-pager"],
              timeout=60)
    attempts_by_hour = collections.Counter()
    ip_count = collections.Counter()
    ip_last: dict[str, float] = {}
    logins = []
    for line in out.splitlines():
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        try:
            ts = float(parts[0])
        except ValueError:
            continue
        msg = parts[3]
        if SSH_END.match(msg) and "[preauth]" in msg:
            attempts_by_hour[int(ts // 3600)] += 1
            mm = IPV4.search(msg)
            if mm:
                ip_count[mm.group(1)] += 1
                ip_last[mm.group(1)] = ts
            continue
        mm = SSH_OK.match(msg)
        if mm:
            method = mm.group(1) + (f" ({mm.group(4).split(':')[0]})" if mm.group(4) else "")
            logins.append({"user": mm.group(2), "ip": mm.group(3), "at": ts, "method": method})
    for ts, ip in knocks(["--since", "-24h"]):
        attempts_by_hour[int(ts // 3600)] += 1
        ip_count[ip] += 1
        ip_last[ip] = max(ip_last.get(ip, 0), ts)
    if len(logins) < 10:
        older = run(["journalctl", "_SYSTEMD_UNIT=ssh.service", "--since", "-30d", "--until", "-24h",
                     "-o", "short-unix", "-q", "--no-pager", "--grep", "^Accepted"], timeout=60)
        extra = []
        for line in older.splitlines():
            parts = line.split(" ", 3)
            if len(parts) < 4:
                continue
            mm = SSH_OK.match(parts[3])
            if mm:
                method = mm.group(1) + (f" ({mm.group(4).split(':')[0]})" if mm.group(4) else "")
                extra.append({"user": mm.group(2), "ip": mm.group(3), "at": float(parts[0]), "method": method})
        logins = extra + logins
    logins = sorted(logins, key=lambda x: -x["at"])[:10]

    hours = [int(t0 // 3600) - 23 + i for i in range(24)]
    past = ban_history_ips()
    top = [{"ip": ip, "count": c, "lastSeen": ip_last[ip], "banned": ip in all_banned or ip in past, "country": geo(ip)}
           for ip, c in ip_count.most_common(10)]
    for b in bans:
        b["country"] = geo(b["ip"])
    for lg in logins:
        lg["country"] = geo(lg["ip"])

    off = {"enabled": False}
    return {
        "jails": jails, "bans": bans[:200],
        "pastAttackers": ban_history_status() if config.enabled("ban-history") else off,
        "sshAttempts": {"t": [h * 3600 for h in hours], "count": [attempts_by_hour[h] for h in hours],
                        "total24h": sum(attempts_by_hour.values()), "uniqueIps24h": len(ip_count)},
        "banHistory": {"t": [h * 3600 for h in hours], "count": [ban_hours[h] for h in hours],
                       "byKind": {k: [c[h] for h in hours] for k, c in ban_kinds.items()}} if f2b else off,
        "topIps": top, "logins": logins, "countries24h": countries(ip_count)[:15], "ports": collect_ports(),
        "firewall": collect_firewall() if config.enabled("firewall") else off,
        "audit": collect_audit() if config.enabled("auditd") else off,
    }


# --------------------------------------------------------------------------- Security: history
#
# SSH attempts per day (in KW_LOCAL_TZ), as far back as the journal goes. Reading
# months of journal takes minutes - so it is built once in the background (newest
# days first) and finished days are kept in a file. That file survives when the
# journal drops old entries, and it is part of the backup.

SEC_DAYS = STATE_DIR / "security-days.json"
SEC = {"days": {}, "building": False, "first": None, "today": None, "today_at": 0.0, "lock": threading.Lock()}
F2B_BAN = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ fail2ban\.actions\s+\[\d+\]: NOTICE\s+\[([\w-]+)\] Ban (\S+)")


def local_day(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, config.local_tz()).strftime("%Y-%m-%d")


def local_time(ts: float, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return dt.datetime.fromtimestamp(ts, config.local_tz()).strftime(fmt)


def day_start(day: str) -> float:
    return dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=config.local_tz()).timestamp()


def next_day(day: str) -> str:
    return (dt.datetime.strptime(day, "%Y-%m-%d") + dt.timedelta(days=1)).strftime("%Y-%m-%d")


def scan_attempts(since: float, until: float) -> dict[str, collections.Counter]:
    """Aborted SSH logins per day and IP, streamed from the journal."""
    res: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    proc = subprocess.Popen(["nice", "-n", "15", "ionice", "-c3", "journalctl", "_SYSTEMD_UNIT=ssh.service",
                             "--since", f"@{int(since)}", "--until", f"@{int(until)}", "-o", "short-unix",
                             "-q", "--no-pager", "--grep", "preauth"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    for line in proc.stdout:
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        msg = parts[3]
        if not (SSH_END.match(msg) and "[preauth]" in msg):
            continue
        m = IPV4.search(msg)
        try:
            res[local_day(float(parts[0]))][m.group(1) if m else "?"] += 1
        except ValueError:
            continue
    proc.wait()
    for ts, ip in knocks(["--since", f"@{int(since)}", "--until", f"@{int(until)}"]):
        res[local_day(ts)][ip] += 1
    return res


def scan_bans() -> tuple[dict[str, dict[str, int]], str | None]:
    """Bans per day and kind from the fail2ban logs (they go back ~5 weeks)."""
    if not config.enabled("fail2ban"):
        return {}, None
    import gzip
    per_day: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    first = None
    for path in sorted(glob.glob("/var/log/fail2ban.log*")):
        try:
            fh = gzip.open(path, "rt", errors="replace") if path.endswith(".gz") else open(path, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if first is None or line[:10] < first:
                    if re.match(r"^\d{4}-\d{2}-\d{2}", line):
                        first = line[:10] if first is None or line[:10] < first else first
                m = F2B_BAN.match(line)
                if m:
                    ts = dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()
                    per_day[local_day(ts)][ban_kind(m.group(2))] += 1
    return {d: dict(c) for d, c in per_day.items()}, first


def _first_journal_day() -> str | None:
    proc = subprocess.Popen(["journalctl", "_SYSTEMD_UNIT=ssh.service", "-o", "short-unix", "-q", "--no-pager"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    line = proc.stdout.readline()
    proc.kill()
    try:
        return local_day(float(line.split(" ", 1)[0]))
    except (ValueError, IndexError):
        return None


def _save_sec():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    write_atomic(SEC_DAYS, json.dumps({"first": SEC["first"], "days": SEC["days"]}, separators=(",", ":")), 0o600)


LOGINS_FILE = STATE_DIR / "login-ips.json"
LOGINS = {"until": 0.0, "ips": {}, "lock": threading.Lock()}
# v2: per IP also the timestamps ("times", at most LOGIN_TIMES), so logins can be counted from a
# given day on (logins since SSH is Tailscale-only). An older file keeps counts and IPs; the
# timestamps are filled in once from the journal (backfill).
LOGINS_VERSION = 2
LOGIN_TIMES = 5000


def _journal_logins(since: float):
    """(time, IP, user, method) per successful SSH login after `since` (0 = the whole journal)."""
    args = ["--since", f"@{int(since)}"] if since else []
    proc = subprocess.Popen(["nice", "-n", "15", "ionice", "-c3", "journalctl", "_SYSTEMD_UNIT=ssh.service", *args,
                             "-o", "short-unix", "-q", "--no-pager", "--grep", "^Accepted "],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    for line in proc.stdout:
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        m = SSH_OK.match(parts[3])
        if not m:
            continue
        try:
            ts = float(parts[0])
        except ValueError:
            continue
        if ts <= since:
            continue
        method = m.group(1) + (f" ({m.group(4).split(':')[0]})" if m.group(4) else "")
        yield ts, m.group(3), m.group(2), method
    proc.wait()


def _keep_times(e: dict, times: list[int]):
    e["times"] = sorted(times)[-LOGIN_TIMES:]


def scan_logins():
    """Successful SSH logins per IP since the journal began (incremental)."""
    since = LOGINS["until"] or 0
    if LOGINS.get("backfill"):
        # File without timestamps (v1): counts stay (the journal may not reach back that far any more),
        # only the timestamps up to `until` are filled in once from the journal.
        upto = since
        found: dict[str, list[int]] = {}
        for ts, ip, _user, _method in _journal_logins(0):
            if ts <= upto:
                found.setdefault(ip, []).append(int(ts))
        with LOGINS["lock"]:
            for ip, times in found.items():
                if ip in LOGINS["ips"]:
                    _keep_times(LOGINS["ips"][ip], times + LOGINS["ips"][ip].get("times", []))
        LOGINS["backfill"] = False
    last = since
    for ts, ip, user, method in _journal_logins(since):
        with LOGINS["lock"]:
            e = LOGINS["ips"].setdefault(ip, {"first": ts, "last": ts, "count": 0, "users": [], "methods": [], "times": []})
            e["first"], e["last"] = min(e["first"], ts), max(e["last"], ts)
            e["count"] += 1
            times = e.setdefault("times", [])
            times.append(int(ts))
            if len(times) > LOGIN_TIMES:
                del times[: len(times) - LOGIN_TIMES]
            if user not in e["users"]:
                e["users"].append(user)
            if method not in e["methods"]:
                e["methods"].append(method)
        last = max(last, ts)
    LOGINS["until"] = last
    write_atomic(LOGINS_FILE, json.dumps({"v": LOGINS_VERSION, "until": LOGINS["until"], "ips": LOGINS["ips"]},
                                         separators=(",", ":")), 0o600)


def ssh_tailscale_since() -> float | None:
    """Since when port 22 is closed to the internet (SSH only through Tailscale), else None.
    From SSH_PUBLIC_SINCE in config.FIREWALL_ENV; without it (SSH_PUBLIC=no) the file's mtime."""
    if not (config.enabled("firewall") and config.enabled("tailscale")):
        return None
    env = read_env_file(FIREWALL_ENV)
    if env.get("SSH_PUBLIC", "yes") != "no":
        return None
    raw = env.get("SSH_PUBLIC_SINCE")
    if raw and raw.isdigit():  # Unix time (firewall module and dashboard)
        return float(raw)
    if raw:
        try:
            d = dt.datetime.fromisoformat(raw)
            return (d if d.tzinfo else d.replace(tzinfo=config.local_tz())).timestamp()
        except ValueError:
            pass
    try:
        return FIREWALL_ENV.stat().st_mtime
    except OSError:
        return None


def security_logins():
    since = ssh_tailscale_since()
    with LOGINS["lock"]:
        items = [{"ip": ip, **{k: v for k, v in e.items() if k != "times"},
                  "countSince": sum(1 for t in e.get("times", []) if t >= since) if since else None}
                 for ip, e in LOGINS["ips"].items()]
    for it in items:
        it["country"] = geo(it["ip"])
        it["tailnet"] = it["country"]["name"] == "Tailnet"
    items.sort(key=lambda x: -x["last"])
    return {"ips": items, "complete": LOGINS["until"] > 0 and not LOGINS.get("backfill"), "firstDay": SEC["first"], "since": since}


def security_history_loop():
    try:
        data = json.loads(SEC_DAYS.read_text())
        SEC["days"], SEC["first"] = data.get("days", {}), data.get("first")
    except (OSError, ValueError):
        pass
    try:
        data = json.loads(LOGINS_FILE.read_text())
        LOGINS["until"], LOGINS["ips"] = data.get("until", 0.0), data.get("ips", {})
        LOGINS["backfill"] = data.get("v") != LOGINS_VERSION and bool(LOGINS["until"])
    except (OSError, ValueError):
        pass
    while True:
        geo_update()
        try:
            scan_logins()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        try:
            first = _first_journal_day()
            if first and (not SEC["first"] or first < SEC["first"]):
                SEC["first"] = first
            today = local_day(now())
            missing, d = [], SEC["first"] or today
            while d < today:
                if d not in SEC["days"]:
                    missing.append(d)
                d = next_day(d)
            SEC["building"] = bool(missing)
            # newest first, in blocks of a week
            missing.sort(reverse=True)
            for i in range(0, len(missing), 7):
                chunk = missing[i:i + 7]
                counts = scan_attempts(day_start(min(chunk)), day_start(next_day(max(chunk))))
                with SEC["lock"]:
                    for day in chunk:
                        c = counts.get(day, collections.Counter())
                        SEC["days"][day] = {"a": sum(c.values()), "ips": dict(c), "b": SEC["days"].get(day, {}).get("b"),
                                          "bk": SEC["days"].get(day, {}).get("bk")}
                    _save_sec()
            bans, log_first = scan_bans()
            with SEC["lock"]:
                for day, entry in SEC["days"].items():
                    if log_first and day >= log_first:
                        kinds = bans.get(day, {})
                        entry["b"], entry["bk"] = sum(kinds.values()), kinds
                _save_sec()
            SEC["building"] = False
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(3600)


def security_history(query: dict):
    try:
        days = int(query.get("days", ["30"])[0])
    except ValueError:
        days = 30
    today = local_day(now())
    if now() - SEC["today_at"] > 60:
        c = scan_attempts(day_start(today), now() + 60).get(today, collections.Counter())
        kinds_today: collections.Counter = collections.Counter()
        try:
            if config.enabled("fail2ban"):
                con = sqlite3.connect(f"file:{F2B_DB}?mode=ro", uri=True, timeout=5)
                for jail, n in con.execute("SELECT jail, count(*) FROM bans WHERE timeofban >= ? GROUP BY jail",
                                           (int(day_start(today)),)):
                    kinds_today[ban_kind(jail)] += n
                con.close()
        except sqlite3.Error:
            pass
        SEC["today"] = {"a": sum(c.values()), "ips": dict(c), "b": sum(kinds_today.values()), "bk": dict(kinds_today)}
        SEC["today_at"] = now()
    with SEC["lock"]:
        all_days = dict(SEC["days"])
    all_days[today] = SEC["today"]
    start = SEC["first"] or today
    if days > 0:
        start = max(start, (dt.datetime.strptime(today, "%Y-%m-%d") - dt.timedelta(days=days - 1)).strftime("%Y-%m-%d"))
    # Banned today: ban history + active fail2ban bans. Per day, "blocked" counts the attempts
    # from addresses that are banned today (red part of the day bar).
    banned = set(ban_history_ips())
    sec = safe("security")
    if sec and config.enabled("fail2ban"):
        banned |= {b["ip"] for b in sec["bans"] if b["active"]}
    out, ips, d = [], collections.Counter(), start
    while d <= today:
        e = all_days.get(d)
        if e is not None:
            ips.update(e["ips"])
        out.append({"day": d, "t": day_start(d), "attempts": e["a"] if e else None,
                    "uniqueIps": len(e["ips"]) if e else None, "bans": e.get("b") if e else None,
                    "bansByKind": e.get("bk") if e else None,
                    "blocked": sum(n for ip, n in e["ips"].items() if ip in banned) if e else None})
        d = next_day(d)
    known_bans = [x["bans"] for x in out if x["bans"] is not None]
    return {
        "firstDay": SEC["first"], "building": SEC["building"],
        "days": out,
        "total": {"attempts": sum(x["attempts"] or 0 for x in out), "uniqueIps": len(ips),
                  "blocked": sum(x["blocked"] or 0 for x in out), "blockedIps": sum(1 for ip in ips if ip in banned),
                  "bans": sum(known_bans) if known_bans else None,
                  "bansByKind": {k: sum((x["bansByKind"] or {}).get(k, 0) for x in out) for k in BAN_KINDS}},
        "topIps": [{"ip": ip, "count": n, "banned": ip in banned, "country": geo(ip)} for ip, n in ips.most_common(10)],
        "countries": countries(ips)[:25],
    }


def collect_firewall():
    """Ports keepwatch-firewall lets in, and whether its DOCKER-USER rule is in place."""
    allowed = ALLOWED_TCP_FALLBACK
    # "-A INPUT -i eth0 -p tcp -m conntrack --ctstate NEW [-m multiport ! --dports 22,80,443]
    #  -m comment --comment keepwatch -j DROP" - without --dports nothing is public.
    for rule in run(["iptables", "-S", "INPUT"]).splitlines():
        if "--comment keepwatch" in rule and rule.endswith("-j DROP"):
            m = re.search(r"! --dports ([\d,:]+)", rule)
            allowed = []
            for part in (m.group(1).split(",") if m else []):
                lo, _, hi = part.partition(":")
                allowed += list(range(int(lo), int(hi or lo) + 1))[:1000]
            break
    du = run(["iptables", "-S", "DOCKER-USER"]) if config.enabled("docker") else ""
    return {"enabled": True, "allowedTcp": allowed,
            "dockerUserActive": bool(re.search(r"-i \S+ -j DROP", du)) if config.enabled("docker") else None}


def collect_ports():
    """Listening sockets. Without the firewall module every non-local socket counts as public."""
    allowed = set(collect_firewall()["allowedTcp"]) if config.enabled("firewall") else None
    res, seen = [], set()
    for line in run(["ss", "-tulpnH"]).splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        proto, local = cols[0], cols[4]
        proc = ""
        m = re.search(r'users:\(\("([^"]+)"', line)
        if m:
            proc = m.group(1)
        addr, _, port = local.rpartition(":")
        addr = addr.split("%")[0].strip("[]")
        try:
            port_i = int(port)
            private = addr not in ("0.0.0.0", "*", "::") and ipaddress.ip_address(addr).is_private
        except ValueError:
            continue
        key = (proto, addr, port_i)
        if key in seen:
            continue
        seen.add(key)
        loopback = addr in ("127.0.0.1", "::1", "localhost") or addr.startswith("127.")
        if loopback:
            exposure = "local"
        elif not private:
            exposure = "public" if proto == "tcp" and (allowed is None or port_i in allowed) else (
                "public" if proto == "udp" and port_i not in (68, 546) and addr in ("0.0.0.0", "::", "*") else "internal")
        else:
            exposure = "internal"
        res.append({"proto": proto if proto in ("tcp", "udp") else "tcp", "addr": addr, "port": port_i,
                    "process": proc, "exposure": exposure})
    order = {"public": 0, "internal": 1, "local": 2}
    return sorted(res, key=lambda r: (order[r["exposure"]], r["port"]))


AUDIT_MSG = re.compile(r"msg=audit\((\d+)\.\d+:(\d+)\)")


def collect_audit():
    cutoff = now() - 86400
    events: dict[str, dict] = {}
    files = [AUDIT_LOG.with_name("audit.log.1"), AUDIT_LOG]
    for f in files:
        for line in tail_bytes(f, 8_000_000):
            m = AUDIT_MSG.search(line)
            if not m or int(m.group(1)) < cutoff:
                continue
            ev = events.setdefault(m.group(2), {"at": int(m.group(1)), "key": None, "exe": None, "path": None})
            if line.startswith("type=SYSCALL"):
                k = re.search(r' key="([^"]+)"', line)
                if k:
                    ev["key"] = k.group(1)
                e = re.search(r' exe="([^"]+)"', line)
                if e:
                    ev["exe"] = e.group(1)
            elif line.startswith("type=PATH") and ev["path"] is None:
                n = re.search(r' name="([^"]+)"', line)
                if n and n.group(1) not in ("(null)",):
                    ev["path"] = n.group(1)
    keyed = [e for e in events.values() if e["key"]]
    by_key = collections.Counter(e["key"] for e in keyed)
    recent = sorted(keyed, key=lambda e: -e["at"])[:25]
    return {"enabled": True, "total24h": len(keyed), "byKey": [{"key": k, "count": c} for k, c in by_key.most_common()],
            "recent": recent}


def unban(body):
    jail = str(body.get("jail", ""))
    ip = str(body.get("ip", ""))
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise ApiError(400, "That is not a valid IP address.")
    if jail == "ban-history":  # past SSH attackers (ban-history module), not fail2ban
        require("ban-history")
        run([str(config.BAN_HISTORY_BIN), "release", ip], check=True)
        COLLECTORS["security"].refresh()
        return {"ok": True}
    require("fail2ban")
    jails = [j["name"] for j in COLLECTORS["security"].get()["jails"]]
    if jail not in jails:
        raise ApiError(400, f"There is no jail \"{jail}\".")
    run(["fail2ban-client", "set", jail, "unbanip", ip], check=True)
    COLLECTORS["security"].refresh()
    return {"ok": True}


# --------------------------------------------------------------------------- Docker

def collect_docker():
    ids = run(["docker", "ps", "-aq"]).split()
    inspect = json.loads(run(["docker", "inspect", *ids], timeout=30) or "[]") if ids else []
    stats = {}
    for line in run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], timeout=30).splitlines():
        try:
            s = json.loads(line)
        except ValueError:
            continue
        mem_used, _, mem_lim = s.get("MemUsage", "").partition("/")
        rx, _, tx = s.get("NetIO", "").partition("/")
        stats[s.get("Name")] = {
            "cpuPct": float(s.get("CPUPerc", "0").rstrip("%") or 0),
            "memUsed": parse_size(mem_used), "memLimit": parse_size(mem_lim),
            "netRx": parse_size(rx), "netTx": parse_size(tx),
        }
    containers = []
    for c in inspect:
        name = c["Name"].lstrip("/")
        st = c["State"]
        health = (st.get("Health") or {}).get("Status")
        started = None
        if st.get("Running") and st.get("StartedAt"):
            try:
                started = dt.datetime.fromisoformat(st["StartedAt"][:26].rstrip("Z") + "+00:00").timestamp()
            except ValueError:
                started = None
        ports = []
        for cport, binds in (c.get("NetworkSettings", {}).get("Ports") or {}).items():
            if binds:
                for b in binds:
                    hip = b.get("HostIp") or "0.0.0.0"
                    if hip == "::":
                        continue
                    ports.append(f"{hip}:{b.get('HostPort')}→{cport}")
            else:
                ports.append(cport)
        labels = c["Config"].get("Labels") or {}
        mounts = c.get("Mounts") or []
        s = stats.get(name, {})
        containers.append({
            "name": name, "image": c["Config"]["Image"], "state": st.get("Status", "dead"),
            "status": human_status(st), "health": health if health in ("healthy", "unhealthy", "starting") else None,
            "startedAt": started, "restartCount": c.get("RestartCount", 0),
            "cpuPct": s.get("cpuPct"), "memUsed": s.get("memUsed"), "memLimit": s.get("memLimit"),
            "netRx": s.get("netRx"), "netTx": s.get("netTx"),
            "ports": ports, "networks": sorted((c.get("NetworkSettings", {}).get("Networks") or {}).keys()),
            "project": labels.get("com.docker.compose.project"),
            "workingDir": labels.get("com.docker.compose.project.working_dir"),
            "readOnly": bool(c["HostConfig"].get("ReadonlyRootfs")),
            "user": c["Config"].get("User") or None,
            "privileged": bool(c["HostConfig"].get("Privileged")),
            "dockerSock": any(m.get("Source") == "/var/run/docker.sock" for m in mounts),
            "restartPolicy": (c["HostConfig"].get("RestartPolicy") or {}).get("Name"),
        })
    containers.sort(key=lambda x: (x["state"] != "running", x["project"] or "~", x["name"]))
    disk = {"images": 0, "containers": 0, "volumes": 0, "buildCache": 0}
    for line in run(["docker", "system", "df", "--format", "{{json .}}"], timeout=60).splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        key = {"Images": "images", "Containers": "containers", "Local Volumes": "volumes",
               "Build Cache": "buildCache"}.get(row.get("Type"))
        if key:
            disk[key] = parse_size(row.get("Size", "0")) or 0
    return {"containers": containers, "disk": disk}


def human_status(st: dict) -> str:
    s = st.get("Status", "")
    if s == "running":
        return "running"
    if s == "exited":
        return f"exited (code {st.get('ExitCode', '?')})"
    return {"restarting": "restarting", "paused": "paused", "created": "created", "dead": "dead"}.get(s, s)


def public_containers():
    """What the API shows, without internal fields."""
    require("docker")
    data = COLLECTORS["docker"].get()
    return {"containers": [{k: v for k, v in c.items() if k not in ("workingDir", "restartPolicy")}
                           for c in data["containers"]], "disk": data["disk"]}


def known_container(name: str) -> str:
    require("docker")
    if not CONTAINER_NAME.match(name):
        raise ApiError(400, "Invalid container name.")
    names = {c["name"] for c in COLLECTORS["docker"].get()["containers"]}
    if name not in names:
        COLLECTORS["docker"].refresh()
        names = {c["name"] for c in COLLECTORS["docker"].get()["containers"]}
    if name not in names:
        raise ApiError(404, f"There is no container \"{name}\".")
    return name


def container_logs(name: str, query: dict):
    name = known_container(name)
    try:
        tail = max(1, min(2000, int(query.get("tail", ["300"])[0])))
    except ValueError:
        tail = 300
    cmd = ["docker", "logs", "--timestamps", "--tail", str(tail)]
    since = query.get("since", [None])[0]
    if since:
        try:
            cmd += ["--since", f"{float(since) + 0.000001:.6f}"]
        except ValueError:
            pass
    cmd.append(name)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20, errors="replace")
    except subprocess.TimeoutExpired:
        raise ApiError(504, "Docker took too long to return the logs.")
    lines = []
    for stream, out in (("stdout", p.stdout), ("stderr", p.stderr)):
        for line in out.splitlines():
            stamp, _, text = line.partition(" ")
            try:
                t = dt.datetime.fromisoformat(stamp[:26].rstrip("Z") + "+00:00").timestamp()
            except ValueError:
                t, text = now(), line
            lines.append({"t": t, "stream": stream, "text": text})
    lines.sort(key=lambda x: x["t"])
    return {"lines": lines[-tail:]}


def container_action(name: str, action: str):
    name = known_container(name)
    if action not in ("start", "stop", "restart"):
        raise ApiError(400, "Unknown action.")
    run(["docker", action, name], timeout=120, check=True)
    COLLECTORS["docker"].refresh()
    return {"ok": True}


# --------------------------------------------------------------------------- Portainer / Stacks

def portainer_token() -> str | None:
    if not config.enabled("portainer"):
        return None
    try:
        tok = (CONF_DIR / "portainer.token").read_text().strip()
        return tok or None
    except OSError:
        return None


def portainer(method: str, path: str, body=None, timeout: float = 30):
    require("portainer")
    tok = portainer_token()
    if not tok:
        raise ApiError(409, "No Portainer token is set yet (Settings -> Portainer).")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(config.portainer_url() + path, data=data, method=method,
                                 headers={"X-API-Key": tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("details") or json.loads(detail).get("message") or detail
        except ValueError:
            pass
        if e.code in (401, 403):
            raise ApiError(502, "Portainer rejects the token. Please create a new one.")
        raise ApiError(502, f"Portainer answered {e.code}: {str(detail)[:300]}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(502, f"Portainer is not reachable: {e}")


def collect_stacks():
    containers = COLLECTORS["docker"].get()["containers"]
    by_project: dict[str, list[str]] = collections.defaultdict(list)
    workdir: dict[str, str] = {}
    for c in containers:
        if c["project"]:
            by_project[c["project"]].append(c["name"])
            if c.get("workingDir"):
                workdir[c["project"]] = c["workingDir"]

    connected, reason, raw = False, None, []
    if not portainer_token():
        reason = "No Portainer token set."
    else:
        try:
            raw = portainer("GET", "/api/stacks") or []
            connected = True
        except ApiError as e:
            reason = e.message

    stacks, seen = [], set()
    for s in raw:
        git = s.get("GitConfig")
        name = s.get("Name")
        seen.add(name)
        stacks.append({
            "id": s.get("Id"), "name": name, "source": "git" if git else "file",
            "git": {"url": git.get("URL", ""), "ref": (git.get("ReferenceName") or "").replace("refs/heads/", "")}
            if git else None,
            "autoUpdate": (s.get("AutoUpdate") or {}).get("Interval") or None,
            "containers": sorted(by_project.get(name, [])),
            "envCount": len(s.get("Env") or []),
            "updatedAt": s.get("UpdateDate") or s.get("CreationDate") or None,
            "updatedBy": s.get("UpdatedBy") or s.get("CreatedBy") or None,
            "managed": True,
        })
    for project, names in sorted(by_project.items()):
        if project in seen:
            continue
        wd = workdir.get(project, "")
        m = re.match(r"^/data/compose/(\d+)", wd)
        stacks.append({
            "id": int(m.group(1)) if m else None, "name": project,
            "source": "compose" if not m else "git",
            "git": None, "autoUpdate": None, "containers": sorted(names), "envCount": None,
            "updatedAt": None, "updatedBy": None, "managed": bool(m),
        })
    stacks.sort(key=lambda s: (not s["managed"], s["name"]))
    return {"portainer": {"connected": connected, "reason": reason}, "stacks": stacks}


def _stack(stack_id: int) -> dict:
    s = portainer("GET", f"/api/stacks/{stack_id}")
    if not s:
        raise ApiError(404, "Portainer does not know this stack.")
    return s


def stack_env(stack_id: int):
    s = _stack(stack_id)
    return {"env": [{"name": e.get("name", ""), "value": e.get("value", "")} for e in (s.get("Env") or [])]}


def _deploy(s: dict, env: list[dict], pull_image: bool):
    sid, endpoint = s["Id"], s["EndpointId"]
    git = s.get("GitConfig")
    if git:
        auth = git.get("Authentication") or None
        body = {
            "env": env, "prune": False, "pullImage": pull_image,
            "repositoryReferenceName": git.get("ReferenceName") or "",
            # Empty password + Authentication=true: Portainer uses the stored one.
            "repositoryAuthentication": bool(auth),
            "repositoryUsername": (auth or {}).get("Username", ""),
            "repositoryPassword": "",
            "repositoryGitCredentialID": (auth or {}).get("GitCredentialID", 0),
        }
        portainer("PUT", f"/api/stacks/{sid}/git/redeploy?endpointId={endpoint}", body, timeout=900)
    else:
        f = portainer("GET", f"/api/stacks/{sid}/file") or {}
        body = {"stackFileContent": f.get("StackFileContent", ""), "env": env, "prune": False,
                "pullImage": pull_image}
        portainer("PUT", f"/api/stacks/{sid}?endpointId={endpoint}", body, timeout=900)
    COLLECTORS["docker"].refresh()
    COLLECTORS["stacks"].refresh()


def stack_redeploy(stack_id: int, body: dict):
    s = _stack(stack_id)
    _deploy(s, s.get("Env") or [], bool(body.get("pullImage")))
    return {"ok": True}


def stack_set_env(stack_id: int, body: dict):
    env = body.get("env")
    if not isinstance(env, list):
        raise ApiError(400, "env must be a list.")
    clean, names = [], set()
    for e in env:
        name = str((e or {}).get("name", "")).strip()
        if not name:
            continue
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_.-]*$", name):
            raise ApiError(400, f"\"{name}\" is not a valid variable name.")
        if name in names:
            raise ApiError(400, f"\"{name}\" is in the list twice.")
        names.add(name)
        clean.append({"name": name, "value": str(e.get("value", ""))})
    s = _stack(stack_id)
    _deploy(s, clean, False)
    return {"ok": True}


# --------------------------------------------------------------------------- Sites

NPM_LOG = re.compile(r"^\[([^\]]+)\] (\S+) (\S+) (\d{3}) ")


def cert_info(cert_id) -> dict | None:
    if not cert_id:
        return None
    pem = LE_DIR / "live" / f"npm-{cert_id}" / "fullchain.pem"
    if not pem.exists():
        pem = NPM_DIR / "custom_ssl" / f"npm-{cert_id}" / "fullchain.pem"
    if not pem.exists():
        return None
    out = run(["openssl", "x509", "-noout", "-enddate", "-issuer", "-in", str(pem)])
    m = re.search(r"notAfter=(.+)", out)
    if not m:
        return None
    try:
        exp = dt.datetime.strptime(m.group(1).strip(), "%b %d %H:%M:%S %Y %Z").replace(
            tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        return None
    issuer = re.search(r"O ?= ?([^,\n]+)", out.split("issuer=", 1)[-1])
    cn = re.search(r"CN ?= ?([^,\n]+)", out.split("issuer=", 1)[-1])
    name = (issuer.group(1) if issuer else "") + (f" {cn.group(1)}" if cn else "")
    return {"expiresAt": exp, "daysLeft": int((exp - now()) // 86400), "issuer": name.strip()}


def site_check(domain: str) -> dict | None:
    out = run(["curl", "-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code} %{time_total}",
               "--resolve", f"{domain}:443:127.0.0.1", f"https://{domain}/"], timeout=12)
    try:
        code, secs = out.split()
        return {"code": int(code), "ms": int(float(secs) * 1000)}
    except ValueError:
        return None


def log_stats(host_id: int) -> dict:
    cutoff = now() - 86400
    req = e4 = e5 = blocked = 0
    for line in tail_bytes(NPM_DIR / "logs" / f"proxy-host-{host_id}_access.log", 40_000_000):
        m = NPM_LOG.match(line)
        if not m:
            continue
        try:
            t = dt.datetime.strptime(m.group(1), "%d/%b/%Y:%H:%M:%S %z").timestamp()
        except ValueError:
            continue
        if t < cutoff:
            continue
        req += 1
        code = int(m.group(4))
        upstream = m.group(3)
        if code in (403, 444) and upstream == "-":
            blocked += 1
        elif 400 <= code < 500:
            e4 += 1
        elif code >= 500:
            e5 += 1
    return {"requests24h": req, "errors4xx24h": e4, "errors5xx24h": e5, "blocked24h": blocked}


def collect_sites():
    con = npm_db()
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT * FROM proxy_host WHERE is_deleted=0 ORDER BY id").fetchall()
    acl = collections.Counter()
    try:
        for r in con.execute("SELECT access_list_id FROM access_list_client WHERE directive='allow'"):
            acl[r[0]] += 1
    except sqlite3.Error:
        pass
    default_site = "congratulations"
    try:
        r = con.execute("SELECT value FROM setting WHERE id='default-site'").fetchone()
        default_site = r[0] if r else default_site
    except sqlite3.Error:
        pass
    con.close()
    sites = []
    for r in rows:
        domains = json.loads(r["domain_names"] or "[]")
        allow = len(re.findall(r"^\s*allow\s+", r["advanced_config"] or "", re.M)) + acl.get(r["access_list_id"], 0)
        sites.append({
            "id": r["id"], "domains": domains, "target": f"{r['forward_host']}:{r['forward_port']}",
            "enabled": bool(r["enabled"]), "sslForced": bool(r["ssl_forced"]), "hsts": bool(r["hsts_enabled"]),
            "allowlist": allow, "pathLock": split_path_blocks(r["advanced_config"] or "")[0],
            "cert": cert_info(r["certificate_id"]),
            "check": site_check(domains[0]) if domains and r["enabled"] else None,
            **log_stats(r["id"]),
        })
    return {"defaultSite": default_site, "sites": sites}


# --------------------------------------------------------------------------- Backups
#
# keepwatch-backup reads config.BACKUP_ENV (shell syntax): RESTIC_PASSWORD_FILE, LOCAL_REPO,
# KEEP_*, REMOTE_KEEP_* and, for the off-site copy, REMOTE_REPO (any restic repository URL),
# REMOTE_NAME and the credentials restic needs for it. REMOTE_ENV_KEYS lists the names of
# those credentials (e.g. AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY); the backup script exports them.

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
RESERVED_ENV = {"RESTIC_PASSWORD_FILE", "RESTIC_REPOSITORY", "RESTIC_CACHE_DIR", "LOCAL_REPO", "REMOTE_REPO",
                "REMOTE_NAME", "REMOTE_ENV_KEYS", "RCLONE_CONFIG", "KEEP_DAILY", "KEEP_WEEKLY", "KEEP_MONTHLY",
                "REMOTE_KEEP_DAILY", "REMOTE_KEEP_WEEKLY", "REMOTE_KEEP_MONTHLY", "PATH", "HOME", "LD_PRELOAD",
                "LD_LIBRARY_PATH", "IFS", "SHELL", "BASH_ENV", "ENV"}
REPO_URL = re.compile(r"^(?:(?:s3|b2|sftp|rest|rclone|azure|gs|swift|local):\S+|/\S+)$")
REPO_LABEL = {"s3": "S3", "b2": "Backblaze B2", "sftp": "SFTP", "rest": "REST server", "rclone": "rclone",
              "azure": "Azure", "gs": "Google Cloud Storage", "swift": "Swift"}


def password_file(cfg: dict) -> Path:
    return Path(cfg.get("RESTIC_PASSWORD_FILE") or config.RESTIC_PASSWORD_FILE)


def remote_env_keys(cfg: dict) -> list[str]:
    return [k for k in cfg.get("REMOTE_ENV_KEYS", "").split() if ENV_NAME.match(k) and k not in RESERVED_ENV]


def remote_label(cfg: dict) -> str:
    repo = cfg.get("REMOTE_REPO") or ""
    return cfg.get("REMOTE_NAME") or REPO_LABEL.get(repo.split(":", 1)[0], "Remote")


def mask_repo(repo: str) -> str:
    """Repository URL without credentials (user:password@ in the URL)."""
    return re.sub(r"//[^@/]+@", "//***@", repo or "")


def restic_env(cfg: dict) -> dict:
    env = {"RESTIC_PASSWORD_FILE": str(password_file(cfg)), "RESTIC_CACHE_DIR": "/var/cache/restic", "HOME": "/root"}
    env.update({k: cfg[k] for k in remote_env_keys(cfg) if k in cfg})
    rclone = cfg.get("RCLONE_CONFIG") or (str(config.RCLONE_CONF) if config.RCLONE_CONF.exists() else "")
    if rclone:
        env["RCLONE_CONFIG"] = rclone
    return env


def restic(repo: str, cfg: dict, *args: str, timeout: float = 180) -> tuple[bool, str]:
    """(ok, stdout or the last error line)."""
    try:
        p = subprocess.run(["restic", "-r", repo, *args], capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, "LC_ALL": "C.UTF-8", **restic_env(cfg)})
    except subprocess.TimeoutExpired:
        return False, "restic timed out."
    except OSError as e:
        return False, f"restic did not start: {e}"
    if p.returncode == 0:
        return True, p.stdout
    err = [line for line in (p.stderr or "").strip().splitlines() if line.strip()]
    return False, err[-1][:300] if err else f"restic exit code {p.returncode}"


def restic_snapshots(repo: str, cfg: dict) -> list[dict] | None:
    ok, out = restic(repo, cfg, "snapshots", "--json", "--no-lock")
    try:
        snaps = json.loads(out) if ok else None
    except ValueError:
        return None
    if snaps is None:
        return None
    res = []
    for s in snaps or []:
        try:
            t = dt.datetime.fromisoformat(re.sub(r"(\.\d{6})\d*", r"\1", s["time"])).timestamp()
        except ValueError:
            continue
        res.append({"id": s.get("short_id") or s["id"][:8], "time": t, "paths": s.get("paths", []),
                    "tags": s.get("tags") or []})
    return res


_remote_size = {"at": 0.0, "value": None}


def collect_backups():
    cfg = read_env_file(BACKUP_ENV)
    targets, snapshots = [], []
    local = cfg.get("LOCAL_REPO") or str(config.LOCAL_REPO)
    snaps = restic_snapshots(local, cfg)
    size = None
    out = run(["du", "-sb", local], timeout=60)
    if out:
        size = int(out.split()[0])
    targets.append({"name": "Local", "kind": "local", "configured": snaps is not None, "location": local,
                    "snapshots": len(snaps or []), "size": size,
                    "lastSnapshot": max((s["time"] for s in snaps or []), default=None)})
    snapshots += [{**s, "target": "Local"} for s in snaps or []]
    remote = cfg.get("REMOTE_REPO")
    rname = remote_label(cfg)
    if remote:
        snaps = restic_snapshots(remote, cfg)
        if now() - _remote_size["at"] > 3600:
            ok, out = restic(remote, cfg, "stats", "--mode", "raw-data", "--json", "--no-lock", timeout=600)
            try:
                _remote_size["value"] = json.loads(out).get("total_size") if ok else _remote_size["value"]
            except ValueError:
                pass
            _remote_size["at"] = now()
        targets.append({"name": rname, "kind": "remote", "configured": snaps is not None,
                        "location": mask_repo(remote), "snapshots": len(snaps or []),
                        "size": _remote_size["value"],
                        "lastSnapshot": max((s["time"] for s in snaps or []), default=None)})
        snapshots += [{**s, "target": rname} for s in snaps or []]
    else:
        targets.append({"name": rname, "kind": "remote", "configured": False, "location": "",
                        "snapshots": 0, "size": None, "lastSnapshot": None})
    snapshots.sort(key=lambda s: -s["time"])
    return {"enabled": True, "targets": targets, "snapshots": snapshots[:200]}


def remote_last_ok() -> float:
    """When keepwatch-backup last copied off-site successfully (0 = never / unknown)."""
    try:
        return float(config.BACKUP_REMOTE_OK.read_text().strip() or 0)
    except (OSError, ValueError):
        return 0.0


def unit_active(unit: str) -> bool:
    return run(["systemctl", "is-active", unit]).strip() in ("activating", "active")


def backup_unit(kind: str = "backup", suffix: str = "service") -> str:
    return f"{config.UNITS[kind]}.{suffix}"


def backup_status():
    require("backup")
    base = COLLECTORS["backups"].get()
    show = systemd_show(backup_unit(), "ActiveState", "ExecMainStartTimestamp",
                        "ExecMainExitTimestamp", "Result", "ExecMainStatus", "InvocationID")
    running = show.get("ActiveState") in ("activating", "active", "deactivating")
    start = ts_unix(show.get("ExecMainStartTimestamp"))
    end = ts_unix(show.get("ExecMainExitTimestamp"))
    last = None
    if start:
        ok = None if running else (show.get("Result") == "success" and show.get("ExecMainStatus") == "0")
        last = {"startedAt": start, "finishedAt": None if running else end, "ok": ok,
                "durationSec": int((end or now()) - start) if (end and end >= start) or running else None}
    timer = systemd_show(backup_unit(suffix="timer"), "NextElapseUSecRealtime")
    next_run = ts_unix(timer.get("NextElapseUSecRealtime"))
    log = []
    inv = show.get("InvocationID")
    if inv:
        log = run(["journalctl", f"_SYSTEMD_INVOCATION_ID={inv}", "-o", "cat", "--no-pager", "-n", "80"]).splitlines()
    pr = systemd_show(backup_unit("backup-verify"), "ActiveState", "ExecMainStartTimestamp",
                      "ExecMainExitTimestamp", "Result", "ExecMainStatus")
    p_start, p_end = ts_unix(pr.get("ExecMainStartTimestamp")), ts_unix(pr.get("ExecMainExitTimestamp"))
    p_running = pr.get("ActiveState") in ("activating", "active")
    probe = None
    if p_start:
        probe = {"at": p_end or p_start, "running": p_running,
                 "ok": None if p_running else (pr.get("Result") == "success" and pr.get("ExecMainStatus") == "0"),
                 "durationSec": int(p_end - p_start) if p_end and p_end >= p_start else None}
    p_next = ts_unix(systemd_show(backup_unit("backup-verify", "timer"), "NextElapseUSecRealtime")
                     .get("NextElapseUSecRealtime"))
    return {**base, "running": running, "lastRun": last, "nextRun": next_run, "log": log,
            "probe": probe, "probeNext": p_next, "remoteLastOk": remote_last_ok() or None}


def probe_run():
    require("backup")
    if unit_active(backup_unit("backup-verify")):
        raise ApiError(409, "The backup self-test is already running.")
    run(["systemctl", "start", "--no-block", backup_unit("backup-verify")], check=True)
    return {"ok": True}


_backup_was_running = {"v": False}


def backup_watch():
    """Re-read the snapshot list right after a run ends."""
    while True:
        time.sleep(5)
        if not config.enabled("backup"):
            continue
        active = unit_active(backup_unit())
        if _backup_was_running["v"] and not active:
            COLLECTORS["backups"].refresh()
        _backup_was_running["v"] = active


def backup_run():
    require("backup")
    if unit_active(backup_unit()):
        raise ApiError(409, "A backup is already running.")
    run(["systemctl", "start", "--no-block", backup_unit()], check=True)
    _backup_was_running["v"] = True
    return {"ok": True}


# --------------------------------------------------------------------------- Settings
#
# Everything set here lives in its own files under /etc that a deploy never overwrites
# (keepwatch.conf only provides the initial values), so it is part of the backup and
# comes back on a new server with restore.

F2B_DASH = Path("/etc/fail2ban/jail.d/zz-keepwatch-dashboard.local")
APT_REBOOT = Path("/etc/apt/apt.conf.d/52-auto-reboot")
APT_UPGRADE_TIMER = Path("/etc/systemd/system/apt-daily-upgrade.timer.d/override.conf")
APT_LISTS_TIMER = Path("/etc/systemd/system/apt-daily.timer.d/override.conf")
REMOTE_CHECK = STATE_DIR / "remote-check.json"
# Off-site retention, separate from local (KEEP_*): field, key, limits.
REMOTE_KEEP = (("remoteKeepDaily", "REMOTE_KEEP_DAILY", 1, 365), ("remoteKeepWeekly", "REMOTE_KEEP_WEEKLY", 0, 260),
               ("remoteKeepMonthly", "REMOTE_KEEP_MONTHLY", 0, 120))


def _keep_defaults(key: str, fallback: tuple) -> tuple[int, int, int]:
    vals = (config.get_list(key) + [""] * 3)[:3]
    return tuple(int(v) if v.isdigit() else f for v, f in zip(vals, fallback))


LOCAL_KEEP = (("keepDaily", "KEEP_DAILY"), ("keepWeekly", "KEEP_WEEKLY"), ("keepMonthly", "KEEP_MONTHLY"))
KEEP_DEFAULT = dict(zip(("KEEP_DAILY", "KEEP_WEEKLY", "KEEP_MONTHLY"), _keep_defaults("KW_BACKUP_KEEP", (7, 4, 6))))
REMOTE_KEEP_DEFAULT = dict(zip(("REMOTE_KEEP_DAILY", "REMOTE_KEEP_WEEKLY", "REMOTE_KEEP_MONTHLY"),
                               _keep_defaults("KW_BACKUP_REMOTE_KEEP", (14, 13, 24))))
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def timer_dropin() -> Path:
    return Path(f"/etc/systemd/system/{backup_unit(suffix='timer')}.d/schedule.conf")


def write_atomic(path: Path, text: str, mode: int = 0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    # unique name: two threads writing the same file do not get in each other's way
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text)
    os.chmod(tmp, mode)
    tmp.replace(path)


def set_env_values(path: Path, values: dict[str, str | None], mode: int = 0o600):
    """Set keys in a KEY=value file, keep the rest and the comments. None removes a key."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        lines = []
    done = set()
    out = []
    for line in lines:
        m = config.LINE.match(line)
        k = m.group(1) if m and not line.lstrip().startswith("#") else None
        if k in values:
            if values[k] is not None and k not in done:
                out.append(f"{k}={config.quote(values[k])}")
            done.add(k)
        else:
            out.append(line)
    out += [f"{k}={config.quote(v)}" for k, v in values.items() if k not in done and v is not None]
    write_atomic(path, "\n".join(out) + "\n", mode)


def my_ips() -> list[str]:
    """Peers of the open SSH connections - the tunnel runs over them."""
    ips = []
    for line in run(["ss", "-tnH", "state", "established", "( sport = :22 )"]).splitlines():
        cols = line.split()
        if len(cols) >= 4:
            ip = cols[3].rpartition(":")[0].strip("[]")
            if ip.startswith("::ffff:"):
                ip = ip[7:]
            if ip and ip not in ips:
                ips.append(ip)
    return ips


ON_CALENDAR = re.compile(r"^OnCalendar=(?:\*-\*-\*\s+)?(\d{1,2}):(\d{2})(?::\d{2})?(?:\s+([A-Za-z][\w+/-]*))?\s*$", re.M)


def calendar(hhmm: str) -> str:
    """systemd OnCalendar value for a daily time in KW_LOCAL_TZ, as lib/common.sh `calendar` writes it:
    "*-*-* 04:00:00 Europe/Paris"."""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"*-*-* {h:02d}:{m:02d}:00 {config.local_tz_name()}"


def timer_time(*paths: Path, default: str) -> str:
    """Time of day (HH:MM in KW_LOCAL_TZ) from the last daily OnCalendar line. A line in another
    zone (or without one = the system zone) is converted."""
    for p in paths:
        try:
            found = ON_CALENDAR.findall(p.read_text())
        except OSError:
            continue
        if not found:
            continue
        h, m, zone = found[-1]
        local = config.local_tz()
        try:
            src = ZoneInfo(zone) if zone else dt.datetime.now().astimezone().tzinfo
        except (ZoneInfoNotFoundError, ValueError):
            src = local
        at = dt.datetime.now(src).replace(hour=int(h) % 24, minute=int(m), second=0, microsecond=0)
        return at.astimezone(local).strftime("%H:%M")
    return default


def backup_schedule() -> str:
    return timer_time(timer_dropin(), Path(f"/etc/systemd/system/{backup_unit(suffix='timer')}"),
                      default=config.get("KW_BACKUP_TIME", "03:00"))


def f2b_get(jail: str, key: str) -> str:
    return run(["fail2ban-client", "get", jail, key]).strip()


OFF = {"enabled": False}


def fail2ban_settings() -> dict:
    def num(v, default):
        m = re.search(r"-?\d+", v or "")
        return int(m.group(0)) if m else default
    tailnet = config.enabled("tailscale")
    main = config.JAIL_SSH_TAILNET if tailnet else config.JAIL_SSH
    ignore = []
    for line in run(["fail2ban-client", "get", main, "ignoreip"]).splitlines():
        v = re.sub(r"^[\s|`\-]+", "", line).strip()
        if v and not v.startswith("These IP") and v not in ("127.0.0.1/8", "127.0.0.0/8", "::1", "::1/128",
                                                            "100.64.0.0/10", "fd7a:115c:a1e0::/48"):
            ignore.append(v)
    rec = num(f2b_get(config.JAIL_RECIDIVE, "bantime"), 604800)
    rec_find = num(f2b_get(config.JAIL_RECIDIVE, "findtime"), 86400)
    default = f2b_default_maxretry()
    # sshMaxretry: failed logins from the internet (jail sshd); maxretry: through Tailscale (sshd-tailscale).
    return {"enabled": True,
            "sshMaxretry": num(f2b_get(config.JAIL_SSH, "maxretry"), default),
            "maxretry": num(f2b_get(config.JAIL_SSH_TAILNET, "maxretry"), default) if tailnet else None,
            "findtimeHours": max(1, num(f2b_get(main, "findtime"), 86400) // 3600),
            "bantimeHours": max(1, num(f2b_get(main, "bantime"), 604800) // 3600),
            "recidiveMaxretry": num(f2b_get(config.JAIL_RECIDIVE, "maxretry"), 2),
            "recidiveFindtimeDays": max(1, rec_find // 86400),
            "recidiveBantimeDays": max(1, rec // 86400), "ignoreip": ignore}


def remote_settings(cfg: dict) -> dict:
    try:
        check = json.loads(REMOTE_CHECK.read_text())
    except (OSError, ValueError):
        check = None
    return {"configured": bool(cfg.get("REMOTE_REPO")), "name": remote_label(cfg),
            "repo": mask_repo(cfg.get("REMOTE_REPO", "")) or None,
            "env": [k for k in remote_env_keys(cfg) if cfg.get(k)],  # names only, values are write-only
            "rcloneConf": config.RCLONE_CONF.exists(), "check": check}


def get_settings(handler=None):
    cfg = read_env_file(BACKUP_ENV) if config.enabled("backup") else {}
    pw = password_file(cfg)
    if config.enabled("portainer"):
        stk = safe("stacks") or {"portainer": {"connected": False, "reason": None}}
        portainer_s = {"enabled": True, "tokenSet": bool(portainer_token()), "connected": stk["portainer"]["connected"],
                       "reason": stk["portainer"]["reason"]}
    else:
        portainer_s = OFF
    if config.enabled("auto-updates"):
        auto = re.search(r'Unattended-Upgrade::Automatic-Reboot "(\w+)"', run(["apt-config", "dump"]))
        updates_s = {"enabled": True, "autoReboot": bool(auto and auto.group(1) == "true"),
                     "rebootTime": timer_time(APT_UPGRADE_TIMER, default=config.get("KW_UPDATE_TIME", "04:00"))}
    else:
        updates_s = OFF
    return {
        "backup": {"enabled": True, "schedule": backup_schedule(),
                   **{field: int(cfg.get(key) or KEEP_DEFAULT[key]) for field, key in LOCAL_KEEP},
                   **{key: int(cfg.get(env) or REMOTE_KEEP_DEFAULT[env]) for key, env, _, _ in REMOTE_KEEP},
                   "passwordSet": pw.exists() and pw.stat().st_size > 0} if config.enabled("backup") else OFF,
        "remote": remote_settings(cfg) if config.enabled("backup") else OFF,
        "portainer": portainer_s,
        "fail2ban": fail2ban_settings() if config.enabled("fail2ban") else OFF,
        "updates": updates_s,
        "myIps": my_ips(),
        "tailscale": (tailscale_settings(handler) if handler else None) if config.enabled("tailscale") else OFF,
        "ssh": ssh_state() if ssh_toggle_available() else OFF,
    }


def _int(body, key, lo, hi) -> int:
    try:
        v = int(body.get(key))
    except (TypeError, ValueError):
        raise ApiError(400, f"\"{key}\" must be a number.")
    if not lo <= v <= hi:
        raise ApiError(400, f"\"{key}\" must be between {lo} and {hi}.")
    return v


def put_backup_settings(body):
    require("backup")
    sched = str(body.get("schedule", ""))
    if not HHMM.match(sched):
        raise ApiError(400, "Please give the time as HH:MM.")
    keep = {"KEEP_DAILY": _int(body, "keepDaily", 1, 365), "KEEP_WEEKLY": _int(body, "keepWeekly", 0, 260),
            "KEEP_MONTHLY": _int(body, "keepMonthly", 0, 120)}
    # Off-site separately; missing from the request = keep the current value.
    cfg = read_env_file(BACKUP_ENV)
    for key, env, lo, hi in REMOTE_KEEP:
        keep[env] = _int(body, key, lo, hi) if key in body else int(cfg.get(env) or REMOTE_KEEP_DEFAULT[env])
    # Off-site keeps at least as much as local per level - otherwise `restic copy` copies again
    # every night what was just pruned off-site.
    for level, name in (("DAILY", "days"), ("WEEKLY", "weeks"), ("MONTHLY", "months")):
        if keep[f"REMOTE_KEEP_{level}"] < keep[f"KEEP_{level}"]:
            raise ApiError(400, f"Off-site must keep at least as many {name} as local.")
    write_atomic(timer_dropin(), "# Keepwatch: daily backup. Set by the dashboard.\n[Timer]\nOnCalendar=\n"
                                 f"OnCalendar={calendar(sched)}\n")
    run(["systemctl", "daemon-reload"], check=True)
    run(["systemctl", "restart", backup_unit(suffix="timer")], check=True)
    set_env_values(BACKUP_ENV, {k: str(v) for k, v in keep.items()})
    COLLECTORS["backups"].refresh()
    return {"ok": True}


def backup_password():
    require("backup")
    try:
        return {"password": password_file(read_env_file(BACKUP_ENV)).read_text().strip()}
    except OSError:
        raise ApiError(404, "There is no backup password yet.")


def _save_check(ok: bool, message: str):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    REMOTE_CHECK.write_text(json.dumps({"ok": ok, "at": now(), "message": message}))


def remote_test():
    require("backup")
    cfg = read_env_file(BACKUP_ENV)
    repo = cfg.get("REMOTE_REPO")
    if not repo:
        raise ApiError(409, "No off-site repository is set.")
    snaps = restic_snapshots(repo, cfg)
    if snaps is not None:
        msg = f"Connected, {len(snaps)} snapshot{'s' if len(snaps) != 1 else ''} in {remote_label(cfg)}."
        _save_check(True, msg)
        return {"ok": True, "message": msg}
    _, err = restic(repo, cfg, "snapshots", "--json", "--no-lock", timeout=120)
    _save_check(False, err)
    return {"ok": False, "message": err}


def put_remote(body):
    """Set the off-site restic repository: {repo, name?, env?: [{name, value?}], rcloneConf?}.
    Checks access, creates the repository if needed (same chunker as local, so `restic copy`
    deduplicates), saves and starts the first backup. Values of `env` are write-only:
    a missing/null value keeps the stored one, names left out are removed."""
    require("backup")
    repo = str(body.get("repo", "")).strip()
    if not REPO_URL.match(repo) or len(repo) > 500:
        raise ApiError(400, "That does not look like a restic repository URL (e.g. s3:https://host/bucket, "
                            "b2:bucket:path, sftp:user@host:/path, rest:https://host/, rclone:remote:path).")
    name = re.sub(r"[\r\n\"$`\\]", "", str(body.get("name") or "")).strip()[:40]
    raw = body.get("env") or []
    if not isinstance(raw, list):
        raise ApiError(400, "env must be a list of {name, value}.")
    cfg = read_env_file(BACKUP_ENV)
    creds: dict[str, str] = {}
    for e in raw:
        key = str((e or {}).get("name", "")).strip()
        if not ENV_NAME.match(key) or key in RESERVED_ENV:
            raise ApiError(400, f"\"{key}\" cannot be used as a credential variable.")
        value = e.get("value")
        if value is None or value == "":
            if not cfg.get(key):
                raise ApiError(400, f"Please give a value for {key}.")
            value = cfg[key]
        if "\n" in str(value):
            raise ApiError(400, f"{key} must be a single line.")
        creds[key] = str(value)
    rclone_text = body.get("rcloneConf")
    if rclone_text is not None and not isinstance(rclone_text, str):
        raise ApiError(400, "rcloneConf must be text.")
    old_conf = config.RCLONE_CONF.read_text() if config.RCLONE_CONF.exists() else None
    if rclone_text:
        write_atomic(config.RCLONE_CONF, rclone_text.rstrip("\n") + "\n", 0o600)

    test = {**cfg, **creds, "REMOTE_ENV_KEYS": " ".join(creds)}
    for k in remote_env_keys(cfg):
        if k not in creds:
            test.pop(k, None)
    ok, err = restic(repo, test, "cat", "config", "--no-lock", timeout=120)
    if not ok and not re.search(r"does not exist|Is there a repository|unable to open config file|no such file",
                                err, re.I):
        if rclone_text:  # keep the previous rclone.conf when the new one does not work
            if old_conf is None:
                config.RCLONE_CONF.unlink(missing_ok=True)
            else:
                write_atomic(config.RCLONE_CONF, old_conf, 0o600)
        _save_check(False, err)
        raise ApiError(400, f"The repository is not reachable: {err}")
    if not ok:
        local = cfg.get("LOCAL_REPO") or str(config.LOCAL_REPO)
        ok, err = restic(repo, test, "init", "--from-repo", local, "--copy-chunker-params",
                         "--from-password-file", str(password_file(cfg)), timeout=300)
        if not ok:
            _save_check(False, err)
            raise ApiError(500, f"The repository is reachable, but could not be created: {err}")
    values: dict[str, str | None] = {k: None for k in remote_env_keys(cfg) if k not in creds}
    values.update({"REMOTE_REPO": repo, "REMOTE_NAME": name or None, "REMOTE_ENV_KEYS": " ".join(creds) or None,
                   **creds})
    if config.RCLONE_CONF.exists():
        values["RCLONE_CONFIG"] = str(config.RCLONE_CONF)
    set_env_values(BACKUP_ENV, values)
    _save_check(True, "Connected, repository ready.")
    started = not unit_active(backup_unit())
    if started:
        run(["systemctl", "start", "--no-block", backup_unit()])
        _backup_was_running["v"] = True
    _remote_size["at"] = 0
    COLLECTORS["backups"].refresh()
    return {"ok": True, "message": "Connected. The first off-site backup is running." if started
            else "Connected. The running backup does not copy off-site yet - the next one will."}


def delete_remote():
    require("backup")
    cfg = read_env_file(BACKUP_ENV)
    set_env_values(BACKUP_ENV, {"REMOTE_REPO": "", "REMOTE_NAME": None, "REMOTE_ENV_KEYS": None,
                                **{k: None for k in remote_env_keys(cfg)}})
    REMOTE_CHECK.unlink(missing_ok=True)
    COLLECTORS["backups"].refresh()
    return {"ok": True}


def put_portainer(body):
    require("portainer")
    token = str(body.get("token", "")).strip()
    if not re.match(r"^[A-Za-z0-9_+/=.-]{16,512}$", token):
        raise ApiError(400, "That does not look like a Portainer access token.")
    req = urllib.request.Request(config.portainer_url() + "/api/stacks", headers={"X-API-Key": token})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    except urllib.error.HTTPError as e:
        raise ApiError(400, "Portainer rejects the token." if e.code in (401, 403) else f"Portainer answered {e.code}.")
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(502, f"Portainer is not reachable: {e}")
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    write_atomic(CONF_DIR / "portainer.token", token + "\n", 0o600)
    COLLECTORS["stacks"].refresh()
    return {"ok": True}


def _ipnet(v: str) -> ipaddress._BaseNetwork:
    try:
        return ipaddress.ip_network(v.strip(), strict=False)
    except ValueError:
        raise ApiError(400, f"\"{v}\" is not a valid IP address or network.")


def _net_str(n) -> str:
    return str(n.network_address) if n.num_addresses == 1 else str(n)


def f2b_default_maxretry() -> int:
    """KW_F2B_SSH_MAXRETRY (failed SSH logins before a ban), 7 by default."""
    v = config.get_int("KW_F2B_SSH_MAXRETRY", 7)
    return v if 1 <= v <= 50 else 7


def _current_maxretry(jail: str) -> int:
    m = re.search(r"\d+", f2b_get(jail, "maxretry") or "")
    v = int(m.group(0)) if m else f2b_default_maxretry()
    return v if 1 <= v <= 50 else f2b_default_maxretry()


def put_fail2ban(body):
    require("fail2ban")
    if not isinstance(body, dict):
        raise ApiError(400, "Expected a JSON object.")
    tailnet = config.enabled("tailscale")
    # Both limits are optional: a missing one keeps what the jail uses right now.
    ssh_retry = _int(body, "sshMaxretry", 1, 50) if body.get("sshMaxretry") is not None else _current_maxretry(config.JAIL_SSH)
    if tailnet:
        maxretry = _int(body, "maxretry", 1, 50) if body.get("maxretry") is not None else _current_maxretry(config.JAIL_SSH_TAILNET)
    else:
        maxretry = None
    findtime = _int(body, "findtimeHours", 1, 720)
    bantime = _int(body, "bantimeHours", 1, 8760)
    rec_retry = _int(body, "recidiveMaxretry", 1, 50)
    rec_find = _int(body, "recidiveFindtimeDays", 1, 365)
    recidive = _int(body, "recidiveBantimeDays", 1, 3650)
    ips = body.get("ignoreip") or []
    if not isinstance(ips, list):
        raise ApiError(400, "ignoreip must be a list.")
    ignore = []
    for v in ips:
        s = _net_str(_ipnet(str(v)))
        if s not in ignore:
            ignore.append(s)
    extra = "".join(" " + i for i in ignore)
    tailnet_nets = " 100.64.0.0/10 fd7a:115c:a1e0::/48" if tailnet else ""
    text = ("# Set by the Keepwatch dashboard. Overrides the fail2ban module's defaults.\n"
            f"[DEFAULT]\nignoreip = 127.0.0.1/8 ::1{extra}\n\n"
            "# From the internet.\n"
            f"[{config.JAIL_SSH}]\nmaxretry = {ssh_retry}\nfindtime = {findtime}h\nbantime = {bantime}h\n"
            f"ignoreip = 127.0.0.1/8 ::1{tailnet_nets}{extra}\n\n")
    if tailnet:
        text += (f"[{config.JAIL_SSH_TAILNET}]\nmaxretry = {maxretry}\nfindtime = {findtime}h\nbantime = {bantime}h\n\n")
    if config.enabled("firewall"):
        text += ("# Port 22 closed: whoever tries anyway is banned at once.\n"
                 f"[{config.JAIL_SSH_CLOSED}]\nmaxretry = 1\nfindtime = {findtime}h\nbantime = {bantime}h\n\n")
    text += f"[{config.JAIL_RECIDIVE}]\nmaxretry = {rec_retry}\nfindtime = {rec_find}d\nbantime = {recidive}d\n"
    old = F2B_DASH.read_text() if F2B_DASH.exists() else None
    write_atomic(F2B_DASH, text)
    if run(["fail2ban-client", "-t"], timeout=30).find("OK") < 0:
        if old is None:
            F2B_DASH.unlink()
        else:
            write_atomic(F2B_DASH, old)
        raise ApiError(400, "fail2ban rejects these settings - nothing was changed.")
    run(["fail2ban-client", "reload"], timeout=60, check=True)
    COLLECTORS["security"].refresh()
    return {"ok": True}


def put_updates(body):
    require("auto-updates")
    if not isinstance(body.get("autoReboot"), bool):
        raise ApiError(400, "\"autoReboot\" must be true or false.")
    auto = body["autoReboot"]
    t = body.get("rebootTime")
    if not isinstance(t, str) or not HHMM.match(t):
        raise ApiError(400, "Please give the time as HH:MM.")
    # Updates run at t (KW_LOCAL_TZ); a needed reboot follows right after ("now"). A fixed
    # Reboot-Time would be wrong: shutdown would take the next occasion - after the updates
    # at 04:00 that is 04:00 tomorrow.
    tz = config.local_tz_name()
    write_atomic(APT_REBOOT, "// Set by the Keepwatch dashboard.\n"
                             "// Kernel and libc updates only take effect after a reboot.\n"
                             f'Unattended-Upgrade::Automatic-Reboot "{"true" if auto else "false"}";\n'
                             'Unattended-Upgrade::Automatic-Reboot-WithUsers "true";\n'
                             'Unattended-Upgrade::Automatic-Reboot-Time "now";\n')
    write_atomic(APT_UPGRADE_TIMER, f"# Keepwatch: security updates at a fixed time ({tz}); a reboot follows right after\n"
                                    "# when an update needs one (52-auto-reboot). Set by the dashboard.\n[Timer]\nOnCalendar=\n"
                                    f"OnCalendar={calendar(t)}\nRandomizedDelaySec=0\nPersistent=true\n")
    # package lists 30 minutes before (as the auto-updates module sets it up)
    h, m = (int(x) for x in t.split(":"))
    lists = f"{(h * 60 + m - 30) % 1440 // 60:02d}:{(h * 60 + m - 30) % 60:02d}"
    write_atomic(APT_LISTS_TIMER, "# Keepwatch: package lists 30 minutes before the security updates. Set by the dashboard.\n"
                                  f"[Timer]\nOnCalendar=\nOnCalendar={calendar(lists)}\nRandomizedDelaySec=0\nPersistent=true\n")
    run(["systemctl", "daemon-reload"], check=True)
    run(["systemctl", "restart", "apt-daily.timer", "apt-daily-upgrade.timer"], check=True)
    return {"ok": True}


# --------------------------------------------------------------------------- Renew certificates
#
# Exactly like the Proxy Manager itself (app/internal/certificate.js ->
# renewLetsEncryptSsl): certbot inside the container, then the new expiry date
# into its database and reload nginx. Without `force` certbot only renews what
# expires in less than 30 days (Let's Encrypt rate-limits new certificates).

def _renew_cert(cert_id: int, force: bool) -> dict:
    db_path = NPM_DIR / "database.sqlite"
    con = npm_db(write=True)
    row = con.execute("SELECT provider, meta FROM certificate WHERE id=? AND is_deleted=0", (cert_id,)).fetchone()
    if not row:
        con.close()
        raise ApiError(404, "There is no such certificate.")
    provider, meta_raw = row
    meta = json.loads(meta_raw or "{}")
    if provider != "letsencrypt":
        con.close()
        raise ApiError(400, "Only Let's Encrypt certificates can be renewed.")
    if meta.get("dns_challenge"):
        con.close()
        raise ApiError(400, "This certificate uses the DNS challenge - please renew it in the Proxy Manager.")
    before = cert_info(cert_id)
    args = ["certbot", "renew", "--config", "/etc/letsencrypt.ini", "--work-dir", "/tmp/letsencrypt-lib",
            "--logs-dir", "/tmp/letsencrypt-log", "--cert-name", f"npm-{cert_id}", "--preferred-challenges", "http",
            "--no-random-sleep-on-renew", "--disable-hook-validation"]
    if force:
        args.insert(2, "--force-renewal")
    if meta.get("key_type"):
        args += ["--key-type", meta["key_type"]]
    p = subprocess.run(["docker", "exec", npm_container(), *args], capture_output=True, text=True, timeout=300)
    out = (p.stdout + p.stderr).strip()
    if p.returncode != 0:
        con.close()
        lines = [line for line in out.splitlines() if line.strip()]
        hint = next((line for line in reversed(lines) if "Detail:" in line or "Error" in line or "error" in line),
                    lines[-1] if lines else "unknown error")
        raise ApiError(502, f"Renewal failed: {hint.strip()[:300]}")
    after = cert_info(cert_id)
    renewed = bool(after and before and after["expiresAt"] > before["expiresAt"] + 3600)
    if after:
        con.execute("UPDATE certificate SET expires_on=?, modified_on=datetime('now') WHERE id=?",
                    (dt.datetime.fromtimestamp(after["expiresAt"], dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), cert_id))
        con.commit()
    con.close()
    if renewed:
        run(["docker", "exec", npm_container(), "nginx", "-s", "reload"], check=True)
    return {"renewed": renewed, "expiresAt": after["expiresAt"] if after else None,
            "daysLeft": after["daysLeft"] if after else None}


def renew_site_cert(host_id: int, body: dict):
    require("proxy")
    con = npm_db()
    row = con.execute("SELECT certificate_id, domain_names FROM proxy_host WHERE id=? AND is_deleted=0", (host_id,)).fetchone()
    con.close()
    if not row or not row[0]:
        raise ApiError(404, "This site has no certificate.")
    res = _renew_cert(int(row[0]), bool(body.get("force", True)))
    COLLECTORS["sites"].refresh()
    name = (json.loads(row[1] or "[]") or ["?"])[0]
    until = local_time(res["expiresAt"], "%Y-%m-%d") if res["expiresAt"] else "?"
    msg = (f"{name}: new certificate valid until {until}." if res["renewed"]
           else f"{name}: not due yet (valid until {until}).")
    return {"ok": True, "message": msg, **res}


def renew_due_certs():
    require("proxy")
    con = npm_db()
    ids = [r[0] for r in con.execute("SELECT DISTINCT certificate_id FROM proxy_host WHERE is_deleted=0 AND enabled=1 "
                                      "AND certificate_id > 0")]
    con.close()
    renewed, failed = 0, []
    for cid in ids:
        info = cert_info(cid)
        if info and info["daysLeft"] >= 30:
            continue
        try:
            renewed += 1 if _renew_cert(cid, False)["renewed"] else 0
        except ApiError as e:
            failed.append(f"npm-{cid}: {e.message}")
    COLLECTORS["sites"].refresh()
    if failed:
        raise ApiError(502, f"{renewed} renewed, {len(failed)} failed - " + "; ".join(failed)[:400])
    return {"ok": True, "renewed": renewed,
            "message": f"{renewed} certificate{'s' if renewed != 1 else ''} renewed." if renewed
            else "No certificate is due (all are valid for more than 30 days)."}


# --------------------------------------------------------------------------- Tailscale / SSH

FIREWALL_ENV = config.FIREWALL_ENV
REVERT_UNIT = "keepwatch-ssh-revert"  # transient timer: reopens port 22 unless the change is confirmed
TS_LOGIN = {"proc": None, "url": None}


def ssh_toggle_available() -> bool:
    """Closing port 22 needs the firewall (enforces it) and Tailscale (the way in instead)."""
    return config.enabled("firewall") and config.enabled("tailscale")


def ts_status() -> dict | None:
    if not config.enabled("tailscale"):
        return None
    out = run(["tailscale", "status", "--json"], timeout=10)
    try:
        return json.loads(out)
    except ValueError:
        return None


def ts_serve_urls(st: dict | None) -> list[dict]:
    """What `tailscale serve` currently shares in the tailnet. Should be empty: the web UIs are
    meant for the SSH tunnel only (Tailscale AND an SSH key), so the UI shows these as a warning."""
    try:
        cfg = json.loads(run(["tailscale", "serve", "status", "--json"], timeout=10) or "{}")
    except ValueError:
        return []
    host = ((st or {}).get("Self", {}).get("DNSName") or "").rstrip(".")
    names = {u["port"]: u["name"] for u in config.admin_uis()}
    urls = []
    for port, h in (cfg.get("TCP") or {}).items():
        scheme = "https" if h.get("HTTPS") else "http"
        try:
            p = int(port)
        except ValueError:
            continue
        if host:
            urls.append({"port": p, "name": names.get(p, f"Port {p}"), "url": f"{scheme}://{host}:{p}"})
    return sorted(urls, key=lambda u: u["port"])


def ssh_from_tailnet() -> bool:
    """Is there an SSH connection from the tailnet right now (e.g. the tunnel of the desktop app)?"""
    for line in run(["ss", "-Htn", "state", "established", "( sport = :22 )"], timeout=5).splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        peer = parts[-1].rsplit(":", 1)[0].strip("[]")
        if peer.startswith("::ffff:"):
            peer = peer[7:]
        try:
            ip = ipaddress.ip_address(peer.split("%")[0])
        except ValueError:
            continue
        if ip in (TAILNET4 if ip.version == 4 else TAILNET6):
            return True
    return False


def via_tailscale(handler) -> bool:
    """Does this request come through Tailscale? The dashboard is only reachable through an SSH
    tunnel (Host localhost), so: is an SSH connection from the tailnet open."""
    host = handler.headers.get("Host", "").split(":")[0]
    return host in ("localhost", "127.0.0.1") and ssh_from_tailnet()


def ssh_state() -> dict:
    env = read_env_file(FIREWALL_ENV)
    revert = None
    show = systemd_show(f"{REVERT_UNIT}.timer", "ActiveState", "NextElapseUSecRealtime")
    if show.get("ActiveState") == "active":
        revert = ts_unix(show.get("NextElapseUSecRealtime"))
    return {"enabled": True, "public": env.get("SSH_PUBLIC", "yes") != "no", "revertAt": revert}


def tailscale_settings(handler) -> dict:
    installed = bool(run(["which", "tailscale"]).strip())
    st = ts_status() if installed else None
    self_ = (st or {}).get("Self") or {}
    expiry = None
    if self_.get("KeyExpiry"):
        try:
            expiry = dt.datetime.fromisoformat(self_["KeyExpiry"].replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    state = (st or {}).get("BackendState")
    login = TS_LOGIN["url"] if state != "Running" else None
    return {
        "enabled": True, "installed": installed, "state": state,
        "ip": next((ip for ip in self_.get("TailscaleIPs") or [] if "." in ip), None),
        "dnsName": (self_.get("DNSName") or "").rstrip(".") or None,
        "keyExpiry": expiry, "loginUrl": login or (st or {}).get("AuthURL") or None,
        "urls": ts_serve_urls(st) if state == "Running" else [],
        "viaTailscale": via_tailscale(handler),
    }


def tailscale_login():
    require("tailscale")
    if not run(["which", "tailscale"]).strip():
        raise ApiError(409, "Tailscale is not installed on the server - run ./keepwatch deploy.")
    old = TS_LOGIN["proc"]
    if old and old.poll() is None:
        old.kill()
    TS_LOGIN["url"] = None
    hostname = re.sub(r"[^A-Za-z0-9-]", "-", config.hostname())[:63] or "keepwatch"
    proc = subprocess.Popen(["tailscale", "up", f"--hostname={hostname}", "--accept-dns=false", "--reset"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    TS_LOGIN["proc"] = proc

    def reader():
        for line in proc.stdout:
            m = re.search(r"(https://login\.tailscale\.com/\S+)", line)
            if m:
                TS_LOGIN["url"] = m.group(1)
        proc.wait()
        # Deliberately no `tailscale serve`: the web UIs are only reachable through the SSH tunnel.
    threading.Thread(target=reader, daemon=True).start()
    for _ in range(75):
        if TS_LOGIN["url"] or proc.poll() is not None:
            break
        time.sleep(0.2)
    if not TS_LOGIN["url"]:
        if (ts_status() or {}).get("BackendState") == "Running":
            return {"loginUrl": None}
        raise ApiError(500, "Tailscale did not return a login link.")
    return {"loginUrl": TS_LOGIN["url"]}


def put_ssh(body: dict, handler):
    require("firewall", "tailscale")
    public = body.get("public")
    if not isinstance(public, bool):
        raise ApiError(400, "public must be true or false.")
    fw = f"{config.UNITS['firewall']}.service"
    if not public:
        st = ts_status() or {}
        if st.get("BackendState") != "Running":
            raise ApiError(409, "Log the server in to Tailscale first - otherwise you lock yourself out.")
        if not via_tailscale(handler):
            port = config.ports()["dashboard"]
            raise ApiError(409, "Open the dashboard through an SSH tunnel over Tailscale (the desktop app, or "
                                f"ssh -L {port}:127.0.0.1:{port} <user>@<tailscale name of the server>). That proves "
                                "the new way in works before port 22 closes.")
    write_firewall_env(public)
    run(["systemctl", "stop", f"{REVERT_UNIT}.timer"])
    run(["systemctl", "reset-failed", f"{REVERT_UNIT}.service", f"{REVERT_UNIT}.timer"])
    if not public:
        # Dead man's switch: without confirmation port 22 opens again after 10 minutes.
        run(["systemd-run", f"--unit={REVERT_UNIT}", "--on-active=600", "--timer-property=AccuracySec=1s",
             "/bin/sh", "-c", f"sed -i -e 's/^SSH_PUBLIC=.*/SSH_PUBLIC=yes/' -e '/^SSH_PUBLIC_SINCE=/d' "
                              f"{FIREWALL_ENV} && systemctl restart {fw}"],
            check=True)
    run(["systemctl", "restart", fw], check=True)
    COLLECTORS["security"].refresh()
    return {"ok": True, **ssh_state()}


def write_firewall_env(public: bool):
    """Set SSH_PUBLIC in firewall.env and keep every other line (comments, markers of the modules).
    SSH_PUBLIC_SINCE (Unix time, like the firewall module writes it): since when port 22 is closed;
    an existing value stays while it is closed, opening drops it. Closing also drops the markers
    it settles: a pending close from the deploy and an automatic reopening by the fallback."""
    try:
        lines = FIREWALL_ENV.read_text().splitlines()
    except OSError:
        lines = []
    cur = config.parse("\n".join(lines))
    since = (cur.get("SSH_PUBLIC_SINCE") if cur.get("SSH_PUBLIC") == "no" else None) or str(int(now()))
    drop = ("SSH_PUBLIC=", "SSH_PUBLIC_SINCE=") + (("# KEEPWATCH_PENDING_CLOSE", f"# {config.FALLBACK_MARK}=")
                                                  if not public else ())
    keep = [line for line in lines if not line.lstrip().startswith(drop)]
    new = [f"SSH_PUBLIC={'yes' if public else 'no'}"] + ([f"SSH_PUBLIC_SINCE={since}"] if not public else [])
    write_atomic(FIREWALL_ENV, "\n".join(new + keep) + "\n", 0o644)


def ssh_confirm():
    require("firewall", "tailscale")
    if not ssh_state()["revertAt"]:
        raise ApiError(409, "There is no pending change to confirm.")
    run(["systemctl", "stop", f"{REVERT_UNIT}.timer"])
    run(["systemctl", "reset-failed", f"{REVERT_UNIT}.service", f"{REVERT_UNIT}.timer"])
    return {"ok": True, **ssh_state()}


# --------------------------------------------------------------------------- Access lists

ALLOW_LINE = re.compile(r"^\s*allow\s+([^;\s]+)\s*;\s*(?:#\s?(.*))?$")
DENY_LINE = re.compile(r"^\s*deny\s+[^;]+;\s*(?:#.*)?$")


def parse_access(advanced: str) -> tuple[list[dict], bool]:
    entries, deny = [], False
    for line in (advanced or "").splitlines():
        m = ALLOW_LINE.match(line)
        if m:
            entries.append({"value": m.group(1), "note": (m.group(2) or "").strip()})
        elif DENY_LINE.match(line):
            deny = True
    return entries, deny


def describe(entry: dict) -> dict:
    try:
        addresses = ipaddress.ip_network(entry["value"], strict=False).num_addresses
    except (ValueError, TypeError):
        addresses = 0
    return {**entry, "addresses": addresses}


def get_access():
    require("proxy")
    con = npm_db()
    rows = con.execute("SELECT id, domain_names, advanced_config FROM proxy_host WHERE is_deleted=0 ORDER BY id").fetchall()
    con.close()
    hosts = []
    for hid, domains, adv in rows:
        entries, deny = parse_access(adv)
        hosts.append({"id": hid, "domains": json.loads(domains or "[]"),
                      "mode": "list" if entries and deny else "open",
                      "entries": [describe(e) for e in entries],
                      "pathLock": get_path_lock(hid, adv)})
    return {"myIps": my_ips(), "hosts": hosts}


def npm_container() -> str:
    for c in COLLECTORS["docker"].get()["containers"]:
        if c["image"].startswith("jc21/nginx-proxy-manager") and c["state"] == "running":
            return c["name"]
    raise ApiError(503, "The Proxy Manager is not running.")


def clean_entries(raw) -> list[tuple[str, str]]:
    """(address, note) per entry, validated and without duplicates - for put_access and put_path_lock."""
    clean, seen = [], set()
    for e in raw if isinstance(raw, list) else []:
        value = _net_str(_ipnet(str((e or {}).get("value", ""))))
        if value in seen:
            continue
        seen.add(value)
        note = re.sub(r"[\r\n{};#]", " ", str(e.get("note", ""))).strip()[:80]
        clean.append((value, note))
    return clean


def put_access(host_id: int, body: dict):
    require("proxy")
    mode = body.get("mode")
    if mode not in ("open", "list"):
        raise ApiError(400, "mode must be \"open\" or \"list\".")
    clean = clean_entries(body.get("entries"))
    if mode == "list" and not clean:
        raise ApiError(400, "An empty list would lock everyone out. Open to everyone: mode \"open\".")
    if mode == "open":
        clean = []

    db_path = NPM_DIR / "database.sqlite"
    con = npm_db(write=True)
    row = con.execute("SELECT advanced_config FROM proxy_host WHERE id=? AND is_deleted=0", (host_id,)).fetchone()
    if not row:
        con.close()
        raise ApiError(404, "There is no such proxy host.")
    old_adv = row[0] or ""
    rest = [line for line in old_adv.splitlines() if not ALLOW_LINE.match(line) and not DENY_LINE.match(line)]
    block = [f"allow {v};" + (f" # {n}" if n else "") for v, n in clean] + (["deny all;"] if clean else [])
    new_adv = "\n".join(block + [line for line in rest if line.strip()])

    conf = NPM_DIR / "nginx" / "proxy_host" / f"{host_id}.conf"
    old_conf = conf.read_text()
    lines = [line for line in old_conf.splitlines() if not ALLOW_LINE.match(line) and not DENY_LINE.match(line)]
    anchor = next((i for i, line in enumerate(lines) if f"proxy-host-{host_id}_error.log" in line), None)
    if anchor is None:
        anchor = next((i - 1 for i, line in enumerate(lines) if re.match(r"^\s*location\s", line)), len(lines) - 2)
    lines[anchor + 1:anchor + 1] = [""] + block if block else []
    new_conf = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)) + "\n"

    npm = npm_container()
    db_changed = False
    try:
        conf.write_text(new_conf)
        test = subprocess.run(["docker", "exec", npm, "nginx", "-t"], capture_output=True, text=True, timeout=30)
        if test.returncode != 0:
            raise ApiError(400, "nginx rejects the list - nothing was changed: "
                           + (test.stderr.strip().splitlines() or ["?"])[-1])
        # Database AND file: the Proxy Manager rewrites the file from its database the
        # next time the host is saved in its UI.
        con.execute("UPDATE proxy_host SET advanced_config=?, modified_on=datetime('now') WHERE id=?",
                    (new_adv, host_id))
        con.commit()
        db_changed = True
        run(["docker", "exec", npm, "nginx", "-s", "reload"], check=True)
    except Exception:
        conf.write_text(old_conf)
        if db_changed:
            con.execute("UPDATE proxy_host SET advanced_config=? WHERE id=?", (old_adv, host_id))
            con.commit()
        con.close()
        raise
    con.close()
    COLLECTORS["sites"].refresh()
    return {"ok": True}


# --------------------------------------------------------------------------- Path lock
# IP allow-list for single paths only (e.g. /admin), the rest of the site stays open.
# The allow lines are NOT in advanced_config but in a file of their own per host
# (custom/keepwatch-path-lock-<id>.conf). Reason: parse_access/put_access read and remove
# every allow/deny line in advanced_config and in proxy_host/<id>.conf - if they were in the
# location blocks, the dashboard would take the whole site for locked, and put_access would
# silently remove the lock. advanced_config only holds one block per path, with a marker:
#
#   # keepwatch-path-lock
#   location ^~ /admin {
#     include /data/nginx/custom/keepwatch-path-lock-8.conf;
#     add_header Strict-Transport-Security $hsts_header always;   (only with HSTS on the host)
#     include conf.d/include/proxy.conf;
#   }
#
# ^~ is required: otherwise the regex location for assets (conf.d/include/assets.conf,
# caching on) would win for /admin/admin.js - without the lock. The HSTS add_header is what
# NPM itself repeats in "location /": proxy.conf has its own add_header, so the location does
# not inherit the server-level headers. Rate limiting (limit_req from the proxy module) and
# Block Exploits are server-level and keep applying. put_access leaves the blocks alone
# (no allow/deny lines, it only drops empty lines).

ACCESS_LOCK = threading.Lock()  # put_access and put_path_lock write the same files
PATH_MARK = "# keepwatch-path-lock"
PATH_OK = re.compile(r"^/[A-Za-z0-9/_.-]+$")
PATH_LOC = re.compile(r"^\s*location\s+\^~\s+(\S+)\s*\{\s*$")


def path_file(host_id: int) -> Path:
    return NPM_DIR / "nginx" / "custom" / f"keepwatch-path-lock-{host_id}.conf"


def split_path_blocks(text: str) -> tuple[list[str], list[str]]:
    """(locked paths, remaining lines). One block: marker, "location ^~ ... {", ..., "}"."""
    lines, rest, paths, i = (text or "").splitlines(), [], [], 0
    while i < len(lines):
        if lines[i].strip() == PATH_MARK and i + 1 < len(lines) and PATH_LOC.match(lines[i + 1]):
            end = next((j for j in range(i + 2, min(i + 10, len(lines))) if lines[j].strip() == "}"), None)
            if end is not None:
                paths.append(PATH_LOC.match(lines[i + 1]).group(1))
                i = end + 1
                continue
        rest.append(lines[i])
        i += 1
    return paths, rest


def get_path_lock(host_id: int, advanced: str) -> dict:
    paths, _ = split_path_blocks(advanced)
    try:
        text = path_file(host_id).read_text()
    except OSError:
        text = ""
    entries, _ = parse_access(text)
    return {"paths": paths, "entries": [describe(e) for e in entries]}


def put_path_lock(host_id: int, body: dict):
    require("proxy")
    raw = body.get("paths")
    if not isinstance(raw, list):
        raise ApiError(400, "paths must be a list (empty = off).")
    paths: list[str] = []
    for p in raw:
        p = str(p or "").strip()
        if not PATH_OK.match(p) or len(p) > 120 or "//" in p or any(seg in (".", "..") for seg in p.split("/")):
            raise ApiError(400, f"\"{p}\" is not a valid path (e.g. /admin or /api/admin/).")
        if p not in paths:
            paths.append(p)
    if len(paths) > 10:
        raise ApiError(400, "At most 10 paths.")
    clean = clean_entries(body.get("entries"))
    if paths and not clean:
        raise ApiError(400, "An empty list would lock the paths for everyone - you included.")

    db_path = NPM_DIR / "database.sqlite"
    con = npm_db(write=True)
    row = con.execute("SELECT advanced_config, certificate_id, ssl_forced, hsts_enabled FROM proxy_host "
                      "WHERE id=? AND is_deleted=0", (host_id,)).fetchone()
    if not row:
        con.close()
        raise ApiError(404, "There is no such proxy host.")
    old_adv = row[0] or ""
    # Like NPM itself (_hsts.conf): HSTS only with a certificate, "Force SSL" and HSTS on.
    # $hsts_header exists in every host file (_hsts_map.conf, unconditional).
    hsts = bool(row[1]) and bool(row[2]) and bool(row[3])
    include = f"/data/nginx/custom/{path_file(host_id).name}"
    block: list[str] = []
    for p in paths:
        block += [PATH_MARK, f"location ^~ {p} {{", f"  include {include};"]
        if hsts:
            block.append("  add_header Strict-Transport-Security $hsts_header always;")
        block += ["  include conf.d/include/proxy.conf;", "}"]

    _, rest = split_path_blocks(old_adv)
    new_adv = "\n".join([line for line in rest if line.strip()] + block)

    conf = NPM_DIR / "nginx" / "proxy_host" / f"{host_id}.conf"
    old_conf = conf.read_text()
    _, lines = split_path_blocks(old_conf)
    anchor = next((i for i, line in enumerate(lines) if f"proxy-host-{host_id}_error.log" in line), None)
    if anchor is None:
        anchor = next((i - 1 for i, line in enumerate(lines) if re.match(r"^\s*location\s", line)), len(lines) - 2)
    pos = anchor + 1
    while pos < len(lines) and (not lines[pos].strip() or ALLOW_LINE.match(lines[pos]) or DENY_LINE.match(lines[pos])):
        pos += 1  # after the allow-list of the whole site (put_access puts it right below error_log)
    lines[pos:pos] = ([""] + block + [""]) if block else []
    new_conf = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)) + "\n"

    pfile = path_file(host_id)
    old_file = pfile.read_text() if pfile.exists() else None
    # The list is kept when switched off (a file without include has no effect) - it is back
    # when switched on again. Only without any entries the file goes away.
    new_file = ("# Written by the Keepwatch dashboard (Access -> path lock), "
                f"proxy host #{host_id}.\n# Included by the location blocks \"{PATH_MARK}\".\n"
                + "".join(f"allow {v};" + (f" # {n}" if n else "") + "\n" for v, n in clean)
                + "deny all;\n") if clean else None

    npm = npm_container()
    db_changed = False
    try:
        if new_file is not None:
            write_atomic(pfile, new_file, 0o644)
        elif pfile.exists():
            pfile.unlink()
        conf.write_text(new_conf)
        test = subprocess.run(["docker", "exec", npm, "nginx", "-t"], capture_output=True, text=True, timeout=30)
        if test.returncode != 0:
            err = test.stderr.strip().splitlines() or ["?"]
            raise ApiError(400, "nginx rejects the paths - nothing was changed: "
                           + next((line for line in err if "[emerg]" in line), err[-1]))
        # Database AND file (like put_access): NPM rewrites the file from its database the
        # next time the host is saved in its UI.
        con.execute("UPDATE proxy_host SET advanced_config=?, modified_on=datetime('now') WHERE id=?",
                    (new_adv, host_id))
        con.commit()
        db_changed = True
        run(["docker", "exec", npm, "nginx", "-s", "reload"], check=True)
    except Exception:
        conf.write_text(old_conf)
        if old_file is not None:
            write_atomic(pfile, old_file, 0o644)
        elif pfile.exists():
            pfile.unlink()
        if db_changed:
            con.execute("UPDATE proxy_host SET advanced_config=? WHERE id=?", (old_adv, host_id))
            con.commit()
        con.close()
        raise
    con.close()
    COLLECTORS["sites"].refresh()
    return {"ok": True}


# --------------------------------------------------------------------------- Overview

def collect_updates_cached():
    try:
        return COLLECTORS["updates"].get()
    except ApiError:
        return {"pending": 0, "security": 0, "rebootRequired": False, "lastUpgrade": None,
                "release": "", "newRelease": None}


def safe(name):
    """Latest value of a collector, None when it failed or its module is off."""
    try:
        v = COLLECTORS[name].get()
    except (ApiError, KeyError):
        return None
    return None if isinstance(v, dict) and v.get("enabled") is False else v


def health(cur, dsk, updates) -> list[dict]:
    """Everything red or yellow. Only enabled modules can raise a problem."""
    p = []
    on = config.enabled

    def add(level, area, title, detail, key, target=None):
        p.append(problem(level, area, title, detail, key, target))

    for d in dsk:
        pct = 100 * d["used"] / d["total"] if d["total"] else 0
        if pct > 95:
            add("crit", "system", f"Disk {d['mount']} almost full", f"{pct:.0f} % used", "disk.full")
        elif pct > 85:
            add("warn", "system", f"Disk {d['mount']} filling up", f"{pct:.0f} % used", "disk.filling")
    if cur["mem"] > 92:
        add("warn", "system", "Memory low", f"{cur['mem']:.0f} % used", "memory.low")
    if updates.get("rebootRequired"):
        add("warn", "system", "Reboot required", "An update is waiting for the server to reboot.", "system.reboot")
    if updates.get("security"):
        add("warn", "system", "Security updates pending",
            f"{updates['security']} packages." + (" They are installed automatically at night."
                                                  if on("auto-updates") else ""),
            "system.security-updates", "settings/updates" if on("auto-updates") else None)

    sec = safe("security")
    if on("fail2ban"):
        need = {config.JAIL_SSH} | ({config.JAIL_SSH_TAILNET} if on("tailscale") else set())
        if (sec is None or not need <= {j["name"] for j in sec["jails"]}) \
                and now() - COLLECTORS["security"].at > 10:
            # The cached value may stem from a fail2ban restart (every deploy
            # that touches fail2ban) - look again before raising a red problem.
            COLLECTORS["security"].refresh()
            sec = safe("security")
        if sec is None or not need <= {j["name"] for j in sec["jails"]}:
            add("crit", "security", "fail2ban is not protecting SSH",
                f"The jail {' or '.join(sorted(need))} is not running.", "fail2ban.ssh-jail")
    if sec and on("firewall") and on("docker") and sec["firewall"].get("dockerUserActive") is False:
        add("crit", "security", "Docker firewall missing",
            "The DOCKER-USER rule is missing. Container ports could be open to the internet.", "firewall.docker-user")
    if sec and ssh_toggle_available() and not ssh_state()["public"]:
        # SSH is Tailscale-only: a login from anywhere else should not happen.
        trusted = config.trusted_ips()
        foreign = [lg for lg in sec["logins"] if now() - lg["at"] < 86400
                   and (lg.get("country") or {}).get("name") not in ("Tailnet", "internal")
                   and not _in_nets(lg["ip"], trusted)]
        for lg in foreign[:3]:
            add("crit", "security", f"SSH login from outside the tailnet: {lg['ip']}",
                f"{lg['user']} · {(lg.get('country') or {}).get('name', '?')} · {local_time(lg['at'], '%m-%d %H:%M')}",
                "ssh.foreign-login")

    dock = safe("docker") if on("docker") else None
    for c in (dock or {}).get("containers", []):
        if c["state"] in ("exited", "dead") and c.get("restartPolicy") in ("always", "unless-stopped"):
            add("crit", "docker", f"{c['name']} is not running", c["status"], "container.down")
        elif c["health"] == "unhealthy":
            add("crit", "docker", f"{c['name']} is unhealthy", "Its healthcheck fails.", "container.unhealthy")
        elif c["state"] == "restarting":
            add("warn", "docker", f"{c['name']} keeps restarting", f"{c['restartCount']} restarts",
                "container.restarting")

    sites = safe("sites") if on("proxy") else None
    for s in (sites or {}).get("sites", []):
        name = s["domains"][0] if s["domains"] else f"Host {s['id']}"
        if not s["enabled"]:
            continue
        if s["cert"] and s["cert"]["daysLeft"] < 7:
            add("crit", "sites", f"Certificate for {name} expires", f"{s['cert']['daysLeft']} days left", "cert.expiring")
        elif s["cert"] and s["cert"]["daysLeft"] < 21:
            add("warn", "sites", f"Certificate for {name} expires soon", f"{s['cert']['daysLeft']} days left",
                "cert.expiring-soon")
        chk = s["check"]
        if chk is None or chk["code"] == 0 or chk["code"] >= 500:
            add("crit", "sites", f"{name} is not responding", f"HTTP {chk['code'] if chk else '-'}", "site.down")

    bk = safe("backups") if on("backup") else None
    if bk:
        loc = next((t for t in bk["targets"] if t["kind"] == "local"), None)
        ext = next((t for t in bk["targets"] if t["kind"] == "remote"), None)
        if not loc or not loc["lastSnapshot"]:
            add("crit", "backups", "No backup yet", "There is no snapshot.", "backup.none")
        elif now() - loc["lastSnapshot"] > 26 * 3600:
            add("crit", "backups", "Backup out of date",
                f"Latest snapshot is {int((now() - loc['lastSnapshot']) // 3600)} hours old.", "backup.stale")
        if not read_env_file(BACKUP_ENV).get("REMOTE_REPO"):
            add("warn", "backups", "No off-site backup",
                "Backups only exist on this server. If it is lost, so are the backups.",
                "backup.remote-missing", "settings/backup-remote")
        elif ext and now() - max(ext["lastSnapshot"] or 0, remote_last_ok()) > 26 * 3600 \
                and not unit_active(backup_unit()):
            add("crit", "backups", "Off-site backup out of date",
                f"{ext['name']} has no snapshot from the last 26 hours. Expired credentials? "
                "Settings -> Off-site backup -> Test connection.", "backup.remote-stale", "settings/backup-remote")
        pr = systemd_show(backup_unit("backup-verify"), "Result", "ActiveState", "ExecMainExitTimestamp")
        if pr.get("ActiveState") == "failed":
            add("crit", "backups", "Backup self-test failed",
                "The test restore or the off-site sample check went wrong. Details under Backups.",
                "backup.verify-failed")
        show = systemd_show(backup_unit(), "Result", "ActiveState")
        if show.get("Result") not in ("success", "") and show.get("ActiveState") == "failed":
            add("crit", "backups", "Last backup failed", "Details in the log under Backups.", "backup.failed")

    if ssh_toggle_available():
        try:
            m = re.search(rf"{config.FALLBACK_MARK}=(\d+) (.*)", FIREWALL_ENV.read_text())
        except OSError:
            m = None
        if m:
            add("crit", "security", "Port 22 reopened automatically",
                f"{local_time(int(m.group(1)), '%m-%d %H:%M')}: {m.group(2)}. Check Tailscale, then close it "
                "again under Settings -> Remote access.", "ssh.fallback-opened", "settings/remote-access")
        if ssh_state()["revertAt"]:
            add("warn", "security", "SSH change not confirmed",
                "Port 22 will reopen by itself soon. Settings -> Remote access -> Confirm.",
                "ssh.unconfirmed", "settings/remote-access")
    st = ts_status()
    if st and st.get("BackendState") == "Running":
        exp = (st.get("Self") or {}).get("KeyExpiry")
        if exp:
            try:
                days = (dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() - now()) / 86400
                add("crit" if days < 30 else "warn", "security", "Tailscale key expires",
                    f"in {int(days)} days. In the Tailscale admin console, turn on \"Disable key expiry\" for "
                    "this server.", "tailscale.key-expiry", "settings/remote-access")
            except ValueError:
                pass

    stk = safe("stacks") if on("portainer") else None
    if stk and not stk["portainer"]["connected"]:
        add("warn", "stacks", "Portainer not connected", stk["portainer"]["reason"] or "",
            "portainer.disconnected", "settings/portainer")

    # The parameter `updates` (system updates) shadows the module here - fetch it from sys.modules.
    p.extend(sys.modules["updates"].problems())  # open security patches (images)
    import logarchive
    p.extend(logarchive.problems())  # log archive stopped or at its size limit
    p.extend(ctwatch.problems())  # foreign certificate in the CT logs
    p.extend(secrets_check.problems())  # secrets: weak, duplicate, test keys, due
    p.extend(lynis.problems())  # hardening: open Lynis warning, index dropped, audit not running
    p.sort(key=lambda x: x["level"] != "crit")
    return p


def _in_nets(ip: str, nets: list[str]) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for n in nets:
        try:
            if a in ipaddress.ip_network(n, strict=False):
                return True
        except ValueError:
            continue
    return False


def overview():
    cur, live, hist = SAMPLER.series()
    mi = Sampler.meminfo()
    updates = collect_updates_cached()
    dsk = disks()
    procs = sum(1 for d in os.listdir("/proc") if d.isdigit())
    return {
        "host": host_info(),
        "now": {
            "cpu": round(cur["cpu"], 1), "load": [round(x, 2) for x in os.getloadavg()],
            "mem": {"total": mi["MemTotal"], "used": mi["MemTotal"] - mi["MemAvailable"],
                    "available": mi["MemAvailable"]},
            "swap": {"total": mi.get("SwapTotal", 0), "used": mi.get("SwapTotal", 0) - mi.get("SwapFree", 0)},
            "disks": dsk, "net": {"rxBps": round(cur["rx"]), "txBps": round(cur["tx"])}, "procs": procs,
        },
        "history": hist, "live": live, "updates": updates, "health": health(cur, dsk, updates),
    }


# --------------------------------------------------------------------------- HTTP

COLLECTORS: dict[str, Collector] = {}
SAMPLER: Sampler


def host_ok(host: str) -> bool:
    """Only localhost names (SSH tunnel) - protects against DNS rebinding."""
    return bool(re.match(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", host or ""))


def origin_ok(origin: str | None) -> bool:
    return origin is None or bool(re.match(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", origin))


MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
        ".woff": "font/woff", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp", ".map": "application/json"}


_BUILD = {"mtime": None, "id": "dev"}


def build_id() -> str:
    """Id of the served UI (from index.html). When it changes after a deploy, an open
    page - also in the desktop app - reloads by itself."""
    try:
        st = (WEB_DIR / "index.html").stat()
    except OSError:
        return "dev"
    if st.st_mtime_ns != _BUILD["mtime"]:
        import hashlib
        _BUILD["id"] = hashlib.sha1((WEB_DIR / "index.html").read_bytes()).hexdigest()[:12]
        _BUILD["mtime"] = st.st_mtime_ns
    return _BUILD["id"]


class Handler(BaseHTTPRequestHandler):
    server_version = "keepwatch"
    sys_version = ""

    def log_message(self, fmt, *args):  # log errors only
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Dashboard-Build", build_id())
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, data):
        self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8",
                   {"Cache-Control": "no-store"})
        if status == 428:  # "needs a passkey" is only an intermediate step, not an action
            self.__dict__.pop("_req_body", None)
            return
        timeline.audit_request(self, status, data)  # timeline: write requests (endpoint + safe summary only)

    def _guard(self, write: bool):
        if not host_ok(self.headers.get("Host", "")):
            raise ApiError(403, "Only reachable through localhost (SSH tunnel).")
        if write:
            if self.headers.get("X-Dashboard") != "1":
                raise ApiError(403, "Header X-Dashboard is missing.")
            if not origin_ok(self.headers.get("Origin")):
                raise ApiError(403, "Foreign origin.")

    def _body(self) -> dict:
        if "_body_cache" in self.__dict__:  # already read (touchid.gate reads before routing)
            return self._body_cache
        self._body_cache = self._read_body()
        return self._body_cache

    def _read_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Invalid Content-Length.")
        if n < 0:
            raise ApiError(400, "Invalid Content-Length.")
        if n > 1_000_000:
            raise ApiError(413, "Request too large.")
        if not n:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            raise ApiError(400, "Not valid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object.")
        self._req_body = data  # only for timeline.audit_request (reads an allow-list of harmless fields)
        return data

    def _dispatch(self, method: str):
        from urllib.parse import parse_qs, urlsplit
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        try:
            if not path.startswith("/api/"):
                if method not in ("GET", "HEAD"):
                    raise ApiError(405, "Not allowed.")
                self._guard(False)
                return self._static(path)
            self._guard(method != "GET")
            res = self._route(method, path, query)
            self._json(200, res)
        except ApiError as e:
            self._json(e.status, {"error": e.message, **getattr(e, "extra", {})})
        except sqlite3.Error as e:  # a database that is missing, locked or not ours yet
            self._json(503, {"error": f"Database not available: {e}"})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"error": f"Internal error: {e}"})

    def _route(self, method, path, query):
        # Dangerous actions need a passkey (touchid.py) - before every endpoint, add-on modules included.
        touchid.gate(self, method, path, self._body() if method in ("POST", "PUT") else {})
        if method == "GET" and path == "/api/config":  # feature flags for the UI
            return config.public()
        if path.startswith("/api/touchid"):  # passkey devices
            return touchid.route(self, method, path, self._body() if method in ("POST", "PUT") else {})
        if path.startswith("/api/timeline"):  # timeline (timeline.py)
            return timeline.route(method, path, query)
        if path.startswith("/api/ctwatch"):  # certificate watch (ctwatch.py)
            return ctwatch.route(method, path, self._body() if method == "POST" else {})
        if path.startswith("/api/secrets"):  # secrets check (secrets_check.py)
            return secrets_check.route(method, path, self._body() if method in ("POST", "PUT") else {})
        if path.startswith("/api/lynis"):  # hardening audit (lynis.py)
            return lynis.route(method, path, self._body() if method == "POST" else {})
        if path.startswith("/api/sitegrade"):  # security grade per site (sitegrade.py)
            return sitegrade.route(method, path, self._body() if method == "POST" else {})
        if path.startswith(("/api/hosts", "/api/settings/npm")):  # new site (hosts.py)
            return hosts.route(method, path, query, self._body() if method in ("POST", "PUT") else {})
        if path.startswith("/api/uptime"):  # availability (uptime.py)
            return uptime.route(method, path, query)
        if path == "/api/self-update" or path.startswith("/api/self-update/"):  # Keepwatch updates (selfupdate.py)
            return selfupdate.route(method, path, self._body() if method in ("POST", "PUT") else {})
        if path.startswith("/api/logarchive"):  # container log archive (logarchive.py)
            import logarchive
            return logarchive.route(method, path, query, self._body() if method == "PUT" else {})
        if method == "GET":
            if path == "/api/overview":
                return overview()
            if path == "/api/security":
                return COLLECTORS["security"].get()
            if path == "/api/security/history":
                return security_history(query)
            if path == "/api/security/logins":
                return security_logins()
            if path == "/api/security/ip":  # quick search: look up one IP (iplookup.py)
                import iplookup
                return iplookup.ip_info(query, globals())
            if path == "/api/logs":  # live logs, several containers (logs.py)
                require("docker")
                import logs
                return logs.read_logs(query, known_container, ApiError)
            if path == "/api/docker":
                return public_containers()
            if path == "/api/stacks":
                require("portainer")
                return COLLECTORS["stacks"].get()
            if path == "/api/sites":
                require("proxy")
                return COLLECTORS["sites"].get()
            if path == "/api/backups":
                return backup_status()
            m = re.match(r"^/api/containers/([^/]+)/logs$", path)
            if m:
                return container_logs(m.group(1), query)
            m = re.match(r"^/api/stacks/(\d+)/env$", path)
            if m:
                return stack_env(int(m.group(1)))
            if path == "/api/settings":
                return get_settings(self)
            if path == "/api/access":
                return get_access()
            if path in ("/api/updates", "/api/cleanup"):
                return updates.get(path)
        if method == "DELETE":
            if path == "/api/settings/remote":
                return delete_remote()
            raise ApiError(404, "No such endpoint.")
        body = self._body()
        if method == "POST":
            if path == "/api/security/unban":
                return unban(body)
            if path == "/api/backups/run":
                return backup_run()
            m = re.match(r"^/api/containers/([^/]+)/(start|stop|restart)$", path)
            if m:
                return container_action(m.group(1), m.group(2))
            m = re.match(r"^/api/stacks/(\d+)/redeploy$", path)
            if m:
                require("portainer")
                return stack_redeploy(int(m.group(1)), body)
            if path == "/api/settings/backup/password":
                return backup_password()
            if path == "/api/settings/remote/test":
                return remote_test()
            if path == "/api/settings/tailscale/login":
                return tailscale_login()
            if path == "/api/settings/ssh/confirm":
                return ssh_confirm()
            if path == "/api/sites/renew-due":
                return renew_due_certs()
            if path == "/api/backups/probe":
                return probe_run()
            if path.startswith("/api/updates/") or path == "/api/cleanup":
                return updates.post(path, body)
            m = re.match(r"^/api/sites/(\d+)/renew$", path)
            if m:
                return renew_site_cert(int(m.group(1)), body)
        if method == "PUT":
            m = re.match(r"^/api/stacks/(\d+)/env$", path)
            if m:
                require("portainer")
                return stack_set_env(int(m.group(1)), body)
            m = re.match(r"^/api/access/(\d+)$", path)
            if m:
                with ACCESS_LOCK:
                    return put_access(int(m.group(1)), body)
            m = re.match(r"^/api/access/(\d+)/paths$", path)
            if m:  # path lock (IP allow-list for single paths)
                with ACCESS_LOCK:
                    return put_path_lock(int(m.group(1)), body)
            setters = {"/api/settings/backup": put_backup_settings, "/api/settings/remote": put_remote,
                       "/api/settings/portainer": put_portainer, "/api/settings/fail2ban": put_fail2ban,
                       "/api/settings/updates": put_updates}
            if path in setters:
                return setters[path](body)
            if path == "/api/settings/ssh":
                return put_ssh(body, self)
        raise ApiError(404, "No such endpoint.")

    def _static(self, path: str):
        root = WEB_DIR.resolve()
        target = (root / path.lstrip("/")).resolve()
        if not str(target).startswith(str(root)) or not target.is_file():
            target = root / "index.html"
        if not target.is_file():
            return self._send(503, b"UI missing (web/ is empty).", "text/plain; charset=utf-8")
        cache = "public, max-age=31536000, immutable" if "/assets/" in str(target) else "no-cache"
        self._send(200, target.read_bytes(), MIME.get(target.suffix, "application/octet-stream"),
                   {"Cache-Control": cache})

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main():
    global SAMPLER
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SAMPLER = Sampler()
    threading.Thread(target=SAMPLER.loop, daemon=True, name="sampler").start()
    for name, fn, interval, module in [
        ("docker", collect_docker, 10, "docker"), ("security", collect_security, 30, None),
        ("stacks", collect_stacks, 30, "portainer"), ("sites", collect_sites, 60, "proxy"),
        ("backups", collect_backups, 120, "backup"), ("updates", collect_updates, 1800, None),
    ]:
        COLLECTORS[name] = Collector(name, fn, interval, module)
    # docker first, stacks needs it
    COLLECTORS["docker"].refresh()
    for c in COLLECTORS.values():
        threading.Thread(target=c.loop, daemon=True, name=c.name).start()
    threading.Thread(target=backup_watch, daemon=True, name="backup-watch").start()
    threading.Thread(target=security_history_loop, daemon=True, name="security-history").start()
    threading.Thread(target=updates.loop, daemon=True, name="updates").start()
    threading.Thread(target=uptime.loop, daemon=True, name="uptime").start()
    threading.Thread(target=timeline.loop, daemon=True, name="timeline").start()
    threading.Thread(target=sitegrade.loop, daemon=True, name="sitegrade").start()
    threading.Thread(target=ctwatch.loop, daemon=True, name="ctwatch").start()
    threading.Thread(target=secrets_check.loop, daemon=True, name="secrets-check").start()
    threading.Thread(target=lynis.loop, daemon=True, name="lynis").start()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    on = " ".join(m for m in config.MODULES if config.enabled(m))
    print(f"Keepwatch dashboard {config.VERSION} on http://{BIND}:{PORT} (UI: {WEB_DIR}; modules: {on})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
