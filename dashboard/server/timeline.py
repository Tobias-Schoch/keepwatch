"""Timeline "What happened?" - add-on module of the Keepwatch dashboard.

Everything that happens on the server ends up as an event in an SQLite file
(<STATE_DIR>/timeline.db, 120 days). The UI shows it grouped by day (#timeline)
and the eight most important ones since yesterday on the overview.

Other modules add an event with one call:

    import timeline
    timeline.add("services", "shop.example.com unreachable", level="crit",
                 detail="HTTP 502 since 03:12", service="shop", key="uptime:down:shop:1792787000")

Kinds (kind): services, backup, system, security, dashboard.
Levels (level): info, warn, crit. Only warn/crit get a color.
`key` makes an entry unique: the same key a second time is ignored (or replaced
with replace=True). Without a key every call is a new entry.

Sources this module collects itself (thread `loop`, every 20 s, each source on its own
schedule; a source whose module is off in KW_MODULES is skipped):
  - Containers     docker events (own reader thread, records continuously; Docker only
                   keeps 256 events), related starts -> one event              [docker]
  - Portainer      stack redeploys (UpdateDate + commit from GitConfig.ConfigHash) [portainer]
  - Backup         journal of keepwatch-backup / keepwatch-backup-verify, older
                   snapshots from restic                                        [backup]
  - System         /var/log/apt/history.log*, journalctl --list-boots, kernel per boot,
                   Keepwatch deploys (deploys.jsonl, written by lib/apply.sh)
  - Certificates   letsencrypt/archive/npm-*/certN.pem (one file per renewal),
                   failures from <proxy data>/logs/letsencrypt.log*             [proxy]
  - Security       fail2ban (grouped per hour and jail) [fail2ban], SSH logins (per hour
                   and address), port 22 open/closed (journal of keepwatch-firewall)
                   [firewall], automatic reopening (keepwatch-ssh-fallback) [tailscale]
  - Dashboard      every write request (audit(), hook in the handler) - only endpoint and
                   a safe summary, never the request content

On the very first start `backfill` fills in whatever the sources still have;
those entries carry backfill=1 ("filled in from logs").
"""
from __future__ import annotations

import collections
import datetime as dt
import glob
import gzip
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

import config

KINDS = ("services", "backup", "system", "security", "dashboard")
LEVELS = ("info", "warn", "crit")
KEEP_DAYS = 120
APT_LOG = Path("/var/log/apt/history.log")
F2B_LOG = Path("/var/log/fail2ban.log")
DOCKER_WINDOW = 20      # keep collecting this long after the last container event
DOCKER_MAX = 180        # write a bundle at the latest after this
BOOT_GRACE = 300        # starts this soon after booting belong to the reboot

# Weight for "the top 8" on the overview (problems always come first).
WEIGHT = {"boot": 60, "port22": 55, "backup": 40, "probe": 30, "deploy": 40, "docker": 30, "portainer": 35,
          "apt": 35, "cert": 30, "updates": 35, "ssh": 20, "audit": 15, "f2b": 8, "image": 5, "module": 30}

JAILS = {config.JAIL_SSH: "SSH", config.JAIL_SSH_TAILNET: "SSH (Tailscale)", config.JAIL_SSH_CLOSED: "Port 22 (closed)",
         "web-scanner": "Web scanner", "app-login": "App login", config.JAIL_RECIDIVE: "Repeat offenders",
         "ban-history": "Ban history"}

_LOCK = threading.RLock()
_CONN: sqlite3.Connection | None = None
_TL = threading.local()  # .backfill = True while filling in
STATE = {"started": False, "backfilling": False, "sources": {}}


def D():
    return sys.modules["dashboard"]


# --------------------------------------------------------------------------- Storage

def _db() -> sqlite3.Connection:
    global _CONN
    if _CONN is None:
        path = config.STATE_DIR / "timeline.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(path), timeout=15, check_same_thread=False, isolation_level=None)
        con.row_factory = sqlite3.Row
        # No WAL: the backup copies the file as is (STATE_DIR); without -wal something would be missing.
        con.executescript("""
            CREATE TABLE IF NOT EXISTS events(
              id INTEGER PRIMARY KEY,
              key TEXT UNIQUE,
              t REAL NOT NULL,
              t_end REAL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              detail TEXT,
              level TEXT NOT NULL DEFAULT 'info',
              service TEXT,
              service_title TEXT,
              source TEXT NOT NULL DEFAULT 'module',
              count INTEGER NOT NULL DEFAULT 1,
              weight INTEGER NOT NULL DEFAULT 30,
              backfill INTEGER NOT NULL DEFAULT 0,
              link TEXT,
              meta TEXT
            );
            CREATE INDEX IF NOT EXISTS events_t ON events(t);
            CREATE INDEX IF NOT EXISTS events_service ON events(service, t);
            CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        """)
        os.chmod(path, 0o600)
        _CONN = con
    return _CONN


def _meta_get(k: str, default=None):
    with _LOCK:
        row = _db().execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["v"])
    except ValueError:
        return default


