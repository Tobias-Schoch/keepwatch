""""New site" wizard: create a proxy host in Nginx Proxy Manager (needs the proxy module).

Hosts are created through the Proxy Manager's REST API (config.proxy_url() + /api,
the same way its own UI works). It writes its database and nginx config itself
and fetches the certificate with certbot. The credentials (email + password of a
Proxy Manager user) live in /etc/keepwatch/dashboard/npm.json (600) and are
never sent back to the UI.

A job runs in a background thread, the UI polls its state:
  1. create the host (without certificate, IP allow-list already in advanced_config)
  2. fetch the certificate (Let's Encrypt, HTTP challenge)
  3. force HTTPS (set certificate, HSTS, HTTP/2 on the host)
  4. test a request (curl via 127.0.0.1 with the real name)
If 1-3 fails, everything is rolled back: the host is deleted, and so is a
certificate already fetched. Nothing stays half created.

Wired into dashboard.py (import, routes). Helpers from there (run, ApiError,
COLLECTORS, parse_access, ...) are looked up at runtime through
sys.modules["dashboard"], like updates.py; dashboard.py registers itself under
that name at start so it is not loaded a second time.
"""
from __future__ import annotations

import copy
import datetime as dt
import ipaddress
import json
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

import config


def _npm_url() -> str:
    return config.proxy_url()

_G: dict = {}


def bind(g: dict):
    """Tests only: other globals instead of sys.modules["dashboard"]."""
    global _G
    _G = g


class _Dash:
    """Helpers from dashboard.py (run, ApiError, COLLECTORS, ...), looked up at runtime."""

    def __getattr__(self, name):
        g = _G or sys.modules["dashboard"].__dict__
        try:
            return g[name]
        except KeyError:
            raise AttributeError(name) from None


D = _Dash()


def _err(status: int, msg: str) -> Exception:
    return D.ApiError(status, msg)


# --------------------------------------------------------------------------- Access to the Proxy Manager

def _cred_file():
    return D.CONF_DIR / "npm.json"


def npm_creds() -> dict | None:
    try:
        c = json.loads(_cred_file().read_text())
    except (OSError, ValueError):
        return None
    if isinstance(c, dict) and c.get("email") and c.get("password"):
        return {"email": str(c["email"]), "password": str(c["password"])}
    return None


NPM = {"token": None, "exp": 0.0, "ok": None, "reason": None, "at": None, "version": None, "lock": threading.Lock()}
CHECK_EVERY = 600


