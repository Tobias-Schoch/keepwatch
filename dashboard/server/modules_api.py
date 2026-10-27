"""Switching modules from the dashboard - add-on module of the Keepwatch dashboard.

The add-ons in config.TOGGLEABLE (lynis, image-scan, log-archive, ban-history, auditd,
auto-updates, backup) can be switched on and off here. Everything else changes how you reach
or run the server, so it stays on your computer: ./keepwatch enable|disable <m>, ./keepwatch deploy.

The work is done by keepwatch-modules (config.MODULES_CLI, installed by the dashboard module):

  list --json                          every module: on/off, in keepwatch.conf, override, toggleable,
                                       why (not switchable here), blocked (a switch now would be refused)
  enable|disable <id> --by dashboard --json
                                       checks, writes config.MODULES_OVERRIDE, starts
                                       keepwatch-modules-apply.service and returns at once: {ok, message,
                                       started}; exit 0 = started or nothing to do, 1 = refused, 2 = usage
  status --json                        progress of that unit (also config.MODULES_APPLY_JSON)

An override is a module switched here that keepwatch.conf on your computer does not have yet;
the next ./keepwatch deploy asks to take it over. config.modules() applies overrides, so
/api/config and every module gate follow as soon as the CLI wrote the file.

The apply can restart this dashboard: the UI keeps polling. The outcome reaches the timeline
through deploys.jsonl (lib/apply.sh adds "switch": "+lynis", timeline.scan_deploys); `loop` adds
only what apply.sh never logged (e.g. it stopped before the end), keyed so restarts don't repeat it.

Hooked into dashboard.py (import, route /api/modules, thread `loop`) like selfupdate.py; it gets
the helpers from there at runtime through sys.modules["dashboard"]. API: ../API.md, "Modules".
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

import config

APPLY_UNIT = config.UNITS["modules-apply"] + ".service"
MODULE_ID = re.compile(r"^[a-z0-9-]{1,40}$")
LIST_TTL = 2              # seconds: polls while applying share one `list --json`
STALE_RUN = 60            # seconds without news from a "running" apply whose unit is gone = it died (as the CLI)
LOG_LINES = 60
LOCK = threading.Lock()
PENDING: dict = {}        # {"module", "action", "at"}: started, the unit has not reported yet
_CACHE = {"at": 0.0, "list": None}
LINK = {"view": "settings", "setting": "modules"}


def D():
    return sys.modules["dashboard"]


def _name(mid: str, entry: dict | None = None) -> str:
    """The CLI's name, else NAME from modules/<id>/module.conf, else config.MODULE_NAMES."""
    n = (entry or {}).get("name")
    return n.strip() if isinstance(n, str) and n.strip() else config.module_name(mid)


# --------------------------------------------------------------------------- keepwatch-modules

def cli() -> str | None:
    """Path of keepwatch-modules (PATH first, so tests can put a stub there), None if missing."""
    found = shutil.which("keepwatch-modules")
    if found:
        return found
    return str(config.MODULES_CLI) if os.access(config.MODULES_CLI, os.X_OK) else None


def _call(args: list[str], timeout: float = 30) -> tuple[int, str, str]:
    exe = cli()
    if not exe:
        raise D().ApiError(503, "keepwatch-modules is not installed on the server - run ./keepwatch deploy once.")
    try:
        p = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8"})
    except subprocess.TimeoutExpired:
        raise D().ApiError(504, f"keepwatch-modules {args[0]} did not finish in {int(timeout)} s.")
    except OSError as e:
        raise D().ApiError(503, f"keepwatch-modules could not be started: {e}")
    return p.returncode, p.stdout, p.stderr


def _message(out: str, err: str, code: int) -> str:
    """The CLI's own sentence: last non-empty line of stderr (else stdout), without "error:"."""
    lines = [ln.strip() for ln in (err or out or "").splitlines() if ln.strip()]
    msg = re.sub(r"^(keepwatch-modules:\s*)?(error|refused|fatal):\s*", "", lines[-1], flags=re.I) if lines else ""
    return msg or f"keepwatch-modules exited with code {code}."


def _list() -> list[dict] | None:
    """`list --json`, cached for LIST_TTL seconds. None when the CLI is missing."""
    if not cli():
        return None
    if time.time() - _CACHE["at"] < LIST_TTL and _CACHE["list"] is not None:
        return _CACHE["list"]
    code, out, err = _call(["list", "--json"])
    if code != 0:
        raise D().ApiError(502, f"keepwatch-modules list failed: {_message(out, err, code)}")
    try:
        data = json.loads(out)
    except ValueError:
        raise D().ApiError(502, "keepwatch-modules list did not answer with JSON.")
    if isinstance(data, dict) and isinstance(data.get("modules"), list):
        data = data["modules"]
    if not isinstance(data, list):
        raise D().ApiError(502, "keepwatch-modules list did not answer with a list.")
    rows = [r for r in data if isinstance(r, dict) and isinstance(r.get("id"), str)]
    _CACHE.update(at=time.time(), list=rows)
    return rows


