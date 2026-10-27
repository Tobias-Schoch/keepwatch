#!/usr/bin/env python3
"""Keepwatch versions and updates from the dashboard.

One file for three places, Python 3.8+, standard library only:

  your computer (./keepwatch deploy)
    python3 lib/kwupdate.py version-info <repo> [--ui-stale]   VERSION.json for the server copy
    python3 lib/kwupdate.py ui-fingerprint <repo>              fingerprint of the dashboard UI sources
  GitHub Actions (.github/workflows/dashboard-ui.yml)
    python3 lib/kwupdate.py ui-fingerprint .                   name of the prebuilt UI it publishes
  the server, as root - installed as /usr/local/sbin/keepwatch-self-update by the dashboard module
    keepwatch-self-update check        latest commit of KW_SELF_UPDATE_BRANCH on GitHub -> update.json
    keepwatch-self-update apply <sha>  install exactly that commit (keepwatch-self-update@<sha>.service)

Where things are on the server:
  /opt/keepwatch/VERSION.json        what runs: {commit, dirty, date, subject, repo, ui, source, at}
                                     written by deploy and by apply
  /var/lib/keepwatch/update.json     last check and the state of the last update (read by the dashboard)
  /var/lib/keepwatch/self-update.log output of the last update
  /run/keepwatch.lock                one deploy or update at a time (lib/apply.sh, ./keepwatch deploy)

apply, step by step (it runs as its own systemd unit, so the dashboard restarting on the way
does not stop it):
  1. Only the commit the last check showed, and only if nothing was deployed since.
  2. Download https://codeload.github.com/<repo>/tar.gz/<sha> - the exact commit, never a branch -
     check that it holds exactly <name>-<sha>/ (and the commit id git archive records), unpack it
     next to /opt/keepwatch.
  3. The dashboard UI is built, not in git (the server has no Node.js): reuse the installed build
     when the UI sources did not change, otherwise the build GitHub Actions published for exactly
     these sources (release "dashboard-ui", asset keepwatch-ui-<fingerprint>.tar.gz). Missing: stop.
  4. The server's own /etc/keepwatch/keepwatch.conf goes into the new copy, then the copies swap
     places (/opt/keepwatch -> /opt/keepwatch.prev) and lib/apply.sh runs as on a deploy.
  5. apply.sh failed: the previous copy goes back and apply.sh runs again with it.
Nothing is changed before step 4; until then a failure only leaves a message.

For tests only: KW_SELF_UPDATE_TARBALL_URL and KW_SELF_UPDATE_UI_URL replace the two download
URLs (https:// or file://, with {repo}, {sha} and {fp} filled in) - e.g. through
`systemctl set-environment` on a test machine.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path("/opt/keepwatch")
PREV = Path("/opt/keepwatch.prev")
STAGE = Path("/opt/keepwatch.new")
FAILED = Path("/opt/keepwatch.failed")
ETC_CONF = Path("/etc/keepwatch/keepwatch.conf")
STATE_DIR = Path("/var/lib/keepwatch")
STATE = STATE_DIR / "update.json"
STATE_LOCK = STATE_DIR / "update.json.lock"
LOG = STATE_DIR / "self-update.log"
DEPLOY_LOG = STATE_DIR / "deploys.jsonl"
RUN_LOCK = "/run/keepwatch.lock"
API = "https://api.github.com"
TARBALL = "https://codeload.github.com/{repo}/tar.gz/{sha}"
UI_TAG = "dashboard-ui"
UI_ASSET = "https://github.com/{repo}/releases/download/" + UI_TAG + "/keepwatch-ui-{fp}.tar.gz"
UA = "keepwatch-self-update (+https://github.com/Tobias-Schoch/keepwatch)"

SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
BRANCH = re.compile(r"^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$")
MAX_TARBALL = 64 << 20        # the repository is ~1 MB
MAX_UNPACKED = 256 << 20
MAX_MEMBERS = 20000
MAX_CHANGES = 20              # subjects kept for "What's new"
APPLY_TIMEOUT = 45 * 60
LOG_TAIL = 40


# --------------------------------------------------------------------------- Shared

def ui_fingerprint(root: Path):
    """Fingerprint of everything the dashboard UI is built from (dashboard/web without
    node_modules, dist and dot files). The same sources give the same build, so this names the
    prebuilt UI on GitHub and tells whether the installed build fits a new version.
    A contract between deploy, CI and the server: change it only together with a new asset name."""
    web = Path(root) / "dashboard" / "web"
    if not (web / "package.json").is_file():
        return None
    files = []
    for dirpath, dirnames, filenames in os.walk(str(web)):
        rel = Path(dirpath).relative_to(web)
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not (rel == Path(".") and d in ("node_modules", "dist"))]
        files += [(rel / f).as_posix() for f in filenames if not f.startswith(".")]
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode() + b"\0" + hashlib.sha256((web / rel).read_bytes()).digest())
    return h.hexdigest()[:32]


def github_repo(url: str):
    """owner/repo of a github.com remote URL (https, ssh or scp form), else None."""
    m = re.match(r"^(?:https?://(?:[^@/]+@)?github\.com/|ssh://git@github\.com(?::\d+)?/|git@github\.com:)"
                 r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$", url.strip())
    return m.group(1) if m else None


def read_json(path: Path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path: Path, data: dict, mode: int = 0o644):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    os.chmod(str(tmp), mode)
    os.replace(str(tmp), str(path))


# --------------------------------------------------------------------------- Your computer

def git(repo: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def version_info(repo: Path, ui_stale: bool) -> dict:
    """What deploy copies to the server as VERSION.json. ui: null when the UI build that goes
    along does not match the sources (sources changed, npm missing - deploy says so)."""
    built = (repo / "dashboard" / "web" / "dist" / "index.html").is_file()
    info = {"commit": None, "dirty": False, "date": None, "subject": None, "repo": None,
            "ui": ui_fingerprint(repo) if built and not ui_stale else None, "source": "deploy", "at": int(time.time())}
    sha = git(repo, "rev-parse", "HEAD")
    if not SHA.match(sha):
        return info
    log = git(repo, "log", "-1", "--format=%ct%n%s").split("\n", 1)
    info.update(commit=sha, dirty=bool(git(repo, "status", "--porcelain")),
                date=int(log[0]) if log[0].isdigit() else None, subject=log[1] if len(log) > 1 else None,
                repo=github_repo(git(repo, "remote", "get-url", "origin")))
    return info


# --------------------------------------------------------------------------- Server: configuration and state

LINE = re.compile(r'^\s*(?:export\s+)?(KW_[A-Z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|\'([^\']*)\'|([^\s#]*))')


def conf() -> dict:
    """Defaults from the example, the server's keepwatch.conf on top (as lib/apply.sh reads them)."""
    out = {}
    for p in (ROOT / "keepwatch.conf.example", ETC_CONF):
        try:
            text = p.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            m = LINE.match(line)
            if m:
                dq, sq, bare = m.group(2), m.group(3), m.group(4)
                out[m.group(1)] = re.sub(r"\\(.)", r"\1", dq) if dq is not None else sq if sq is not None else bare
    return out


