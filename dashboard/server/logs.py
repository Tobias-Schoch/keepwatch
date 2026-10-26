"""Live logs for the dashboard: one or more containers interleaved, live via cursor.

Wired into dashboard.py (needs the docker module):

    GET /api/logs?c=<name>[@<cursor>]&c=...&window=3600&level=all|problems&limit=1000

"Live" is plain polling (the UI asks every 2 s, only while the window is open,
visible and not paused). Every response carries a cursor per container
(timestamp of the last line read + 1 ns); the next request sends it back as
`c=name@cursor` and only gets what is new. No server-sent events:
ThreadingHTTPServer would keep a thread and a `docker logs -f` open per window.

Limits (a request must never block the server):
- `docker logs` always with `--tail` (the json-file driver then reads from the
  end instead of scanning the whole file from `--since`); FOLLOW_TAIL when following,
- at most LIMIT_MAX lines per container and MAX_LINES_TOTAL per response,
- at most MAX_BYTES read raw per container, MAX_TEXT characters per line,
- DEADLINE seconds per request, then the docker processes are killed,
- at most SLOTS concurrent requests in the whole dashboard (otherwise 503, the
  UI simply tries again on the next tick).

Standard library only, read-only.
"""

from __future__ import annotations

import collections
import os
import re
import selectors
import subprocess
import threading
import time

import config

MAX_CONTAINERS = 16
LIMIT_DEFAULT = 1000
LIMIT_MAX = 2000
SCAN_PROBLEMS = 10000          # lines per container that "errors & warnings" scans on first load
FOLLOW_TAIL = 500              # following with a cursor: more new lines in 2 s count as a gap
MAX_LINES_TOTAL = 5000         # lines per response across all containers (the newest stay)
MAX_TEXT = 4000                # characters per line
MAX_BYTES = 32 * 1024 * 1024   # read raw per container, then stop
DEADLINE = 12.0                # seconds per request
PARALLEL = 6                   # concurrent `docker logs` per request
WINDOW_DEFAULT = 3600
WINDOW_MIN, WINDOW_MAX = 60, 7 * 86400
SLOTS = threading.BoundedSemaphore(3)

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CURSOR = re.compile(r"^(\d{1,12})(?:\.(\d{1,9}))?$")
STAMP = re.compile(rb"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$")

# --------------------------------------------------------------------------- Level (heuristic)

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]")
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

# Explicit level: UPPERCASE as a word near the start ("ERROR:", "[INFO]", "INF", "LOG:"),
# lowercase only in brackets or as level=.../"level":"..." ("[error]" from nginx, JSON logs).
UPPER = re.compile(r"(?<![A-Za-z0-9_])(EMERG|ALERT|CRITICAL|CRIT|FATAL|PANIC|SEVERE|ERROR|EROR|ERR|WARNING|WARN|WRN"
                   r"|NOTICE|INFO|INF|DEBUG|DBG|TRACE|TRC|LOG|HINT|DETAIL|STATEMENT|CONTEXT)(?![A-Za-z0-9_])")
LOWER = re.compile(r"(?:\[|\blevel\"?\s*[=:]\s*\"?|\blvl=|\bseverity\"?\s*[=:]\s*\"?)"
                   r"(emerg|alert|critical|crit|fatal|panic|error|err|warning|warn|notice|info|debug|trace)\b", re.I)
TOKEN_LEVEL = {
    **dict.fromkeys(("emerg", "alert", "critical", "crit", "fatal", "panic", "severe", "error", "eror", "err"), "error"),
    **dict.fromkeys(("warning", "warn", "wrn"), "warn"),
    **dict.fromkeys(("hint", "detail", "statement", "context"), "inherit"),
}
CONTINUATION = re.compile(r"^\s+(at\s|File\s\"|\.\.\.\s*\d+\s+more|\^)|^(Caused by|During handling)")
TRACE_START = re.compile(r"^(Traceback \(most recent call last\)|\s*([A-Za-z_][\w.]*)?(Error|Exception)(:\s|$))")
HTTP_STATUS = re.compile(r"\bHTTP/[\d.]+\"?\s+(\d{3})\b")
NEGATED = re.compile(r"\b(?:0|no|zero|without)\s+(?:errors?|failures?|failed|warnings?)\b", re.I)
ERR_WORDS = re.compile(r"\b(errors?|exception|traceback|fatal|panic|unhandled|uncaught|segfault|segmentation fault"
                       r"|out of memory|oom|crash(?:ed)?|failed|failure)\b", re.I)
WARN_WORDS = re.compile(r"\b(warn|warning|deprecated|deprecation|timeout|timed out"
                        r"|retry|retrying|refused|denied|unauthori[sz]ed|forbidden|too many)\b", re.I)


