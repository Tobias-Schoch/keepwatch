"""Log archive (module "log-archive"). Reads what keepwatch-log-archive writes:

    /var/log/keepwatch/containers/<stack>/<container>/YYYY-MM-DD.log[.gz]   (days in UTC)
    /var/lib/keepwatch/log-archive/status.json                              (sizes, limits, notes)
    /etc/keepwatch/log-archive.conf                                         (DAYS, MAX_MB_PER_CONTAINER, MAX_MB_TOTAL)

Wired into dashboard.py (one route line, one health line):

    GET /api/logarchive                       overview: containers in the archive (also removed ones), sizes, settings
    GET /api/logarchive/lines?c=<name>[@cursor]&c=...&window=604800&level=all|problems&q=&limit=1000[&download=1]
    PUT /api/logarchive/settings              {"days": 14, "maxPerContainerMb": 300, "maxTotalMb": 2000}

/lines answers like GET /api/logs (logs.py) - same fields, same cursor - so the live logs
for 7 and 14 days simply ask here. On top come separator lines (`sep`) where a container
was created, restarted, exited or removed, and `gone`: containers that no longer exist.
A container does not have to exist any more to be read here.

Limits as in logs.py: lines per container (limit), per response, raw bytes read and time
per request, at most two requests at once. Standard library only, read-only (except
PUT /settings, which writes the configuration file).
"""
from __future__ import annotations

import calendar
import collections
import gzip
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

import config

ROOT = config.LOG_ARCHIVE_DIR
STATUS = config.LOG_ARCHIVE_STATUS
CONF = config.LOG_ARCHIVE_CONF

DEFAULTS = {"DAYS": 14, "MAX_MB_PER_CONTAINER": 300, "MAX_MB_TOTAL": 2000}
SETTINGS = {"days": ("DAYS", 1, 90), "maxPerContainerMb": ("MAX_MB_PER_CONTAINER", 10, 50_000),
            "maxTotalMb": ("MAX_MB_TOTAL", 50, 200_000)}

MAX_CONTAINERS = 16
LIMIT_DEFAULT, LIMIT_MAX, LIMIT_DOWNLOAD = 1000, 2000, 50_000
MAX_LINES_TOTAL, MAX_LINES_DOWNLOAD = 5000, 200_000
MAX_BYTES = 400 * 1024 * 1024   # read uncompressed per request
DEADLINE = 15.0
WINDOW_MIN, WINDOW_MAX = 60, 90 * 86400
STALE = 300                      # status.json older: the service is not running
MERGE = 120 * 1_000_000_000      # "exited"/"removed" this close to "created" = one switch, one line
SLOTS = threading.BoundedSemaphore(2)

NAME = re.compile(r"^(?:[A-Za-z0-9_.-]{1,64}/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CURSOR = re.compile(r"^(\d{1,12})(?:\.(\d{1,9}))?$")
STAMP = re.compile(rb"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?Z$")
DAYFILE = re.compile(r"^(\d{4}-\d\d-\d\d)\.log(\.gz)?$")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]")
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

SEP_TEXT = {"created": "recreated", "restarted": "restarted", "exited": "container exited",
            "removed": "container removed", "limit": "archive"}