def source() -> tuple:
    """(repo, branch) from KW_SELF_UPDATE_REPO / KW_SELF_UPDATE_BRANCH. repo "" = turned off."""
    c = conf()
    repo, branch = c.get("KW_SELF_UPDATE_REPO", "").strip(), (c.get("KW_SELF_UPDATE_BRANCH") or "main").strip()
    if repo and not REPO.match(repo):
        raise Fail(f"KW_SELF_UPDATE_REPO=\"{repo}\" is not a GitHub owner/repo.")
    if not BRANCH.match(branch):
        raise Fail(f"KW_SELF_UPDATE_BRANCH=\"{branch}\" is not a branch name.")
    return repo, branch


def installed() -> dict:
    return read_json(ROOT / "VERSION.json")


class Fail(Exception):
    """A failure with a message for the dashboard."""


class _StateLock:
    """check and apply both write update.json (read-modify-write under this lock)."""

    def __enter__(self):
        import fcntl
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(str(STATE_LOCK), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        os.close(self.fd)


def update_state(**fields) -> dict:
    with _StateLock():
        st = read_json(STATE)
        st.update(fields)
        write_json(STATE, st)
        return st


def update_run(**fields) -> dict:
    """Fields of the running/last update (state.run), with a timestamp for "is it still alive?"."""
    with _StateLock():
        st = read_json(STATE)
        run = st.get("run") if isinstance(st.get("run"), dict) else {}
        run.update(fields, updatedAt=int(time.time()))
        st["run"] = run
        write_json(STATE, st)
        return st


# --------------------------------------------------------------------------- Server: HTTP

class Http(Fail):
    def __init__(self, status: int, message: str, headers=None):
        super().__init__(message)
        self.status, self.headers = status, headers or {}


def http_get(url: str, headers: dict | None = None, limit: int = 8 << 20, timeout: float = 30) -> tuple:
    """(status, headers, body). Only https:// (certificates checked) and file:// (tests)."""
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme == "file":
        path = Path(urllib.parse.unquote(urllib.parse.urlsplit(url).path))
        if not path.is_file():
            raise Http(404, f"{path} does not exist.")
        if path.stat().st_size > limit:
            raise Fail(f"{path} is larger than {limit >> 20} MB.")
        return 200, {}, path.read_bytes()
    if scheme != "https":
        raise Fail(f"Only https:// downloads: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - https only, see above
            if urllib.parse.urlsplit(r.geturl()).scheme != "https":
                raise Fail(f"{url} redirected away from https.")
            body = r.read(limit + 1)
            if len(body) > limit:
                raise Fail(f"{url} is larger than {limit >> 20} MB.")
            return r.status, dict(r.headers.items()), body
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, dict(e.headers.items()), b""
        raise Http(e.code, f"HTTP {e.code} from {urllib.parse.urlsplit(url).netloc}", dict(e.headers.items()))
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise Fail(f"Could not reach {urllib.parse.urlsplit(url).netloc} ({reason}). Is the server online?")


def gh(path: str, etag: str | None = None) -> tuple:
    """GitHub REST API without a token (60 requests per hour and address - a check needs one or two)."""
    hdr = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if etag:
        hdr["If-None-Match"] = etag  # an unchanged answer (304) does not count against the limit
    try:
        status, headers, body = http_get(API + path, hdr, timeout=20)
    except Http as e:
        h = {k.lower(): v for k, v in e.headers.items()}
        if e.status == 429 or (e.status == 403 and h.get("x-ratelimit-remaining") == "0"):
            reset = h.get("x-ratelimit-reset", "")
            retry = int(reset) if reset.isdigit() else int(time.time()) + int(h.get("retry-after", "3600") or 3600)
            err = Fail("GitHub's limit for requests without a login is used up for now.")
            err.retry_at = retry  # type: ignore[attr-defined]
            raise err
        if e.status in (404, 422):
            raise Http(404, "not found")
        raise Fail(f"GitHub answered {e.status}.")
    data = json.loads(body) if body else None
    return status, headers, data


def subject(message: str) -> str:
    """First line of a commit message; for a merged pull request its title."""
    lines = [x.strip() for x in (message or "").splitlines() if x.strip()]
    if len(lines) > 1 and re.match(r"^Merge (pull request|branch) ", lines[0]):
        return lines[1][:200]
    return (lines[0] if lines else "")[:200]


def iso_time(s) -> int | None:
    import datetime as dt
    try:
        return int(dt.datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp())
    except ValueError:
        return None


# --------------------------------------------------------------------------- Server: check

def check() -> dict:
    """Latest commit of the branch; if it is not what runs, how the two relate and what changed."""
    try:
        repo, branch = source()
    except Fail as e:
        return update_state(error=str(e), errorAt=int(time.time()))
    if not repo:
        return update_state(error=None, available=False, repo="", latest=None)
    have = installed()
    old = read_json(STATE)
    same_source = old.get("repo") == repo and old.get("branch") == branch
    try:
        status, headers, data = gh(f"/repos/{repo}/commits/{urllib.parse.quote(branch, safe='')}",
                                   old.get("etag") if same_source and old.get("latest") else None)
        if status == 304:
            latest = old["latest"]
        else:
            c = data.get("commit") or {}
            latest = {"commit": data["sha"], "subject": subject(c.get("message", "")),
                      "date": iso_time((c.get("committer") or {}).get("date"))}
        etag = {k.lower(): v for k, v in headers.items()}.get("etag")
        rel = relation(repo, have, latest, old if same_source else {})
    except Http:
        return update_state(error=f"{repo} (branch {branch}) was not found on GitHub. Check KW_SELF_UPDATE_REPO and "
                                  "KW_SELF_UPDATE_BRANCH - a private repository cannot be checked without a login.",
                            errorAt=int(time.time()), retryAt=None, repo=repo, branch=branch)
    except Fail as e:
        return update_state(error=str(e), errorAt=int(time.time()), retryAt=getattr(e, "retry_at", None))
    except (KeyError, TypeError, ValueError) as e:
        return update_state(error=f"Unexpected answer from GitHub ({e}).", errorAt=int(time.time()))
    return update_state(repo=repo, branch=branch, latest=latest, etag=etag, checkedAt=int(time.time()),
                        error=None, errorAt=None, retryAt=None,
                        checkedFor={"commit": have.get("commit"), "dirty": bool(have.get("dirty"))}, **rel)


def relation(repo: str, have: dict, latest: dict, old: dict) -> dict:
    """available: the branch has something this server does not run.
    localBuild: deployed with uncommitted changes, or a commit that is not on the branch."""
    mine, theirs, dirty = have.get("commit"), latest["commit"], bool(have.get("dirty"))
    if not mine:
        return {"available": True, "localBuild": True, "aheadBy": None, "changes": [], "moreChanges": 0}
    if mine == theirs:
        return {"available": False, "localBuild": dirty, "aheadBy": 0, "changes": [], "moreChanges": 0}
    key = f"{mine}...{theirs}"
    if old.get("compareKey") == key and isinstance(old.get("changes"), list):
        cmp = {k: old.get(k) for k in ("available", "localBuild", "aheadBy", "changes", "moreChanges")}
        return {**cmp, "localBuild": dirty or bool(old.get("notOnBranch")), "compareKey": key,
                "notOnBranch": bool(old.get("notOnBranch"))}
    try:
        _, _, data = gh(f"/repos/{repo}/compare/{mine}...{theirs}")
    except Http:  # GitHub does not know the installed commit: a local commit, or another repository
        return {"available": True, "localBuild": True, "aheadBy": None, "changes": [], "moreChanges": 0,
                "compareKey": key, "notOnBranch": True}
    ahead = int(data.get("ahead_by") or 0)
    off_branch = data.get("status") in ("diverged", "behind")
    commits = [subject((c.get("commit") or {}).get("message", "")) for c in data.get("commits") or []]
    commits = [s for s in reversed(commits) if s]  # newest first
    return {"available": ahead > 0, "localBuild": dirty or off_branch, "aheadBy": ahead,
            "changes": commits[:MAX_CHANGES], "moreChanges": max(0, ahead - min(len(commits), MAX_CHANGES)),
            "compareKey": key, "notOnBranch": off_branch}


# --------------------------------------------------------------------------- Server: apply

def run_lock():
    """/run/keepwatch.lock - the same lock lib/apply.sh and ./keepwatch deploy take (flock)."""
    import fcntl
    fd = os.open(RUN_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def _safe_members(found: list, top: str) -> list:
    """Every member below `top`/, nothing absolute, no "..", only files, directories and links
    that stay inside. Raises Fail otherwise."""
    members, total = [], 0
    for m in found:
        if len(members) >= MAX_MEMBERS:
            raise Fail("The archive has too many files.")
        parts = m.name.split("/")
        if m.name.startswith("/") or ".." in parts or (parts[0] != top):
            raise Fail(f"Unexpected path in the archive: {m.name[:120]}")
        if not (m.isfile() or m.isdir() or m.issym()):
            raise Fail(f"Unexpected file type in the archive: {m.name[:120]}")
        if m.issym():
            target = os.path.normpath(os.path.join(os.path.dirname(m.name), m.linkname))
            if m.linkname.startswith("/") or not (target == top or target.startswith(top + "/")):
                raise Fail(f"A link in the archive points outside: {m.name[:120]}")
        total += max(0, m.size)
        if total > MAX_UNPACKED:
            raise Fail("The archive unpacks to more than 256 MB.")
        members.append(m)
    return members


def _extract(tar: tarfile.TarFile, members: list, top: str, dest: Path):
    """Unpack the members of top/ into dest (without top/). Owner root, nobody else may write."""
    for m in members:
        rel = m.name[len(top):].lstrip("/")
        if not rel:
            continue
        target = dest / rel
        if m.isdir():
            target.mkdir(parents=True, exist_ok=True)
            os.chmod(str(target), 0o755)
        elif m.issym():
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(m.linkname, str(target))
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tar.extractfile(m)
            with open(str(target), "wb") as f:
                shutil.copyfileobj(src, f)
            os.chmod(str(target), 0o755 if m.mode & 0o111 else 0o644)


def _swap(a: Path, b: Path):
    """Exchange two directories in one step (renameat2 RENAME_EXCHANGE): /opt/keepwatch never
    disappears, not even for a moment (the backup and the dashboard read from it). Falls back
    to two renames where the kernel or libc cannot."""
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        fn = libc.renameat2
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        if fn(-100, str(a).encode(), -100, str(b).encode(), 2) == 0:  # AT_FDCWD, RENAME_EXCHANGE
            return
    except (OSError, AttributeError):
        pass
    tmp = a.with_name(a.name + ".swap")
    os.rename(str(a), str(tmp))
    os.rename(str(b), str(a))
    os.rename(str(tmp), str(b))


def _rm(path: Path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(str(path))


class Run:
    """One update: progress into update.json, output into self-update.log."""

    def __init__(self, sha: str):
        self.sha, self.tail, self.module = sha, [], None
        LOG.parent.mkdir(parents=True, exist_ok=True)
        self.log = open(str(LOG), "w", encoding="utf-8", errors="replace")
        self._last = 0.0

    def say(self, line: str, flush: bool = False):
        line = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line.rstrip("\n"))
        self.log.write(line + "\n")
        self.log.flush()
        print(line, flush=True)  # the journal of keepwatch-self-update@<sha>
        m = re.match(r"^== (.+)$", line)
        if m:
            self.module = m.group(1).strip()
        self.tail = (self.tail + [line])[-LOG_TAIL:]
        if flush or time.time() - self._last > 1.5:
            self._last = time.time()
            update_run(log=self.tail, module=self.module)

    def step(self, step: str, text: str):
        self.say(f"-- {text}")
        update_run(step=step, log=self.tail, module=None if step != "apply" else self.module)

    def apply_sh(self, root: Path, env: dict) -> int:
        """lib/apply.sh of `root`, output line by line into the log and the state."""
        p = subprocess.Popen(["bash", str(root / "lib" / "apply.sh")], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, cwd="/", text=True, errors="replace", bufsize=1)
        killer = threading.Timer(APPLY_TIMEOUT, p.kill)
        killer.start()
        try:
            for line in p.stdout:
                self.say(line)
            return p.wait()
        finally:
            killer.cancel()
            update_run(log=self.tail)


def apply(sha: str) -> int:
    if not SHA.match(sha or ""):
        print("usage: keepwatch-self-update apply <40-character commit id>", file=sys.stderr)
        return 2
    if os.geteuid() != 0:
        print("Run as root (keepwatch-self-update@<sha>.service).", file=sys.stderr)
        return 1
    lock = run_lock()
    if lock is None:
        st = read_json(STATE)
        if (st.get("run") or {}).get("state") != "running":
            update_run(state="failed", target=sha, startedAt=int(time.time()), finishedAt=int(time.time()), rolledBack=False, log=[],
                       message="Another deploy or update is running on the server right now. Try again in a few minutes.")
        return 1
    run = Run(sha)
    st = read_json(STATE)
    latest = st.get("latest") or {}
    update_run(state="running", step="prepare", target=sha, targetDate=latest.get("date") if latest.get("commit") == sha else None,
               startedAt=int(time.time()), finishedAt=None, message=None, rolledBack=False, log=[], module=None,
               unit=f"keepwatch-self-update@{sha}.service")
    try:
        prepared = prepare(run, sha, st)
    except Fail as e:
        run.say(f"error: {e}", flush=True)
        _rm(STAGE)
        update_run(state="failed", step=None, finishedAt=int(time.time()), message=f"{e} Nothing was changed.")
        return 1
    except Exception as e:  # noqa: BLE001 - whatever it is, the dashboard has to hear about it
        run.say(f"error: {type(e).__name__}: {e}", flush=True)
        _rm(STAGE)
        update_run(state="failed", step=None, finishedAt=int(time.time()), message=f"The update could not be prepared ({e}). Nothing was changed.")
        return 1
    return install(run, sha, prepared)


def prepare(run: Run, sha: str, st: dict) -> dict:
    """Steps 1-3: everything up to a complete new copy in /opt/keepwatch.new. Changes nothing else."""
    repo, branch = source()
    if not repo:
        raise Fail("Updates from the dashboard are off (KW_SELF_UPDATE_REPO is empty).")
    have = installed()
    if (st.get("latest") or {}).get("commit") != sha or st.get("repo") != repo:
        raise Fail("This is not the update the last check found. Check again.")
    seen = st.get("checkedFor") or {}
    if seen.get("commit") != have.get("commit") or bool(seen.get("dirty")) != bool(have.get("dirty")):
        raise Fail("Keepwatch was deployed from a computer since the last check. Check again.")

    run.step("download", f"Download {repo} at {sha[:12]}")
    url = os.environ.get("KW_SELF_UPDATE_TARBALL_URL") or TARBALL
    url = url.format(repo=repo, sha=sha)
    try:
        _, _, body = http_get(url, limit=MAX_TARBALL, timeout=120)
    except Http as e:
        raise Fail(f"GitHub has no archive of this version ({e}).")
    run.say(f"   {len(body) >> 10} KB")
    top = f"{repo.split('/')[1]}-{sha}"
    _rm(STAGE)
    try:
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
            recorded = tar.pax_headers.get("comment")  # git archive writes the commit id here
            if recorded and recorded != sha:
                raise Fail(f"The archive is of another commit ({recorded[:12]}).")
            _extract(tar, _safe_members(tar.getmembers(), top), top, STAGE)
    except (tarfile.TarError, EOFError, OSError) as e:
        raise Fail(f"The download is not a readable archive ({e}).")
    for need in ("lib/apply.sh", "lib/common.sh", "keepwatch.conf.example", "modules/base/install.sh"):
        if not (STAGE / need).is_file():
            raise Fail(f"The archive is not a Keepwatch copy ({need} is missing).")
    fp = ui_fingerprint(STAGE)  # before the sources go
    # As deploy leaves the server copy: without the parts only your computer needs.
    for extra in ("desktop", "docs", "dashboard/web/src", ".github"):
        _rm(STAGE / extra)

    run.step("prepare", "Dashboard interface")
    dist = STAGE / "dashboard" / "web" / "dist"
    old_dist = ROOT / "dashboard" / "web" / "dist"
    if fp and have.get("ui") == fp and (old_dist / "index.html").is_file():
        shutil.copytree(str(old_dist), str(dist), symlinks=True)
        run.say("   unchanged - the installed build stays")
    elif fp:
        ui_url = (os.environ.get("KW_SELF_UPDATE_UI_URL") or UI_ASSET).format(repo=repo, sha=sha, fp=fp)
        try:
            _, _, ui = http_get(ui_url, limit=MAX_TARBALL, timeout=120)
        except Http:
            raise Fail("This version comes with a new dashboard interface, and GitHub does not have it built yet "
                       f"(release \"{UI_TAG}\" of {repo}, published by the \"Dashboard UI\" workflow a few minutes "
                       "after a push). Try again later, or update from your computer: git pull, then ./keepwatch deploy.")
        try:
            with tarfile.open(fileobj=io.BytesIO(ui), mode="r:gz") as tar:
                found = tar.getmembers()
                stamp = next((m for m in found if m.name == "ui-fingerprint" and m.isfile()), None)
                if not stamp or tar.extractfile(stamp).read().decode().strip() != fp:
                    raise Fail("The prebuilt dashboard interface is for other sources.")
                _extract(tar, _safe_members([m for m in found if m is not stamp], "dist"), "dist", dist)
        except (tarfile.TarError, EOFError, OSError, UnicodeDecodeError) as e:
            raise Fail(f"The prebuilt dashboard interface is not a readable archive ({e}).")
        if not (dist / "index.html").is_file():
            raise Fail("The prebuilt dashboard interface has no index.html.")
        run.say(f"   new build {fp[:12]}")

    # The server's own configuration (deploy would copy yours; this server has the one it uses).
    if ETC_CONF.is_file():
        shutil.copy2(str(ETC_CONF), str(STAGE / "keepwatch.conf"))
        os.chmod(str(STAGE / "keepwatch.conf"), 0o644)
    latest = st.get("latest") or {}
    write_json(STAGE / "VERSION.json", {"commit": sha, "dirty": False, "date": latest.get("date"),
                                        "subject": latest.get("subject"), "repo": repo, "ui": fp,
                                        "source": "dashboard", "at": int(time.time())})
    os.chmod(str(STAGE), 0o755)
    return {"repo": repo, "have": have}


def install(run: Run, sha: str, prepared: dict) -> int:
    """Steps 4-5: swap the copies, apply.sh; on failure the previous copy and apply.sh again."""
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
           "LC_ALL": "C.UTF-8", "KW_LOCKED": "1", "KW_VIA": "dashboard", "TERM": "dumb"}
    # The checks a deploy does for the user it logs in as (SSH keys) apply to that user here too.
    user = conf().get("KW_SSH_USER", "root") or "root"
    if user != "root" and re.match(r"^[a-z_][a-z0-9_-]*$", user):
        env["SUDO_USER"] = user
    run.step("install", "Swap /opt/keepwatch for the new version (the previous one: /opt/keepwatch.prev)")
    _rm(PREV)
    _swap(ROOT, STAGE)
    os.rename(str(STAGE), str(PREV))
    run.step("apply", "Set up the server (lib/apply.sh)")
    code = run.apply_sh(ROOT, env)
    if code == 0:
        run.say("-- Done", flush=True)
        update_state(available=False, changes=[], moreChanges=0, aheadBy=0, localBuild=False, notOnBranch=False,
                     checkedFor={"commit": sha, "dirty": False})
        update_run(state="done", step=None, finishedAt=int(time.time()), message="Keepwatch is up to date.")
        return 0

    run.step("rollback", f"lib/apply.sh failed (exit code {code}) - putting the previous version back")
    _rm(FAILED)
    _swap(ROOT, PREV)
    os.rename(str(PREV), str(FAILED))
    _deploy_log_failure(sha)
    again = run.apply_sh(ROOT, {**env, "KW_VIA": "rollback"})
    if again == 0:
        msg = ("The update failed while setting up the server, so the previous version was put back and set up again. "
               "The log shows where it stopped; the failed copy is in /opt/keepwatch.failed.")
    else:
        msg = ("The update failed and the previous version was put back, but setting it up again failed too. "
               "Run ./keepwatch deploy from your computer.")
    run.say(f"-- {msg}", flush=True)
    update_run(state="failed", step=None, finishedAt=int(time.time()), message=msg, rolledBack=True)
    return 1


def _deploy_log_failure(sha: str):
    """A line for the dashboard timeline ("ok": false), as lib/apply.sh writes one for each deploy."""
    try:
        with open(str(DEPLOY_LOG), "a") as f:
            f.write(json.dumps({"t": time.time(), "commit": sha[:7], "subject": None, "dirty": False,
                                "changed": [], "ok": False, "via": "dashboard"}) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- Command line

def main(argv: list) -> int:
    cmd, args = (argv[0] if argv else ""), argv[1:]
    if cmd == "ui-fingerprint":
        fp = ui_fingerprint(Path(args[0] if args else "."))
        if not fp:
            print("no dashboard/web/package.json here", file=sys.stderr)
            return 1
        print(fp)
        return 0
    if cmd == "version-info":
        print(json.dumps(version_info(Path(args[0] if args and not args[0].startswith("-") else "."), "--ui-stale" in args)))
        return 0
    if cmd == "check":
        st = check()
        if st.get("error"):  # offline or rate-limited: recorded for the dashboard, not a failed unit
            print(st["error"], file=sys.stderr)
            return 0
        latest = (st.get("latest") or {}).get("commit") or "-"
        print(f"latest {latest[:12]} · {'update available' if st.get('available') else 'up to date'}")
        return 0
    if cmd == "apply":
        return apply(args[0] if args else "")
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
