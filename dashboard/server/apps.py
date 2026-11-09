""""New app": from a Git repository to a live site in one job (needs modules proxy, docker, portainer).

Portainer clones the repository and starts its compose file as a new stack, then the job waits for the
container and hands over to the "New site" job in hosts.py (proxy host, certificate, HTTPS, test request).

Nothing stays half created: if a later step fails, the proxy host and certificate are rolled back by
hosts.py and the stack is deleted here. Volumes and built images stay, Portainer does not remove them.

The access token of a private repository goes to Portainer, which stores it for later redeploys. It is
kept out of the job, because the job is sent to the UI, and out of error messages for the same reason.
"""
from __future__ import annotations

import re
import threading
import time
import traceback

import hosts
from hosts import D

# Credentials in the URL would end up in Portainer's stack list in plain text: the token has its own field.
REPO = re.compile(r"^https://[^\s/@:]+(?::\d{1,5})?/[^\s@?#]+$")
BRANCH = re.compile(r"^(?!-)[\w./-]{1,200}$")
COMPOSE = re.compile(r"^(?![/-])[\w./-]{1,200}$")
STACK = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
USER = re.compile(r"^[^\s:]{1,100}$")

STEPS = [("stack", "Deploy from Git"), ("container", "Wait for the container")]

# A build on a small VPS takes minutes, and Portainer only answers when the stack is up.
DEPLOY_TIMEOUT = 900
CONTAINER_WAIT = 150
# The container is up but its app still boots: how long to wait for a listening port before trusting EXPOSE.
PORT_WAIT = 45
# Names that usually mean "the part people open" when a stack has several reachable containers.
FRONT = ("web", "app", "frontend", "front", "site", "nginx", "server", "ui")


def _err(status: int, msg: str) -> Exception:
    return D.ApiError(status, msg)


def _portainer_status() -> dict:
    if not D.portainer_token():
        return {"connected": False, "reason": "No Portainer token set."}
    try:
        D.portainer("GET", "/api/stacks")
        return {"connected": True, "reason": None}
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "reason": getattr(e, "message", None) or str(e)}


def wizard_data() -> dict:
    return {**hosts.wizard_data(), "portainer": _portainer_status()}


def _name_from(url: str) -> str:
    last = url.rstrip("/").rsplit("/", 1)[-1]
    last = re.sub(r"\.git$", "", last).lower()
    return re.sub(r"[^a-z0-9_-]+", "-", last).strip("-_")


def _git(body: dict) -> dict:
    url = str(body.get("repoUrl", "")).strip().rstrip("/")
    if not REPO.match(url):
        raise _err(400, "Enter the repository as an https:// address, without a login in it.")
    branch = str(body.get("branch") or "main").strip()
    if not BRANCH.match(branch) or ".." in branch:
        raise _err(400, "That is not a valid branch name.")
    compose = str(body.get("composeFile") or "docker-compose.yml").strip()
    if not COMPOSE.match(compose) or ".." in compose:
        raise _err(400, "The compose file must be a relative path inside the repository.")
    name = str(body.get("stackName") or _name_from(url)).strip()
    if not STACK.match(name):
        raise _err(400, "The stack name may contain lowercase letters, digits, - and _ and must start with a letter or digit.")
    token = str(body.get("gitToken") or "").strip()
    user = str(body.get("gitUsername") or "git").strip()
    if not USER.match(user):
        raise _err(400, "That is not a valid Git user name.")
    return {"url": url, "branch": branch, "compose": compose, "name": name, "user": user, "token": token}


def _target(body: dict) -> dict:
    container = str(body.get("container") or "").strip()
    raw = body.get("port")
    port = None
    if raw not in (None, ""):
        try:
            port = int(raw)
        except (TypeError, ValueError):
            raise _err(400, "The port must be a number.")
        if not 1 <= port <= 65535:
            raise _err(400, "The port must be between 1 and 65535.")
    return {"container": container, "port": port}


def _ssl() -> dict:
    """Always HTTPS. HSTS for subdomains stays off: there is no switch here, and it would bind every other subdomain."""
    return {**hosts.defaults()["values"], "certificate": True, "sslForced": True, "http2": True, "blockExploits": True,
            "hstsSubdomains": False}


def _endpoint() -> int:
    docker = [e for e in (D.portainer("GET", "/api/endpoints") or []) if e.get("Type") in (1, 2)]
    if not docker:
        raise _err(409, "Portainer has no Docker environment to deploy to.")
    local = next((e for e in docker if str(e.get("URL", "")).startswith("unix://")), docker[0])
    return int(local["Id"])


def _find_stack(name: str) -> dict | None:
    return next((s for s in (D.portainer("GET", "/api/stacks") or []) if s.get("Name") == name), None)


def create_app(body: dict):
    git = _git(body)
    target = _target(body)
    site = hosts.validate_site({**body, "ssl": _ssl()})
    hosts._token()  # check access first so the error comes right away
    endpoint = _endpoint()
    if _find_stack(git["name"]):
        raise _err(409, f'Portainer already has a stack called "{git["name"]}". Choose another name under Advanced.')
    if any(c["project"] == git["name"] for c in hosts.targets()["containers"]):
        raise _err(409, f'Containers of a compose project called "{git["name"]}" are already running. Choose another name under Advanced.')
    job = hosts.new_job(site["domain"], site["domains"], STEPS + hosts.STEPS)
    job["stack"] = git["name"]
    threading.Thread(target=_run, args=(job, git, target, site, endpoint), daemon=True,
                     name=f"new-app-{job['id']}").start()
    return {"ok": True, "job": job["id"]}