class _Err(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _api_error():
    d = sys.modules.get("dashboard")
    return getattr(d, "ApiError", _Err)


# --------------------------------------------------------------------------- Level (from logs.py, if present)

def _classifier():
    try:
        import logs  # live logs: same heuristic for "errors & warnings"
        return logs.classify, logs.clean
    except Exception:  # noqa: BLE001
        err = re.compile(r"\b(error|exception|traceback|fatal|panic|failed)\b", re.I)
        warn = re.compile(r"\b(warn|warning|deprecated|timeout)\b", re.I)

        def classify(text, prev):
            return "error" if err.search(text) else "warn" if warn.search(text) else None

        def clean(text):
            text = CTRL.sub("", ANSI.sub("", text.replace("\t", "    ")))
            return text if len(text) <= 4000 else text[:4000] + " …"
        return classify, clean


# --------------------------------------------------------------------------- Time

_SEC: dict[bytes, int] = {}


def _ns(raw: bytes) -> int | None:
    m = STAMP.match(raw)
    if not m:
        return None
    sec = _SEC.get(raw[:19])
    if sec is None:
        sec = calendar.timegm(tuple(int(x) for x in m.groups()[:6]) + (0, 0, 0))
        if len(_SEC) > 8192:
            _SEC.clear()
        _SEC[raw[:19]] = sec
    return sec * 1_000_000_000 + int((m.group(7) or b"").ljust(9, b"0"))


def _day(ns: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ns // 1_000_000_000))


def _fmt_cursor(ns: int) -> str:
    return f"{ns // 1_000_000_000}.{ns % 1_000_000_000:09d}"


def _parse_cursor(s: str) -> int | None:
    m = CURSOR.match(s)
    return int(m.group(1)) * 1_000_000_000 + int((m.group(2) or "").ljust(9, "0")) if m else None


# --------------------------------------------------------------------------- Archive directory

def _keys() -> dict[str, list[str]]:
    """Container name -> keys "stack/name" (a name may have been in two stacks)."""
    out: dict[str, list[str]] = {}
    try:
        for stack in sorted(ROOT.iterdir()):
            if stack.is_dir():
                for cont in sorted(stack.iterdir()):
                    if cont.is_dir():
                        out.setdefault(cont.name, []).append(f"{stack.name}/{cont.name}")
    except OSError:
        pass
    return out


def _days(key: str) -> list[tuple[str, Path]]:
    out = []
    try:
        for p in (ROOT / key).iterdir():
            m = DAYFILE.match(p.name)
            if m:
                out.append((m.group(1), p))
    except OSError:
        pass
    return sorted(out, key=lambda x: (x[0], x[1].suffix == ".log"))  # .gz before .log on the same day


def _status() -> dict | None:
    try:
        return json.loads(STATUS.read_text())
    except (OSError, ValueError):
        return None


def _conf() -> dict:
    conf = dict(DEFAULTS)
    try:
        for line in CONF.read_text().splitlines():
            k, sep, v = line.partition("=")
            k, v = k.strip(), v.split("#", 1)[0].strip().strip('"')
            if sep and k in conf:
                try:
                    conf[k] = int(v)
                except ValueError:
                    pass
    except OSError:
        pass
    return conf


def _existing() -> set[str] | None:
    """Names of the containers that exist right now (from the dashboard's docker collector)."""
    d = sys.modules.get("dashboard")
    try:
        return {c["name"] for c in d.COLLECTORS["docker"].get()["containers"]}
    except Exception:  # noqa: BLE001
        return None


def _running(st: dict | None) -> bool:
    return bool(st and time.time() - float(st.get("at") or 0) < STALE)


# --------------------------------------------------------------------------- Reading

class _Budget:
    def __init__(self):
        self.bytes = 0
        self.deadline = time.monotonic() + DEADLINE
        self.hit: str | None = None

    def spend(self, n: int) -> bool:
        self.bytes += n
        if self.bytes > MAX_BYTES:
            self.hit = "Too much at once - showing what was read until then. Pick a shorter range or a narrower search."
        elif time.monotonic() > self.deadline:
            self.hit = "The archive took too long - showing what was read until then."
        return self.hit is None


def _raw_lines(p: Path, since_ns: int, budget: _Budget):
    """Lines of one day file. Today (uncompressed) with a cursor: read only the end."""
    if p.suffix == ".gz":
        try:
            with gzip.open(p, "rb") as f:
                for raw in f:
                    if not budget.spend(len(raw)):
                        return
                    yield raw
        except (OSError, EOFError):  # just compressed/deleted or half written
            return
        return
    try:
        with open(p, "rb") as f:
            size = f.seek(0, 2)
            start = 0
            if since_ns:
                # from the end: 1 MB back is almost always enough; otherwise further back
                step = 1 << 20
                start = max(0, size - step)
                while start > 0:
                    f.seek(start)
                    f.readline()
                    first = f.readline()
                    ns = _ns(first.partition(b" ")[0])
                    if ns is None or ns < since_ns:
                        break
                    start = max(0, start - step * 4)
            f.seek(start)
            if start:
                f.readline()  # partial line
            for raw in f:
                if not budget.spend(len(raw)):
                    return
                yield raw
    except OSError:
        return


def _parse(raw: bytes):
    stamp, _, rest = raw.rstrip(b"\n").partition(b" ")
    kind, _, text = rest.partition(b" ")
    ns = _ns(stamp)
    if ns is None or kind not in (b"out", b"err", b"meta"):
        return None
    return ns, kind.decode(), text.decode("utf-8", "replace")


def _sep_line(ns: int, name: str, text: str) -> dict | None:
    try:
        m = json.loads(text)
    except ValueError:
        return None
    ev = m.get("event") or "created"
    reason = m.get("reason") or ""
    label = SEP_TEXT.get(ev, ev)
    return {"t": ns / 1e9, "c": name, "stream": "stdout", "level": None, "sep": ev, "_ns": ns,
            "text": f"{label} · {reason}" if reason and ev != "limit" else (reason or label),
            "id": m.get("id"), "image": m.get("image")}


def _merge_seps(seps: list[dict]) -> list[dict]:
    """"exited (code 0)" and "removed" around a "created" are the same switch."""
    created = [s["_ns"] for s in seps if s["sep"] == "created"]
    out = []
    for s in seps:
        if s["sep"] in ("exited", "removed") and any(abs(s["_ns"] - n) < MERGE for n in created):
            continue
        out.append(s)
    return out


def _read_container(name: str, keys: list[str], floor_ns: int, since_ns: int, limit: int, problems: bool,
                    needle: str, budget: _Budget, classify, clean) -> dict:
    """Lines of one container (all its keys) in the window; the newest `limit` matches."""
    from_ns = max(floor_ns, since_ns)
    first_day = _day(from_ns)
    files = sorted(((d, p) for k in keys for d, p in _days(k) if d >= first_day), key=lambda x: x[0])
    keep: collections.deque = collections.deque(maxlen=limit)
    seps: list[dict] = []
    matched = 0
    last_ns = 0
    filtered = problems or bool(needle)

    def take(day_files: list[tuple[str, Path]], out):
        nonlocal matched, last_ns
        prev = {"out": None, "err": None}
        for _, p in day_files:
            for raw in _raw_lines(p, since_ns if p.suffix == ".log" else 0, budget):
                rec = _parse(raw)
                if not rec:
                    continue
                ns, kind, text = rec
                if ns < from_ns:
                    continue
                if ns > last_ns:
                    last_ns = ns
                if kind == "meta":
                    s = _sep_line(ns, name, text)
                    if s:
                        seps.append(s)
                    continue
                text = clean(text)
                level = classify(text, prev[kind])
                prev[kind] = level
                if problems and level is None:
                    continue
                if needle and needle not in text.lower():
                    continue
                matched += 1
                out.append((ns, kind, text, level))
            if budget.hit:
                return

    if filtered or since_ns:
        take(files, keep)
    else:
        # Without a filter the newest days suffice: from the end until `limit` lines are together.
        by_day: dict[str, list] = collections.OrderedDict()
        for d, p in files:
            by_day.setdefault(d, []).append((d, p))
        chunks: list[list] = []
        have = 0
        for d in reversed(by_day):
            part: list = []
            take(by_day[d], part)
            chunks.append(part)
            have += len(part)
            if have >= limit or budget.hit:
                if d != next(iter(by_day)):
                    matched += 1  # older days not read -> there is more
                break
        for part in reversed(chunks):
            keep.extend(part)

    lines = list(keep)
    oldest = lines[0][0] if lines and (matched > len(lines)) else from_ns
    seps = _merge_seps(sorted(seps, key=lambda s: s["_ns"]))
    seps = [s for s in seps if s["_ns"] >= oldest]
    if len(seps) > limit:
        seps = seps[-limit:]
    return {"lines": lines, "seps": seps, "truncated": matched > len(lines), "last_ns": last_ns}


def read_lines(query: dict) -> dict:
    E = _api_error()
    targets = query.get("c", [])
    if not targets:
        raise E(400, "Which containers? Parameter c=<name> is missing.")
    if len(targets) > MAX_CONTAINERS:
        raise E(400, f"At most {MAX_CONTAINERS} containers at once.")
    download = query.get("download", ["0"])[0] == "1"
    window = _int(query, "window", 7 * 86400, WINDOW_MIN, WINDOW_MAX)
    limit = _int(query, "limit", LIMIT_DEFAULT, 1, LIMIT_DOWNLOAD if download else LIMIT_MAX)
    problems = query.get("level", ["all"])[0] == "problems"
    needle = (query.get("q", [""])[0] or "").strip().lower()[:200]
    now_ns = time.time_ns()
    floor_ns = now_ns - window * 1_000_000_000
    classify, clean = _classifier()
    index = _keys()
    existing = _existing()

    if not SLOTS.acquire(timeout=4):
        raise E(503, "Several archive requests are already running - try again in a moment.")
    budget = _Budget()
    out: list[dict] = []
    cursor: dict[str, str] = {}
    truncated: list[str] = []
    errors: dict[str, str] = {}
    gone: list[str] = []
    try:
        seen = set()
        for item in targets:
            name, _, cur = item.partition("@")
            if not NAME.match(name):
                raise E(400, "Invalid container name.")
            if name in seen:
                continue
            seen.add(name)
            keys = [name] if "/" in name else index.get(name, [])
            base = name.rsplit("/", 1)[-1]
            if existing is not None and base not in existing:
                gone.append(name)
            since = _parse_cursor(cur) if cur else None
            since_ns = max(since, floor_ns) if since is not None else 0
            if not keys or not any(_days(k) for k in keys):
                errors[name] = ("The archive has nothing for this container."
                                if _running(_status()) else "The log archive is not running (yet) - see Settings -> Log archive.")
                cursor[name] = _fmt_cursor(max(since_ns, now_ns - 5_000_000_000))
                continue
            r = _read_container(name, keys, floor_ns, since_ns, limit, problems, needle, budget, classify, clean)
            for ns, kind, text, level in r["lines"]:
                out.append({"t": ns / 1e9, "c": name, "stream": "stderr" if kind == "err" else "stdout",
                            "text": text, "level": level, "_ns": ns})
            for s in r["seps"]:
                if since_ns and s["_ns"] < since_ns:
                    continue
                out.append(s)
            # Nothing new: cursor to just before now (the archive writes with ~1 s delay).
            cursor[name] = _fmt_cursor(r["last_ns"] + 1 if r["last_ns"] else max(since_ns or floor_ns, now_ns - 5_000_000_000))
            if r["truncated"] and not since_ns:
                truncated.append(name)
            if budget.hit:
                errors[name] = budget.hit
                break
    finally:
        SLOTS.release()

    out.sort(key=lambda x: x["_ns"])
    cap = MAX_LINES_DOWNLOAD if download else MAX_LINES_TOTAL
    dropped = max(0, len(out) - cap)
    if dropped:
        out = out[dropped:]
    for o in out:
        o.pop("_ns", None)
    st = _status()
    return {"now": now_ns / 1e9, "since": floor_ns / 1e9, "lines": out, "cursor": cursor,
            "truncated": truncated, "dropped": dropped, "errors": errors,
            "archive": True, "gone": gone, "running": _running(st), "retentionDays": (st or {}).get("days") or _conf()["DAYS"]}


# --------------------------------------------------------------------------- Overview and settings

def overview() -> dict:
    st = _status()
    conf = _conf()
    existing = _existing()
    by_key = (st or {}).get("containers") or {}
    conts = []
    total = 0
    for name, keys in sorted(_keys().items()):
        for key in keys:
            days = _days(key)
            if not days:
                continue
            size = 0
            newest = 0.0
            for _, p in days:
                try:
                    s = p.stat()
                    size += s.st_size
                    newest = max(newest, s.st_mtime)
                except OSError:
                    pass
            total += size
            info = by_key.get(key) or {}
            conts.append({
                "key": key, "name": name, "stack": key.split("/", 1)[0],
                "exists": None if existing is None else name in existing,
                "bytes": size, "days": len({d for d, _ in days}), "from": days[0][0], "to": days[-1][0],
                "lastWrite": newest or None, "dropped": info.get("dropped") or 0, "trimmed": info.get("trimmed"),
                "image": info.get("image"),
            })
    notes = list((st or {}).get("notes") or [])
    running = _running(st)
    return {
        "installed": st is not None or ROOT.is_dir(),
        "running": running,
        "statusAt": (st or {}).get("at"),
        "since": (st or {}).get("since"),
        "dir": str(ROOT),
        "settings": {"days": conf["DAYS"], "maxPerContainerMb": conf["MAX_MB_PER_CONTAINER"], "maxTotalMb": conf["MAX_MB_TOTAL"]},
        "bytes": total,
        "containers": conts,
        "skipped": (st or {}).get("unarchived") or {},
        "notes": notes,
    }


def put_settings(body: dict) -> dict:
    E = _api_error()
    conf = _conf()
    for field, (key, lo, hi) in SETTINGS.items():
        if field in body:
            try:
                v = int(body[field])
            except (TypeError, ValueError):
                raise E(400, f"{field}: a whole number is expected.")
            if not lo <= v <= hi:
                raise E(400, f"{field}: allowed is {lo} to {hi}.")
            conf[key] = v
    if conf["MAX_MB_TOTAL"] < conf["MAX_MB_PER_CONTAINER"]:
        raise E(400, "The total limit must be at least as large as the limit per container.")
    text = ("# Keepwatch container log archive (keepwatch-log-archive). Changed in the dashboard\n"
            "# (Settings -> Log archive); the service re-reads this file every minute.\n"
            f"DAYS={conf['DAYS']}\nMAX_MB_PER_CONTAINER={conf['MAX_MB_PER_CONTAINER']}\nMAX_MB_TOTAL={conf['MAX_MB_TOTAL']}\n")
    tmp = CONF.with_name(CONF.name + ".tmp")
    tmp.write_text(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, CONF)
    return overview()


def problems() -> list[dict]:
    """For health: archive service stopped, limits reached. Nothing while the module is off."""
    if not config.enabled("log-archive"):
        return []
    st = _status()
    if st is None:
        return []
    unit = config.UNITS["log-archive"]
    out = []
    if not _running(st):
        out.append({"level": "warn", "area": "docker", "title": "Log archive stopped", "key": "logarchive.stopped",
                    "detail": f"{unit} no longer writes - logs are lost when a container is recreated. "
                              f"systemctl status {unit}"})
    for n in (st.get("notes") or [])[:3]:
        out.append({"level": "warn", "area": "docker", "title": "Log archive at its limit", "detail": n,
                    "key": "logarchive.limit", "target": "settings/log-archive"})
    return out


def _int(query: dict, key: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(float(query.get(key, [default])[0]))))
    except (TypeError, ValueError):
        return default


def route(method: str, path: str, query: dict, body: dict):
    E = _api_error()
    if not config.enabled("log-archive"):
        d = sys.modules.get("dashboard")
        if d and hasattr(d, "module_off"):
            raise d.module_off("log-archive")
        raise E(404, "The Log archive module is not enabled (KW_MODULES in keepwatch.conf).")
    if method == "GET" and path == "/api/logarchive":
        return overview()
    if method == "GET" and path == "/api/logarchive/lines":
        return read_lines(query)
    if method == "PUT" and path == "/api/logarchive/settings":
        return put_settings(body)
    raise E(404, "No such endpoint.")
