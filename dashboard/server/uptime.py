"""Availability history per site - dashboard add-on (needs the proxy module).

A background thread fetches every enabled site once a minute - like
site_check() in dashboard.py (curl via 127.0.0.1 with the real name and
certificate), but with an expectation per site:

  - Default: 2xx/3xx (and 401 - a login is in front) on "/".
  - KW_UPTIME_PROBES: containers where "/" says nothing get their own path and codes,
    e.g. "my-app=/health" or "my-app=/health:200,204" (space separated).
  - With an IP allow-list (allow ...; deny all;): the proxy answers the server
    with 403 - that counts, but says nothing about the container (the block
    applies before proxy_pass). So the container is also asked directly on its
    Docker IP: any HTTP answer below 500 means "up".

A failed fetch is retried after 5 s; only then does it count as an outage
(a single hiccup is not an outage).

Stored in <state>/uptime.db (SQLite, config.STATE_DIR):
  checks   one row per fetch (time, ok, ms, code, reason), 90 days
  days     daily totals (KW_LOCAL_TZ) - kept when the raw rows expire
  outages  outages with start, end, reason
keepwatch-backup copies the file with sqlite3 .backup.

The helpers of dashboard.py (run, ApiError, NPM_DIR, parse_access, ...) come from sys.modules["dashboard"] at run time.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import re
import sqlite3
import subprocess
import sys
import threading
import time
import traceback

import config

INTERVAL = 60
KEEP_DAYS = 90
RETRY_AFTER = 5



def probe_paths() -> dict[str, tuple[str, tuple[int, ...]]]:
    """KW_UPTIME_PROBES: container -> path and expected codes, where "/" says nothing.

    "my-app=/health" expects 2xx/3xx there, "my-app=/health:200,204" exactly those codes.
    Read on every cycle, so a deploy takes effect without restarting the dashboard."""
    out: dict[str, tuple[str, tuple[int, ...]]] = {}
    for item in config.get("KW_UPTIME_PROBES", "").split():
        name, _, rest = item.partition("=")
        path, _, codes = rest.partition(":")
        if not name or not path.startswith("/"):
            continue
        out[name] = (path, tuple(int(c) for c in codes.split(",") if c.isdigit() and 100 <= int(c) <= 599))
    return out

_G: dict = {}


def bind(g: dict):
    """Tests only: other globals instead of sys.modules["dashboard"]."""
    global _G
    _G = g


class _Dash:
    def __getattr__(self, name):
        g = _G or sys.modules["dashboard"].__dict__
        try:
            return g[name]
        except KeyError:
            raise AttributeError(name) from None


D = _Dash()
LOCK = threading.Lock()
STATE = {"last": {}, "since": None, "sites": []}


def _db_path():
    return D.STATE_DIR / "uptime.db"


def _con() -> sqlite3.Connection:
    con = sqlite3.connect(str(_db_path()), timeout=10)
    con.execute("""CREATE TABLE IF NOT EXISTS checks (site TEXT NOT NULL, t INTEGER NOT NULL, ok INTEGER NOT NULL,
                   ms INTEGER, code INTEGER, reason TEXT)""")
    con.execute("CREATE INDEX IF NOT EXISTS checks_site_t ON checks(site, t)")
    con.execute("""CREATE TABLE IF NOT EXISTS days (site TEXT NOT NULL, day TEXT NOT NULL, total INTEGER NOT NULL,
                   ok INTEGER NOT NULL, ms_sum INTEGER NOT NULL DEFAULT 0, ms_n INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (site, day))""")
    con.execute("""CREATE TABLE IF NOT EXISTS outages (id INTEGER PRIMARY KEY, site TEXT NOT NULL, start INTEGER NOT NULL,
                   end INTEGER, reason TEXT, last_reason TEXT)""")
    con.execute("CREATE INDEX IF NOT EXISTS outages_site ON outages(site, start)")
    return con


def _day(t: float) -> str:
    return dt.datetime.fromtimestamp(t, config.local_tz()).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- Sites and expectations

def sites() -> list[dict]:
    """Enabled proxy hosts with their probe plan."""
    con = D.npm_db()
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT id, domain_names, forward_scheme, forward_host, forward_port, certificate_id, "
                           "advanced_config FROM proxy_host WHERE is_deleted=0 AND enabled=1 ORDER BY id").fetchall()
    finally:
        con.close()
    out = []
    probes = probe_paths()
    for r in rows:
        domains = json.loads(r["domain_names"] or "[]")
        if not domains:
            continue
        entries, deny = D.parse_access(r["advanced_config"] or "")
        path, expect = probes.get(r["forward_host"], ("/", ()))
        locked = bool(entries and deny)
        out.append({
            "domain": domains[0], "hostId": r["id"], "https": bool(r["certificate_id"]),
            "path": path, "expect": list(expect), "locked": locked,
            "upstream": {"host": r["forward_host"], "port": r["forward_port"], "scheme": r["forward_scheme"] or "http"},
        })
    return out


def expect_text(s: dict) -> str:
    if s["locked"]:
        return "403 (IP allow-list) and the container answers"
    if s["expect"]:
        return f"{'/'.join(map(str, s['expect']))} on {s['path']}"
    return f"2xx/3xx on {s['path']}"


def _container_ips(names: set[str]) -> dict[str, str]:
    if not names:
        return {}
    raw = D.run(["docker", "inspect", "--format", "{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
                 *sorted(names)], timeout=20)
    ips = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            ips[parts[0].lstrip("/")] = parts[1]
    return ips


CURL_REASON = {6: "name does not resolve", 7: "connection refused", 28: "timeout",
               35: "TLS error", 52: "empty reply", 56: "connection reset", 60: "invalid certificate"}


def _curl(url: str, resolve: str | None = None, insecure: bool = False, timeout: int = 10) -> tuple[int, int, int]:
    """(curl exit code, HTTP code, ms)."""
    cmd = ["curl", "-s", "-o", "/dev/null", "-m", str(timeout), "-w", "%{http_code} %{time_total}"]
    if resolve:
        cmd += ["--resolve", resolve]
    if insecure:
        cmd.append("-k")
    cmd.append(url)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    except (OSError, subprocess.TimeoutExpired):
        return 28, 0, timeout * 1000
    try:
        code, secs = p.stdout.split()
        return p.returncode, int(code), int(float(secs) * 1000)
    except ValueError:
        return p.returncode or 1, 0, 0


def _probe_once(s: dict, ip: str | None) -> dict:
    port = 443 if s["https"] else 80
    url = f"{'https' if s['https'] else 'http'}://{s['domain']}{s['path']}"
    rc, code, ms = _curl(url, f"{s['domain']}:{port}:127.0.0.1")
    res = {"ok": False, "ms": ms if code else None, "code": code or None, "reason": None}
    if rc != 0 or not code:
        res["reason"] = CURL_REASON.get(rc, f"no answer (curl {rc})")
        return res
    if s["locked"]:
        if code != 403 and not 200 <= code < 400:
            res["reason"] = _code_reason(code)
            return res
        up = s["upstream"]
        if not ip:
            res["reason"] = f"container {up['host']} is not running"
            return res
        urc, ucode, _ = _curl(f"{up['scheme']}://{ip}:{up['port']}{s['path']}", insecure=True, timeout=8)
        if urc != 0 or not ucode:
            res["reason"] = f"container does not answer ({CURL_REASON.get(urc, f'curl {urc}')})"
            return res
        if ucode >= 500:
            res["reason"] = f"container returns {ucode}"
            return res
        res["ok"] = True
        return res
    if s["expect"]:
        res["ok"] = code in s["expect"]
        if not res["ok"]:
            res["reason"] = f"{code} instead of {'/'.join(map(str, s['expect']))} on {s['path']}"
        return res
    res["ok"] = 200 <= code < 400 or code == 401
    if not res["ok"]:
        res["reason"] = _code_reason(code)
    return res


def _code_reason(code: int) -> str:
    return {502: "502 - container unreachable", 503: "503 - service unavailable",
            504: "504 - container too slow", 403: "403 - forbidden", 404: "404 - not found"}.get(
        code, f"answer {code}")


def probe(s: dict, ip: str | None) -> dict:
    r = _probe_once(s, ip)
    if not r["ok"]:
        time.sleep(RETRY_AFTER)
        r2 = _probe_once(s, ip)
        if r2["ok"]:
            return r2
    return r


# --------------------------------------------------------------------------- Measure and store

def cycle():
    plan = sites()
    ips = _container_ips({s["upstream"]["host"] for s in plan if s["locked"]})
    t = int(time.time())
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda s: probe(s, ips.get(s["upstream"]["host"])), plan))
    day = _day(t)
    with LOCK:
        con = _con()
        try:
            for s, r in zip(plan, results):
                con.execute("INSERT INTO checks (site, t, ok, ms, code, reason) VALUES (?,?,?,?,?,?)",
                            (s["domain"], t, int(r["ok"]), r["ms"], r["code"], r["reason"]))
                con.execute("""INSERT INTO days (site, day, total, ok, ms_sum, ms_n) VALUES (?,?,1,?,?,?)
                               ON CONFLICT(site, day) DO UPDATE SET total=total+1, ok=ok+excluded.ok,
                               ms_sum=ms_sum+excluded.ms_sum, ms_n=ms_n+excluded.ms_n""",
                            (s["domain"], day, int(r["ok"]), r["ms"] or 0 if r["ok"] else 0, 1 if r["ok"] and r["ms"] else 0))
                open_ = con.execute("SELECT id, start, reason FROM outages WHERE site=? AND end IS NULL", (s["domain"],)).fetchone()
                if not r["ok"] and not open_:
                    con.execute("INSERT INTO outages (site, start, reason, last_reason) VALUES (?,?,?,?)",
                                (s["domain"], t, r["reason"], r["reason"]))
                elif not r["ok"]:
                    con.execute("UPDATE outages SET last_reason=? WHERE id=?", (r["reason"], open_[0]))
                elif open_:
                    con.execute("UPDATE outages SET end=? WHERE id=?", (t, open_[0]))
            # Sites that are gone (deleted, disabled): close open outages silently.
            live = {s["domain"] for s in plan}
            for oid, site in con.execute("SELECT id, site FROM outages WHERE end IS NULL").fetchall():
                if site not in live:
                    con.execute("UPDATE outages SET end=? WHERE id=?", (t, oid))
            con.commit()
        finally:
            con.close()
        STATE["sites"] = plan
        STATE["last"] = {s["domain"]: {"t": t, **r} for s, r in zip(plan, results)}


def compact():
    """Delete raw rows older than 90 days - the daily totals in `days` stay."""
    cutoff = int(time.time()) - KEEP_DAYS * 86400
    with LOCK:
        con = _con()
        try:
            con.execute("DELETE FROM checks WHERE t < ?", (cutoff,))
            con.execute("DELETE FROM days WHERE day < ?", (_day(time.time() - 730 * 86400),))
            con.execute("DELETE FROM outages WHERE end IS NOT NULL AND end < ?", (int(time.time()) - 730 * 86400,))
            con.commit()
            con.execute("VACUUM")
        finally:
            con.close()


def loop():
    D.STATE_DIR.mkdir(parents=True, exist_ok=True)
    time.sleep(20)  # let the Docker collector run first
    last_compact = 0.0
    while True:
        started = time.time()
        if not config.enabled("proxy"):  # nothing to probe without the proxy
            time.sleep(INTERVAL)
            continue
        try:
            cycle()
            if started - last_compact > 6 * 3600:
                compact()
                last_compact = started
        except Exception as e:  # noqa: BLE001 - an error must not end the thread
            if getattr(e, "status", None) is None:  # ApiError (e.g. proxy database missing) is expected, no traceback
                traceback.print_exc()
        time.sleep(max(5.0, INTERVAL - (time.time() - started)))


# --------------------------------------------------------------------------- Queries

def summary() -> dict:
    plan = STATE["sites"] or sites()
    now = time.time()
    days = [_day(now - i * 86400) for i in range(KEEP_DAYS - 1, -1, -1)]
    first = days[0]
    with LOCK:
        con = _con()
        try:
            rows = con.execute("SELECT site, day, total, ok, ms_sum, ms_n FROM days WHERE day >= ?", (first,)).fetchall()
            outs = con.execute("SELECT site, start, end, reason FROM outages WHERE start >= ? OR end IS NULL OR end >= ?",
                               (int(now) - KEEP_DAYS * 86400,) * 2).fetchall()
            since = con.execute("SELECT MIN(t) FROM checks").fetchone()[0]
            last_rows = {r[0]: r for r in con.execute(
                "SELECT c.site, c.t, c.ok, c.ms, c.code, c.reason FROM checks c JOIN "
                "(SELECT site, MAX(t) AS t FROM checks GROUP BY site) m ON m.site=c.site AND m.t=c.t")}
            ms24 = dict(con.execute("SELECT site, CAST(AVG(ms) AS INTEGER) FROM checks WHERE t >= ? AND ok=1 AND ms IS NOT NULL "
                                    "GROUP BY site", (int(now) - 86400,)).fetchall())
        finally:
            con.close()
    by_site: dict[str, dict[str, tuple]] = {}
    for site, day, total, ok, ms_sum, ms_n in rows:
        by_site.setdefault(site, {})[day] = (total, ok, ms_sum, ms_n)
    down_by_day: dict[str, dict[str, int]] = {}
    tz = config.local_tz()
    for site, start, end, _reason in outs:
        a, b = start, end or now
        while a < b:  # outage seconds per day (KW_LOCAL_TZ)
            d = dt.datetime.fromtimestamp(a, tz)
            nxt = (d.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)).timestamp()
            seg = min(b, nxt) - a
            down_by_day.setdefault(site, {}).setdefault(d.strftime("%Y-%m-%d"), 0)
            down_by_day[site][d.strftime("%Y-%m-%d")] += int(seg)
            a = nxt
    out = []
    for s in plan:
        dd = by_site.get(s["domain"], {})
        series = []
        for d in days:
            total, ok, _ms_sum, _ms_n = dd.get(d, (0, 0, 0, 0))
            series.append({"day": d, "total": total, "ok": ok, "downSec": down_by_day.get(s["domain"], {}).get(d, 0)})
        last30 = series[-30:]
        tot30 = sum(x["total"] for x in last30)
        open_ = next((o for o in outs if o[0] == s["domain"] and o[2] is None), None)
        lr = last_rows.get(s["domain"])
        out.append({
            "domain": s["domain"], "hostId": s["hostId"], "expect": expect_text(s),
            "url": f"{'https' if s['https'] else 'http'}://{s['domain']}{s['path']}",
            "last": {"t": lr[1], "ok": bool(lr[2]), "ms": lr[3], "code": lr[4], "reason": lr[5]} if lr else None,
            "down": bool(open_), "downSince": open_[1] if open_ else None, "downReason": open_[3] if open_ else None,
            "uptime30": round(100 * sum(x["ok"] for x in last30) / tot30, 6) if tot30 else None,  # 6 decimals: services add up downtime
            "avgMs24h": ms24.get(s["domain"]),
            "days": series,
        })
    return {"interval": INTERVAL, "since": since, "sites": out}


def detail(query: dict) -> dict:
    domain = (query.get("domain") or [""])[0].strip().lower()
    rng = (query.get("range") or ["24h"])[0]
    if not re.match(r"^[a-z0-9.-]{3,253}$", domain):
        raise D.ApiError(400, "Invalid domain.")
    if rng not in ("24h", "7d"):
        raise D.ApiError(400, "range must be 24h or 7d.")
    now = int(time.time())
    span, bucket = (86400, 300) if rng == "24h" else (7 * 86400, 3600)
    t0 = (now - span) // bucket * bucket
    with LOCK:
        con = _con()
        try:
            pts = con.execute(f"""SELECT (t / {bucket}) * {bucket} AS b, CAST(AVG(CASE WHEN ok=1 THEN ms END) AS INTEGER),
                                  MAX(CASE WHEN ok=1 THEN ms END), SUM(1-ok), COUNT(*)
                                  FROM checks WHERE site=? AND t >= ? GROUP BY b ORDER BY b""", (domain, t0)).fetchall()
            outs = con.execute("SELECT start, end, reason, last_reason FROM outages WHERE site=? AND (start >= ? OR end IS NULL) "
                               "ORDER BY start DESC LIMIT 200", (domain, now - KEEP_DAYS * 86400)).fetchall()
        finally:
            con.close()
    return {
        "domain": domain, "range": rng, "bucket": bucket, "from": t0, "to": now,
        "points": [{"t": b, "ms": avg, "maxMs": mx, "fails": fails, "n": n} for b, avg, mx, fails, n in pts],
        "outages": [{"start": s, "end": e, "durationSec": (e or now) - s, "reason": r,
                     "lastReason": lr if lr != r else None} for s, e, r, lr in outs],
    }


def route(method: str, path: str, query: dict):
    D.require("proxy")
    if method == "GET" and path == "/api/uptime":
        return summary()
    if method == "GET" and path == "/api/uptime/site":
        return detail(query)
    raise D.ApiError(404, "Unknown endpoint.")