def _module_conf(mid: str) -> dict[str, str]:
    """modules/<id>/module.conf (NAME, SUMMARY, REQUIRES) - only for the fallback without the CLI."""
    return config.parse_file(config.ROOT / "modules" / mid / "module.conf")


def _fallback() -> list[dict]:
    """Without keepwatch-modules (older server): what keepwatch.conf and the override file say, nothing switchable."""
    conf = set(config.get_list("KW_MODULES"))
    ovr = config.overrides()
    out = []
    for m in config.MODULES:
        mc = _module_conf(m)
        out.append({"id": m, "name": mc.get("NAME") or config.MODULE_NAMES.get(m, m), "summary": mc.get("SUMMARY") or None,
                    "requires": (mc.get("REQUIRES") or "").split(), "enabled": config.enabled(m),
                    "inConf": m in conf or m in ("base", "dashboard"),
                    "override": None if m not in ovr else "on" if ovr[m] else "off", "toggleable": False, "why": None})
    return out


# --------------------------------------------------------------------------- Status of the apply

def _read_status() -> dict:
    try:
        data = json.loads(config.MODULES_APPLY_JSON.read_text())
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        return {}
    if not cli():
        return {}
    try:
        code, out, _ = _call(["status", "--json"], timeout=10)
        data = json.loads(out) if code == 0 else {}
        return data if isinstance(data, dict) else {}
    except (ValueError, D().ApiError):
        return {}


def _action(v) -> str | None:
    v = str(v or "").lower()
    return "on" if v in ("on", "enable", "enabled", "true") else "off" if v in ("off", "disable", "disabled", "false") else None