def _scrubbed(e: Exception, token: str) -> Exception:
    """Portainer quotes git's error output, and git's output can contain the address it was given."""
    msg = getattr(e, "message", None)
    if msg is None:
        traceback.print_exc()
        msg = str(e)
    return _err(502, msg.replace(token, "***") if token else msg)


def _deploy(git: dict, endpoint: int) -> None:
    D.portainer("POST", f"/api/stacks/create/standalone/repository?endpointId={endpoint}", {
        "name": git["name"], "repositoryURL": git["url"],
        "repositoryReferenceName": git["branch"] if git["branch"].startswith("refs/") else f"refs/heads/{git['branch']}",
        "composeFile": git["compose"], "repositoryAuthentication": bool(git["token"]),
        "repositoryUsername": git["user"] if git["token"] else "", "repositoryPassword": git["token"],
        "env": [], "tlsskipVerify": False,
    }, timeout=DEPLOY_TIMEOUT)


def _rank(c: dict, stack: str) -> tuple:
    names = {c["name"], c["service"] or ""}
    return (stack not in names, not any(n in FRONT for n in names), not c["listening"], c["name"])


def _pick_port(c: dict) -> int | None:
    # EXPOSE and reality can differ (a base image exposing 80 next to the app's own port), so what listens wins.
    both = [p for p in c["listening"] if p in c["exposed"]]
    if both:
        return both[0]
    if c["listening"]:
        return c["listening"][0]
    return c["suggestedPort"]


def _wait_for_container(job: dict, stack: str, target: dict) -> tuple[dict, int]:
    start = time.time()
    seen_at = None
    while time.time() - start < CONTAINER_WAIT:
        t = hosts.targets()
        ours = [c for c in t["containers"] if c["project"] == stack]
        if ours:
            seen_at = seen_at or time.time()
            reach = [c for c in ours if c["reachable"]]
            # A compose file does not join a network by itself later, but containers can come up one by one.
            if not reach and time.time() - seen_at > 10:
                net = t["npm"]["join"] or "the network of the Proxy Manager"
                raise _err(400, f"No container of this stack shares a network with the Proxy Manager. Add {net} as an "
                                "external network to the service in the compose file and deploy again.")
            if reach:
                if target["container"]:
                    c = next((x for x in reach if target["container"] in (x["name"], x["service"])), None)
                    if not c and time.time() - seen_at > 15:
                        names = ", ".join(x["name"] for x in reach)
                        raise _err(400, f'No reachable container called "{target["container"]}". Reachable: {names}.')
                else:
                    c = sorted(reach, key=lambda x: _rank(x, stack))[0]
                if c and (target["port"] or c["listening"] or time.time() - seen_at > PORT_WAIT):
                    port = target["port"] or _pick_port(c)
                    if not port:
                        raise _err(400, f"{c['name']} neither listens on a port nor exposes one. Set the port under Advanced.")
                    others = len(reach) - 1
                    hosts._step(job, "container", "ok", f"{c['name']}:{port}"
                                + (f" · chosen from {others + 1} containers, change it under Advanced" if others and not target["container"] else ""))
                    return c, port
        time.sleep(3)
    raise _err(504, "Portainer started the stack, but no container is running. Check its logs under Services.")


def _undo_stack(job: dict, name: str, endpoint: int) -> None:
    try:
        s = _find_stack(name)
        if not s:
            return
        D.portainer("DELETE", f"/api/stacks/{int(s['Id'])}?endpointId={endpoint}", timeout=180)
        job["rollback"].append({"label": f"Stack {name} removed again", "ok": True})
    except Exception as e:  # noqa: BLE001
        job["rollback"].append({"label": f"Stack {name} could not be removed - please delete it in Portainer: "
                                         f"{getattr(e, 'message', e)}", "ok": False})


def _refresh() -> None:
    for name in ("docker", "stacks"):
        try:
            D.COLLECTORS[name].refresh()
        except Exception:  # noqa: BLE001
            pass


def _run(job: dict, git: dict, target: dict, site: dict, endpoint: int) -> None:
    undo = lambda: _undo_stack(job, git["name"], endpoint)  # noqa: E731
    try:
        hosts._step(job, "stack", "running", "Portainer clones the repository and starts the stack. A build can take a few minutes ...")
        _deploy(git, endpoint)
        hosts._step(job, "stack", "ok", f"{git['name']} · {git['branch']} · {git['compose']}")
        hosts._step(job, "container", "running")
        container, port = _wait_for_container(job, git["name"], target)
    except Exception as e:  # noqa: BLE001
        hosts.fail_job(job, _scrubbed(e, git["token"]))
        undo()
        job["state"] = "failed"
        job["finishedAt"] = time.time()
        _refresh()
        return
    hosts._run_job(job, {**site, "host": container["name"], "port": port, "scheme": "http"}, on_fail=undo)
    _refresh()


def route(method: str, path: str, query: dict, body: dict):  # noqa: ARG001
    D.require("proxy", "docker", "portainer")
    if method == "GET" and path == "/api/apps/new":
        return wizard_data()
    m = re.match(r"^/api/apps/jobs/([0-9a-f]{12})$", path)
    if method == "GET" and m:
        return hosts.get_job(m.group(1))
    if method == "POST" and path == "/api/apps":
        return create_app(body)
    raise _err(404, "No such endpoint.")