def classify(text: str, prev: str | None) -> str | None:
    """'error' | 'warn' | None. `prev` = level of the previous line in the same stream (for stack traces)."""
    best = None
    m = LOWER.search(text, 0, 300)
    if m:
        best = (m.start(), m.group(1).lower())
    m = UPPER.search(text, 0, 80)
    if m and (best is None or m.start() < best[0]):
        best = (m.start(), m.group(1).lower())
    if best:
        lv = TOKEN_LEVEL.get(best[1])
        if lv == "inherit":
            return prev
        return lv
    if CONTINUATION.match(text):
        return prev if prev == "error" else None
    if TRACE_START.match(text):
        return "error"
    m = HTTP_STATUS.search(text)
    if m:
        code = int(m.group(1))
        return "error" if code >= 500 else "warn" if code == 429 else None
    rest = NEGATED.sub(" ", text)
    if ERR_WORDS.search(rest):
        return "error"
    if WARN_WORDS.search(rest):
        return "warn"
    return None


def clean(text: str) -> str:
    text = CTRL.sub("", ANSI.sub("", text.replace("\t", "    ")))
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + " …"


# --------------------------------------------------------------------------- Time

_EPOCH_CACHE: dict[bytes, int] = {}


def stamp_ns(raw: bytes) -> int | None:
    """RFC3339Nano from `docker logs --timestamps` -> nanoseconds since 1970."""
    m = STAMP.match(raw)
    if not m:
        return None
    key = raw[:19]
    sec = _EPOCH_CACHE.get(key)
    if sec is None:
        import calendar
        y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
        sec = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0))
        if len(_EPOCH_CACHE) > 4096:
            _EPOCH_CACHE.clear()
        _EPOCH_CACHE[key] = sec
    tz = m.group(8)
    if tz != b"Z":
        sign = 1 if tz[:1] == b"+" else -1
        sec -= sign * (int(tz[1:3]) * 3600 + int(tz[4:6]) * 60)
    frac = (m.group(7) or b"").ljust(9, b"0")
    return sec * 1_000_000_000 + int(frac)


def fmt_cursor(ns: int) -> str:
    return f"{ns // 1_000_000_000}.{ns % 1_000_000_000:09d}"


def parse_cursor(s: str) -> int | None:
    m = CURSOR.match(s)
    if not m:
        return None
    return int(m.group(1)) * 1_000_000_000 + int((m.group(2) or "").ljust(9, "0"))


# --------------------------------------------------------------------------- Reading

class _Reader:
    """One `docker logs` with both streams; split into lines, keeps the last `keep`."""

    def __init__(self, name: str, since_ns: int, tail: int, keep: int, problems: bool):
        self.name, self.since_ns, self.tail, self.problems = name, since_ns, tail, problems
        self.lines: collections.deque = collections.deque(maxlen=keep)
        self.buf = {"stdout": b"", "stderr": b""}
        self.prev = {"stdout": None, "stderr": None}
        self.read = 0
        self.scanned = 0
        self.last_ns: int | None = None
        self.cut = False
        self.slow = False
        self.junk: str | None = None
        self.proc = subprocess.Popen(
            ["docker", "logs", "--timestamps", "--since", fmt_cursor(since_ns), "--tail", str(tail), name],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
            env={**os.environ, "LC_ALL": "C.UTF-8"})

    def feed(self, stream: str, chunk: bytes):
        if self.cut:
            return
        self.read += len(chunk)
        if self.read > MAX_BYTES:
            self.cut = True
            self.kill()
            return
        data = self.buf[stream] + chunk
        *done, self.buf[stream] = data.split(b"\n")
        for raw in done:
            self._line(stream, raw)

    def flush(self, stream: str):
        rest, self.buf[stream] = self.buf[stream], b""
        if rest and not self.cut:
            self._line(stream, rest)

    def _line(self, stream: str, raw: bytes):
        stamp, _, body = raw.partition(b" ")
        ns = stamp_ns(stamp)
        if ns is None:
            # Without a timestamp it is a message from docker itself (e.g. "No such container").
            self.junk = clean(raw.decode("utf-8", "replace")).strip() or self.junk
            return
        self.scanned += 1
        if self.last_ns is None or ns > self.last_ns:
            self.last_ns = ns
        text = clean(body.rstrip(b"\r").decode("utf-8", "replace"))
        level = classify(text, self.prev[stream])
        self.prev[stream] = level
        if self.problems and level is None:
            return
        self.lines.append((ns, self.name, stream, text, level))

    def kill(self):
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass


def _run(readers: list[_Reader], deadline: float):
    sel = selectors.DefaultSelector()
    open_pipes = 0
    for r in readers:
        for stream, pipe in (("stdout", r.proc.stdout), ("stderr", r.proc.stderr)):
            sel.register(pipe, selectors.EVENT_READ, (r, stream))
            open_pipes += 1
    try:
        while open_pipes:
            left = deadline - time.monotonic()
            if left <= 0:
                for r in readers:
                    if r.proc.poll() is None:
                        r.slow = True
                        r.kill()
                break
            for key, _ in sel.select(timeout=min(left, 1.0)):
                r, stream = key.data
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
                    open_pipes -= 1
                    r.flush(stream)
                else:
                    r.feed(stream, chunk)
    finally:
        for key in list(sel.get_map().values()):
            sel.unregister(key.fileobj)
            key.fileobj.close()
        sel.close()
        for r in readers:
            try:
                r.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                r.kill()


def _int(query: dict, key: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(float(query.get(key, [default])[0]))))
    except (TypeError, ValueError):
        return default


def read_logs(query: dict, known_container, api_error):
    """GET /api/logs. `known_container(name)` checks the name (raises ApiError 400/404)."""
    if not config.enabled("docker"):
        raise api_error(404, "The Docker module is not enabled (KW_MODULES in keepwatch.conf).")
    targets = query.get("c", [])
    if not targets:
        raise api_error(400, "Which containers? Parameter c=<name> is missing.")
    if len(targets) > MAX_CONTAINERS:
        raise api_error(400, f"At most {MAX_CONTAINERS} containers at once.")
    window = _int(query, "window", WINDOW_DEFAULT, WINDOW_MIN, WINDOW_MAX)
    limit = _int(query, "limit", LIMIT_DEFAULT, 1, LIMIT_MAX)
    problems = query.get("level", ["all"])[0] == "problems"
    now_ns = time.time_ns()
    floor_ns = now_ns - window * 1_000_000_000

    errors: dict[str, str] = {}
    cursors_in: dict[str, int] = {}
    follow: set[str] = set()
    names: list[str] = []
    for item in targets:
        name, _, cur = item.partition("@")
        if not NAME.match(name):
            raise api_error(400, "Invalid container name.")
        if name in cursors_in or name in errors:
            continue
        try:
            known_container(name)
        except api_error as e:
            if getattr(e, "status", 0) != 404:
                raise
            errors[name] = e.message
            continue
        since = parse_cursor(cur) if cur else None
        # A cursor only counts within the window (an old cursor would otherwise load hours of logs).
        cursors_in[name] = max(since, floor_ns) if since is not None else floor_ns
        if since is not None:
            follow.add(name)
        names.append(name)

    if names and not SLOTS.acquire(timeout=4):
        raise api_error(503, "Several log requests are already running - try again in a moment.")
    readers: list[_Reader] = []
    try:
        deadline = time.monotonic() + DEADLINE
        for i in range(0, len(names), PARALLEL):
            group = []
            for name in names[i:i + PARALLEL]:
                try:
                    tail = FOLLOW_TAIL if name in follow else SCAN_PROBLEMS if problems else limit
                    group.append(_Reader(name, cursors_in[name], tail, limit, problems))
                except OSError as e:
                    errors[name] = f"docker failed to run: {e}"
            _run(group, deadline)
            readers += group
    finally:
        if names:
            SLOTS.release()

    lines: list[tuple] = []
    cursor: dict[str, str] = {}
    truncated: list[str] = []
    for r in readers:
        lines.extend(r.lines)
        if r.last_ns is not None:
            cursor[r.name] = fmt_cursor(r.last_ns + 1)
        else:
            # Nothing new: move the cursor to just before now (lines reach the file a few ms late).
            cursor[r.name] = fmt_cursor(max(r.since_ns, now_ns - 5_000_000_000))
        if r.cut or r.scanned >= r.tail or (problems and len(r.lines) >= limit):
            truncated.append(r.name)
        if r.slow:
            errors[r.name] = "Docker took too long - showing what arrived until then."
        elif r.proc.returncode not in (0, None, -9) and not r.scanned:
            errors[r.name] = r.junk or f"docker logs exited with code {r.proc.returncode}."
    lines.sort(key=lambda x: x[0])
    dropped = max(0, len(lines) - MAX_LINES_TOTAL)
    if dropped:
        lines = lines[dropped:]
    return {
        "now": now_ns / 1e9,
        "since": floor_ns / 1e9,
        "lines": [{"t": ns / 1e9, "c": c, "stream": s, "text": text, "level": lv} for ns, c, s, text, lv in lines],
        "cursor": cursor,
        "truncated": truncated,
        "dropped": dropped,
        "errors": errors,
    }