def _num(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _unit_active() -> bool:
    return D().run(["systemctl", "is-active", APPLY_UNIT]).strip() in ("active", "activating", "reloading")


def run_state(raw: dict | None = None) -> dict:
    """{state, module, action, step, startedAt, endedAt, log, error, rolledBack, by} of the last apply."""
    st = _read_status() if raw is None else raw
    state = st.get("state") if st.get("state") in ("running", "done", "failed") else "idle"
    mid = st.get("module") if isinstance(st.get("module"), str) else None
    out = {"state": state, "module": mid, "name": _name(mid) if mid else None, "action": _action(st.get("action")),
           "step": st.get("step") if isinstance(st.get("step"), str) else None,
           "startedAt": _num(st.get("startedAt")), "endedAt": _num(st.get("endedAt") or st.get("finishedAt")),
           "log": [str(x) for x in (st.get("log") or []) if x is not None][-LOG_LINES:] if isinstance(st.get("log"), list) else [],
           "error": str(st["error"]) if st.get("error") else None,
           "rolledBack": bool(st.get("rolledBack")), "by": st.get("by") if isinstance(st.get("by"), str) else None}
    pend = PENDING.get("module")
    if pend and time.time() - PENDING.get("at", 0) < 60 and (out["startedAt"] or 0) < PENDING["at"] - 1:
        # Started a moment ago, the unit has not reported yet.
        return {**out, "state": "running", "module": pend, "name": _name(pend), "action": PENDING["action"], "step": "starting",
                "startedAt": PENDING["at"], "endedAt": None, "log": [], "error": None, "rolledBack": False, "by": "dashboard"}
    quiet = time.time() - (_num(st.get("updatedAt")) or out["startedAt"] or 0)
    if state == "running" and quiet > STALE_RUN and not _unit_active():
        out.update(state="failed", step=None, endedAt=out["endedAt"] or time.time(), stale=True,
                   error=out["error"] or f"Switching stopped without finishing. Details: journalctl -u {APPLY_UNIT}")
    return out


def _lock_held() -> bool:
    """Is a deploy (or an update) holding /run/keepwatch.lock right now? A non-blocking probe."""
    import fcntl
    try:
        fd = os.open(str(config.DEPLOY_LOCK), os.O_RDONLY)
    except OSError:
        return False  # no lock file: nothing ever ran since boot
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


def busy(run: dict) -> str | None:
    """What is running that a switch would collide with: "modules" | "self-update" | "deploy" | None."""
    if run["state"] == "running":
        return "modules"
    try:
        import selfupdate
        if config.self_update_repo() and selfupdate._run_state(selfupdate._read(config.UPDATE_JSON))["state"] == "running":
            return "self-update"
    except Exception:  # noqa: BLE001 - never let the update check break this page
        pass
    return "deploy" if _lock_held() else None


BUSY = {"self-update": "A Keepwatch update is being installed right now - try again when it is done.",
        "deploy": "A deploy is running on the server right now - try again when it is done."}


# --------------------------------------------------------------------------- List

def _entry(r: dict) -> dict:
    mid = r["id"]
    ovr = r.get("override") if r.get("override") in ("on", "off") else None
    req = r.get("requires")
    req = req.split() if isinstance(req, str) else [x for x in req if isinstance(x, str)] if isinstance(req, list) else []
    return {"id": mid, "name": _name(mid, r), "summary": r.get("summary") if isinstance(r.get("summary"), str) and r.get("summary") else None,
            "requires": req, "enabled": bool(r.get("enabled")) or mid in ("base", "dashboard"),
            "inConf": bool(r.get("inConf")), "override": ovr, "toggleable": bool(r.get("toggleable")),
            "why": r.get("why") if isinstance(r.get("why"), str) and r.get("why") else None,
            "installed": r.get("installed") if isinstance(r.get("installed"), bool) else None,
            # the CLI's reason ("" = free); missing (older CLI): worked out in _with_blocks
            "_blocked": r.get("blocked") if isinstance(r.get("blocked"), str) else None}


def _with_blocks(rows: list[dict]) -> list[dict]:
    """`requiredBy` (enabled modules that need it) and `blocked` (why its switch is greyed out)."""
    by = {r["id"]: r for r in rows}
    order = {m: i for i, m in enumerate(config.MODULES)}
    rows.sort(key=lambda r: order.get(r["id"], 99))
    for r in rows:
        r["requiredBy"] = [x["id"] for x in rows if x["enabled"] and r["id"] in x["requires"]]
        cli_blocked = r.pop("_blocked", None)
        r["blocked"] = None
        r["command"] = None if r["id"] == "base" else \
            f"./keepwatch {'disable' if r['enabled'] else 'enable'} {r['id']} && ./keepwatch deploy"
        if not r["toggleable"]:
            continue
        if cli_blocked is not None:
            r["blocked"] = cli_blocked.strip() or None
            continue
        if not r["enabled"]:
            missing = [m for m in r["requires"] if not (by.get(m) or {}).get("enabled")]
            if missing:
                names = " and ".join(_name(m, by.get(m)) for m in missing)
                r["blocked"] = f"Needs {names} - " + ("switch that on first." if all((by.get(m) or {}).get("toggleable") for m in missing)
                                                      else f"on your computer: ./keepwatch enable {' '.join(missing)}, then ./keepwatch deploy.")
        elif r["requiredBy"]:
            r["blocked"] = f"{' and '.join(_name(m, by.get(m)) for m in r['requiredBy'])} needs it - switch that off first."
    return rows


def status() -> dict:
    """GET /api/modules."""
    rows = _list()
    available = rows is not None
    mods = _with_blocks([_entry(r) for r in rows] if available else _fallback())
    run = run_state()
    record(run)
    run.pop("stale", None)
    return {"available": available, "modules": mods, "run": run, "busy": busy(run),
            "overrides": sum(1 for m in mods if m["override"])}


# --------------------------------------------------------------------------- Switch

def _note(handler, title: str, *, detail: str | None = None, level: str = "info", meta: dict | None = None):
    """Own timeline entry instead of the generic "Action POST /api/modules/..." (Handler._json skips it)."""
    handler._audited = True
    if getattr(handler, "_touchid_ok", None):
        detail = " · ".join(x for x in (detail, "confirmed with a passkey") if x)
    try:
        import timeline
        timeline.add("dashboard", title, detail=detail, level=level, source="audit", link=LINK, meta=meta,
                     weight=30 if level != "info" else 25)
    except Exception:  # noqa: BLE001 - the timeline must never break a switch
        pass


def switch(handler, mid: str, body: dict):
    """POST /api/modules/<id> {enabled}: switch an add-on, the apply runs in the background (202)."""
    d = D()
    if mid not in config.MODULES:
        raise d.ApiError(404, f"Unknown module \"{mid}\".")
    want = body.get("enabled")
    if not isinstance(want, bool):
        raise d.ApiError(400, "\"enabled\" must be true or false.")
    verb = "on" if want else "off"
    meta = {"module": mid, "action": verb}
    with LOCK:
        st = status()
        entry = next((m for m in st["modules"] if m["id"] == mid), None) or {"id": mid}
        name = _name(mid, entry)
        try:
            if not st["available"]:
                raise d.ApiError(503, "keepwatch-modules is not installed on the server - run ./keepwatch deploy once.")
            if st["busy"] == "modules":
                r = st["run"]
                raise d.ApiError(409, f"{r['name'] or 'A module'} is being switched {r['action'] or ''} right now - "
                                      "wait until that is done.".replace("  ", " "))
            if st["busy"]:
                raise d.ApiError(409, BUSY[st["busy"]])
            if not entry.get("toggleable"):
                raise d.ApiError(409, f"{name} can't be switched from the dashboard. On your computer: "
                                      f"./keepwatch {'enable' if want else 'disable'} {mid}, then ./keepwatch deploy.")
            if entry.get("enabled") == want:
                raise d.ApiError(409, f"{name} is already {verb}.")
            if entry.get("blocked"):
                raise d.ApiError(409, entry["blocked"])
            code, out, err = _call(["enable" if want else "disable", mid, "--by", "dashboard", "--json"], timeout=60)
            try:
                res = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
            except ValueError:
                res = {}
            res = res if isinstance(res, dict) else {}
            msg = res.get("message") if isinstance(res.get("message"), str) and res.get("message") else _message(out, err, code)
            if code != 0:
                raise d.ApiError(400 if code == 2 else 409, msg)
        except d.ApiError as e:
            _note(handler, f"Switching {name} {verb} refused", detail=e.message, level="warn", meta=meta)
            raise
        if res and res.get("started") is False:  # nothing to do (already so)
            _CACHE.update(at=0.0, list=None)
            handler._audited = True
            return {"ok": True, "message": msg, **status()}
        PENDING.update(module=mid, action=verb, at=time.time())
        _CACHE.update(at=0.0, list=None)
    _note(handler, f"Switch {name} {verb} - started in the dashboard", meta=meta,
          detail="Not in keepwatch.conf yet: the next ./keepwatch deploy asks to take it over.")
    return d.Reply(202, {"ok": True, **status()})


# --------------------------------------------------------------------------- Timeline: how it ended

def _logged_by_apply(run: dict) -> bool:
    """Did lib/apply.sh write this switch to deploys.jsonl ("switch": "+lynis", via dashboard, or via
    rollback after a failure)? Then timeline.scan_deploys shows it - no second entry from here."""
    want = ("+" if run["action"] == "on" else "-") + str(run["module"])
    via = "dashboard" if run["state"] == "done" else "rollback"
    try:
        lines = config.DEPLOY_LOG.read_text(errors="replace").splitlines()[-50:]
    except OSError:
        return False
    for line in reversed(lines):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("switch") == want and r.get("via") == via \
                and float(r.get("t") or 0) >= (run["startedAt"] or 0) - 5:
            return True
    return False


def record(run: dict):
    """A finished switch apply.sh did not log itself (stopped early, lock timeout) -> one timeline
    entry, keyed by its start so restarts don't repeat it."""
    if run["state"] not in ("done", "failed") or not run["module"] or not run["endedAt"] or run.get("stale"):
        return  # a run that only looks dead (unit gone) stays out: the status file has the last word
    if _logged_by_apply(run):
        return
    try:
        import timeline
        name, verb = run["name"] or run["module"], run["action"] or "over"
        where = " in the dashboard" if run["by"] in (None, "dashboard") else ""
        if run["state"] == "done":
            title, level, detail = f"{name} switched {verb}{where}", "info", None
        else:
            title = f"Switching {name} {verb} failed" + (" - previous state put back" if run["rolledBack"] else "")
            level, detail = "warn", (run["error"] or (run["log"][-1] if run["log"] else None))
        timeline.add("system", title, detail=detail, level=level, t=run["endedAt"], source="module", link=LINK,
                     key=f"modules:{run['module']}:{verb}:{int(run['startedAt'] or run['endedAt'])}",
                     meta={"module": run["module"], "action": verb, "state": run["state"], "rolledBack": run["rolledBack"]})
    except Exception:  # noqa: BLE001
        pass


def loop():
    """Thread: record finished applies also while nobody has the page open (e.g. after a restart)."""
    seen = None
    while True:
        try:
            m = config.MODULES_APPLY_JSON.stat().st_mtime_ns if config.MODULES_APPLY_JSON.exists() else None
            if m is not None and m != seen:
                seen = m
                record(run_state())
        except Exception:  # noqa: BLE001
            pass
        time.sleep(15)


def route(handler, method: str, path: str, body: dict):
    d = D()
    if method == "GET" and path == "/api/modules":
        return status()
    m = re.match(r"^/api/modules/([^/]+)$", path)
    if m and method == "POST":
        if not MODULE_ID.match(m.group(1)):
            raise d.ApiError(404, "Unknown module.")
        return switch(handler, m.group(1), body)
    raise d.ApiError(404, "Unknown endpoint.")