def _npm_http(method: str, path: str, body=None, token: str | None = None, timeout: float = 60):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(_npm_url() + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(raw)
            msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error")
            msg = msg or j.get("message") or raw
        except (ValueError, AttributeError):
            msg = raw
        return e.code, {"__error": str(msg or f"HTTP {e.code}")}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise _err(502, f"The Proxy Manager is not reachable ({_npm_url()}): {getattr(e, 'reason', e)}")


def _login(email: str, password: str) -> tuple[str, float]:
    code, res = _npm_http("POST", "/api/tokens", {"identity": email, "secret": password}, timeout=20)
    if code in (400, 401, 403):
        raise _err(400, "The Proxy Manager rejects the email or password.")
    if code != 200 or not isinstance(res, dict):
        raise _err(502, f"Login to the Proxy Manager failed ({code}): {(res or {}).get('__error', '')[:200]}")
    if res.get("requires_2fa"):
        raise _err(400, "This account has two-factor login enabled - the dashboard cannot enter a code. "
                        "Create a separate user for the dashboard in the Proxy Manager (admin role, no 2FA).")
    tok = res.get("token")
    if not tok:
        raise _err(502, "The Proxy Manager returned no token.")
    exp = time.time() + 3600
    try:
        exp = dt.datetime.fromisoformat(str(res.get("expires", "")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        pass
    return tok, exp


def _token(force: bool = False) -> str:
    creds = npm_creds()
    if not creds:
        raise _err(409, "No Proxy Manager credentials are stored yet (Settings -> Proxy Manager access).")
    with NPM["lock"]:
        if not force and NPM["token"] and NPM["exp"] - time.time() > 600:
            return NPM["token"]
        try:
            tok, exp = _login(creds["email"], creds["password"])
        except Exception as e:
            NPM.update(token=None, ok=False, reason=getattr(e, "message", str(e)), at=time.time())
            raise
        NPM.update(token=tok, exp=exp, ok=True, reason=None, at=time.time())
        return tok


def npm(method: str, path: str, body=None, timeout: float = 60):
    """Call the Proxy Manager API with a token; logs in again once on 401."""
    code, res = _npm_http(method, path, body, _token(), timeout)
    if code == 401:
        code, res = _npm_http(method, path, body, _token(force=True), timeout)
    if code >= 400:
        msg = (res or {}).get("__error", f"HTTP {code}")
        if code == 403:
            raise _err(502, f"The Proxy Manager user is not allowed to do that ({msg}). It needs the admin role.")
        raise _err(502, f"The Proxy Manager reports {code}: {_short(msg)}")
    return res


def _short(msg: str, n: int = 400) -> str:
    """certbot output is long: pick the meaningful line."""
    lines = [line.strip() for line in str(msg).splitlines() if line.strip()]
    if not lines:
        return "unknown error"
    if len(lines) == 1:
        return lines[0][:n]
    hint = next((line for line in lines if "Detail:" in line), None) \
        or next((line for line in reversed(lines) if re.search(r"error|failed|problem", line, re.I)), None) \
        or lines[-1]
    return hint[:n]


def _who(tok: str) -> tuple[str | None, bool]:
    """(name, may manage hosts and certificates)."""
    code, me = _npm_http("GET", "/api/users/me?expand=permissions", token=tok, timeout=15)
    if code != 200 or not isinstance(me, dict):
        return None, True
    roles = me.get("roles") or []
    perms = me.get("permissions") or {}
    ok = "admin" in roles or (perms.get("proxy_hosts") == "manage" and perms.get("certificates") == "manage")
    return me.get("name") or me.get("email"), ok


def _version() -> str | None:
    try:
        code, res = _npm_http("GET", "/api/", timeout=8)
        v = (res or {}).get("version") or {}
        return f"{v.get('major')}.{v.get('minor')}.{v.get('revision')}" if code == 200 and v else None
    except Exception:  # noqa: BLE001
        return None


def npm_status(check: bool = True) -> dict:
    creds = npm_creds()
    if creds and check and (NPM["at"] is None or time.time() - NPM["at"] > CHECK_EVERY):
        try:
            _token(force=NPM["token"] is None)
        except Exception:  # noqa: BLE001 - reason is in NPM["reason"]
            pass
    return {"configured": bool(creds), "email": creds["email"] if creds else None,
            "connected": bool(creds) and NPM["ok"] is True, "reason": NPM["reason"] if creds else None,
            "checkedAt": NPM["at"] if creds else None, "url": _npm_url()}


EMAIL = re.compile(r"^[^@\s]{1,128}@[^@\s]{1,253}$")


def put_npm(body: dict):
    email = str(body.get("email", "")).strip()
    password = str(body.get("password", ""))
    old = npm_creds()
    if not password and old and old["email"].lower() == email.lower():
        password = old["password"]
    if not EMAIL.match(email):
        raise _err(400, "Please enter the email address of the Proxy Manager user.")
    if not password or len(password) > 512:
        raise _err(400, "Please enter the password.")
    tok, exp = _login(email, password)
    name, allowed = _who(tok)
    if not allowed:
        raise _err(400, f"{name or email} may not manage hosts and certificates in the Proxy Manager. "
                        "The user needs the admin role.")
    D.CONF_DIR.mkdir(parents=True, exist_ok=True)
    D.write_atomic(_cred_file(), json.dumps({"email": email, "password": password}) + "\n", 0o600)
    with NPM["lock"]:
        NPM.update(token=tok, exp=exp, ok=True, reason=None, at=time.time())
    return {"ok": True, "message": f"Proxy Manager connected as {name or email}."}


def test_npm():
    creds = npm_creds()
    if not creds:
        raise _err(409, "No credentials are stored yet.")
    tok = _token(force=True)
    name, allowed = _who(tok)
    ver = _version()
    if not allowed:
        raise _err(400, f"Login works, but {name or creds['email']} may not manage hosts and certificates.")
    return {"ok": True, "message": f"Connected as {name or creds['email']}" + (f" · Proxy Manager {ver}" if ver else "") + "."}


def delete_npm():
    _cred_file().unlink(missing_ok=True)
    with NPM["lock"]:
        NPM.update(token=None, exp=0.0, ok=None, reason=None, at=None)
    return {"ok": True}


# --------------------------------------------------------------------------- Domain and DNS

LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def clean_domain(raw: str) -> str:
    s = str(raw or "").strip().lower()
    s = re.sub(r"^[a-z]+://", "", s).split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    s = s.rsplit("@", 1)[-1]
    if ":" in s:
        s = s.split(":", 1)[0]
    s = s.strip(".")
    if not s:
        raise _err(400, "Please enter a domain, e.g. app.example.com.")
    try:
        s = s.encode("idna").decode("ascii")
    except UnicodeError:
        raise _err(400, f"\"{raw}\" is not a valid domain.")
    labels = s.split(".")
    if len(s) > 253 or len(labels) < 2 or not all(LABEL.match(x) for x in labels) or labels[-1].isdigit():
        raise _err(400, f"\"{raw}\" is not a valid domain.")
    return s


def domain_list(domain: str, www: bool) -> list[str]:
    out = [domain]
    if www and not domain.startswith("www."):
        out.append(f"www.{domain}")
    return out


def _db():
    return D.npm_db()


def taken(domains: list[str]) -> list[dict]:
    """Like isHostnameTaken in the Proxy Manager: proxy, redirection and 404 hosts."""
    want = {d.lower() for d in domains}
    hits = []
    con = _db()
    try:
        for table, kind in (("proxy_host", "proxy host"), ("redirection_host", "redirection host"), ("dead_host", "404 host")):
            try:
                rows = con.execute(f"SELECT id, domain_names FROM {table} WHERE is_deleted=0").fetchall()
            except sqlite3.Error:
                continue
            for hid, names in rows:
                for n in json.loads(names or "[]"):
                    if str(n).lower() in want:
                        hits.append({"domain": str(n).lower(), "kind": kind, "id": hid})
    finally:
        con.close()
    return hits


def server_ips() -> dict:
    """Public addresses of the server (without Tailscale, Docker networks, ULA)."""
    v4, v6 = [], []
    try:
        data = json.loads(D.run(["ip", "-j", "addr", "show", "scope", "global"]) or "[]")
    except ValueError:
        data = []
    for iface in data:
        if str(iface.get("ifname", "")).startswith(("tailscale", "docker", "br-", "veth")):
            continue
        for a in iface.get("addr_info") or []:
            try:
                ip = ipaddress.ip_address(a.get("local", ""))
            except ValueError:
                continue
            if not ip.is_global:
                continue
            (v4 if ip.version == 4 else v6).append(str(ip))
    pub = D.public_ip()
    if pub and pub not in v4:
        try:
            if ipaddress.ip_address(pub).is_global:
                v4.insert(0, pub)
        except ValueError:
            pass
    return {"v4": v4, "v6": v6}


def _dig(name: str, rr: str) -> tuple[list[str], list[str]] | None:
    """(addresses, CNAME chain) from a public resolver - no local cache.
    None if dig is missing or no resolver answers (then ask the system)."""
    if not shutil.which("dig"):
        return None
    for server in ("1.1.1.1", "9.9.9.9"):
        try:
            p = subprocess.run(["dig", "+short", "+time=2", "+tries=2", rr, name, f"@{server}"],
                               capture_output=True, text=True, timeout=12)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if p.returncode != 0:
            continue
        addrs, chain = [], []
        for line in (x.strip() for x in p.stdout.splitlines()):
            if not line or line.startswith(";"):
                continue
            try:
                addrs.append(str(ipaddress.ip_address(line)))
            except ValueError:
                chain.append(line.rstrip("."))
        return addrs, chain
    return None


def _resolve(name: str, rr: str) -> tuple[list[str], list[str]]:
    r = _dig(name, rr)
    if r is not None:
        return r
    fam = socket.AF_INET if rr == "A" else socket.AF_INET6
    try:
        infos = socket.getaddrinfo(name, None, fam, socket.SOCK_STREAM)
    except socket.gaierror:
        return [], []
    return sorted({i[4][0] for i in infos}), []


def dns_check(name: str, ips: dict) -> dict:
    a, chain_a = _resolve(name, "A")
    aaaa, chain_6 = _resolve(name, "AAAA")
    v4, v6 = set(ips["v4"]), set(ips["v6"])
    bad4 = [x for x in a if x not in v4]
    bad6 = [x for x in aaaa if ipaddress.ip_address(x).compressed not in {ipaddress.ip_address(y).compressed for y in v6}]
    want4 = ips["v4"][0] if ips["v4"] else "the server IP"
    problem = None
    if not a and not aaaa:
        problem = f"No A record found. Create an A record \"{name}\" -> {want4} at your DNS provider."
    elif bad4:
        problem = f"A points to {', '.join(bad4)} instead of {want4}."
    elif bad6:
        problem = (f"AAAA points to {', '.join(bad6)}. Let's Encrypt prefers IPv6 and would not end up here - "
                   + (f"delete the AAAA record or point it to {ips['v6'][0]}." if ips["v6"] else "delete the AAAA record."))
    return {"name": name, "a": a, "aaaa": aaaa, "cname": (chain_a or chain_6 or [None])[0], "ok": problem is None, "problem": problem}


def check_domain(query: dict) -> dict:
    domain = clean_domain((query.get("domain") or [""])[0])
    www = (query.get("www") or ["0"])[0] in ("1", "true", "yes")
    names = domain_list(domain, www)
    ips = server_ips()
    hits = taken(names)
    dns = [dns_check(n, ips) for n in names]
    return {"domain": domain, "domains": names, "taken": hits, "dns": dns, "serverIps": ips,
            "ok": not hits and all(d["ok"] for d in dns)}


# --------------------------------------------------------------------------- Targets (containers)

def _loopback(hexaddr: str) -> bool:
    """Is an address from /proc/net/tcp{,6} (bytes reversed per 32-bit word) loopback?"""
    if len(hexaddr) == 8:
        return hexaddr[6:8] == "7F"  # 127.x.x.x, also Docker's DNS 127.0.0.11
    if hexaddr == "00000000000000000000000001000000":  # ::1
        return True
    return hexaddr.startswith("0000000000000000FFFF0000") and hexaddr[30:32] == "7F"  # ::ffff:127.x


def _listening(pid: int) -> list[int]:
    """Listening TCP ports in the container's network namespace (without loopback)."""
    ports = set()
    for fn in ("tcp", "tcp6"):
        try:
            with open(f"/proc/{pid}/net/{fn}") as f:
                lines = f.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            cols = line.split()
            if len(cols) < 4 or cols[3] != "0A":  # 0A = LISTEN
                continue
            addr, _, port = cols[1].partition(":")
            if not _loopback(addr):
                ports.add(int(port, 16))
    return sorted(ports)


def _host_rows() -> list[sqlite3.Row]:
    con = _db()
    con.row_factory = sqlite3.Row
    try:
        return con.execute("SELECT * FROM proxy_host WHERE is_deleted=0 ORDER BY id").fetchall()
    finally:
        con.close()


def targets() -> dict:
    ids = D.run(["docker", "ps", "-q"]).split()
    inspect = json.loads(D.run(["docker", "inspect", *ids], timeout=30) or "[]") if ids else []
    npm_c = next((c for c in inspect if str(c["Config"].get("Image", "")).startswith("jc21/nginx-proxy-manager")), None)
    npm_nets = sorted(set(((npm_c or {}).get("NetworkSettings", {}).get("Networks") or {}).keys()) - {"host", "none"})
    # Docker does not resolve names on the default "bridge" network - does not count.
    usable = [n for n in npm_nets if n != "bridge"]
    sites: dict[str, list[str]] = {}
    for r in _host_rows():
        sites.setdefault(r["forward_host"], []).extend(json.loads(r["domain_names"] or "[]"))
    out = []
    for c in inspect:
        if c is npm_c:
            continue
        name = c["Name"].lstrip("/")
        labels = c["Config"].get("Labels") or {}
        nets = sorted((c.get("NetworkSettings", {}).get("Networks") or {}).keys())
        shared = [n for n in nets if n in usable]
        exposed = sorted({int(k.split("/")[0]) for k in (c["Config"].get("ExposedPorts") or {}) if k.endswith("/tcp")})
        listening = _listening(int(c["State"].get("Pid") or 0)) if c["State"].get("Pid") else []
        cand = listening or exposed
        out.append({
            "name": name, "image": c["Config"].get("Image"), "project": labels.get("com.docker.compose.project"),
            "service": labels.get("com.docker.compose.service"),
            "composeFile": labels.get("com.docker.compose.project.config_files"),
            "networks": nets, "shared": shared, "reachable": bool(shared),
            "hostNetwork": (c.get("HostConfig") or {}).get("NetworkMode") == "host",
            "listening": listening, "exposed": exposed, "suggestedPort": cand[0] if cand else None,
            "sites": sites.get(name, []),
        })
    out.sort(key=lambda x: (x["project"] or "~", bool(x["sites"]), not x["reachable"], x["name"]))
    net = config.get("KW_PROXY_NETWORK", "proxy-net")
    prefer = net if net in usable else (usable[0] if usable else None)
    return {"npm": {"name": npm_c["Name"].lstrip("/") if npm_c else None, "networks": usable, "join": prefer},
            "containers": out}


# --------------------------------------------------------------------------- Defaults and IP lists

FLAGS = {  # API name -> (column, default on a tie)
    "certificate": ("certificate_id", True), "sslForced": ("ssl_forced", True), "hsts": ("hsts_enabled", True),
    "hstsSubdomains": ("hsts_subdomains", True), "http2": ("http2_support", True),
    "blockExploits": ("block_exploits", True), "caching": ("caching_enabled", True),
    "websockets": ("allow_websocket_upgrade", False),
}


def defaults() -> dict:
    """"Like your other sites": per switch, what most active hosts have."""
    rows = [r for r in _host_rows() if r["enabled"]]
    n = len(rows)
    vals, counts = {}, {}
    for key, (col, tie) in FLAGS.items():
        on = sum(1 for r in rows if (r[col] or 0) > 0)
        counts[key] = on
        vals[key] = tie if n == 0 or on * 2 == n else on * 2 > n
    return {"values": vals, "counts": counts, "basis": n}


def ip_lists() -> dict:
    """The allow-lists of all sites, grouped by name (comment)."""
    by_value: dict[str, dict] = {}
    for r in _host_rows():
        entries, deny = D.parse_access(r["advanced_config"] or "")
        if not (entries and deny):
            continue
        site = (json.loads(r["domain_names"] or "[]") or ["?"])[0]
        for e in entries:
            v = e["value"]
            cur = by_value.setdefault(v, {"value": v, "note": "", "sites": []})
            if e["note"] and not cur["note"]:
                cur["note"] = e["note"]
            if site not in cur["sites"]:
                cur["sites"].append(site)
    groups: dict[str, dict] = {}
    for e in by_value.values():
        name = e["note"] or e["value"]
        g = groups.setdefault(name, {"name": name, "named": bool(e["note"]), "entries": [], "sites": []})
        g["entries"].append(D.describe({"value": e["value"], "note": e["note"]}))
        g["sites"] += [s for s in e["sites"] if s not in g["sites"]]
    # The tunnel comes in over Tailscale (100.64.0.0/10) - such addresses do not help in an allow-list.
    mine = []
    for ip in D.my_ips():
        try:
            if ipaddress.ip_address(ip).is_global:
                mine.append(ip)
        except ValueError:
            pass
    return {"lists": sorted(groups.values(), key=lambda g: (not g["named"], g["name"].lower())), "myIps": mine}


def wizard_data() -> dict:
    lists = ip_lists()
    return {"npm": npm_status(), "serverIps": server_ips(), "defaults": defaults(), "targets": targets(),
            "ipLists": lists["lists"], "myIps": lists["myIps"]}


# --------------------------------------------------------------------------- Create

JOBS: dict[str, dict] = {}
JOB_LOCK = threading.Lock()
STEPS = [("host", "Create host"), ("cert", "Fetch certificate"), ("https", "Force HTTPS"), ("test", "Test request")]


def _access_block(access: dict) -> tuple[str, list[tuple[str, str]]]:
    """Exactly like put_access: "allow x; # name" per entry, then "deny all;"."""
    mode = (access or {}).get("mode", "open")
    if mode not in ("open", "list"):
        raise _err(400, 'Access mode must be "open" or "list".')
    clean, seen = [], set()
    for e in (access or {}).get("entries") or []:
        value = D._net_str(D._ipnet(str((e or {}).get("value", ""))))
        if value in seen:
            continue
        seen.add(value)
        note = re.sub(r"[\r\n{};#]", " ", str(e.get("note", ""))).strip()[:80]
        clean.append((value, note))
    if mode == "list" and not clean:
        raise _err(400, 'An empty list would lock everyone out. Open to everyone: "Public".')
    if mode == "open":
        clean = []
    block = [f"allow {v};" + (f" # {n}" if n else "") for v, n in clean] + (["deny all;"] if clean else [])
    return "\n".join(block), clean


def _validate(body: dict) -> dict:
    domain = clean_domain(body.get("domain", ""))
    names = domain_list(domain, bool(body.get("www")))
    hits = taken(names)
    if hits:
        raise _err(409, f"{hits[0]['domain']} already exists in the Proxy Manager ({hits[0]['kind']} #{hits[0]['id']}).")
    host = str(body.get("forwardHost", "")).strip()
    if not D.CONTAINER_NAME.match(host):
        raise _err(400, "Please choose a container as the target.")
    t = targets()
    c = next((x for x in t["containers"] if x["name"] == host), None)
    if not c:
        raise _err(400, f"The container \"{host}\" is not running.")
    if not c["reachable"]:
        raise _err(400, f"\"{host}\" shares no network with the Proxy Manager - add the network "
                        f"{t['npm']['join'] or 'of the Proxy Manager'} to its compose file and redeploy first.")
    try:
        port = int(body.get("forwardPort"))
    except (TypeError, ValueError):
        raise _err(400, "The port must be a number.")
    if not 1 <= port <= 65535:
        raise _err(400, "The port must be between 1 and 65535.")
    scheme = body.get("forwardScheme", "http")
    if scheme not in ("http", "https"):
        raise _err(400, "The scheme must be http or https.")
    ssl_in = body.get("ssl") or {}
    base = defaults()["values"]
    ssl = {k: bool(ssl_in.get(k, base[k])) for k in FLAGS}
    if not ssl["certificate"]:
        ssl.update(sslForced=False, hsts=False, hstsSubdomains=False, http2=False)
    if not ssl["sslForced"]:
        ssl.update(hsts=False, hstsSubdomains=False)
    if not ssl["hsts"]:
        ssl["hstsSubdomains"] = False
    advanced, entries = _access_block(body.get("access") or {})
    if ssl["certificate"]:
        ips = server_ips()
        bad = [d for d in (dns_check(n, ips) for n in names) if not d["ok"]]
        if bad:
            raise _err(400, f"{bad[0]['name']}: {bad[0]['problem']} Without matching DNS the certificate fails.")
    if not npm_creds():
        raise _err(409, "No Proxy Manager credentials are stored yet (Settings -> Proxy Manager access).")
    return {"domain": domain, "domains": names, "host": host, "port": port, "scheme": scheme, "ssl": ssl,
            "advanced": advanced, "entries": entries}


def create_host(body: dict):
    spec = _validate(body)
    _token()  # check access first so the error comes right away
    with JOB_LOCK:
        if any(j["state"] == "running" for j in JOBS.values()):
            raise _err(409, "A site is already being created.")
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "state": "running", "domain": spec["domain"], "domains": spec["domains"],
               "url": None, "hostId": None, "error": None, "rollback": [], "startedAt": time.time(), "finishedAt": None,
               "steps": [{"key": k, "label": label, "state": "pending", "detail": None} for k, label in STEPS]}
        JOBS[jid] = job
        for old in [k for k, j in JOBS.items() if j["state"] != "running" and time.time() - (j["finishedAt"] or 0) > 3600]:
            JOBS.pop(old, None)
    threading.Thread(target=_run_job, args=(job, spec), daemon=True, name=f"new-site-{jid}").start()
    return {"ok": True, "job": jid}


def get_job(jid: str) -> dict:
    job = JOBS.get(jid)
    if not job:
        raise _err(404, "This job does not exist (any more).")
    return copy.deepcopy(job)


def _step(job: dict, key: str, state: str, detail: str | None = None):
    for s in job["steps"]:
        if s["key"] == key:
            s["state"] = state
            if detail is not None:
                s["detail"] = detail


def _host_id_for(domains: list[str]) -> int | None:
    want = sorted(d.lower() for d in domains)
    for r in _host_rows():
        if sorted(str(x).lower() for x in json.loads(r["domain_names"] or "[]")) == want:
            return int(r["id"])
    return None


def _nginx_ok(row) -> tuple[bool, str | None]:
    meta = (row or {}).get("meta") or {}
    if meta.get("nginx_online") is False:
        return False, _short(meta.get("nginx_err") or "nginx rejects the configuration")
    return True, None


def _probe(domain: str, https: bool) -> dict | None:
    scheme, port = ("https", 443) if https else ("http", 80)
    out = D.run(["curl", "-s", "-o", "/dev/null", "-m", "10", "-w", "%{http_code} %{time_total}",
                 "--resolve", f"{domain}:{port}:127.0.0.1", f"{scheme}://{domain}/"], timeout=15)
    try:
        code, secs = out.split()
        return {"code": int(code), "ms": int(float(secs) * 1000)}
    except ValueError:
        return None


def _run_job(job: dict, spec: dict):
    host_id = cert_id = None
    ssl = spec["ssl"]
    try:
        # 1. Create the host - without certificate; the Proxy Manager would reset the HTTPS switches anyway.
        _step(job, "host", "running")
        payload = {
            "domain_names": spec["domains"], "forward_scheme": spec["scheme"], "forward_host": spec["host"],
            "forward_port": spec["port"], "certificate_id": 0, "ssl_forced": False, "hsts_enabled": False,
            "hsts_subdomains": False, "http2_support": False, "block_exploits": ssl["blockExploits"],
            "caching_enabled": ssl["caching"], "allow_websocket_upgrade": ssl["websockets"], "access_list_id": 0,
            "advanced_config": spec["advanced"], "enabled": True, "meta": {}, "locations": [],
        }
        try:
            row = npm("POST", "/api/nginx/proxy-hosts", payload, timeout=90)
        except Exception:
            host_id = _host_id_for(spec["domains"])  # timeout: maybe it was created after all
            raise
        host_id = int((row or {}).get("id") or 0) or _host_id_for(spec["domains"])
        job["hostId"] = host_id
        ok, why = _nginx_ok(row)
        if not ok:
            raise _err(502, f"nginx rejects the new host: {why}")
        _step(job, "host", "ok", f"#{host_id} · {spec['scheme']}://{spec['host']}:{spec['port']}"
              + (f" · {len(spec['entries'])} allowed IPs" if spec["entries"] else " · public"))

        if ssl["certificate"]:
            # 2. Certificate - the Proxy Manager deletes a failed one itself.
            _step(job, "cert", "running", "Let's Encrypt is checking the domain (up to a minute) ...")
            cert = npm("POST", "/api/nginx/certificates",
                       {"provider": "letsencrypt", "domain_names": spec["domains"], "meta": {"dns_challenge": False}},
                       timeout=300)
            cert_id = int((cert or {}).get("id") or 0)
            if not cert_id:
                raise _err(502, "The Proxy Manager returned no certificate.")
            exp = (cert or {}).get("expires_on")
            _step(job, "cert", "ok", f"npm-{cert_id}" + (f" · valid until {str(exp)[:10]}" if exp else ""))

            # 3. Force HTTPS
            _step(job, "https", "running")
            row = npm("PUT", f"/api/nginx/proxy-hosts/{host_id}", {
                "certificate_id": cert_id, "ssl_forced": ssl["sslForced"], "hsts_enabled": ssl["hsts"],
                "hsts_subdomains": ssl["hstsSubdomains"], "http2_support": ssl["http2"]}, timeout=90)
            ok, why = _nginx_ok(row)
            if not ok:
                raise _err(502, f"nginx rejects the HTTPS configuration: {why}")
            on = [label for flag, label in (("sslForced", "HTTPS forced"), ("hsts", "HSTS"), ("http2", "HTTP/2")) if ssl[flag]]
            _step(job, "https", "ok", " · ".join(on) if on else "certificate set, HTTP stays allowed")
        else:
            _step(job, "cert", "skipped", "no certificate requested")
            _step(job, "https", "skipped", "HTTP only")
    except Exception as e:  # noqa: BLE001
        msg = getattr(e, "message", None) or str(e)
        if not getattr(e, "message", None):
            traceback.print_exc()
        cur = next((s for s in job["steps"] if s["state"] == "running"), None)
        if cur:
            _step(job, cur["key"], "failed", msg)
        for s in job["steps"]:
            if s["state"] == "pending":
                s["state"] = "cancelled"
        job["error"] = msg
        _rollback(job, host_id, cert_id)
        job["state"] = "failed"
        job["finishedAt"] = time.time()
        _refresh_sites(hosts_changed=bool(host_id))
        return

    # 4. Test a request - nginx is reloading, so a few tries.
    _step(job, "test", "running")
    https = ssl["certificate"]
    res = None
    for _ in range(5):
        res = _probe(spec["domain"], https)
        if res and res["code"] not in (0, 502, 503, 504):
            break
        time.sleep(1.5)
    scheme = "https" if https else "http"
    job["url"] = f"{scheme}://{spec['domain']}/"
    if not res or res["code"] == 0:
        _step(job, "test", "warning", "No answer via 127.0.0.1 - please check in a browser.")
    elif res["code"] in (502, 503, 504):
        _step(job, "test", "warning", f"{res['code']}: the Proxy Manager cannot reach {spec['host']}:{spec['port']}. "
                                      "Does the container listen on that port?")
    elif res["code"] == 403 and spec["entries"]:
        _step(job, "test", "ok", f"403 in {res['ms']} ms - the IP allow-list works (the server itself is not on the list).")
    else:
        _step(job, "test", "ok", f"{res['code']} in {res['ms']} ms")
    job["state"] = "done"
    job["finishedAt"] = time.time()
    _refresh_sites(hosts_changed=True)


def _rollback(job: dict, host_id: int | None, cert_id: int | None):
    if host_id:
        try:
            npm("DELETE", f"/api/nginx/proxy-hosts/{host_id}", timeout=90)
            job["rollback"].append({"label": f"Host #{host_id} removed again", "ok": True})
            job["hostId"] = None
        except Exception as e:  # noqa: BLE001
            job["rollback"].append({"label": f"Host #{host_id} could not be removed - please delete it in the Proxy Manager: "
                                             f"{getattr(e, 'message', e)}", "ok": False})
    if cert_id:
        try:
            npm("DELETE", f"/api/nginx/certificates/{cert_id}", timeout=120)
            job["rollback"].append({"label": f"Certificate npm-{cert_id} removed again", "ok": True})
        except Exception as e:  # noqa: BLE001
            job["rollback"].append({"label": f"Certificate npm-{cert_id} could not be removed - please delete it in the "
                                             f"Proxy Manager: {getattr(e, 'message', e)}", "ok": False})


def _refresh_sites(hosts_changed: bool = False):
    try:
        D.COLLECTORS["sites"].refresh()
    except Exception:  # noqa: BLE001
        pass
    # fail2ban expands the log globs of its web jails (proxy-host-*_access.log) only when it
    # (re)loads - a new host's log is watched only after a reload.
    if hosts_changed and config.enabled("fail2ban"):
        D.run(["fail2ban-client", "reload"], timeout=60)


# --------------------------------------------------------------------------- Routes

def route(method: str, path: str, query: dict, body: dict):
    D.require("proxy", "docker")
    if method == "GET":
        if path == "/api/hosts/new":
            return wizard_data()
        if path == "/api/hosts/check":
            return check_domain(query)
        m = re.match(r"^/api/hosts/jobs/([0-9a-f]{12})$", path)
        if m:
            return get_job(m.group(1))
        if path == "/api/settings/npm":
            return npm_status()
    if method == "POST":
        if path == "/api/hosts":
            return create_host(body)
        if path == "/api/settings/npm/test":
            return test_npm()
    if method == "PUT" and path == "/api/settings/npm":
        return put_npm(body)
    if method == "DELETE" and path == "/api/settings/npm":
        return delete_npm()
    raise _err(404, "No such endpoint.")
