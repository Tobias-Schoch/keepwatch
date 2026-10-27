"""Keepwatch updates from the dashboard - add-on module of the Keepwatch dashboard.

When KW_SELF_UPDATE_BRANCH on GitHub (KW_SELF_UPDATE_REPO) is newer than what the server runs,
the overview offers to install it. The work is done by keepwatch-self-update (lib/kwupdate.py,
installed by the dashboard module):

  check           keepwatch-self-update-check.service (timer every 6 h, "Check now" here)
  apply <sha>     keepwatch-self-update@<sha>.service - its own unit, because lib/apply.sh
                  restarts this dashboard halfway through

Both write config.UPDATE_JSON; this module only reads it, starts the units and switches the
timer. What runs is config.VERSION_JSON (written by deploy and by the updater).

Hooked into dashboard.py (import, route /api/self-update) like lynis.py; it gets the helpers
from there at runtime through sys.modules["dashboard"]. API: ../API.md, "Keepwatch updates".
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time

import config

CHECK_UNIT = config.UNITS["self-update-check"] + ".service"
TIMER = config.UNITS["self-update-check"] + ".timer"
SHA = re.compile(r"^[0-9a-f]{40}$")
CHECK_AGAIN = 30          # seconds: "Check now" more often answers from the last result
STALE_RUN = 90            # seconds without a sign of life from a "running" update = it died
LOCK = threading.Lock()
PENDING: dict = {}        # {"sha", "at"}: started, the unit has not written "running" yet
LAST_AUTO = {"at": 0.0}


def D():
    return sys.modules["dashboard"]


def _read(path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _active(unit: str) -> bool:
    return D().run(["systemctl", "is-active", unit]).strip() in ("active", "activating", "reloading")


def _installed() -> dict:
    v = _read(config.VERSION_JSON)
    commit = v.get("commit") if isinstance(v.get("commit"), str) and SHA.match(v["commit"]) else None
    return {"commit": commit, "date": v.get("date"), "subject": v.get("subject"), "dirty": bool(v.get("dirty")),
            "source": v.get("source") if v.get("source") in ("deploy", "dashboard") else None,
            "at": v.get("at"), "repo": v.get("repo")}


def _run_state(st: dict) -> dict:
    run = st.get("run") if isinstance(st.get("run"), dict) else {}
    state = run.get("state") if run.get("state") in ("running", "done", "failed") else "idle"
    out = {"state": state, "step": run.get("step"), "module": run.get("module"), "target": run.get("target"),
           "startedAt": run.get("startedAt"), "finishedAt": run.get("finishedAt"), "message": run.get("message"),
           "rolledBack": bool(run.get("rolledBack")), "log": [str(x) for x in (run.get("log") or [])][-40:]}
    pend = PENDING.get("sha")
    if pend and time.time() - PENDING.get("at", 0) < 60 and not (state == "running" and out["target"] == pend) \
            and (run.get("startedAt") or 0) < PENDING["at"] - 1:
        # Started a moment ago, the unit has not reported yet.
        return {**out, "state": "running", "step": "starting", "module": None, "target": pend, "startedAt": int(PENDING["at"]),
                "finishedAt": None, "message": None, "rolledBack": False, "log": []}
    if state == "running":
        unit = run.get("unit") or f"{config.UNITS['self-update']}@{out['target']}.service"
        quiet = time.time() - float(run.get("updatedAt") or run.get("startedAt") or 0)
        if quiet > STALE_RUN and not _active(unit):
            out.update(state="failed", step=None, message=f"The update stopped without finishing. Details: journalctl -u {unit}")
    return out


def status() -> dict:
    repo = config.self_update_repo()
    if not repo:
        return {"enabled": False}
    st = _read(config.UPDATE_JSON)
    have = _installed()
    latest = st.get("latest") if isinstance(st.get("latest"), dict) else None
    checked_for = st.get("checkedFor") if isinstance(st.get("checkedFor"), dict) else {}
    same_source = st.get("repo") == repo and st.get("branch") == (config.get("KW_SELF_UPDATE_BRANCH") or "main")
    # The last check was for what runs now (and for this repository)? Otherwise it says nothing.
    current = same_source and checked_for.get("commit") == have["commit"] and bool(checked_for.get("dirty")) == have["dirty"]
    auto = D().run(["systemctl", "is-enabled", TIMER]).strip() == "enabled"
    run = _run_state(st)
    if not current and auto and run["state"] != "running" and time.time() - LAST_AUTO["at"] > 300:
        LAST_AUTO["at"] = time.time()  # e.g. right after a deploy: look again, in the background
        D().run(["systemctl", "start", "--no-block", CHECK_UNIT])
    available = bool(current and latest and st.get("available"))
    return {
        "enabled": True, "repo": repo, "branch": config.get("KW_SELF_UPDATE_BRANCH") or "main",
        "url": f"https://github.com/{repo}", "autoCheck": auto,
        "installed": have,
        "latest": {"commit": latest.get("commit"), "date": latest.get("date"), "subject": latest.get("subject")}
                  if latest and same_source else None,
        "current": current, "available": available,
        "localBuild": bool(have["dirty"] or (current and st.get("localBuild"))) or not have["commit"],
        "otherRepo": bool(have["repo"] and have["source"] == "deploy" and have["repo"].lower() != repo.lower()),
        "changes": [str(c) for c in (st.get("changes") or [])][:20] if available else [],
        "moreChanges": int(st.get("moreChanges") or 0) if available else 0,
        "checkedAt": st.get("checkedAt") if same_source else None,
        "error": st.get("error"), "errorAt": st.get("errorAt"), "retryAt": st.get("retryAt"),
        "run": run,
    }


def check() -> dict:
    """POST /api/self-update/check: ask GitHub now (keepwatch-self-update-check.service, ~1 s)."""
    d = D()
    if not config.self_update_repo():
        raise d.ApiError(404, "Updates from the dashboard are off (KW_SELF_UPDATE_REPO is empty).")
    st = _read(config.UPDATE_JSON)
    if time.time() - float(st.get("checkedAt") or 0) < CHECK_AGAIN and not st.get("error") and status()["current"]:
        return status()
    if "LoadState=loaded" not in d.run(["systemctl", "show", "-p", "LoadState", CHECK_UNIT]):
        raise d.ApiError(503, f"{CHECK_UNIT} is not installed - run ./keepwatch deploy once.")
    with LOCK:
        d.run(["systemctl", "start", CHECK_UNIT], timeout=150)  # a failed check writes its error into update.json
    LAST_AUTO["at"] = time.time()
    return status()


def apply(body: dict) -> dict:
    """POST /api/self-update/apply {sha}: install exactly the commit the last check showed."""
    d = D()
    sha = body.get("sha")
    if not isinstance(sha, str) or not SHA.match(sha):
        raise d.ApiError(400, "\"sha\" must be the 40-character id of the update shown.")
    with LOCK:
        st = status()
        if not st.get("enabled"):
            raise d.ApiError(404, "Updates from the dashboard are off (KW_SELF_UPDATE_REPO is empty).")
        if st["run"]["state"] == "running":
            raise d.ApiError(409, "An update is already being installed.")
        if not st["latest"] or st["latest"]["commit"] != sha or not st["available"]:
            raise d.ApiError(409, "This is not the update the last check found. Check again.")
        unit = f"{config.UNITS['self-update']}@{sha}.service"
        if "LoadState=loaded" not in d.run(["systemctl", "show", "-p", "LoadState", unit]):
            raise d.ApiError(503, "The updater is not installed - run ./keepwatch deploy once.")
        d.run(["systemctl", "reset-failed", unit])
        PENDING.update(sha=sha, at=time.time())
        try:
            d.run(["systemctl", "start", "--no-block", unit], check=True)
        except d.ApiError:
            PENDING.clear()
            raise
    return {"ok": True, **status()}


def put_settings(body: dict) -> dict:
    """PUT /api/self-update/settings {autoCheck}: switch the check every 6 h on or off. The timer
    is the setting - a deploy only overrides it when KW_SELF_UPDATE_CHECK changed (dashboard module)."""
    d = D()
    if not config.self_update_repo():
        raise d.ApiError(404, "Updates from the dashboard are off (KW_SELF_UPDATE_REPO is empty).")
    auto = body.get("autoCheck")
    if not isinstance(auto, bool):
        raise d.ApiError(400, "\"autoCheck\" must be true or false.")
    d.run(["systemctl", "enable" if auto else "disable", "--now", TIMER], check=True)
    if auto:
        d.run(["systemctl", "start", "--no-block", CHECK_UNIT])
    return status()


def route(method: str, path: str, body: dict):
    d = D()
    if method == "GET" and path == "/api/self-update":
        return status()
    if method == "POST" and path == "/api/self-update/check":
        return check()
    if method == "POST" and path == "/api/self-update/apply":
        return apply(body)
    if method == "PUT" and path == "/api/self-update/settings":
        return put_settings(body)
    raise d.ApiError(404, "Unknown endpoint.")