def _meta_set(k: str, v):
    with _LOCK:
        _db().execute("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      (k, json.dumps(v, ensure_ascii=False)))


def add(kind: str, title: str, *, detail: str | None = None, level: str = "info", service: str | None = None,
        service_title: str | None = None, t: float | None = None, t_end: float | None = None,
        key: str | None = None, source: str = "module", link: dict | None = None, meta: dict | None = None,
        weight: int | None = None, count: int = 1, replace: bool = False) -> int | None:
    """Record an event. Returns the id (or None if the key already existed).

    kind     services | backup | system | security | dashboard
    level    info | warn | crit (only warn/crit get a color and count as a problem)
    service  stack / compose project (filter "Service" and jump to the service block)
    key      unique key; already present -> nothing happens (replace=True: replace it)
    link     where a click leads: {"view": "services", "sel": ".d-block-title", "text": "...", "exact": true,
             "up": ".d-block"}; settings rows: {"view": "settings", "setting": "<row>"}
    """
    if kind not in KINDS:
        kind = "system"
    if level not in LEVELS:
        level = "warn" if level == "warning" else "crit" if level in ("error", "critical") else "info"
    t = float(t if t is not None else time.time())
    if service and not service_title:
        service_title = service_title_of(service)
    if service and link is None:
        link = service_link(service)
    key = key or f"{source}:{int(t * 1000)}:{title}"
    row = (key, t, t_end, kind, str(title)[:300], (str(detail)[:1000] if detail else None), level, service,
           service_title, source, int(count), int(weight if weight is not None else WEIGHT.get(source, 30)),
           1 if getattr(_TL, "backfill", False) else 0, json.dumps(link) if link else None,
           json.dumps(meta, ensure_ascii=False) if meta else None)
    verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
    try:
        with _LOCK:
            if replace:  # the "filled in" flag survives a replace
                old = _db().execute("SELECT backfill FROM events WHERE key=?", (key,)).fetchone()
                if old and old["backfill"]:
                    row = row[:12] + (1,) + row[13:]
            cur = _db().execute(f"{verb} INTO events(key, t, t_end, kind, title, detail, level, service, service_title,"
                                " source, count, weight, backfill, link, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            return cur.lastrowid if cur.rowcount else None
    except sqlite3.Error:
        traceback.print_exc()
        return None


def exists(key: str) -> bool:
    with _LOCK:
        return _db().execute("SELECT 1 FROM events WHERE key=?", (key,)).fetchone() is not None


def _bump(key: str, t: float, n: int, item: str | None, make) -> None:
    """Increase the counter of a grouped entry (fail2ban per hour, SSH per hour)."""
    with _LOCK:
        row = _db().execute("SELECT count, t, t_end, meta FROM events WHERE key=?", (key,)).fetchone()
        if row is None:
            items = [item] if item else []
            title, detail, level = make(n, items)
            add(**make.base, title=title, detail=detail, level=level, t=t, t_end=t, key=key, count=n,
                meta={"items": items})
            return
        meta = json.loads(row["meta"] or "{}")
        items = meta.get("items") or []
        if item and item not in items and len(items) < 30:
            items.append(item)
        count = row["count"] + n
        title, detail, level = make(count, items)
        _db().execute("UPDATE events SET count=?, t=?, t_end=?, title=?, detail=?, level=?, meta=? WHERE key=?",
                      (count, min(row["t"], t), max(row["t_end"] or row["t"], t), title, detail, level,
                       json.dumps({**meta, "items": items}, ensure_ascii=False), key))


def _find(source: str | tuple, service: str, t0: float, t1: float):
    sources = (source,) if isinstance(source, str) else source
    with _LOCK:
        return _db().execute(
            f"SELECT * FROM events WHERE source IN ({','.join('?' * len(sources))}) AND service=? AND t BETWEEN ? AND ?"
            " ORDER BY t DESC LIMIT 1", (*sources, service, t0, t1)).fetchone()


def _update(eid: int, **cols):
    if "meta" in cols and isinstance(cols["meta"], dict):
        cols["meta"] = json.dumps(cols["meta"], ensure_ascii=False)
    with _LOCK:
        _db().execute(f"UPDATE events SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?", (*cols.values(), eid))


def prune():
    with _LOCK:
        _db().execute("DELETE FROM events WHERE t < ?", (time.time() - KEEP_DAYS * 86400,))


# --------------------------------------------------------------------------- Helpers

def _num(x: float, digits: int = 1) -> str:
    s = f"{x:,.{digits}f}"
    return s[:-2] if digits == 1 and s.endswith(".0") else s


def _dur(sec: float) -> str:
    sec = max(0, int(sec))
    if sec < 60:
        return f"{sec} s"
    if sec < 3600:
        return f"{sec // 60} min"
    if sec < 86400:
        h, m = sec // 3600, (sec % 3600) // 60
        return f"{h} h {m} min" if m else f"{h} h"
    return f"{sec // 86400} d {(sec % 86400) // 3600} h"


def _restic_size(s: str) -> str:
    """"7.940 MiB" -> "7.9 MiB"."""
    m = re.match(r"([\d.]+)\s*(\S+)", s.strip())
    return f"{_num(float(m.group(1)))} {m.group(2)}" if m else s.strip()


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _more(items: list[str], limit: int) -> str:
    """"a, b, c and 4 more"."""
    return ", ".join(items[:limit]) + (f" and {len(items) - limit} more" if len(items) > limit else "")


def _local_ts(s: str, fmt: str) -> float | None:
    """Time from a server log file (server local time, UTC there)."""
    try:
        return dt.datetime.strptime(s, fmt).timestamp()
    except ValueError:
        return None


def _open_log(path: str):
    return gzip.open(path, "rt", errors="replace") if path.endswith(".gz") else open(path, errors="replace")


def _rotated(base: Path, full: bool) -> list[str]:
    """base, base.1, base.2.gz, ... - oldest first. Without full only the current file (+ .1)."""
    files = [str(base)] + sorted(glob.glob(f"{base}.*"), key=lambda p: int(re.search(r"\.(\d+)", p[len(str(base)):]).group(1))
                                 if re.search(r"\.(\d+)", p[len(str(base)):]) else 0)
    if not full:
        files = files[:2]
    return [f for f in reversed(files) if os.path.isfile(f)]


def _journal(args: list[str], timeout: float = 600):
    """Journal entries as dicts (streamed, low priority)."""
    cmd = ["nice", "-n", "15", "ionice", "-c3", "journalctl", "-o", "json", "-q", "--no-pager", *args]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace",
                                env={**os.environ, "LC_ALL": "C.UTF-8"})
    except OSError:
        return
    end = time.time() + timeout
    try:
        for line in proc.stdout:
            if time.time() > end:
                break
            try:
                e = json.loads(line)
            except ValueError:
                continue
            msg = e.get("MESSAGE")
            if isinstance(msg, list):  # binary data comes as a list of bytes
                try:
                    e["MESSAGE"] = bytes(msg).decode("utf-8", "replace")
                except (TypeError, ValueError):
                    e["MESSAGE"] = ""
            try:
                e["_t"] = int(e.get("__REALTIME_TIMESTAMP", "0")) / 1e6
            except ValueError:
                e["_t"] = 0
            yield e
    finally:
        proc.kill()
        proc.wait()


_STACKS = {"at": 0.0, "titles": {}, "containers": {}}


def _stack_titles() -> dict[str, str]:
    """Project -> display name, like the block on the Services page (Services.tsx titleOf)."""
    if time.time() - _STACKS["at"] < 60:
        return _STACKS["titles"]
    titles, owner = {}, {}
    try:
        col = D().COLLECTORS.get("stacks") if config.enabled("portainer") else None
        stacks = (col.value or {}).get("stacks") or [] if col else []
    except Exception:  # noqa: BLE001
        stacks = []
    for s in stacks:
        name = s.get("name") or ""
        if not s.get("managed"):
            title = "Infrastructure"
        else:
            repo = re.sub(r"\.git$", "", ((s.get("git") or {}).get("url") or "")).rstrip("/").split("/")[-1]
            title = repo if re.search(r"[A-Z]", repo) else (name.upper() if len(name) <= 4 else name)
        titles[name] = title
        for c in s.get("containers") or []:
            owner[c] = name
    if stacks:
        _STACKS.update(at=time.time(), titles=titles, containers=owner)
    return titles


def service_title_of(service: str) -> str:
    return _stack_titles().get(service) or service


def service_of_container(name: str) -> str | None:
    """Container -> project (from the dashboard's docker collector)."""
    _stack_titles()
    if name in _STACKS["containers"]:
        return _STACKS["containers"][name]
    try:
        for c in (D().COLLECTORS["docker"].value or {}).get("containers") or []:
            if c["name"] == name:
                return c.get("project") or name
    except Exception:  # noqa: BLE001
        pass
    return None


def service_link(service: str, container: str | None = None) -> dict:
    if service in _stack_titles():
        return {"view": "services", "sel": ".d-block-title", "text": service_title_of(service), "exact": True, "up": ".d-block"}
    return {"view": "services", "sel": ".d-block td", "text": container or service, "up": "tr"}


def _site_link(domain: str) -> dict:
    return {"view": "services", "sel": ".d-block td, .d-block a", "text": domain, "up": "tr"}


def _setting(row: str) -> dict:
    """Link to a settings row (rows as in problem targets: "settings/<row>")."""
    return {"view": "settings", "setting": row}


LINK_BACKUP = {"view": "backups"}
LINK_SERVICES = {"view": "services"}
LINK_F2B = {"view": "security", "sel": ".o-h2", "text": "Banned addresses", "up": ".o-panel"}
LINK_SSH = {"view": "security", "sel": ".o-h2", "text": "Logins", "up": ".o-panel"}
LINK_PORT22 = _setting("remote-access")
LINK_MACHINE = {"view": "overview", "sel": ".d-fold-panel", "text": "Machine"}


def _boot_time() -> float:
    try:
        for line in open("/proc/stat"):
            if line.startswith("btime "):
                return float(line.split()[1])
    except OSError:
        pass
    return 0.0


# --------------------------------------------------------------------------- Containers (docker events)

DOCKER_ACTIONS = ("create", "start", "restart", "die", "stop", "kill", "oom", "destroy", "health_status", "pull", "delete")
_PENDING: dict[str, dict] = {}
_HEALTH: dict[str, str] = {}
_DLOCK = threading.Lock()
_LAST_EVENT = {"t": None}


def _docker_reader():
    """Reads `docker events` continuously. If the stream breaks, it resumes from the last event.
    Idles while the docker module is off."""
    saved = _meta_get("docker_since")
    since = saved if saved and time.time() - saved < 3600 else time.time()
    seen: collections.deque = collections.deque(maxlen=2000)
    seen_set: set = set()
    filters = ["--filter", "type=container", "--filter", "type=image"]
    for a in DOCKER_ACTIONS:
        filters += ["--filter", f"event={a}"]
    while True:
        if not config.enabled("docker"):
            STATE["sources"].pop("docker", None)
            since = time.time()
            time.sleep(60)
            continue
        try:
            proc = subprocess.Popen(["docker", "events", "--format", "{{json .}}", "--since", f"{since:.3f}", *filters],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
            STATE["sources"]["docker"] = {"ok": True, "since": STATE["sources"].get("docker", {}).get("since") or time.time()}
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                ident = (ev.get("timeNano"), (ev.get("Actor") or {}).get("ID"), ev.get("Action"))
                if ident in seen_set:
                    continue
                if len(seen) == seen.maxlen:
                    seen_set.discard(seen[0])
                seen.append(ident)
                seen_set.add(ident)
                since = max(since, (ev.get("timeNano") or 0) / 1e9)
                _LAST_EVENT["t"] = since
                try:
                    _docker_ingest(ev)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            proc.wait()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        STATE["sources"]["docker"] = {**STATE["sources"].get("docker", {}), "ok": False}
        time.sleep(5)


def _docker_ingest(ev: dict):
    attrs = (ev.get("Actor") or {}).get("Attributes") or {}
    full = ev.get("Action") or ""
    action = full.split(":", 1)[0].strip()
    t = (ev.get("timeNano") or 0) / 1e9 or float(ev.get("time") or time.time())
    if ev.get("Type") == "image":
        gk, item = "~images", {"action": action, "name": attrs.get("name") or (ev.get("Actor") or {}).get("ID", "")[:19], "t": t}
    else:
        name = attrs.get("name") or ""
        project = attrs.get("com.docker.compose.project") or name
        item = {"action": action, "name": name, "t": t, "project": project, "image": attrs.get("image"),
                "exit": attrs.get("exitCode")}
        if action == "health_status":
            status = full.split(":", 1)[1].strip() if ":" in full else ""
            before = _HEALTH.get(name)
            _HEALTH[name] = status
            if status == "healthy" and before != "unhealthy":
                return  # "healthy" after every start is not an event
            if status not in ("healthy", "unhealthy"):
                return
            item["health"] = status
        bt = _boot_time()
        gk = "~boot" if bt and action in ("create", "start", "health_status") and t - bt < BOOT_GRACE else project
    with _DLOCK:
        g = _PENDING.setdefault(gk, {"first": t, "last": t, "items": []})
        g["last"] = max(g["last"], t)
        g["first"] = min(g["first"], t)
        g["items"].append(item)


def _docker_flush(force: bool = False):
    now = time.time()
    ready = []
    with _DLOCK:
        for gk, g in list(_PENDING.items()):
            wait = 60 if gk == "~images" else DOCKER_WINDOW
            if force or now - g["last"] >= wait or now - g["first"] >= DOCKER_MAX:
                if gk == "~images":
                    continue  # images last: pulls usually belong to a redeploy
                ready.append((gk, _PENDING.pop(gk)))
        imgs = _PENDING.get("~images")
        for gk, g in ready:
            images = {i.get("image") for i in g["items"] if i.get("image")}
            if imgs and any(i["action"] == "create" for i in g["items"]):
                take = [i for i in imgs["items"] if i["action"] == "pull" and i["t"] >= g["first"] - 900 and i["name"] in images]
                if take:
                    g["pulled"] = sorted({i["name"] for i in take})
                    imgs["items"] = [i for i in imgs["items"] if i not in take]
        if imgs and (not imgs["items"] or force or now - imgs["last"] >= 60):
            _PENDING.pop("~images", None)
            if imgs["items"]:
                ready.append(("~images", imgs))
    for gk, g in ready:
        try:
            _docker_write(gk, g)
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def _docker_flush_loop():
    last_saved = None
    while True:
        time.sleep(5)
        _docker_flush()
        # After a dashboard restart the stream resumes from here (do not lose pending bundles).
        with _DLOCK:
            mark = min((g["first"] for g in _PENDING.values()), default=None)
        mark = (mark - 1) if mark else _LAST_EVENT["t"]
        if mark and mark != last_saved:
            _meta_set("docker_since", mark)
            last_saved = mark


def _exit_text(code) -> str:
    return {"137": "exit 137 - killed", "139": "exit 139 - segmentation fault", "143": "exit 143"}.get(str(code), f"exit {code}")


def _deployed_by_keepwatch(svc: str, t0: float, t1: float) -> bool:
    """Did a Keepwatch deploy change files of this compose project just before (e.g. /srv/keepwatch/proxy/...)?"""
    with _LOCK:
        rows = _db().execute("SELECT meta FROM events WHERE source='deploy' AND t BETWEEN ? AND ?", (t0, t1)).fetchall()
    for r in rows:
        changed = json.loads(r["meta"] or "{}").get("changed") or []
        if any(f"/{svc}/" in c for c in changed):
            return True
    return False


def _docker_write(gk: str, g: dict):
    items = sorted(g["items"], key=lambda i: i["t"])
    first, last = g["first"], g["last"]
    if gk == "~images":
        pulls = sorted({i["name"] for i in items if i["action"] == "pull"})
        dels = sorted({i["name"] for i in items if i["action"] == "delete"})
        if pulls:
            add("services", f"Image pulled: {pulls[0]}" if len(pulls) == 1 else f"{len(pulls)} images pulled",
                detail=", ".join(pulls[:6]) if len(pulls) > 1 else None, t=first, t_end=last, source="image",
                key=f"image:pull:{int(first)}")
        if dels:
            add("services", f"{_plural(len(dels), 'image', 'images')} removed", detail=_more(dels, 6),
                t=first, t_end=last, source="image", key=f"image:delete:{int(first)}")
        return

    by: dict[str, set] = collections.defaultdict(set)
    exits: dict[str, str] = {}
    die_t: dict[str, float] = {}
    health: dict[str, list] = collections.defaultdict(list)
    for i in items:
        by[i["action"]].add(i["name"])
        if i["action"] == "die":
            exits[i["name"]] = str(i.get("exit") or "0")
            die_t[i["name"]] = i["t"]
        if i["action"] == "health_status":
            health[i["name"]].append(i["health"])
    stopped = by["stop"] | by["kill"]
    crashed = {n: c for n, c in exits.items() if c != "0" and n not in stopped}
    restarted_after_crash = {n for n in crashed if any(i["action"] == "start" and i["name"] == n and i["t"] >= die_t[n] for i in items)}
    names = sorted({i["name"] for i in items})

    if gk == "~boot":
        projects = sorted({service_title_of(i.get("project") or i["name"]) for i in items if i["action"] == "start"})
        n = len(by["start"])
        level = "crit" if crashed else "warn" if any("unhealthy" == h[-1] for h in health.values()) else "info"
        facets = [_more(projects, 8)] if projects else []
        if crashed:
            facets.append("crashed: " + ", ".join(f"{n_} ({_exit_text(c)})" for n_, c in crashed.items()))
        add("services", f"After boot: {_plural(n, 'container', 'containers')} started in {_plural(len(projects), 'service', 'services')}"
            if n else "Containers after boot", detail=" · ".join(f for f in facets if f) or None, level=level,
            t=first, t_end=last, source="docker", key=f"docker:boot:{int(_boot_time())}", weight=20,
            link=LINK_SERVICES, meta={"containers": names})
        return

    svc = gk
    title_svc = service_title_of(svc)
    facets: list[str] = []
    level = "info"
    title = None
    weight = WEIGHT["docker"]
    if by["oom"]:
        title, level = f"{title_svc}: out of memory (OOM) - {', '.join(sorted(by['oom']))}", "crit"
    if crashed:
        n0, c0 = next(iter(crashed.items()))
        times = sum(1 for i in items if i["action"] == "die" and i["name"] == n0)
        txt = f"{title_svc}: {n0} crashed ({_exit_text(c0)})" + (f" - {times}x in {_dur(last - first)}" if times > 1 else "") + \
            (" and restarted" if n0 in restarted_after_crash else "")
        if title:
            facets.append(txt)
        else:
            title = txt
        level = "crit" if n0 not in restarted_after_crash or level == "crit" else "warn"
        for n_, c in list(crashed.items())[1:]:
            facets.append(f"{n_} crashed ({_exit_text(c)})")
    action_title = None
    if by["create"] and by["start"]:
        action_title = f"{title_svc} redeployed ({_plural(len(by['create'] | by['start']), 'container', 'containers')})"
    elif by["start"] or by["restart"]:
        st = (by["start"] | by["restart"]) - set(restarted_after_crash)
        if st:
            verb = "restarted" if (stopped & st or by["restart"]) else "started"
            action_title = f"{title_svc} {verb} ({_plural(len(st), 'container', 'containers')})"
    elif by["destroy"]:
        action_title = f"{title_svc}: {_plural(len(by['destroy']), 'container', 'containers')} removed"
    elif stopped and by["die"] and not crashed:
        action_title = f"{title_svc} stopped ({_plural(len(stopped), 'container', 'containers')})"
    if action_title:
        if title:
            facets.insert(0, action_title)
        else:
            title = action_title
    for n_, hs in sorted(health.items()):
        if hs[-1] == "unhealthy":
            txt = f"{title_svc}: {n_} unhealthy"
            level = "warn" if level == "info" else level
        elif "unhealthy" in hs:
            txt = f"{title_svc}: {n_} briefly unhealthy, healthy again"
            level = "warn" if level == "info" else level
        else:
            txt = f"{title_svc}: {n_} healthy again"
        if title:
            facets.append(txt.split(": ", 1)[1])
        else:
            title = txt
    if not title:
        return  # nothing worth mentioning (e.g. a single kill)
    if g.get("pulled"):
        facets.append("new image: " + ", ".join(g["pulled"]))
    if len(names) > 1 and (by["create"] or by["start"]):
        facets.append(", ".join(names))
    # Who triggered it? An action in the dashboard, an update job or a Keepwatch deploy just before.
    trig = _find(("audit", "updates"), svc, first - 300, last + 5)
    if trig:
        facets.append("triggered in the dashboard")
    elif _deployed_by_keepwatch(svc, first - 900, last + 5):
        facets.append("during a Keepwatch deploy")
    meta = {"containers": names, "facets": facets}
    # Portainer redeploy already recorded? Then merge into it.
    pt = _find("portainer", svc, first - 900, last + 600)
    if pt:
        pmeta = json.loads(pt["meta"] or "{}")
        facets = facets + [f for f in pmeta.get("facets", []) if f not in facets]
        _update(pt["id"], title=title, level=level if LEVELS.index(level) > LEVELS.index(pt["level"]) else pt["level"],
                detail=" · ".join(facets) or None, source="docker", t=min(pt["t"], first), t_end=last,
                meta={**pmeta, **meta, "facets": facets})
        return
    add("services", title, detail=" · ".join(facets) or None, level=level, service=svc, t=first, t_end=last,
        source="docker", key=f"docker:{svc}:{int(first)}", weight=weight if level == "info" else 50, meta=meta)


def backfill_docker(boot_only: bool = False):
    """What runs today and when it started, from docker inspect (Docker itself keeps no longer history).
    boot_only: only the starts right after boot (if the dashboard starts later, it does not see them live)."""
    if not config.enabled("docker"):
        return
    d = D()
    ids = d.run(["docker", "ps", "-aq"]).split()
    try:
        info = json.loads(d.run(["docker", "inspect", *ids], timeout=60) or "[]") if ids else []
    except ValueError:
        return

    def ts(v):
        if not v or v.startswith("0001-"):
            return None
        try:
            return dt.datetime.fromisoformat(v[:26].rstrip("Z") + "+00:00").timestamp()
        except ValueError:
            return None
    bt = _boot_time()
    groups: dict[str, list] = collections.defaultdict(list)
    for c in info:
        name = c["Name"].lstrip("/")
        labels = (c.get("Config") or {}).get("Labels") or {}
        project = labels.get("com.docker.compose.project") or name
        st = c.get("State") or {}
        started, created = ts(st.get("StartedAt")), ts(c.get("Created"))
        if started:
            groups["~boot" if bt and 0 <= started - bt < BOOT_GRACE else project].append(
                {"action": "start", "name": name, "t": started, "project": project, "exit": None})
            if created and abs(started - created) < 120:
                groups["~boot" if bt and 0 <= started - bt < BOOT_GRACE else project].append(
                    {"action": "create", "name": name, "t": created, "project": project, "exit": None})
        if not st.get("Running") and ts(st.get("FinishedAt")):
            groups[project].append({"action": "die", "name": name, "t": ts(st["FinishedAt"]), "project": project,
                                    "exit": str(st.get("ExitCode", 0))})
            groups[project].append({"action": "stop", "name": name, "t": ts(st["FinishedAt"]), "project": project})
    for gk, items in groups.items():
        if boot_only and gk != "~boot":
            continue
        items.sort(key=lambda i: i["t"])
        cluster: list = []
        for i in items + [None]:
            if cluster and (i is None or i["t"] - cluster[-1]["t"] > 120):
                _docker_write(gk, {"first": cluster[0]["t"], "last": cluster[-1]["t"], "items": cluster})
                cluster = []
            if i:
                cluster.append(i)


# --------------------------------------------------------------------------- Portainer

def scan_portainer(full: bool = False):
    d = D()
    if not d.portainer_token():
        return
    try:
        stacks = d.portainer("GET", "/api/stacks") or []
    except Exception:  # noqa: BLE001
        STATE["sources"]["portainer"] = {"ok": False}
        return
    STATE["sources"]["portainer"] = {"ok": True}
    seen = _meta_get("portainer_seen", {}) or {}
    for s in stacks:
        name, upd = s.get("Name") or "", s.get("UpdateDate") or s.get("CreationDate") or 0
        if not upd:
            continue
        git = s.get("GitConfig") or {}
        commit = (git.get("ConfigHash") or "")[:7]
        sig = f"{upd}:{commit}"
        if seen.get(name) == sig:
            continue
        seen[name] = sig
        facet = "via Portainer" + (f" · commit {commit}" if commit else "") + \
                (f" ({(git.get('ReferenceName') or '').replace('refs/heads/', '')})" if git.get("ReferenceName") else "") + \
                (f" · by {s.get('UpdatedBy')}" if s.get("UpdatedBy") else "")
        key = f"portainer:{s.get('Id')}:{upd}"
        if exists(key):
            continue
        dk = _find("docker", name, upd - 600, upd + 900)
        if dk:
            meta = json.loads(dk["meta"] or "{}")
            facets = [f for f in meta.get("facets", []) if not f.startswith("via Portainer")] + [facet]
            _update(dk["id"], detail=" · ".join(facets), meta={**meta, "facets": facets, "commit": commit, "portainerKey": key})
            continue
        add("services", f"{service_title_of(name)} redeployed", detail=facet, service=name, t=upd, source="portainer",
            key=key, meta={"facets": [facet], "commit": commit})
    _meta_set("portainer_seen", seen)


# --------------------------------------------------------------------------- Backup
#
# Reads the journal of keepwatch-backup(.service) and keepwatch-backup-verify. Lines it
# understands: restic's own output, "[HH:MM:SS] step" lines, "-> remote (<name>)" when
# copying off-site and "No off-site repository" when there is none.

ADDED = re.compile(r"^Added to the repository: (.+?)(?: \((.+) stored\))?$")
PROCESSED = re.compile(r"^processed (\d+) files, (.+?) in ")
SAVED = re.compile(r"^snapshot ([0-9a-f]{8}) saved")
STEP = re.compile(r"^\[\d\d:\d\d:\d\d\] (.+)$")
REMOTE_STEP = re.compile(r"-> remote ?\(?([^)]*)\)?")
NO_REMOTE = re.compile(r"(?i)\bno (?:off-site|remote) repository\b")
ERROR = re.compile(r"(?i)fatal|error|failed")


def scan_backups(full: bool = False):
    since = [] if full else ["--since", f"@{int(time.time() - 2 * 86400)}"]
    runs: list[dict] = []
    cur: dict[str, dict] = {}
    backup, verify = config.UNITS["backup"], config.UNITS["backup-verify"]
    for e in _journal(["-u", f"{backup}.service", "-u", f"{verify}.service", *since]):
        unit = e.get("UNIT") or e.get("_SYSTEMD_UNIT") or ""
        unit = "probe" if verify in unit else "backup"
        msg = (e.get("MESSAGE") or "").strip()
        t = e["_t"]
        sysd = e.get("_PID") == "1" or e.get("SYSLOG_IDENTIFIER") == "systemd"
        if sysd and msg.startswith("Starting "):
            cur[unit] = {"unit": unit, "start": t, "lines": [], "added": None, "total": None, "snap": None,
                         "remote": None, "ok": None, "end": None}
            continue
        r = cur.get(unit)
        if r is None:
            if sysd:
                continue
            # the run started before the window we read
            r = cur[unit] = {"unit": unit, "start": t, "lines": [], "added": None, "total": None, "snap": None,
                             "remote": None, "ok": None, "end": None, "partial": True}
        if sysd:
            if "Failed with result" in msg or msg.startswith("Failed to start"):
                r["ok"], r["end"] = False, t
            elif msg.startswith("Finished ") or "Deactivated successfully" in msg:
                if r["ok"] is None:
                    r["ok"] = True
                r["end"] = t
            if r["end"] and re.match(r"^(Finished |Failed to start)|.*(Failed with result|Consumed )", msg):
                runs.append(cur.pop(unit))
            continue
        m = ADDED.match(msg)
        if m and r["added"] is None:
            r["added"] = m.group(1)
        m = PROCESSED.match(msg)
        if m and r["total"] is None:
            r["total"] = m.group(2)
        m = SAVED.match(msg)
        if m and r["snap"] is None:
            r["snap"] = m.group(1)
        m = REMOTE_STEP.search(msg)
        if m:
            r["remote"] = m.group(1).strip() or "remote"
        if NO_REMOTE.search(msg):
            r["remote"] = ""
        m = STEP.match(msg)
        if m:
            r["lines"].append(m.group(1))
        elif ERROR.search(msg):
            r["lines"].append(msg)
    for r in runs:
        if r.get("partial"):
            continue
        dur = (r["end"] or r["start"]) - r["start"]
        if r["unit"] == "probe":
            facets = [_dur(dur)]
            last = next((ln for ln in reversed(r["lines"]) if ln and ln != "Done"), None)
            if not r["ok"] and last:
                facets.insert(0, last[:200])
            add("backup", "Backup check passed" if r["ok"] else "Backup check failed", detail=" · ".join(facets),
                level="info" if r["ok"] else "crit", t=r["start"], t_end=r["end"], source="probe",
                key=f"probe:{int(r['start'])}", link=LINK_BACKUP, replace=True)
            continue
        facets = []
        if r["added"]:
            facets.append(f"+{_restic_size(r['added'])} new")
        if r["total"]:
            facets.append(f"{_restic_size(r['total'])} backed up")
        facets.append(_dur(dur))
        if r["remote"] is not None:
            facets.append(f"local + {r['remote']}" if r["remote"] else "local only")
        if not r["ok"]:
            err = next((ln for ln in reversed(r["lines"]) if ERROR.search(ln)), None) \
                or (r["lines"][-1] if r["lines"] else None)
            if err:
                facets.insert(0, err[:200])
        key = f"backup:{r['snap']}" if r["snap"] else f"backup-run:{int(r['start'])}"
        add("backup", "Backup completed" if r["ok"] else "Backup failed", detail=" · ".join(facets),
            level="info" if r["ok"] else "crit", t=r["start"], t_end=r["end"], source="backup", key=key,
            link=LINK_BACKUP, replace=True, meta={"snapshot": r["snap"]})
    # Older snapshots the journal no longer knows: from restic's list (once).
    if not _meta_get("backup_snapshots_done"):
        col = D().COLLECTORS.get("backups")
        snaps = ((col.value or {}).get("snapshots") if col else None)
        if snaps is not None:
            with _LOCK:
                oldest = _db().execute("SELECT MIN(t) m FROM events WHERE source='backup'").fetchone()["m"] or time.time()
            prev = getattr(_TL, "backfill", False)
            _TL.backfill = True
            try:
                for s in snaps:
                    if s.get("target") != "Local" or s["time"] >= oldest - 600:
                        continue
                    if exists(f"backup:{s['id']}"):
                        continue
                    add("backup", "Backup completed", detail=f"Snapshot {s['id']}" + (" · " + ", ".join(s["tags"]) if s.get("tags") else ""),
                        t=s["time"], source="backup", key=f"backup:{s['id']}", link=LINK_BACKUP)
            finally:
                _TL.backfill = prev
            _meta_set("backup_snapshots_done", True)


# --------------------------------------------------------------------------- System: apt, reboots, kernel, deploys

def _apt_blocks(full: bool):
    for path in _rotated(APT_LOG, full):
        block: dict = {}
        try:
            with _open_log(path) as f:
                for line in f:
                    line = line.rstrip("\n")
                    if not line.strip():
                        if block.get("Start-Date"):
                            yield block
                        block = {}
                        continue
                    k, _, v = line.partition(": ")
                    block[k] = v
            if block.get("Start-Date"):
                yield block
        except OSError:
            continue


def _pkgs(v: str) -> list[str]:
    return re.findall(r"(?:^|\), )([^:\s(]+)(?::\w+)? \(", v or "")


def scan_apt(full: bool = False):
    blocks = []
    for b in _apt_blocks(full):
        t = _local_ts(re.sub(r"\s+", " ", b["Start-Date"]), "%Y-%m-%d %H:%M:%S")
        if not t:
            continue
        end = _local_ts(re.sub(r"\s+", " ", b.get("End-Date", "")), "%Y-%m-%d %H:%M:%S") or t
        blocks.append((t, end, b))
    blocks.sort(key=lambda x: x[0])
    clusters: list[list] = []
    for t, end, b in blocks:
        auto = bool(re.search(r"(^|/)unattended-upgrade(\s|$)", b.get("Commandline", "")))
        gap = 900 if auto else 180  # a deploy runs install, purge, autoremove in quick succession -> one entry
        if clusters and auto == clusters[-1][-1][3] and t - clusters[-1][-1][1] < gap:
            clusters[-1].append((t, end, b, auto))
        else:
            clusters.append([(t, end, b, auto)])
    cutoff = time.time() - KEEP_DAYS * 86400
    for cl in clusters:
        t0, t1 = cl[0][0], max(x[1] for x in cl)
        if t1 < cutoff:
            continue
        auto = cl[0][3]
        up, inst, rem, err = [], [], [], []
        for _, _, b, _ in cl:
            up += _pkgs(b.get("Upgrade", ""))
            inst += _pkgs(b.get("Install", ""))
            rem += _pkgs(b.get("Remove", "")) + _pkgs(b.get("Purge", ""))
            if b.get("Error"):
                err.append(b["Error"])
        kernels = sorted({re.sub(r"^linux-image-", "", p) for p in inst if re.match(r"linux-image-\d", p)})
        n = len(set(up + inst))
        if not n and not rem:
            continue
        names = sorted(set(up + inst))
        if auto:
            title = f"Automatic updates: {_plural(n, 'package', 'packages')}" if n else \
                f"Automatic updates: {_plural(len(set(rem)), 'package', 'packages')} removed"
        else:
            what = ([f"{len(set(up))} upgraded"] if up else []) + ([f"{len(set(inst))} installed"] if inst else []) + \
                ([f"{len(set(rem))} removed"] if rem else [])
            title = "Packages: " + ", ".join(what)
        if kernels:
            title += ", new kernel"
        facets = []
        if kernels:
            facets.append(f"Kernel {', '.join(kernels)} (active after reboot)")
        if names:
            facets.append(_more(names, 8))
        if auto and rem:
            facets.append(f"{_plural(len(set(rem)), 'package', 'packages')} removed")
        if not auto:
            cmds = []
            for _, _, b, _ in cl:
                c = re.sub(r"^(/usr/bin/)?(apt-get|apt) ", r"\2 ", b.get("Commandline", ""))
                c = re.sub(r" -\w+", "", c)  # drop flags: "apt-get install restic rclone"
                c = c if len(c) <= 60 else c[:57].rsplit(" ", 1)[0] + " ..."
                if c and c not in cmds:
                    cmds.append(c)
            if cmds:
                facets.append("; ".join(cmds[:3]))
        if err:
            facets.insert(0, "Error: " + err[0][:160])
        add("system", title, detail=" · ".join(facets), level="warn" if err else "info", t=t0, t_end=t1, source="apt",
            key=f"apt:{int(t0)}", link=LINK_MACHINE, meta={"kernels": kernels, "auto": auto}, replace=True)


def _boot_kernel(boot_id: str) -> str:
    """Kernel version of a boot (first kernel message "Linux version ..."), '' if the journal lacks the start."""
    try:
        proc = subprocess.Popen(["journalctl", "-b", boot_id, "-k", "-o", "cat", "-q", "--no-pager"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    except OSError:
        return ""
    try:
        first = proc.stdout.readline()
    finally:
        proc.kill()
        proc.wait()
    m = re.match(r"Linux version (\S+)", first)
    return m.group(1) if m else ""


def _clean_shutdown(boot_id: str) -> bool | None:
    out = D().run(["journalctl", "-b", boot_id, "-n", "40", "-o", "cat", "-q", "--no-pager"], timeout=60)
    if not out:
        return None
    return bool(re.search(r"reboot\.target|poweroff\.target|System Reboot|System Power Off|Shutting down\.", out))


def scan_boots(full: bool = False):
    try:
        boots = json.loads(D().run(["journalctl", "--list-boots", "-o", "json", "--no-pager"], timeout=60) or "[]")
    except ValueError:
        return
    known = _meta_get("boots", {}) or {}
    for b in boots:
        bid = b["boot_id"]
        if bid not in known:
            known[bid] = {"kernel": _boot_kernel(bid)}
    _meta_set("boots", known)
    for i, b in enumerate(boots):
        bid = b["boot_id"]
        kernel = known[bid]["kernel"]
        key = f"boot:{bid}"
        if not kernel or exists(key):
            continue  # the start of this boot is no longer in the journal
        start = b["first_entry"] / 1e6
        prev = boots[i - 1] if i > 0 else None
        facets, level = [], "info"
        title = "Server rebooted"
        if prev:
            pk = known.get(prev["boot_id"], {}).get("kernel")
            offline = start - prev["last_entry"] / 1e6
            facets.append(f"down for {_dur(offline)}")
            if pk and pk != kernel:
                title = f"Rebooted into new kernel {kernel}"
                facets.append(f"previously {pk}")
            clean = _clean_shutdown(prev["boot_id"])
            if clean is False:
                level = "warn"
                facets.append("without a clean shutdown")
        else:
            facets.append(f"Kernel {kernel}")
        with _LOCK:
            apt = _db().execute("SELECT meta FROM events WHERE source='apt' AND t_end BETWEEN ? AND ? ORDER BY t DESC LIMIT 1",
                                (start - 3 * 3600, start)).fetchone()
        if apt:
            facets.append("after automatic updates" if json.loads(apt["meta"] or "{}").get("auto") else "after package updates")
        add("system", title, detail=" · ".join(facets), level=level, t=start, source="boot", key=key, link=LINK_MACHINE,
            meta={"kernel": kernel, "boot": bid})


def scan_deploys(full: bool = False):
    """Lines lib/apply.sh writes on every deploy: {"t", "commit", "subject", "dirty", "changed": [paths],
    "via": "deploy" | "dashboard" | "rollback"} (+ "ok": false from keepwatch-self-update after a rollback)."""
    try:
        lines = config.DEPLOY_LOG.read_text(errors="replace").splitlines()
    except OSError:
        return
    for line in lines[-500:]:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        t = float(r.get("t") or 0)
        if not t:
            continue
        changed = [c for c in (r.get("changed") or []) if isinstance(c, str)]
        commit = str(r.get("commit") or "")[:12]
        short = [re.sub(r"^/(etc|opt|srv|usr/local/sbin|usr/local/bin)/", "", c) for c in changed]
        facets = []
        if r.get("subject"):
            facets.append(str(r["subject"])[:160])
        facets.append(("changed: " + _more(short, 6)) if short else "nothing changed - the server already matched the configuration")
        if r.get("dirty"):
            facets.append("the local checkout had uncommitted changes")
        via = r.get("via")
        if r.get("ok") is False and via == "dashboard":  # written by keepwatch-self-update after a rollback
            what, facets = "Keepwatch update failed - previous version put back", ["Settings -> Keepwatch updates has the log"]
        else:
            what = {"dashboard": "Keepwatch updated from the dashboard",
                    "rollback": "Keepwatch: previous version set up again"}.get(via, "Keepwatch deployed")
        add("system", f"{what}{f' · {commit}' if commit else ''}", detail=" · ".join(facets),
            level="warn" if r.get("ok") is False else "info", t=t, source="deploy", key=f"deploy:{int(t)}",
            meta={"commit": commit, "changed": changed[:50]}, weight=WEIGHT["deploy"] if changed else 15)


# --------------------------------------------------------------------------- Certificates

_CERT_LOG_MTIME: dict[str, float] = {}


def _cert_domains() -> dict[str, str]:
    db = config.PROXY_DATA / "database.sqlite"
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        rows = con.execute("SELECT id, nice_name, domain_names FROM certificate").fetchall()
        con.close()
    except sqlite3.Error:
        return {}
    res = {}
    for cid, nice, doms in rows:
        try:
            d = json.loads(doms or "[]")
        except ValueError:
            d = []
        res[f"npm-{cid}"] = (d[0] if d else nice) + (f" (+{len(d) - 1})" if len(d) > 1 else "")
    return res


def scan_certs(full: bool = False):
    le = config.PROXY_LE
    names = None
    cutoff = time.time() - KEEP_DAYS * 86400
    for path in glob.glob(str(le / "archive" / "*" / "cert*.pem")):
        m = re.search(r"/([^/]+)/cert(\d+)\.pem$", path)
        if not m:
            continue
        cname, n = m.group(1), int(m.group(2))
        key = f"cert:{cname}:{n}"
        try:
            t = os.stat(path).st_mtime
        except OSError:
            continue
        if t < cutoff or exists(key):
            continue
        if names is None:
            names = _cert_domains()
        dom = names.get(cname, cname)
        add("system", f"Certificate {'issued' if n == 1 else 'renewed'}: {dom}", detail="Let's Encrypt" +
            (f" · issue #{n}" if n > 1 else ""), t=t, source="cert", key=key,
            link=_site_link(dom.split(" ")[0]), meta={"cert": cname, "domain": dom})
    # Failed certbot runs (one log file per run, rotated up to .53)
    logdir = config.PROXY_DATA / "logs"
    for path in glob.glob(str(logdir / "letsencrypt.log*")):
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not st.st_size or _CERT_LOG_MTIME.get(path) == st.st_mtime:
            continue
        _CERT_LOG_MTIME[path] = st.st_mtime
        if st.st_mtime < cutoff:
            continue
        try:
            text = open(path, errors="replace").read(400_000)
        except OSError:
            continue
        if not re.search(r"AuthorizationError|Some challenges have failed|An unexpected error occurred|Failed to renew", text):
            continue
        m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", text)
        t = dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp() if m else st.st_mtime
        cname = (re.search(r"'--cert-name', '([^']+)'", text) or [None, ""])[1]
        if names is None:
            names = _cert_domains()
        dom = names.get(cname, cname or "unknown")
        why = re.search(r"Detail: (.+)", text) or re.search(r"Type: urn:ietf:params:acme:error:(\w+)", text)
        add("system", f"Certificate renewal failed: {dom}", detail=(why.group(1).strip()[:200] if why else "certbot reported an error"),
            level="warn", t=t, source="cert", key=f"certfail:{int(t)}:{cname}", link=_site_link(dom.split(" ")[0]))


# --------------------------------------------------------------------------- Security

def _f2b_make(jail: str):
    def make(n, ips):
        more = n - len(ips[:3])
        det = ", ".join(ips[:3]) + (f" and {more} more" if more > 0 else "") if ips else None
        return f"{_plural(n, 'ban', 'bans')} · {JAILS.get(jail, jail)}", det, "info"
    make.base = {"kind": "security", "source": "f2b", "link": LINK_F2B,
                 "weight": WEIGHT["f2b"], "service": None}
    return make


F2B_BAN = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ fail2ban\.actions\s+\[\d+\]: \w+\s+\[([^\]]+)\] Ban (\S+)")


def scan_f2b(full: bool = False):
    if full:
        t0 = time.time()
        for path in _rotated(F2B_LOG, True):
            try:
                with _open_log(path) as f:
                    for line in f:
                        m = F2B_BAN.match(line)
                        if not m:
                            continue
                        t = _local_ts(m.group(1), "%Y-%m-%d %H:%M:%S")
                        if not t or t >= t0 or t < t0 - KEEP_DAYS * 86400:
                            continue
                        jail = m.group(2)
                        _bump(f"f2b:{jail}:{int(t // 3600 * 3600)}", t, 1, m.group(3), _f2b_make(jail))
            except OSError:
                continue
        _meta_set("f2b_cursor", t0)
        return
    cursor = _meta_get("f2b_cursor")
    if cursor is None:
        _meta_set("f2b_cursor", time.time())
        return
    try:
        con = sqlite3.connect(f"file:{D().F2B_DB}?mode=ro", uri=True, timeout=5)
        rows = con.execute("SELECT jail, ip, timeofban FROM bans WHERE timeofban > ? ORDER BY timeofban", (int(cursor),)).fetchall()
        con.close()
    except sqlite3.Error:
        return
    for jail, ip, t in rows:
        _bump(f"f2b:{jail}:{int(t // 3600 * 3600)}", float(t), 1, ip, _f2b_make(jail))
        cursor = max(cursor, t)
    _meta_set("f2b_cursor", cursor)


def _ssh_make(user: str, ip: str, where: str, outside: bool):
    """outside = login from outside the tailnet although port 22 was already closed (a problem)."""
    def make(n, _items):
        title = f"SSH login: {user} {where}" + (f" ({n}x)" if n > 1 else "")
        return title, ip, "warn" if outside else "info"
    make.base = {"kind": "security", "source": "ssh", "link": LINK_SSH,
                 "weight": 50 if outside else WEIGHT["ssh"], "service": None}
    return make


def scan_ssh(full: bool = False):
    d = D()
    since = 0.0 if full else (_meta_get("ssh_cursor") or time.time() - 3600)
    if full and since == 0.0:
        since = time.time() - KEEP_DAYS * 86400
    last = since
    closed = None  # since when port 22 is closed to the internet (None = open, or no firewall/Tailscale)
    if config.enabled("firewall") and config.enabled("tailscale"):
        try:
            closed = d.ssh_tailscale_since()
        except Exception:  # noqa: BLE001
            closed = None
    for ts, ip, user, method in d._journal_logins(since):
        try:
            c = d.geo(ip)
        except Exception:  # noqa: BLE001
            c = {"name": None}
        tail = c.get("name") in ("Tailnet", "internal")
        where = "from the tailnet" if c.get("name") == "Tailnet" else "from the local network" if tail \
            else f"from {c.get('name') or 'outside'}"
        suspicious = not tail and closed is not None and ts >= closed
        _bump(f"ssh:{ip}:{user}:{int(ts // 3600 * 3600)}", ts, 1, None, _ssh_make(user, ip, where, suspicious))
        last = max(last, ts)
    _meta_set("ssh_cursor", last)


# keepwatch-firewall logs one line per run, e.g. "firewall set on eth0: public TCP 22,80,443,
# SSH public on 22 (IPv4 + IPv6)" or "... public TCP 80,443, SSH closed (Tailscale only) ...".
FW = re.compile(r"\bpublic TCP ([\d,:]+|none)\b")
FW_SSH = re.compile(r"\bSSH (closed|public on [\d,]+)")
FALLBACK = re.compile(r"(?i)\b(re)?opened\b")


def scan_firewall(full: bool = False):
    """Port 22 open/closed from the journal of keepwatch-firewall (every change restarts the unit),
    plus automatic reopening by keepwatch-ssh-fallback (tailscale module)."""
    cursor = 0.0 if full else (_meta_get("fw_cursor") or time.time() - 86400)
    since = ["--since", f"@{int(cursor)}"] if cursor else []
    state = _meta_get("fw22")  # True = open
    last = cursor
    for e in _journal(["-u", f"{config.UNITS['firewall']}.service", *since]):
        if e["_t"] <= cursor:
            continue
        msg = e.get("MESSAGE") or ""
        m = FW.search(msg)
        last = max(last, e["_t"])
        if not m:
            continue
        ssh = FW_SSH.search(msg)
        open22 = ssh.group(1) != "closed" if ssh else "22" in m.group(1).split(",")
        if state is not None and open22 != state:
            add("security", "Port 22 open again - SSH reachable from the internet" if open22
                else "Port 22 closed - SSH only through Tailscale",
                detail=f"reachable from the internet: {m.group(1).replace(',', ', ')}", level="warn" if open22 else "info",
                t=e["_t"], source="port22", key=f"port22:{int(e['_t'])}", link=LINK_PORT22)
        state = open22
    if config.enabled("tailscale"):
        for e in _journal(["-t", config.UNITS["ssh-fallback"], *since]):
            msg = e.get("MESSAGE") or ""
            if e["_t"] > cursor and FALLBACK.search(msg):
                add("security", "Fallback: port 22 reopened automatically", detail=msg[:200], level="crit", t=e["_t"],
                    source="port22", key=f"fallback:{int(e['_t'])}", link=LINK_PORT22)
    if state is not None:
        _meta_set("fw22", state)
    _meta_set("fw_cursor", last)


# --------------------------------------------------------------------------- Actions in the dashboard

VERB = {"start": "started", "stop": "stopped", "restart": "restarted"}


def _stack_name(stack_id: str) -> str | None:
    try:
        for s in (D().COLLECTORS["stacks"].value or {}).get("stacks") or []:
            if str(s.get("id")) == str(stack_id):
                return s.get("name")
    except Exception:  # noqa: BLE001
        pass
    return None


def _host_domain(host_id: str) -> str:
    try:
        con = sqlite3.connect(f"file:{config.PROXY_DATA / 'database.sqlite'}?mode=ro", uri=True, timeout=5)
        row = con.execute("SELECT domain_names FROM proxy_host WHERE id=?", (int(host_id),)).fetchone()
        con.close()
        return (json.loads(row[0]) or [f"Host {host_id}"])[0] if row else f"Host {host_id}"
    except (sqlite3.Error, ValueError):
        return f"Host {host_id}"


def _safe(v, n: int = 80) -> str:
    """Only short, harmless values from a request (IP, jail, image) - never secrets."""
    s = str(v or "")
    return s[:n] if re.match(r"^[\w.:/@+\- ]*$", s) else ""


def _summary(method: str, path: str, body: dict, res) -> tuple[str, str | None, str | None, dict | None]:
    """(title, service, extra, link) - from the endpoint and an allow-list of fields."""
    b = body if isinstance(body, dict) else {}
    m = re.match(r"^/api/containers/([^/]+)/(start|stop|restart)$", path)
    if m:
        svc = service_of_container(m.group(1))
        return f"Container {m.group(1)} {VERB[m.group(2)]}", svc, None, service_link(svc, m.group(1)) if svc else LINK_SERVICES
    m = re.match(r"^/api/stacks/(\d+)/(redeploy|env)$", path)
    if m:
        name = _stack_name(m.group(1)) or f"Stack {m.group(1)}"
        if m.group(2) == "redeploy":
            return f"Redeploy {service_title_of(name)}" + (" (pull new image)" if b.get("pullImage") else ""), name, None, None
        n = len(b.get("env") or []) if isinstance(b.get("env"), list) else None
        return f"Environment variables of {service_title_of(name)} changed", name, (f"{n} variables" if n is not None else None), None
    m = re.match(r"^/api/access/(\d+)$", path)
    if m:
        dom = _host_domain(m.group(1))
        mode = b.get("mode")
        return (f"IP allow-list of {dom} changed" if mode != "open" else f"IP allow-list of {dom} removed (open to all)"), \
            None, None, _site_link(dom)
    m = re.match(r"^/api/access/(\d+)/paths$", path)
    if m:
        dom = _host_domain(m.group(1))
        raw = b.get("paths")
        paths = [x for x in (_safe(v, 60) for v in raw) if x] if isinstance(raw, list) else []
        return (f"Admin paths limited to the allow-list: {dom}" if paths else f"Admin paths open again: {dom}"), None, \
            (", ".join(paths[:4]) or None), _site_link(dom)
    m = re.match(r"^/api/sites/(\d+)/renew$", path)
    if m:
        dom = _host_domain(m.group(1))
        return f"Renew certificate: {dom}", None, None, _site_link(dom)
    if path == "/api/security/unban":
        ip, jail = _safe(b.get("ip"), 45), _safe(b.get("jail"), 40)
        return f"Ban lifted: {ip or 'address'}", None, JAILS.get(jail, jail) or None, LINK_F2B
    if path == "/api/settings/ssh":
        pub = b.get("public")
        return ("Open port 22 (SSH from the internet)" if pub else "Close port 22 (SSH only through Tailscale)"), None, None, LINK_PORT22
    if path in ("/api/updates/apply", "/api/updates/rollback"):
        k = _safe(b.get("key"), 120)
        svc = None
        try:
            names = sys.modules["updates"]._item(k).get("containers") or []
            svc = service_of_container(names[0]) if names else None
        except Exception:  # noqa: BLE001
            pass
        return (f"Update started: {k}" if path.endswith("apply") else f"Rollback started: {k}"), svc, None, \
            service_link(svc) if svc else LINK_SERVICES
    if path == "/api/cleanup" and isinstance(res, dict) and isinstance(res.get("message"), str):
        return "Cleaned up", None, _safe(res["message"].rstrip("."), 60) or None, LINK_SERVICES
    if path == "/api/hosts" and method == "POST":
        dom = _safe(b.get("domain"), 100)
        return f"New site created{': ' + dom if dom else ''}", None, None, LINK_SERVICES
    if path == "/api/settings/remote" and method == "PUT":
        # the repository type only (s3, b2, sftp, rest, rclone, ...) - never the URL or credentials
        scheme = _safe(str(b.get("repo") or "").split(":", 1)[0], 12) if ":" in str(b.get("repo") or "") else ""
        return "Remote backup configured", None, (scheme or None), _setting("backup-remote")
    fixed = {
        ("POST", "/api/backups/run"): ("Backup started manually", LINK_BACKUP),
        ("POST", "/api/backups/probe"): ("Backup check started", LINK_BACKUP),
        ("POST", "/api/sites/renew-due"): ("Renew due certificates", LINK_SERVICES),
        ("PUT", "/api/settings/backup"): ("Backup schedule & retention changed", _setting("backup-schedule")),
        ("POST", "/api/settings/backup/password"): ("Backup password revealed", _setting("backup-password")),
        ("DELETE", "/api/settings/remote"): ("Remote backup removed", _setting("backup-remote")),
        ("POST", "/api/settings/remote/test"): ("Remote backup tested", _setting("backup-remote")),
        ("PUT", "/api/settings/portainer"): ("Portainer token changed", _setting("portainer")),
        ("PUT", "/api/settings/fail2ban"): ("fail2ban settings changed", _setting("fail2ban")),
        ("PUT", "/api/settings/updates"): ("Automatic updates configured", _setting("updates")),
        ("POST", "/api/settings/ssh/confirm"): ("Port 22 closed - confirmed", LINK_PORT22),
        ("POST", "/api/settings/tailscale/login"): ("Tailscale login started", LINK_PORT22),
        ("PUT", "/api/settings/npm"): ("Proxy Manager login changed", _setting("proxy")),
        ("DELETE", "/api/settings/npm"): ("Proxy Manager login removed", _setting("proxy")),
        ("POST", "/api/settings/npm/test"): ("Proxy Manager login tested", _setting("proxy")),
        ("PUT", "/api/logarchive/settings"): ("Log archive settings changed", _setting("log-archive")),
        ("POST", "/api/updates/check"): ("Checked for updates", LINK_SERVICES),
        ("POST", "/api/updates/scan"): ("Image security scan started", LINK_SERVICES),
        ("POST", "/api/lynis/run"): ("Hardening audit started", {"view": "security"}),
        ("POST", "/api/self-update/check"): ("Checked for a Keepwatch update", _setting("self-update")),
        ("POST", "/api/self-update/apply"): ("Keepwatch update started", _setting("self-update")),
        ("PUT", "/api/self-update/settings"): ("Automatic Keepwatch update check changed", _setting("self-update")),
        ("POST", "/api/touchid/register/start"): ("Passkey: device setup started", _setting("passkey")),
        ("POST", "/api/touchid/register/finish"): ("Passkey: device added", _setting("passkey")),
        ("POST", "/api/touchid/pair"): ("Passkey: pairing code created", _setting("passkey")),
    }
    if method == "DELETE" and path.startswith("/api/touchid/devices/"):
        return "Passkey: device removed", None, None, _setting("passkey")
    if (method, path) in fixed:
        title, link = fixed[(method, path)]
        return title, None, None, link or {"view": "settings"}
    area = path.split("/")[2] if path.count("/") >= 2 else ""
    view = {"settings": "settings", "backups": "backups", "security": "security"}.get(area, "services")
    return f"Action {method} {path[:80]}", None, None, {"view": view}


def audit(method: str, path: str, ok: bool, error: str | None = None, body=None, res=None):
    """Hook in the handler: every write request. Never store the request content."""
    if method in ("GET", "HEAD") or not path.startswith("/api/") or _CONN is None and not STATE["started"]:
        return
    try:
        title, svc, extra, link = _summary(method, path, body or {}, res if ok else None)
        facets = [f"{method} {path}"]
        if extra:
            facets.insert(0, extra)
        if not ok and error:
            facets.insert(0, f"failed: {str(error)[:160]}")
        add("dashboard", title if ok else f"{title} - failed", detail=" · ".join(facets),
            level="info" if ok else "warn", service=svc, source="audit", link=link,
            meta={"method": method, "path": path, "ok": ok}, weight=WEIGHT["audit"] if ok else 30)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def audit_request(handler, status: int, data):
    """The single hook in the handler (Handler._json): every response to a write request.
    The request content is never stored - _summary reads only an allow-list of harmless fields."""
    body = handler.__dict__.pop("_req_body", None)  # never carry it into the next request
    try:
        method = getattr(handler, "command", "GET")
        if method in ("GET", "HEAD"):
            return
        from urllib.parse import urlsplit
        path = urlsplit(handler.path).path
        ok = status < 400
        err = data.get("error") if isinstance(data, dict) and not ok else None
        audit(method, path, ok, err, body, data if ok else None)
    except Exception:  # noqa: BLE001 - the timeline must never break a response
        traceback.print_exc()


# --------------------------------------------------------------------------- Reading (API)

def _row(r) -> dict:
    return {"id": r["id"], "t": r["t"], "tEnd": r["t_end"], "kind": r["kind"], "title": r["title"], "detail": r["detail"],
            "level": r["level"], "service": r["service"], "serviceTitle": r["service_title"], "source": r["source"],
            "count": r["count"], "backfill": bool(r["backfill"]), "link": json.loads(r["link"]) if r["link"] else None}


def _q1(query: dict, k: str, default=None):
    v = query.get(k)
    return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else default)


def list_events(query: dict) -> dict:
    now = time.time()
    try:
        frm = float(_q1(query, "from") or now - 7 * 86400)
        to = float(_q1(query, "to") or now + 60)
        before = _q1(query, "before")
        before = float(before) if before else None
        limit = max(1, min(1000, int(_q1(query, "limit") or 300)))
    except ValueError:
        raise D().ApiError(400, "from, to, before and limit must be numbers.")
    kinds = [k for k in (_q1(query, "kind") or "").split(",") if k in KINDS]
    service = _q1(query, "service")
    problems = _q1(query, "problems") in ("1", "true", "yes")
    text = (_q1(query, "q") or "").strip()
    where, args = ["t >= ?", "t <= ?", "source != 'merged'"], [frm, to]
    if before is not None:
        where.append("t < ?")
        args.append(before)
    base_where, base_args = list(where), list(args)
    if kinds:
        where.append(f"kind IN ({','.join('?' * len(kinds))})")
        args += kinds
    if service:
        where.append("service = ?")
        args.append(service)
    if problems:
        where.append("level IN ('warn','crit')")
    if text:
        where.append("(title LIKE ? OR detail LIKE ?)")
        args += [f"%{text}%", f"%{text}%"]
    with _LOCK:
        rows = _db().execute(f"SELECT * FROM events WHERE {' AND '.join(where)} ORDER BY t DESC, id DESC LIMIT ?",
                             (*args, limit + 1)).fetchall()
        svc = _db().execute(f"SELECT service, MAX(service_title) title, COUNT(*) n FROM events WHERE {' AND '.join(base_where)}"
                            " AND service IS NOT NULL GROUP BY service ORDER BY title", base_args).fetchall()
        counts = _db().execute(f"SELECT kind, COUNT(*) n, SUM(level IN ('warn','crit')) p FROM events WHERE {' AND '.join(base_where)}"
                               " GROUP BY kind", base_args).fetchall()
        oldest = _db().execute("SELECT MIN(t) m FROM events WHERE source != 'merged'").fetchone()["m"]
    return {
        "events": [_row(r) for r in rows[:limit]], "more": len(rows) > limit,
        "services": [{"id": s["service"], "title": s["title"] or s["service"], "count": s["n"]} for s in svc],
        "counts": {c["kind"]: {"total": c["n"], "problems": c["p"] or 0} for c in counts},
        "range": {"from": frm, "to": to}, "oldest": oldest, "keepDays": KEEP_DAYS,
        "backfilledAt": _meta_get("backfilled_at"), "backfilling": STATE["backfilling"],
    }


def _score(r) -> float:
    return {"crit": 1000, "warn": 500}.get(r["level"], 0) + r["weight"] + min(r["count"], 50) / 10


def recent(query: dict | None = None) -> dict:
    """The eight most important events since yesterday 00:00 (KW_LOCAL_TZ) for the overview."""
    tz = config.local_tz()
    today = dt.datetime.now(tz).date()
    since = dt.datetime.combine(today - dt.timedelta(days=1), dt.time(0, 0), tzinfo=tz).timestamp()
    n = 8
    try:
        n = max(1, min(20, int(_q1(query or {}, "n") or 8)))
    except ValueError:
        pass
    with _LOCK:
        rows = _db().execute("SELECT * FROM events WHERE t >= ? AND source != 'merged' ORDER BY t DESC", (since,)).fetchall()
    top = sorted(rows, key=lambda r: (-_score(r), -r["t"]))[:n]
    top.sort(key=lambda r: -r["t"])
    return {"since": since, "events": [_row(r) for r in top], "total": len(rows),
            "problems": sum(1 for r in rows if r["level"] in ("warn", "crit")), "backfilling": STATE["backfilling"]}


def route(method: str, path: str, query: dict):
    if method == "GET" and path == "/api/timeline":
        return list_events(query)
    if method == "GET" and path == "/api/timeline/recent":
        return recent(query)
    raise D().ApiError(404, "Unknown endpoint.")


# --------------------------------------------------------------------------- Schedule

SCANNERS = [  # (name, function, every n seconds, module it needs or None)
    ("deploy", scan_deploys, 30, None), ("backup", scan_backups, 60, "backup"), ("portainer", scan_portainer, 120, "portainer"),
    ("f2b", scan_f2b, 60, "fail2ban"), ("ssh", scan_ssh, 120, None), ("firewall", scan_firewall, 120, "firewall"),
    ("apt", scan_apt, 300, None), ("boot", scan_boots, 300, None), ("cert", scan_certs, 600, "proxy"),
]


def backfill():
    """Once: fill in whatever the sources still have (backfill=1)."""
    STATE["backfilling"] = True
    _TL.backfill = True
    started = time.time()
    try:
        for name, fn, module in [("apt", scan_apt, None), ("boot", scan_boots, None), ("cert", scan_certs, "proxy"),
                                 ("backup", scan_backups, "backup"), ("docker", lambda full: backfill_docker(), "docker"),
                                 ("portainer", scan_portainer, "portainer"), ("deploy", scan_deploys, None),
                                 ("firewall", scan_firewall, "firewall"), ("f2b", scan_f2b, "fail2ban"), ("ssh", scan_ssh, None)]:
            if module and not config.enabled(module):
                continue
            try:
                fn(full=True)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        _meta_set("backfilled_at", started)
    finally:
        _TL.backfill = False
        STATE["backfilling"] = False


def loop():
    STATE["started"] = True
    _db()
    time.sleep(15)  # let the dashboard collectors (stacks, backups) run once first
    threading.Thread(target=_docker_reader, daemon=True, name="timeline-docker").start()
    threading.Thread(target=_docker_flush_loop, daemon=True, name="timeline-docker-flush").start()
    if _meta_get("backfilled_at") is None:
        backfill()
    elif config.enabled("docker") and _boot_time() and not exists(f"docker:boot:{int(_boot_time())}"):
        try:
            backfill_docker(boot_only=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    due = {name: 0.0 for name, _, _, _ in SCANNERS}
    last_prune = 0.0
    while True:
        now = time.time()
        for name, fn, every, module in SCANNERS:
            if module and not config.enabled(module):
                STATE["sources"].pop(name, None)
                continue
            if now >= due[name]:
                due[name] = now + every
                try:
                    fn(full=False)
                    STATE["sources"][name] = {"ok": True, "at": now}
                except Exception:  # noqa: BLE001
                    STATE["sources"][name] = {"ok": False, "at": now}
                    traceback.print_exc()
        if now - last_prune > 86400:
            last_prune = now
            try:
                prune()
            except sqlite3.Error:
                traceback.print_exc()
        time.sleep(20)
