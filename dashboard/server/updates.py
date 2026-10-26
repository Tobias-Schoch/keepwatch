"""Updates & rollback, cleanup - add-on module of the Keepwatch dashboard (needs "docker").

Hooked into dashboard.py (import, routes, background thread, health). It gets the
helpers from there (run, portainer, ApiError, COLLECTORS, ...) at runtime through
sys.modules["dashboard"]: dashboard.py registers itself under that name at start,
so it is not loaded a second time.

Check (every 6 h and on demand):
  - Images from a registry: local RepoDigest against the digest of the tag in the
    registry. Docker Hub via hub.docker.com (anonymous, also returns the version tags
    for the digest), ghcr.io with an anonymous token - private = "unknown", no error.
  - Stacks built from Git: deployed commit (Portainer GitConfig.ConfigHash) and date.
    The dashboard cannot see the state of the repository (private repos, Portainer
    does not hand out its Git credentials) - that is what "Redeploy" is for.

Update (one job at a time, runs in the background):
  1. tag the running image as <repo>:keepwatch-previous (one per image)
  2. Postgres: pg_dumpall to config.PRE_UPDATE_DUMPS
  3. pull and recreate - Portainer stack: redeploy with pull (Portainer knows the
     registry credentials); other Compose projects: docker compose pull + up -d
  4. wait up to 2 min for "healthy", otherwise roll back to :keepwatch-previous automatically

Cleanup: build cache, images without containers (except :keepwatch-previous), stopped
containers. Never volumes.

Security scan (module "image-scan"): read the result of keepwatch-image-scan (Trivy),
start a run on demand.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

import config

CHECK_EVERY = 6 * 3600
HEALTH_WAIT = 120
PREV_TAG = "keepwatch-previous"
DUMP_DIR = config.PRE_UPDATE_DUMPS
DUMP_KEEP = 3
UA = {"User-Agent": f"{config.USER_AGENT} update check"}

# Display names (Compose service -> name)
SERVICE_NAMES = {"nginx-proxy-manager": "Proxy Manager", "portainer": "Portainer"}
NOTES = {
    "jc21/nginx-proxy-manager": "https://github.com/NginxProxyManager/nginx-proxy-manager/releases",
    "portainer/portainer-ce": "https://github.com/portainer/portainer/releases",
}
# Postgres minor releases are bug and security fixes only, according to the project.
SECURITY_PATCH_REPOS = {"postgres"}

STATE: dict = {"checkedAt": None, "checking": False, "error": None, "images": [], "stacks": [],
               "jobs": {}, "lock": threading.Lock(), "job_lock": threading.Lock(), "cleanup": None,
               "cleanup_at": 0.0}


def D():
    return sys.modules["dashboard"]


def _state_file() -> Path:
    return D().STATE_DIR / "updates.json"


def _load_saved() -> dict:
    try:
        return json.loads(_state_file().read_text())
    except (OSError, ValueError):
        return {}


def _save(extra: dict):
    data = _load_saved()
    data.update(extra)
    D().write_atomic(_state_file(), json.dumps(data, ensure_ascii=False), 0o600)


# --------------------------------------------------------------------------- Helpers

def _http_json(url: str, headers: dict | None = None, timeout: float = 15):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def _docker_json(*args: str, timeout: float = 60):
    out = D().run(["docker", *args], timeout=timeout)
    try:
        return json.loads(out or "null")
    except ValueError:
        return None


def _split_ref(ref: str) -> tuple[str, str, str]:
    """"postgres:16-alpine" -> (registry, repo, tag); repo without registry, Docker Hub: library/..."""
    ref = ref.split("@", 1)[0]
    name, tag = (ref.rsplit(":", 1) if ":" in ref.rsplit("/", 1)[-1] else (ref, "latest"))
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        registry, repo = first, name.split("/", 1)[1]
    else:
        registry, repo = "docker.io", name
    return registry, repo, tag


def _hub_repo(repo: str) -> str:
    return repo if "/" in repo else f"library/{repo}"


VERSION = re.compile(r"^v?(\d+(?:\.\d+)+)")


def _vtuple(v: str | None) -> tuple[int, ...] | None:
    m = VERSION.match(v or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def _version_from_tags(tags: list[dict], digest: str, tag: str) -> str | None:
    """Version name for a digest: the most precise tag with the same suffix (16-alpine -> 16.15-alpine)."""
    suffix = re.sub(r"^v?\d+(\.\d+)*", "", tag) if _vtuple(tag) or re.match(r"^\d+", tag) else ""
    if tag == "latest":
        suffix = ""
    best = None
    for t in tags:
        if t.get("digest") != digest:
            continue
        name = t.get("name") or ""
        m = re.match(r"^v?(\d+(?:\.\d+)+)(.*)$", name)
        if not m or m.group(2) != suffix:
            continue
        if best is None or len(m.group(1).split(".")) > len(best.split(".")):
            best = m.group(1)
    return best


def _hub_tags(repo: str, tag: str, pages: int = 3) -> list[dict]:
    hub = _hub_repo(repo)
    major = re.match(r"^v?(\d+)", tag)
    q = f"&name={major.group(1)}." if major and tag != "latest" else ""
    out, url = [], f"https://hub.docker.com/v2/repositories/{hub}/tags?page_size=100&ordering=last_updated{q}"
    for _ in range(pages):
        data = _http_json(url)
        out += data.get("results") or []
        url = data.get("next")
        if not url:
            break
    return out


def _local_version(img: dict, repo: str) -> str | None:
    env = dict(e.split("=", 1) for e in (img.get("Config", {}).get("Env") or []) if "=" in e)
    labels = img.get("Config", {}).get("Labels") or {}
    if repo == "postgres" and env.get("PG_VERSION"):
        return env["PG_VERSION"]
    return labels.get("org.opencontainers.image.version") or None


def _running_version(repo: str) -> str | None:
    """Version from the running service when the image does not carry it."""
    try:
        if repo == "portainer/portainer-ce" and config.enabled("portainer"):
            return (D().portainer("GET", "/api/system/version", timeout=8) or {}).get("ServerVersion")
        if repo == "jc21/nginx-proxy-manager" and config.enabled("proxy"):
            v = _http_json(config.proxy_url() + "/api/", timeout=5).get("version") or {}
            return f"{v['major']}.{v['minor']}.{v['revision']}" if "major" in v else None
    except Exception:  # noqa: BLE001
        return None
    return None


def _created(img: dict) -> float | None:
    raw = (img or {}).get("Created") or ""
    try:
        return dt.datetime.fromisoformat(raw[:26].rstrip("Z") + "+00:00").timestamp()
    except ValueError:
        return None


# --------------------------------------------------------------------------- Check

def _containers() -> list[dict]:
    ids = D().run(["docker", "ps", "-aq"]).split()
    return _docker_json("inspect", *ids) or [] if ids else []


def _check_image(ref: str, img: dict) -> dict:
    registry, repo, tag = _split_ref(ref)
    digests = img.get("RepoDigests") or []
    local_digest = next((d.split("@", 1)[1] for d in digests if "@" in d), None)
    res = {"status": "unknown", "kind": None, "security": False, "reason": None,
           "local": {"digest": local_digest, "version": _local_version(img, repo), "created": _created(img)},
           "remote": None, "notesUrl": NOTES.get(repo)}
    if registry == "docker.io":
        try:
            hub = _hub_repo(repo)
            t = _http_json(f"https://hub.docker.com/v2/repositories/{hub}/tags/{tag}")
            rdig = t.get("digest")
            tags = _hub_tags(repo, tag)
            rver = _version_from_tags(tags, rdig, tag)
            lver = res["local"]["version"] or (_version_from_tags(tags, local_digest, tag) if local_digest else None) \
                or _running_version(repo)
            res["local"]["version"] = lver
            upd = t.get("last_updated") or t.get("tag_last_pushed")
            res["remote"] = {"digest": rdig, "version": rver,
                             "updated": dt.datetime.fromisoformat(upd.replace("Z", "+00:00")).timestamp() if upd else None}
            if repo == "postgres" and rver:
                res["notesUrl"] = f"https://www.postgresql.org/docs/release/{rver}/"
            if not rdig or not local_digest:
                res["reason"] = "digests not comparable"
            elif rdig == local_digest:
                res["status"] = "current"
            else:
                lt, rt = _vtuple(lver), _vtuple(rver)
                if lt and rt and rt[0] > lt[0]:
                    res["status"], res["kind"] = "major", "major"
                else:
                    res["status"] = "update"
                    res["kind"] = ("minor" if lt and rt and rt[:2] != lt[:2] else "patch" if lt and rt and rt != lt
                                   else "build")
                    res["security"] = res["kind"] in ("patch", "build") and repo.split("/")[-1] in SECURITY_PATCH_REPOS
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
            res["reason"] = f"Docker Hub unreachable ({e.__class__.__name__})"
    elif registry == "ghcr.io":
        try:
            tok = _http_json(f"https://ghcr.io/token?scope=repository:{repo}:pull").get("token")
            req = urllib.request.Request(f"https://ghcr.io/v2/{repo}/manifests/{tag}", method="HEAD", headers={
                **UA, "Authorization": f"Bearer {tok}",
                "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,"
                          "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                rdig = r.headers.get("Docker-Content-Digest")
            res["remote"] = {"digest": rdig, "version": None, "updated": None}
            res["status"] = "current" if rdig and rdig == local_digest else "update" if rdig else "unknown"
            res["kind"] = "build" if res["status"] == "update" else None
        except urllib.error.HTTPError as e:
            res["reason"] = "private package - ghcr.io returns nothing without login" if e.code in (401, 403) \
                else f"ghcr.io returned {e.code}"
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            res["reason"] = f"ghcr.io unreachable ({e.__class__.__name__})"
    else:
        res["reason"] = f"registry {registry} is not checked"
    return res


def _built(img: dict) -> bool:
    """Built by Compose (label on the image) or without a registry origin - nothing to compare then.
    With the containerd image store built images carry a RepoDigest too, hence the label."""
    labels = (img.get("Config") or {}).get("Labels") or {}
    return bool(labels.get("com.docker.compose.project")) or not img.get("RepoDigests")


def _previous(repo_ref: str) -> dict | None:
    registry, repo, _tag = _split_ref(repo_ref)
    name = repo if registry == "docker.io" else f"{registry}/{repo}"
    img = _docker_json("image", "inspect", f"{name}:{PREV_TAG}")
    if not img:
        return None
    img = img[0]
    saved = (_load_saved().get("previous") or {}).get(repo_ref) or {}
    return {"ref": f"{name}:{PREV_TAG}", "id": img.get("Id"), "created": _created(img),
            "version": saved.get("version") or _local_version(img, repo), "savedAt": saved.get("at")}


def check():
    """Check all images and Git stacks (takes a few seconds, runs in the background)."""
    with STATE["lock"]:
        if STATE["checking"]:
            return
        STATE["checking"] = True
    try:
        conts = _containers()
        by_image: dict[str, dict] = {}
        for c in conts:
            ref = c["Config"]["Image"]
            labels = c["Config"].get("Labels") or {}
            e = by_image.setdefault(ref, {"ref": ref, "imageId": c.get("Image"), "containers": [], "services": [],
                                          "project": labels.get("com.docker.compose.project"),
                                          "workingDir": labels.get("com.docker.compose.project.working_dir"),
                                          "configFiles": labels.get("com.docker.compose.project.config_files")})
            e["containers"].append(c["Name"].lstrip("/"))
            svc = labels.get("com.docker.compose.service")
            if svc and svc not in e["services"]:
                e["services"].append(svc)
        stacks = []
        try:
            raw = (D().portainer("GET", "/api/stacks") or []) if config.enabled("portainer") else []
        except Exception:  # noqa: BLE001 - without Portainer there is no Git state
            raw = []
        managed = {s.get("Name"): s for s in raw}
        images = []
        for ref, e in sorted(by_image.items()):
            img = _docker_json("image", "inspect", e["imageId"] or ref)
            img = img[0] if img else {}
            if _built(img):
                continue  # built locally (from Git) - listed with the stack
            r = _check_image(ref, img)
            stack = managed.get(e["project"] or "")
            names = [SERVICE_NAMES.get(s, s) for s in e["services"]]
            images.append({
                "key": ref, "ref": ref, "containers": sorted(e["containers"]), "services": e["services"],
                "name": names[0] if len(names) == 1 and e["services"][0] in SERVICE_NAMES else None,
                "project": e["project"],
                "via": "portainer" if stack else ("compose" if e["configFiles"] else None),
                **r, "previous": _previous(ref),
            })
        for s in raw:
            git = s.get("GitConfig")
            if not git:
                continue
            built = sorted({ref for ref, e in by_image.items() if e["project"] == s.get("Name")
                            and _built((_docker_json("image", "inspect", e["imageId"] or ref) or [{}])[0])})
            stacks.append({"name": s.get("Name"), "id": s.get("Id"), "commit": git.get("ConfigHash") or None,
                           "branch": (git.get("ReferenceName") or "").replace("refs/heads/", ""),
                           "deployedAt": s.get("UpdateDate") or s.get("CreationDate") or None,
                           "autoUpdate": (s.get("AutoUpdate") or {}).get("Interval") or None, "built": built})
        with STATE["lock"]:
            STATE["images"], STATE["stacks"], STATE["error"] = images, stacks, None
            STATE["checkedAt"] = time.time()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        STATE["error"] = str(e)
    finally:
        STATE["checking"] = False


def loop():
    time.sleep(60)  # only after the other collectors have started
    while True:
        if config.enabled("docker"):
            check()
            time.sleep(CHECK_EVERY)
        else:
            time.sleep(300)  # module off: look again later


def problems() -> list[dict]:
    """For health (dock dot): open security patches."""
    if not config.enabled("docker"):
        return []
    out = []
    for i in STATE["images"]:
        if i["status"] == "update" and i["security"]:
            v = f" ({i['local']['version']} -> {i['remote']['version']})" if i["local"]["version"] and (i["remote"] or {}).get("version") else ""
            out.append({"level": "warn", "area": "docker", "title": f"Security patch for {i['ref']}",
                        "detail": f"New version{v}. Update it under Services.", "key": "image.security-patch"})
    return out


def status() -> dict:
    if not config.enabled("docker"):
        return {"enabled": False}
    with STATE["lock"]:
        images = [dict(i) for i in STATE["images"]]
        jobs = {k: {kk: vv for kk, vv in j.items() if not kk.startswith("_")} for k, j in STATE["jobs"].items()}
        return {"enabled": True, "checkedAt": STATE["checkedAt"], "checking": STATE["checking"], "error": STATE["error"],
                "images": images, "stacks": list(STATE["stacks"]), "jobs": jobs,
                "available": sum(1 for i in images if i["status"] == "update"),
                "major": sum(1 for i in images if i["status"] == "major"),
                "scan": _scan_safe()}


def _scan_safe() -> dict:
    if not config.enabled("image-scan"):
        return {"enabled": False}
    try:
        return scan_status()
    except Exception as e:  # noqa: BLE001 - the scan must not break /api/updates
        return {"enabled": True, "installed": False, "running": False, "progress": None, "lastResult": None,
                "startedAt": None, "finishedAt": None, "ok": None, "error": f"Scan status unreadable: {e}", "images": {}}


# --------------------------------------------------------------------------- Security scan (Trivy)
#
# keepwatch-image-scan (module "image-scan", systemd service + timer, KW_IMAGE_SCAN_TIME) writes its result
# to config.IMAGE_SCAN_JSON; here it is only read, and started on demand.

SCAN_UNIT = config.UNITS["image-scan"] + ".service"


def scan_status() -> dict:
    d = D()
    show = d.systemd_show(SCAN_UNIT, "LoadState", "ActiveState", "Result", "ExecMainStartTimestamp")
    installed = show.get("LoadState") == "loaded"
    running = show.get("ActiveState") in ("activating", "active", "reloading")
    try:
        res = json.loads(config.IMAGE_SCAN_JSON.read_text())
    except (OSError, ValueError):
        res = None
    try:
        prog = json.loads(config.IMAGE_SCAN_PROGRESS.read_text()) if running else None
    except (OSError, ValueError):
        prog = None
    out = {"enabled": True, "installed": installed, "running": running, "progress": prog,
           "lastResult": show.get("Result") or None,
           "startedAt": None, "finishedAt": None, "ok": None, "error": None, "images": {}}
    if res:
        out.update({k: res.get(k) for k in ("startedAt", "finishedAt", "ok", "error", "previousAt")})
        out["images"] = _without_infra(res.get("images") or {})
    return out


def _without_infra(images: dict) -> dict:
    """Infrastructure (Proxy Manager, Portainer: stacks not managed by Portainer) is not rated - its
    vulnerabilities count nowhere (services, overview, widgets, hints). Only an upstream release can fix them."""
    try:
        stacks = D().safe("stacks") if config.enabled("portainer") else None
    except Exception:  # noqa: BLE001 - collector missing
        stacks = None
    if not stacks or not stacks.get("stacks"):
        return images
    infra = {c for s in stacks["stacks"] if not s["managed"] for c in s["containers"]}
    return {ref: i for ref, i in images.items() if not (set(i.get("containers") or []) and set(i["containers"]) <= infra)}


def scan_start() -> dict:
    d = D()
    d.require("image-scan")
    st = scan_status()
    if not st["installed"]:
        raise d.ApiError(409, f"The image scan is not set up on the server ({SCAN_UNIT} is missing - run ./keepwatch deploy).")
    if st["running"]:
        return {"ok": True, "running": True}
    d.run(["systemctl", "start", "--no-block", SCAN_UNIT], check=True)
    return {"ok": True, "running": True}


# --------------------------------------------------------------------------- Update / roll back

def _item(key: str) -> dict:
    for i in STATE["images"]:
        if i["key"] == key:
            return i
    raise D().ApiError(404, "The update check does not know this image. Run \"Check for updates\" first.")


def _wait_healthy(names: list[str], job: dict) -> tuple[bool, str]:
    """Up to HEALTH_WAIT seconds: all running and healthy (without a healthcheck: 15 s without restart)."""
    end = time.time() + HEALTH_WAIT
    last = "starting ..."
    while time.time() < end:
        data = _docker_json("inspect", *names) or []
        states = {c["Name"].lstrip("/"): c["State"] for c in data}
        ok, bad = True, []
        for n in names:
            st = states.get(n)
            if not st or not st.get("Running"):
                ok = False
                bad.append(f"{n} is not running")
                continue
            h = (st.get("Health") or {}).get("Status")
            if h == "healthy":
                continue
            if h is None:
                started = _created({"Created": st.get("StartedAt")}) or time.time()
                if time.time() - started >= 15:
                    continue
            ok = False
            bad.append(f"{n}: {h or 'starting'}")
        if ok:
            return True, "healthy"
        last = ", ".join(bad)
        job["step"] = f"waiting for \"healthy\" - {last}"
        time.sleep(4)
    return False, last


def _recreate(item: dict, pull: bool):
    d = D()
    if item["via"] == "portainer":
        d.require("portainer")
        stack = next((s for s in (d.portainer("GET", "/api/stacks") or []) if s.get("Name") == item["project"]), None)
        if not stack:
            raise d.ApiError(409, f"Portainer does not know the stack {item['project']}.")
        d._deploy(stack, stack.get("Env") or [], pull)
    elif item["via"] == "compose":
        conts = _docker_json("inspect", item["containers"][0]) or []
        labels = conts[0]["Config"]["Labels"] if conts else {}
        files = (labels.get("com.docker.compose.project.config_files") or "").split(",")
        wd = labels.get("com.docker.compose.project.working_dir") or "."
        project = labels.get("com.docker.compose.project")
        base = ["docker", "compose", "-p", project, "--project-directory", wd]
        for f in files:
            if f:
                base += ["-f", f]
        if pull:
            d.run([*base, "pull", *item["services"]], timeout=900, check=True)
        d.run([*base, "up", "-d", "--no-deps", *item["services"]], timeout=600, check=True)
    else:
        raise d.ApiError(409, "It is unclear how to recreate this image (no Compose project).")
    d.COLLECTORS["docker"].refresh()


def _prev_name(ref: str) -> str:
    registry, repo, _ = _split_ref(ref)
    return f"{repo if registry == 'docker.io' else registry + '/' + repo}:{PREV_TAG}"


def _dump_postgres(names: list[str], job: dict):
    DUMP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for n in names:
        job["step"] = f"backing up database ({n}) ..."
        target = DUMP_DIR / f"{n}-{stamp}.sql"
        p = D().run(["sh", "-c", f"docker exec {n} sh -c 'pg_dumpall -U \"${{POSTGRES_USER:-postgres}}\"' > {target}.part "
                                 f"&& mv {target}.part {target} && echo ok"], timeout=1800)
        if "ok" not in p:
            raise D().ApiError(500, f"pg_dumpall for {n} failed - nothing was updated.")
        olds = sorted(DUMP_DIR.glob(f"{n}-*.sql"))
        for old in olds[:-DUMP_KEEP]:
            old.unlink(missing_ok=True)


def _rollback_steps(item: dict, job: dict) -> tuple[bool, str]:
    d = D()
    prev = _prev_name(item["ref"])
    job["step"] = f"rolling back to {prev} ..."
    d.run(["docker", "tag", prev, item["ref"]], check=True)
    _recreate(item, pull=False)
    return _wait_healthy(item["containers"], job)


def _run_job(key: str, action: str):
    job = STATE["jobs"][key]
    d = D()
    try:
        item = _item(key)
        if action == "update":
            job["step"] = "saving the running version ..."
            old_id = d.run(["docker", "image", "inspect", "-f", "{{.Id}}", item["ref"]]).strip()
            d.run(["docker", "tag", old_id or item["ref"], _prev_name(item["ref"])], check=True)
            saved = _load_saved().get("previous") or {}
            saved[item["ref"]] = {"version": item["local"]["version"], "id": old_id, "at": time.time()}
            _save({"previous": saved})
            if _split_ref(item["ref"])[1].split("/")[-1] == "postgres":
                _dump_postgres(item["containers"], job)
            job["step"] = "pulling the new image and recreating ..."
            _recreate(item, pull=True)
            ok, why = _wait_healthy(item["containers"], job)
            if ok:
                job.update(state="ok", message=f"{item['ref']} is updated" + (
                    f" to {item['remote']['version']}." if (item.get("remote") or {}).get("version") else "."))
            else:
                ok2, why2 = _rollback_steps(item, job)
                job.update(state="rolledBack" if ok2 else "error",
                           message=(f"Not healthy after {HEALTH_WAIT // 60} min ({why}) - rolled back to the previous version automatically."
                                    if ok2 else f"Not healthy ({why}) and the rollback failed too ({why2}). Please check by hand."))
        else:
            ok, why = _rollback_steps(item, job)
            job.update(state="rolledBack" if ok else "error",
                       message=f"{item['ref']} runs the previous version again." if ok
                       else f"Rolled back, but not healthy: {why}")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        msg = getattr(e, "message", None) or str(e)
        job.update(state="error", message=msg)
    finally:
        job["finishedAt"] = time.time()
        job["step"] = None
        STATE["job_lock"].release()
        threading.Thread(target=check, daemon=True).start()
        _to_timeline(key, action, job)


def _to_timeline(key: str, action: str, job: dict):
    """Result of a job into the timeline (timeline.py)."""
    try:
        import timeline
        svc = None
        try:
            names = _item(key).get("containers") or []
            svc = timeline.service_of_container(names[0]) if names else None
        except Exception:  # noqa: BLE001
            pass
        state = job.get("state")
        if action == "update":
            title, level = {"ok": (f"Update installed: {key}", "info"),
                            "rolledBack": (f"Update rolled back: {key}", "warn")}.get(state, (f"Update failed: {key}", "crit"))
        else:
            title, level = (f"Back to the previous version: {key}", "info") if state == "rolledBack" \
                else (f"Rollback failed: {key}", "crit")
        # First timeline kind = services (timeline.KINDS); by position, so a rename there cannot break this.
        kind = "services" if "services" in timeline.KINDS else timeline.KINDS[0]
        timeline.add(kind, title, detail=job.get("message"), level=level, service=svc, source="updates",
                     t=job.get("startedAt"), t_end=job.get("finishedAt"), key=f"updates:{action}:{key}:{int(job.get('startedAt') or 0)}")
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def start(key: str, action: str) -> dict:
    d = D()
    item = _item(key)
    if action == "update":
        if item["status"] == "major":
            raise d.ApiError(409, "Major version jump - this is not installed with one click.")
        if item["status"] != "update":
            raise d.ApiError(409, "No update is known for this image.")
    elif not item.get("previous"):
        raise d.ApiError(409, f"There is no previous version (:{PREV_TAG}) of this image.")
    if not STATE["job_lock"].acquire(blocking=False):
        raise d.ApiError(409, "An update or cleanup is already running. Please wait a moment.")
    STATE["jobs"][key] = {"key": key, "action": action, "state": "running", "step": "starting ...",
                          "startedAt": time.time(), "finishedAt": None, "message": None}
    threading.Thread(target=_run_job, args=(key, action), daemon=True, name=f"update-{action}").start()
    return {"ok": True, "job": STATE["jobs"][key]}


# --------------------------------------------------------------------------- Cleanup

def _df_total() -> float:
    total = 0.0
    for line in D().run(["docker", "system", "df", "--format", "{{json .}}"], timeout=90).splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("Type") in ("Images", "Containers", "Build Cache"):
            total += D().parse_size(row.get("Size", "0")) or 0
    return total


def cleanup_info(force: bool = False) -> dict:
    if not force and STATE["cleanup"] and time.time() - STATE["cleanup_at"] < 60:
        return STATE["cleanup"]
    d = D()
    df = _docker_json("system", "df", "-v", "--format", "{{json .}}", timeout=120) or {}
    size = lambda s: d.parse_size(s or "0") or 0  # noqa: E731
    imgs = df.get("Images") or []
    unused = [i for i in imgs if str(i.get("Containers", "0")) == "0" and i.get("Tag") != PREV_TAG]
    prev = [i for i in imgs if i.get("Tag") == PREV_TAG]
    stopped = [c for c in (df.get("Containers") or []) if c.get("State") != "running"]
    parts = {"images": 0.0, "containers": 0.0, "volumes": 0.0, "buildCache": 0.0}
    reclaim_cache = 0.0
    for line in d.run(["docker", "system", "df", "--format", "{{json .}}"], timeout=90).splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        key = {"Images": "images", "Containers": "containers", "Local Volumes": "volumes", "Build Cache": "buildCache"}.get(row.get("Type"))
        if key:
            parts[key] = size(row.get("Size"))
            if key == "buildCache":
                reclaim_cache = size((row.get("Reclaimable") or "0").split(" ")[0])
    info = {
        "total": sum(parts.values()), "parts": parts,
        "buildCache": {"bytes": reclaim_cache},
        "images": {"bytes": sum(size(i.get("UniqueSize")) for i in unused), "count": len(unused),
                   "items": [{"ref": f"{i.get('Repository')}:{i.get('Tag')}" if i.get("Repository") != "<none>" else i.get("ID", "")[:19],
                              "size": size(i.get("UniqueSize"))} for i in unused]},
        "kept": [{"ref": f"{i.get('Repository')}:{i.get('Tag')}", "size": size(i.get("UniqueSize"))} for i in prev],
        "containers": {"bytes": sum(size(c.get("Size")) for c in stopped), "count": len(stopped),
                       "items": [c.get("Names") for c in stopped]},
    }
    STATE["cleanup"], STATE["cleanup_at"] = info, time.time()
    return info


def cleanup(body: dict) -> dict:
    d = D()
    want = {k: bool(body.get(k)) for k in ("buildCache", "images", "containers")}
    if not any(want.values()):
        raise d.ApiError(400, "Nothing selected.")
    if not STATE["job_lock"].acquire(blocking=False):
        raise d.ApiError(409, "An update is running. Please clean up afterwards.")
    try:
        before = _df_total()
        if want["containers"]:
            d.run(["docker", "container", "prune", "-f"], timeout=300, check=True)
        if want["images"]:
            df = _docker_json("system", "df", "-v", "--format", "{{json .}}", timeout=120) or {}
            for i in df.get("Images") or []:
                if str(i.get("Containers", "0")) != "0" or i.get("Tag") == PREV_TAG:
                    continue
                ref = i.get("ID") if i.get("Repository") in (None, "<none>") else f"{i['Repository']}:{i['Tag']}"
                d.run(["docker", "rmi", ref], timeout=120)  # no -f: whatever is still needed stays
        if want["buildCache"]:
            d.run(["docker", "builder", "prune", "-af"], timeout=900, check=True)
        after = _df_total()
    finally:
        STATE["job_lock"].release()
    freed = max(0.0, before - after)
    d.COLLECTORS["docker"].refresh()
    STATE["cleanup"] = None
    gb = freed / 1e9
    return {"ok": True, "freed": freed,
            "message": f"{gb:.1f} GB freed." if gb >= 0.1 else f"{freed / 1e6:.0f} MB freed."}


# --------------------------------------------------------------------------- Routes

def get(path: str):
    if path == "/api/updates":
        return status()  # {"enabled": false} without docker
    if path == "/api/cleanup":
        D().require("docker")
        return cleanup_info()
    raise D().ApiError(404, "Unknown endpoint.")


def post(path: str, body: dict):
    d = D()
    if path == "/api/updates/scan":
        return scan_start()
    d.require("docker")
    if path == "/api/updates/check":
        if not STATE["checking"]:
            threading.Thread(target=check, daemon=True, name="update-check").start()
            time.sleep(0.2)
        return {"ok": True, "checking": True}
    if path in ("/api/updates/apply", "/api/updates/rollback"):
        key = str(body.get("key") or "")
        if not key:
            raise d.ApiError(400, "key is missing.")
        return start(key, "update" if path.endswith("apply") else "rollback")
    if path == "/api/cleanup":
        return cleanup(body)
    raise d.ApiError(404, "Unknown endpoint.")
