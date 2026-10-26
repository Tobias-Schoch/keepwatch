"""Security grade per site (0-100 points, A-F) - dashboard add-on (needs the proxy module).

Checks every site the way a visitor sees it - through the public domain - every 6 h and on demand.
Read-only requests only (TLS handshakes, GET on the home page, login and admin paths, a page that does
not exist, HTTP on port 80) - never a login attempt, never POST/PUT/DELETE.

Six categories with fixed maximum points (sum 100), each made of single checks:

  Transport 30          TLS versions, ciphers, certificate, HTTP -> HTTPS, HSTS
  Headers 25            CSP, framing, nosniff, Referrer-Policy, Permissions-Policy
  Cookies & session 10  Secure, HttpOnly, SameSite (home page and login page)
  Information leaks 5   versions in Server/X-Powered-By, error pages (version, stack trace)
  Access protection 15  login protection (IP allow-list or fail2ban app-login + rate limit), public admin path?
  Software 15           open critical / high vulnerabilities in the site's containers (Trivy, image-scan module)

A failure costs the full weight of the check, a warning half. Caps as with SSL Labs limit the score
(invalid certificate -> at most 49 = F); the grade follows from the score alone. Schema in API.md.

Sites behind an IP allow-list answer strangers with 403. Then the app itself is graded as well:
directly over the Docker network (container IP:port as in the Proxy Manager, Host header = domain, GET
only, like uptime.py). Headers, cookies and error page then come from the app, transport and HSTS still
from outside ("checked: app directly"). If the container is unreachable, only the block page counts.

Hooked into dashboard.py (import, routes, background thread) like updates.py; it takes the helpers from
there at run time through sys.modules["dashboard"]. HSTS / Force SSL are switched on through the Proxy
Manager API (hosts.npm, the same way as its UI) - only on, never off. A score that drops lands in the
timeline (timeline.py).

To try it without the dashboard (read-only, reads proxy hosts, containers and scan itself), on the server:
  python3 /opt/keepwatch/dashboard/server/sitegrade.py                      (all enabled sites)
  python3 /opt/keepwatch/dashboard/server/sitegrade.py example.com --json
"""
from __future__ import annotations

import datetime as dt
import http.client
import json
import re
import secrets
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import config

warnings.filterwarnings("ignore", category=DeprecationWarning)  # TLSVersion.TLSv1 is old on purpose

SCHEMA = 2  # grading version; a change recomputes everything and reports no "drop" for it
CHECK_EVERY = 6 * 3600
WAKE_EVERY = 600  # new sites without a grade are checked within 10 min
TIMEOUT = 8
BODY_MAX = 400_000
UA = f"Mozilla/5.0 (compatible; keepwatch-sitegrade/2; +{config.PROJECT_URL})"
LOCKED_NOTE = "behind an IP allow-list, only the block page was checked"
APP_NOTE = "behind an IP allow-list - app checked directly"
ALERT_BELOW = 80  # below this the score shows in the header of a service

STATE_DIR = config.STATE_DIR
NPM_DIR = config.PROXY_DATA
HALF_YEAR = 15_552_000  # 180 days
GRADES = [(90, "A"), (80, "B"), (70, "C"), (60, "D"), (50, "E"), (0, "F")]
ORDER = "ABCDEF"
# Cap "at most X" = at most this many points (one below the limit of the next better grade).
CAP_MAX = {"B": 89, "C": 79, "D": 69, "E": 59, "F": 49}

# Categories with their checks and weights. Sum 100. Rationale in API.md.
CATEGORIES = [
    ("transport", "Transport", {"tls-versions": 6, "tls-ciphers": 5, "cert": 8, "https-redirect": 5, "hsts": 6}),
    ("header", "Headers", {"csp": 10, "frame": 5, "xcto": 4, "referrer": 3, "permissions": 3}),
    ("cookies", "Cookies & session", {"cookies": 10}),
    ("leak", "Information leaks", {"leak": 3, "errors": 2}),
    ("access", "Access protection", {"login": 10, "admin": 5}),
    ("software", "Software", {"vuln-critical": 10, "vuln-high": 5}),
]
WEIGHTS = {cid: w for _, _, checks in CATEGORIES for cid, w in checks.items()}
CAT_OF = {cid: cat for cat, _, checks in CATEGORIES for cid in checks}
assert sum(WEIGHTS.values()) == 100
TITLES = {
    "tls-versions": "TLS versions", "tls-ciphers": "Ciphers", "cert": "Certificate",
    "https-redirect": "HTTP → HTTPS", "hsts": "HSTS", "csp": "Content-Security-Policy",
    "xcto": "X-Content-Type-Options", "frame": "Framing protection", "referrer": "Referrer-Policy",
    "permissions": "Permissions-Policy", "leak": "Version disclosure", "errors": "Error pages", "cookies": "Cookies",
    "login": "Login protection", "admin": "Admin area", "vuln-critical": "Critical vulnerabilities",
    "vuln-high": "High vulnerabilities",
}

# The Proxy Manager always sets HSTS with max-age=63072000 and preload.
NPM_HSTS = re.compile(r"^max-age=63072000;\s*(includeSubDomains;\s*)?preload$", re.I)

STATE: dict = {"checkedAt": None, "checking": set(), "error": None, "sites": {}, "lock": threading.Lock(),
               "loaded": False}


def D():
    return sys.modules.get("dashboard")


def _date(ts: float, fmt: str = "%Y-%m-%d") -> str:
    return dt.datetime.fromtimestamp(ts, config.local_tz()).strftime(fmt)


def _state_file() -> Path:
    return STATE_DIR / "sitegrade.json"


def _load():
    if STATE["loaded"] or not D():
        return
    STATE["loaded"] = True
    try:
        data = json.loads(_state_file().read_text())
        STATE["sites"] = {r["domain"]: r for r in data.get("sites", []) if r.get("domain")}
        STATE["checkedAt"] = data.get("checkedAt")
    except (OSError, ValueError, AttributeError):
        pass


def _save():
    with STATE["lock"]:
        data = {"checkedAt": STATE["checkedAt"], "sites": list(STATE["sites"].values())}
    try:
        D().write_atomic(_state_file(), json.dumps(data, ensure_ascii=False), 0o600)
    except Exception:  # noqa: BLE001 - saving must not abort the check
        traceback.print_exc()


# --------------------------------------------------------------------------- TLS

V = ssl.TLSVersion
CLIENT_CANT = {"NO_PROTOCOLS_AVAILABLE", "NO_CIPHERS_AVAILABLE", "NO_SUITABLE_SIGNATURE_ALGORITHM"}
OLD_CIPHERS = "3DES:RC4:DES:NULL:eNULL:aNULL:EXPORT:IDEA:SEED:@SECLEVEL=0"
NO_FS_CIPHERS = "kRSA:@SECLEVEL=0"
CBC_CIPHERS = "kECDHE:kDHE:!AESGCM:!CHACHA20:!AESCCM:!aNULL:@SECLEVEL=0"


def _handshake(host: str, version=None, ciphers: str | None = None) -> tuple[bool | None, str]:
    """(True, cipher) = accepted, (False, reason) = rejected, (None, reason) = cannot be tested here."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.set_ciphers(ciphers or "DEFAULT:@SECLEVEL=0")
        if version is not None:
            ctx.minimum_version = version
            ctx.maximum_version = version
    except (ssl.SSLError, ValueError) as e:
        return None, f"this OpenSSL cannot do that ({e})"
    try:
        with socket.create_connection((host, 443), timeout=TIMEOUT) as s:
            with ctx.wrap_socket(s, server_hostname=host) as t:
                c = t.cipher()
                return True, f"{t.version()} {c[0] if c else ''}".strip()
    except ssl.SSLError as e:
        if (e.reason or "") in CLIENT_CANT:
            return None, f"this OpenSSL cannot do that ({e.reason})"
        return False, e.reason or str(e)
    except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
        return False, "connection rejected"
    except OSError as e:
        return None, f"no answer ({e})"


def _cert(host: str) -> dict:
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, 443), timeout=TIMEOUT) as s:
            with ctx.wrap_socket(s, server_hostname=host) as t:
                pc = t.getpeercert() or {}
        exp = ssl.cert_time_to_seconds(pc["notAfter"])
        issuer = dict(x[0] for x in pc.get("issuer", ()))
        names = [v for k, v in pc.get("subjectAltName", ()) if k == "DNS"]
        return {"ok": True, "expiresAt": exp, "daysLeft": int((exp - time.time()) // 86400),
                "issuer": " ".join(filter(None, [issuer.get("organizationName"), issuer.get("commonName")])), "names": names}
    except ssl.SSLCertVerificationError as e:
        return {"ok": False, "code": e.verify_code, "message": e.verify_message or str(e)}
    except (ssl.SSLError, OSError) as e:
        return {"ok": None, "message": str(e)}


# --------------------------------------------------------------------------- HTTP

class Resp:
    def __init__(self, status: int, url: str, headers: list[tuple[str, str]], body: bytes):
        self.status, self.url, self.headers, self.body = status, url, headers, body

    def all(self, name: str) -> list[str]:
        n = name.lower()
        return [v for k, v in self.headers if k.lower() == n]

    def one(self, name: str) -> str | None:
        v = self.all(name)
        return v[0] if v else None


def _request(url: str, verify: bool = True, via: dict | None = None) -> Resp:
    """GET url. via = {ip, port, scheme}: straight to the container on the Docker network instead of the domain -
    with Host and X-Forwarded-Proto headers like the Proxy Manager sends, so the app serves the same page."""
    u = urlsplit(url)
    headers = {"User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en"}
    if via:
        if via.get("scheme") == "https":
            conn = http.client.HTTPSConnection(via["ip"], via["port"], timeout=TIMEOUT,
                                               context=ssl._create_unverified_context())  # noqa: SLF001
        else:
            conn = http.client.HTTPConnection(via["ip"], via["port"], timeout=TIMEOUT)
        headers.update({"Host": u.hostname or "", "X-Forwarded-Proto": "https", "X-Forwarded-Host": u.hostname or ""})
    elif u.scheme == "https":
        ctx = ssl.create_default_context() if verify else ssl._create_unverified_context()  # noqa: SLF001
        conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=TIMEOUT, context=ctx)
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=TIMEOUT)
    try:
        conn.request("GET", (u.path or "/") + (f"?{u.query}" if u.query else ""), headers=headers)
        r = conn.getresponse()
        body = r.read(BODY_MAX)
        return Resp(r.status, url, list(r.getheaders()), body)
    finally:
        conn.close()


def _follow(url: str, verify: bool, hops: int = 5, via: dict | None = None) -> tuple[Resp, list[Resp]]:
    """Follow redirects on the same host over HTTPS (like a browser). Returns (final, all responses).
    Straight at the container, http:// of the same name counts too (the app does not always know HTTPS is in front)."""
    chain = []
    host = urlsplit(url).hostname
    for _ in range(hops):
        r = _request(url, verify, via)
        chain.append(r)
        loc = r.one("Location")
        if r.status not in (301, 302, 303, 307, 308) or not loc:
            break
        n = urlsplit(urljoin(url, loc))
        if n.hostname != host or (n.scheme != "https" and not via):
            break
        url = n._replace(scheme="https").geturl()
    return chain[-1], chain


LOGIN_HREF = re.compile(r"""href\s*=\s*["']([^"'#]*(?:login|log-in|signin|sign-in)[^"'#]*)["']""", re.I)
LOGIN_PATHS = ["/login", "/signin", "/auth/login", "/admin/login"]
ADMIN_PATHS = ["/admin", "/api/admin"]
PASSWORD = re.compile(rb"type\s*=\s*[\"']?password", re.I)
FORM_ACTION = re.compile(rb"<form[^>]*\saction\s*=\s*[\"']([^\"'#]+)", re.I)


def _find_login(home: Resp, verify: bool, via: dict | None = None) -> Resp | None:
    host = urlsplit(home.url).hostname
    text = home.body.decode("utf-8", "replace")
    candidates = []
    for m in LOGIN_HREF.finditer(text):
        u = urljoin(home.url, m.group(1).strip())
        if urlsplit(u).hostname == host and urlsplit(u).scheme == "https" and u not in candidates:
            candidates.append(u)
    candidates += [f"https://{host}{p}" for p in LOGIN_PATHS]
    for u in candidates[:6]:
        try:
            r, chain = _follow(u, verify, 3, via)
        except (OSError, http.client.HTTPException, ssl.SSLError):
            continue
        # Single-page apps return the home page for every path - then there is no separate login page.
        if r.status == 200 and r.body and r.body != home.body and PASSWORD.search(r.body):
            r.chain = chain  # type: ignore[attr-defined]
            return r
    return None


def _find_admin(home: Resp, missing: Resp | None, verify: bool) -> list[dict]:
    """Admin paths that answer from the internet (not 404, not the home page of a single-page app)."""
    host = urlsplit(home.url).hostname
    found = []
    for p in ADMIN_PATHS:
        try:
            r, _ = _follow(f"https://{host}{p}", verify, 3)
        except (OSError, http.client.HTTPException, ssl.SSLError):
            continue
        if r.status in (404, 410) or r.status >= 500 or r.body == home.body or (missing and r.body == missing.body):
            continue
        if r.status in (200, 401):  # 403 = blocked (e.g. an allow-list for the path) - does not count
            m = FORM_ACTION.search(r.body or b"")
            found.append({"path": p, "status": r.status, "url": r.url, "password": bool(PASSWORD.search(r.body or b"")),
                          "action": m.group(1).decode("utf-8", "replace") if m else None})
    return found


# --------------------------------------------------------------------------- Grading

def _chk(cid: str, status: str, summary: str, detail: str = "", fix: dict | None = None) -> dict:
    w = WEIGHTS[cid]
    ded = 0 if status in ("ok", "skip") else w if status == "fail" else w / 2
    return {"id": cid, "category": CAT_OF[cid], "title": TITLES[cid], "status": status, "weight": w,
            "deduction": ded, "summary": summary, "detail": detail, "fix": fix, "via": "public"}


def _npm_where(ctx: dict, tab: str) -> str:
    sid = ctx.get("id")
    return f"Proxy Manager → Proxy Hosts → {ctx['domain']}{f' (#{sid})' if sid else ''} → {tab}"


def _app_where(ctx: dict) -> str:
    app = ctx.get("app") or {}
    kind = ctx.get("appKind")
    file = {"next": "next.config.js → headers()", "express": "Express app (helmet)"}.get(
        kind or "", "the app's configuration (nginx.conf or server code)")
    parts = [x for x in (app.get("repo"), f"container {app['container']}" if app.get("container") else None) if x]
    return f"{file}{' - ' + ', '.join(parts) if parts else ''}"


def _app_snippet(ctx: dict, header: str, value: str) -> str:
    if ctx.get("appKind") == "next":
        return ("// next.config.js\nasync headers() {\n  return [{ source: \"/(.*)\", headers: [\n"
                f"    {{ key: \"{header}\", value: \"{value}\" }},\n" + "  ] }];\n}")
    return f"add_header {header} \"{value}\" always;"


def _header_fix(ctx: dict, header: str, value: str, why: str = "") -> dict:
    return {"where": _app_where(ctx),
            "text": (why + " " if why else "") + "Best set in the app, then it applies everywhere alike. "
                    "In the Proxy Manager it only works with a custom \"location /\" block under Advanced - "
                    "nginx does not inherit add_header from the server block once the host sets HSTS.",
            "snippet": _app_snippet(ctx, header, value), "action": None}


def check_tls_versions(host: str) -> dict:
    res = {name: _handshake(host, ver) for name, ver in
           (("1.0", V.TLSv1), ("1.1", V.TLSv1_1), ("1.2", V.TLSv1_2), ("1.3", V.TLSv1_3))}
    on = [k for k, (ok, _) in res.items() if ok]
    unknown = [k for k, (ok, _) in res.items() if ok is None]
    detail = "Offered: " + (", ".join(f"TLS {k}" for k in on) or "nothing") + \
        (f". Not testable: {', '.join(f'TLS {k}' for k in unknown)}" if unknown else "") + "."
    old = [k for k in ("1.0", "1.1") if res[k][0]]
    fix = {"where": "Proxy Manager → conf.d/include/ssl-ciphers.conf (part of the image) or "
                    + _npm_where({"domain": host}, "Advanced"),
           "text": "Allow only TLS 1.2 and 1.3. A current Proxy Manager does that by itself - otherwise update the "
                   "image or add the line under Advanced.",
           "snippet": "ssl_protocols TLSv1.2 TLSv1.3;", "action": None}
    if old:
        return _chk("tls-versions", "fail", f"Outdated TLS {' and '.join(old)} is still enabled.",
                    detail + " Old versions have known weaknesses; browsers stopped using them in 2020. "
                             "Score at most 89.", fix)
    if not res["1.3"][0] and res["1.3"][0] is not None:
        return _chk("tls-versions", "warn", "TLS 1.3 is missing.",
                    detail + " TLS 1.3 is faster and allows only secure ciphers.", fix)
    if not on:
        return _chk("tls-versions", "fail", "No TLS handshake possible.", detail, fix)
    return _chk("tls-versions", "ok", "Only TLS 1.2 and 1.3 - 1.0 and 1.1 are off.", detail)


def check_ciphers(host: str) -> tuple[dict, list]:
    old = _handshake(host, V.TLSv1_2, OLD_CIPHERS)
    nofs = _handshake(host, V.TLSv1_2, NO_FS_CIPHERS)
    cbc = _handshake(host, V.TLSv1_2, CBC_CIPHERS)
    fix = {"where": "Proxy Manager → conf.d/include/ssl-ciphers.conf (part of the image) or "
                    + _npm_where({"domain": host}, "Advanced"),
           "text": "Offer only AEAD ciphers with forward secrecy (Mozilla \"intermediate\"). A current Proxy "
                   "Manager ships exactly this list.",
           "snippet": "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:"
                      "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
           "action": None}
    untested = [n for n, r in (("outdated", old), ("without forward secrecy", nofs), ("CBC", cbc)) if r[0] is None]
    note = f" Not testable: {', '.join(untested)}." if untested else ""
    caps = []
    if old[0]:
        caps.append(("C", "outdated ciphers (3DES/RC4/NULL)"))
        return _chk("tls-ciphers", "fail", "Outdated ciphers are accepted.",
                    f"The server accepts {old[1]}. Such ciphers are considered broken. Score at most 79." + note, fix), caps
    if nofs[0]:
        caps.append(("B", "no forward secrecy"))
        return _chk("tls-ciphers", "warn", "Ciphers without forward secrecy are accepted.",
                    f"The server accepts {nofs[1]}. If the server key ever leaks, recorded traffic can be "
                    "decrypted afterwards. Score at most 89." + note, fix), caps
    if cbc[0]:
        return _chk("tls-ciphers", "warn", "Older CBC ciphers are still accepted.",
                    f"The server accepts {cbc[1]}. Not broken, but SSL Labs marks them as weak." + note, fix), caps
    return _chk("tls-ciphers", "ok", "Only modern ciphers with forward secrecy.",
                "No outdated ciphers, no RSA key exchange, no CBC under TLS 1.2." + note), caps


def check_cert(host: str, ctx: dict) -> tuple[dict, list]:
    c = _cert(host)
    ctx["cert"] = c
    fix_renew = {"where": "Services → site → certificate \"Renew\" (or Proxy Manager → SSL Certificates)",
                 "text": "Have the certificate issued again. If automatic renewal is stuck, the Proxy Manager log "
                         "shows why (often: port 80 unreachable or DNS points elsewhere).",
                 "snippet": None, "action": None}
    if c["ok"] is None:
        return _chk("cert", "fail", "Certificate not retrievable.", c["message"], fix_renew), [("F", "certificate not testable")]
    if c["ok"] is False:
        code = c.get("code")
        what = {10: "The certificate has expired.",
                20: "The chain is incomplete - the server lacks the intermediate certificate.",
                62: "The certificate does not match the site's name.",
                18: "The certificate is self-signed.", 19: "The chain ends at an unknown authority."
                }.get(code, "The certificate is invalid.")
        if code == 20:
            fix_renew = {**fix_renew, "text": "Serve fullchain.pem instead of cert.pem. The Proxy Manager does this "
                                              "automatically - have the certificate issued again there."}
        return _chk("cert", "fail", what, f"{c['message']}. Browsers show a warning page. Score at most 49.", fix_renew), \
            [("F", "invalid certificate")]
    days = c["daysLeft"]
    detail = f"Valid until {_date(c['expiresAt'])} · {c['issuer']} · chain complete."
    if days < 7:
        return _chk("cert", "fail", f"Expires in {max(days, 0)} days.", detail + " Automatic renewal is stuck.", fix_renew), []
    if days < 21:
        return _chk("cert", "warn", f"Expires in {days} days.",
                    detail + " Let's Encrypt renews 30 days ahead - that should have happened already.", fix_renew), []
    return _chk("cert", "ok", f"Valid, {days} days left, chain complete.", detail), []


def check_redirect(host: str, ctx: dict) -> tuple[dict, list]:
    fix = {"where": _npm_where(ctx, "SSL → \"Force SSL\""),
           "text": "Turn on \"Force SSL\". The Proxy Manager then redirects every HTTP request to HTTPS with 301.",
           "snippet": None, "action": "force-ssl" if ctx.get("id") else None}
    try:
        r = _request(f"http://{host}/")
    except (ConnectionRefusedError, socket.timeout, TimeoutError):
        return _chk("https-redirect", "ok", "Port 80 is closed - nothing is served unencrypted.",
                    "Visitors who only type the name are not sent to HTTPS automatically, though."), []
    except (OSError, http.client.HTTPException) as e:
        return _chk("https-redirect", "ok", "No answer over HTTP.", str(e)), []
    loc = r.one("Location") or ""
    target = urlsplit(urljoin(f"http://{host}/", loc)) if loc else None
    if r.status in (301, 302, 303, 307, 308) and target and target.scheme == "https":
        if target.hostname != host:
            return _chk("https-redirect", "warn", f"Redirects to another host ({target.hostname}).",
                        f"HTTP {r.status} → {loc}. For HSTS, redirect to HTTPS of the same name first.", fix), []
        if r.status in (302, 303, 307):
            return _chk("https-redirect", "ok", f"Redirects to HTTPS ({r.status}).",
                        f"→ {loc}. 301 or 308 would be permanent and remembered by browsers.", None), []
        return _chk("https-redirect", "ok", "Redirects permanently to HTTPS.", f"HTTP {r.status} → {loc}"), []
    if r.status in (301, 302, 303, 307, 308):
        return _chk("https-redirect", "warn", "Redirects, but not to HTTPS.", f"HTTP {r.status} → {loc}", fix), []
    return _chk("https-redirect", "fail", "The site is also reachable unencrypted.",
                f"http://{host}/ answers with {r.status} instead of redirecting. Anyone listening on the same Wi-Fi "
                "can read and change content. Score at most 79.", fix), [("C", "HTTPS not enforced")]


def _directives(csp: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for part in csp.split(";"):
        bits = part.strip().split()
        if bits and bits[0].lower() not in out:
            out[bits[0].lower()] = [b.lower() for b in bits[1:]]
    return out


def check_hsts(r: Resp, ctx: dict) -> dict:
    vals = r.all("Strict-Transport-Security")
    npm_fix = {"where": _npm_where(ctx, "SSL → \"HSTS Enabled\""),
               "text": "Turn on HSTS in the Proxy Manager. Browsers then remember for 2 years to open the site only "
                       "over HTTPS - even when someone types http:// or an attacker redirects.",
               "snippet": None, "action": "hsts" if ctx.get("id") and ctx.get("hasCert", True) else None}
    if not vals:
        return _chk("hsts", "fail", "No HSTS.", "On the next visit the browser may ask unencrypted again; "
                    "an attacker on the same network can exploit that.", npm_fix)
    eff = vals[0]
    m = re.search(r"max-age\s*=\s*\"?(\d+)", eff, re.I)
    age = int(m.group(1)) if m else 0
    sub = bool(re.search(r"includesubdomains", eff, re.I))
    detail = f"Sent: \"{eff}\"."
    app_first = len(vals) > 1 and not NPM_HSTS.match(eff.strip())
    if len(vals) > 1:
        detail += f" {len(vals)} HSTS headers arrive - browsers only honor the first" + \
                  (" (the app's, not the Proxy Manager's)." if app_first else ".")
    app_fix = {"where": _app_where(ctx),
               "text": "The app sends its own HSTS header, and it comes before the Proxy Manager's. Remove the line "
                       "in the app (the Proxy Manager already sets HSTS) or extend it like this:",
               "snippet": _app_snippet(ctx, "Strict-Transport-Security", "max-age=63072000; includeSubDomains"),
               "action": None}
    fix = app_fix if app_first else {**npm_fix, "action": None,
                                     "text": "Turn on \"HSTS Subdomains\" in the Proxy Manager. Note: the Proxy Manager "
                                             "defines the HSTS value anew in every host conf, nginx uses the one loaded "
                                             "last (alphabetically last file in nginx/proxy_host/)."}
    if age <= 0:
        return _chk("hsts", "fail", "HSTS is switched off with max-age=0.", detail, fix)
    if age < HALF_YEAR:
        return _chk("hsts", "warn", f"HSTS lasts only {age // 86400} days.",
                    detail + " At least 6 months are recommended, 1-2 years are better.", fix)
    if not sub:
        return _chk("hsts", "warn", "HSTS without includeSubDomains.",
                    detail + " Subdomains (e.g. www.) are not protected; an attacker could set cookies for the main "
                             "domain through an unencrypted subdomain.", fix)
    return _chk("hsts", "ok", f"HSTS for {age // 86400} days including subdomains.", detail)


def check_csp(r: Resp, ctx: dict, locked: bool) -> dict:
    vals = r.all("Content-Security-Policy")
    ro = r.all("Content-Security-Policy-Report-Only")
    base = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    if not vals:
        if locked:
            return _chk("csp", "skip", "Not visible on the block page.",
                        "Whether the app sends a CSP cannot be tested from outside. No deduction.",
                        _header_fix(ctx, "Content-Security-Policy", base))
        return _chk("csp", "fail", "No Content-Security-Policy." + (" Report-only only." if ro else ""),
                    "Without a CSP any injected script may run (cross-site scripting). The CSP defines "
                    "where scripts, images and connections may come from.",
                    _header_fix(ctx, "Content-Security-Policy", base,
                                "Start with a strict base rule and allow what the page needs (the browser console shows violations)."))
    d = _directives(";".join(vals))
    script = d.get("script-src", d.get("default-src"))
    issues = []
    if script is None:
        issues.append("neither script-src nor default-src - scripts are not restricted")
    else:
        strict = any(s.startswith(("'nonce-", "'sha256-", "'sha384-", "'sha512-")) or s == "'strict-dynamic'" for s in script)
        if "'unsafe-inline'" in script and not strict:
            issues.append("script-src allows 'unsafe-inline' - injected inline scripts run")
        if "'unsafe-eval'" in script:
            issues.append("script-src allows 'unsafe-eval' - eval() and friends are open")
        if any(s in ("*", "https:", "http:", "data:") for s in script):
            issues.append("script-src allows scripts from anywhere")
    if "frame-ancestors" not in d:
        issues.append("frame-ancestors is missing - framing by other sites is only governed by X-Frame-Options")
    detail = f"Sent: \"{'; '.join(vals)[:400]}\"."
    if issues:
        return _chk("csp", "warn", "CSP present, but " + issues[0].split(" - ")[0] + ".",
                    detail + " " + "; ".join(i[0].upper() + i[1:] for i in issues) + ".",
                    _header_fix(ctx, "Content-Security-Policy", base,
                                "Move inline scripts into files or allow them with a nonce/hash, then drop 'unsafe-inline'/'unsafe-eval'; add frame-ancestors 'none'."))
    return _chk("csp", "ok", "Strict CSP without unsafe-inline/unsafe-eval for scripts.", detail)


def _simple_header(cid: str, r: Resp, ctx: dict, locked: bool, header: str, good, value: str,
                   missing_status: str, missing_text: str, ok_text: str) -> dict:
    v = r.one(header)
    fix = _header_fix(ctx, header, value)
    if v is None:
        if locked:
            return _chk(cid, "skip", "Not visible on the block page.",
                        "Whether the app sends it cannot be tested from outside. No deduction.", fix)
        return _chk(cid, missing_status, f"{header} is missing.", missing_text, fix)
    bad = good(v)
    if bad:
        return _chk(cid, "warn", f"{header}: {v}", bad, fix)
    return _chk(cid, "ok", ok_text, f"Sent: \"{v}\".")


def check_xcto(r: Resp, ctx: dict, locked: bool) -> dict:
    return _simple_header("xcto", r, ctx, locked, "X-Content-Type-Options",
                          lambda v: None if v.strip().lower() == "nosniff" else "Only \"nosniff\" is valid.",
                          "nosniff", "fail",
                          "Browsers may guess the file type and e.g. run an uploaded text file as a script.",
                          "nosniff is set.")


def check_frame(r: Resp, ctx: dict, locked: bool) -> dict:
    xfo = r.one("X-Frame-Options")
    fa = _directives(";".join(r.all("Content-Security-Policy"))).get("frame-ancestors")
    fix = _header_fix(ctx, "X-Frame-Options", "DENY",
                      "Or set frame-ancestors 'none' (or 'self') in the CSP.")
    if fa is not None:
        return _chk("frame", "ok", f"frame-ancestors {' '.join(fa) or '(empty)'}.",
                    "The CSP controls who may embed the page." + (f" Also X-Frame-Options: {xfo}." if xfo else ""))
    if xfo:
        if xfo.strip().upper() in ("DENY", "SAMEORIGIN"):
            return _chk("frame", "ok", f"X-Frame-Options: {xfo}.", "Other sites cannot embed it.")
        return _chk("frame", "warn", f"X-Frame-Options: {xfo}.", "Only DENY or SAMEORIGIN work in all browsers.", fix)
    if locked:
        return _chk("frame", "skip", "Not visible on the block page.",
                    "Whether the app forbids framing cannot be tested from outside. No deduction.", fix)
    return _chk("frame", "fail", "Other sites may embed this one.",
                "Neither X-Frame-Options nor frame-ancestors. A foreign page can embed this one invisibly and "
                "capture clicks (clickjacking).", fix)


def check_referrer(r: Resp, ctx: dict, locked: bool) -> dict:
    weak = {"unsafe-url": "Sends the full address including path and parameters to every other site.",
            "no-referrer-when-downgrade": "Sends the full address to other HTTPS sites.",
            "origin-when-cross-origin": None, "same-origin": None, "origin": None, "no-referrer": None,
            "strict-origin": None, "strict-origin-when-cross-origin": None}
    return _simple_header("referrer", r, ctx, locked, "Referrer-Policy",
                          lambda v: weak.get(v.split(",")[-1].strip().lower(), None),
                          "strict-origin-when-cross-origin", "warn",
                          "Browsers then use their default (usually strict-origin-when-cross-origin). Better set it "
                          "explicitly, so paths with tokens or IDs do not go to other sites.",
                          "Referrer-Policy is set.")


def check_permissions(r: Resp, ctx: dict, locked: bool) -> dict:
    return _simple_header("permissions", r, ctx, locked, "Permissions-Policy", lambda v: None,
                          "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "warn",
                          "Defines which device features (camera, microphone, location) the page and embedded "
                          "third-party content may use. Without the header the browser alone decides.",
                          "Permissions-Policy is set.")


def check_leak(r: Resp, ctx: dict) -> dict:
    found = []
    srv = r.one("Server")
    if srv and re.search(r"\d", srv):
        found.append(f"Server: {srv}")
    for h in ("X-Powered-By", "X-AspNet-Version", "X-AspNetMvc-Version", "X-Generator"):
        for v in r.all(h):
            found.append(f"{h}: {v}")
    if not found:
        return _chk("leak", "ok", "No versions disclosed.", f"Server: {srv or '-'}.")
    kind = ctx.get("appKind")
    snippet = {"next": "// next.config.js\npoweredByHeader: false,",
               "express": "app.disable(\"x-powered-by\");"}.get(kind or "", "proxy_hide_header X-Powered-By;")
    where = _app_where(ctx) if kind in ("next", "express") else _npm_where(ctx, "Advanced")
    return _chk("leak", "warn", "Discloses software" + (" and version" if any(re.search(r"\d", f) for f in found) else "") + ".",
                "; ".join(found) + ". Helps attackers look up matching known vulnerabilities.",
                {"where": where, "text": "Turn it off in the app or hide it in the Proxy Manager under Advanced "
                                         "(proxy_hide_header there also applies to location /).",
                 "snippet": snippet, "action": None})


SESSIONISH = re.compile(r"sess|sid|token|auth|jwt|login|user|remember|csrf|xsrf", re.I)


def _parse_cookie(raw: str) -> dict:
    parts = [p.strip() for p in raw.split(";")]
    name = parts[0].split("=", 1)[0].strip()
    attrs = {p.split("=", 1)[0].strip().lower(): (p.split("=", 1)[1].strip() if "=" in p else "") for p in parts[1:] if p}
    return {"name": name, "secure": "secure" in attrs, "httpOnly": "httponly" in attrs,
            "sameSite": attrs.get("samesite") or None}


def check_cookies(resps: list[Resp], ctx: dict, locked: bool, login_url: str | None) -> dict:
    seen: dict[str, dict] = {}
    for r in resps:
        for raw in r.all("Set-Cookie"):
            c = _parse_cookie(raw)
            seen[c["name"]] = c
    where_txt = "home page" + (f" and login page ({urlsplit(login_url).path})" if login_url else "")
    if not seen:
        if locked:
            return _chk("cookies", "skip", "No cookies on the block page.",
                        "The app's cookies are not visible from outside. No deduction.")
        return _chk("cookies", "ok", "Sets no cookies.", f"Checked: {where_txt}.")
    fails, warns, lines = [], [], []
    for c in seen.values():
        miss = [f for f, ok in (("Secure", c["secure"]), ("HttpOnly", c["httpOnly"]), ("SameSite", c["sameSite"])) if not ok]
        if c["sameSite"] and c["sameSite"].lower() == "none" and not c["secure"]:
            miss.append("SameSite=None without Secure")
        lines.append(f"{c['name']}: " + ("all set" if not miss else "without " + ", ".join(miss)))
        if not c["secure"]:
            fails.append(c["name"])
        elif not c["sameSite"] or (not c["httpOnly"] and SESSIONISH.search(c["name"])):
            warns.append(c["name"])
    detail = f"Checked: {where_txt}. " + " · ".join(lines) + "."
    fix = {"where": _app_where(ctx),
           "text": "Set cookies in the app with Secure, HttpOnly (unless a script must read them) and SameSite=Lax or Strict.",
           "snippet": "Set-Cookie: name=value; Path=/; Secure; HttpOnly; SameSite=Lax", "action": None}
    if fails:
        return _chk("cookies", "fail", f"{len(fails)} cookie{'s' if len(fails) > 1 else ''} without Secure.",
                    detail + " Without Secure the cookie is also sent over unencrypted HTTP.", fix)
    if warns:
        return _chk("cookies", "warn", f"{len(warns)} cookie{'s' if len(warns) > 1 else ''} without SameSite/HttpOnly.",
                    detail + " Without HttpOnly injected scripts can read session cookies; without SameSite "
                             "the browser sends them along with requests from other sites (CSRF).", fix)
    return _chk("cookies", "ok", f"{len(seen)} cookie{'s' if len(seen) > 1 else ''}, all with Secure and SameSite.", detail)


# --------------------------------------------------------------------------- Information leaks: error page

TRACE = re.compile(rb"Traceback \(most recent call last\)|\n\s+at [\w$.<>\[\] ]+ \((?:/|file:|node:)|Whitelabel Error Page|"
                   rb"Werkzeug Debugger|DisallowedHost|<b>(?:Fatal error|Warning|Notice)</b>:|SQLSTATE\[|Stack trace:", re.I)
VERSION_IN_PAGE = re.compile(rb"\b(nginx|apache|openresty|caddy|express|php|tomcat|jetty|gunicorn|werkzeug|"
                             rb"uvicorn|microsoft-iis|lighttpd)/v?(\d+\.\d+[\w.]*)", re.I)


def check_errors(r: Resp | None, ctx: dict, mode: str) -> dict:
    """A page that does not exist: does it disclose software versions or a stack trace?"""
    what = "The block page" if mode == "lock" else "A page that does not exist"
    if r is None:
        return _chk("errors", "skip", "Error page not retrievable.", "No deduction.")
    body = r.body or b""
    m_trace = TRACE.search(body)
    m_ver = VERSION_IN_PAGE.search(body)
    path = urlsplit(r.url).path
    if m_trace:
        snippet = body[max(0, m_trace.start() - 40):m_trace.end() + 80].decode("utf-8", "replace").strip()
        return _chk("errors", "fail", "Error page shows a stack trace.",
                    f"{path} → {r.status}: \"...{snippet[:160]}...\". Discloses paths, libraries and sometimes data.",
                    {"where": _app_where(ctx), "text": "Turn off debug output in the app (production mode, "
                     "own error page without details).", "snippet": None, "action": None})
    if m_ver:
        soft, ver = m_ver.group(1).decode(), m_ver.group(2).decode()
        is_nginx = soft.lower() in ("nginx", "openresty")
        return _chk("errors", "warn", f"Error page discloses {soft} {ver}.",
                    f"{what} ({path} → {r.status}) names \"{soft}/{ver}\". Whoever knows the version can look "
                    "for matching vulnerabilities.",
                    {"where": _app_where(ctx) if mode != "lock" else "Proxy Manager → nginx.conf",
                     "text": ("Set \"server_tokens off;\" in the app's nginx configuration (http or server block), "
                              "then error pages only say \"nginx\".") if is_nginx else
                     "Turn off the version in the error page or serve your own error page.",
                     "snippet": "server_tokens off;" if is_nginx else None, "action": None})
    return _chk("errors", "ok", "Error pages without versions and stack traces.",
                f"Checked: {path} → {r.status}.")


# --------------------------------------------------------------------------- Access protection

# Same as the path pattern of the app-login filter (modules/fail2ban/files/filter-app-login.conf).
F2B_PATH = re.compile(r"(?:/api/admin/|/admin(?:[/?]|$)|/(?:api/(?:v\d/)?)?(?:auth/)?"
                      r"(?:login|signin|sign-in)(?:[/?]|$))")
_CACHE: dict = {}


def _sh(cmd: list[str], timeout: float = 15) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def _cached(key: str, ttl: float, fn):
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _CACHE[key] = (time.time(), val)
    return val


def _f2b_login() -> bool:
    """Is the app-login jail running (failed logins on the sites -> ban)?"""
    if not config.enabled("fail2ban"):
        return False
    return _cached("f2b", 600, lambda: (lambda rc_out: rc_out[0] == 0 and "Status for the jail" in rc_out[1])(
        _sh(["fail2ban-client", "status", "app-login"])))


def _rate() -> int:
    return config.get_int("KW_PROXY_RATE", 20)


def _rate_limit(host_id: int | None) -> bool:
    """Rate limit for all sites (limit_req, KW_PROXY_RATE per IP) active and included by the proxy host?"""
    def probe():
        try:
            top = (NPM_DIR / "nginx/custom/http_top.conf").read_text()
            srv = (NPM_DIR / "nginx/custom/server_proxy.conf").read_text()
        except OSError:
            return False
        if "limit_req_zone" not in top or not re.search(r"^\s*limit_req\s+zone=", srv, re.M):
            return False
        if host_id is None:
            return True
        try:
            return "custom/server_proxy" in (NPM_DIR / f"nginx/proxy_host/{host_id}.conf").read_text()
        except OSError:
            return False
    return _cached(f"ratelimit:{host_id}", 600, probe)


def check_login(ctx: dict, mode: str, login: Resp | None, admin: list[dict]) -> dict:
    allow = ctx.get("allowlist") or 0
    if mode in ("app", "lock"):
        return _chk("login", "ok", f"Only allowed addresses ({allow}) reach the app.",
                    "Strangers get the Proxy Manager's 403 block page before the app sees anything - login and "
                    "admin area are invisible to them.")
    paths = []
    if login:
        paths.append(urlsplit(login.url).path or "/")
        m = FORM_ACTION.search(login.body or b"")
        if m:
            paths.append(urlsplit(urljoin(login.url, m.group(1).decode("utf-8", "replace"))).path)
    for a in admin:
        paths.append(a["path"])
        if a.get("action"):
            paths.append(urlsplit(urljoin(a["url"], a["action"])).path)
    paths = list(dict.fromkeys(p for p in paths if p))
    limited = _rate_limit(ctx.get("id"))
    rate_text = f"rate limit for all sites active ({_rate()} requests/s per IP)"
    if not paths:
        return _chk("login", "ok", "No login found - nothing to guess.",
                    "Searched: login links on the home page, " + ", ".join(LOGIN_PATHS + ADMIN_PATHS) + ". "
                    + (rate_text[0].upper() + rate_text[1:] + " anyway." if limited else ""))
    f2b = _f2b_login()
    covered = [p for p in paths if F2B_PATH.search(p)]
    guard_f2b = f2b and bool(covered)
    shown = ", ".join(paths[:4])
    parts = [
        ("fail2ban app-login bans after 5 failed logins within 1 h for 1 day (covers " + ", ".join(covered) + ")")
        if guard_f2b else ("fail2ban app-login is not running" if not f2b else f"fail2ban does not cover {shown}"),
        rate_text if limited else "no rate limit (limit_req) on the proxy host",
    ]
    detail = f"Login at {shown}. " + "; ".join(parts) + "."
    fix = {"where": "modules/fail2ban/files/filter-app-login.conf (path pattern) or modules/proxy/files/server_proxy.conf, "
                    "then ./keepwatch deploy",
           "text": ("Add the login path to the filter's path pattern, so failed logins (401/403) lead to a ban."
                    if f2b and not covered else "Turn on the app-login jail (fail2ban module, KW_F2B_APP_LOGIN=\"yes\").")
           if not guard_f2b else "Include the rate limit again: server_proxy.conf with \"limit_req zone=...\" "
                                 "(KW_PROXY_RATE above 0).",
           "snippet": None, "action": None}
    if guard_f2b and limited:
        return _chk("login", "ok", "Login is protected against guessing.", detail)
    if guard_f2b or limited:
        return _chk("login", "warn", "Login is only half protected.", detail, fix)
    return _chk("login", "fail", "Passwords can be guessed without limit.", detail, {**fix, "text": (
        "Set up fail2ban app-login for the path and include the rate limit - or open the site only to your own "
        "addresses with an IP allow-list.")})


def check_admin(ctx: dict, mode: str, admin: list[dict]) -> dict:
    if mode in ("app", "lock"):
        return _chk("admin", "ok", "Admin area only reachable through the IP allow-list.",
                    "The whole site is behind the allow-list.")
    if not admin:
        return _chk("admin", "ok", "No public admin area found.",
                    "Checked: " + ", ".join(ADMIN_PATHS) + " - none answers with its own page (404 or home page).")
    a = admin[0]
    how = "asks for a login" if a["status"] == 401 or a["password"] else "answers with its own page"
    more = f" (also {', '.join(x['path'] for x in admin[1:])})" if len(admin) > 1 else ""
    sid = ctx.get("id")
    return _chk("admin", "warn", f"{a['path']} is reachable from the internet.",
                f"https://{ctx['domain']}{a['path']} → {a['status']}, {how}{more}. Anyone can try passwords "
                "there; a flaw in the login would hit immediately.",
                {"where": f"Services → {ctx['domain']}{f' (#{sid})' if sid else ''} → Access → Paths for the list only",
                 "text": f"Add {', '.join(dict.fromkeys(x['path'] for x in admin))} there and allow only your own "
                         "addresses - strangers get 403, the rest of the site stays open.",
                 "snippet": None, "action": None})


# --------------------------------------------------------------------------- Software (Trivy)

def _scan() -> dict | None:
    if not config.enabled("image-scan"):
        return None

    def read():
        try:
            return json.loads(config.IMAGE_SCAN_JSON.read_text())
        except (OSError, ValueError):
            return None
    return _cached("scan", 300, read)


def check_vulns(ctx: dict) -> tuple[dict, dict]:
    conts = set((ctx.get("app") or {}).get("containers") or [])
    scan = _scan()
    images = [(ref, i) for ref, i in ((scan or {}).get("images") or {}).items() if conts & set(i.get("containers") or [])]
    if not config.enabled("image-scan"):
        why = "The image-scan module is off."
        return (_chk("vuln-critical", "skip", why, "No deduction. Enable image-scan in KW_MODULES to grade this."),
                _chk("vuln-high", "skip", why, "No deduction."))
    if not conts or not images:
        why = "No security scan yet." if not scan else (
            "No containers found for the service." if not conts else "The service's containers are not scanned yet.")
        when = config.get("KW_IMAGE_SCAN_TIME", "weekly")
        return (_chk("vuln-critical", "skip", why, f"No deduction until the next scan ({when}) has run."),
                _chk("vuln-high", "skip", why, "No deduction."))
    when = scan.get("finishedAt") or max((i.get("scannedAt") or 0) for _, i in images)
    stamp = f"Scan of {_date(when)}" if when else "Last scan"

    # Counted per CVE (Trivy lists the same vulnerability in libssl3 and libcrypto3 twice).
    def uniq(i: dict, sev: str, fixed: bool | None = None) -> set[str]:
        return {v["id"] for v in i.get("vulns") or [] if v.get("severity") == sev and (fixed is None or bool(v.get("fixed")) == fixed)}

    def count(i: dict, sev: str) -> int:
        n = len(uniq(i, sev))
        return n if len(i.get("vulns") or []) < 200 else max(n, i.get(sev.lower()) or 0)

    crit = len(set().union(*(uniq(i, "CRITICAL") for _, i in images)))
    high = len(set().union(*(uniq(i, "HIGH") for _, i in images)))
    first: dict[str, tuple[str, dict]] = {}
    for ref, i in images:
        for v in i.get("vulns") or []:
            if v.get("fixed"):
                first.setdefault(v["id"], (ref, v))
    cfix = [x for x in first.values() if x[1].get("severity") == "CRITICAL"]
    hfix = [x for x in first.values() if x[1].get("severity") == "HIGH"]
    per = " · ".join(f"{ref}: {count(i, 'CRITICAL')} critical, {count(i, 'HIGH')} high" for ref, i in images
                     if count(i, "CRITICAL") + count(i, "HIGH")) or "none"

    def fixed(v: dict) -> str:  # "15.5.24, 16.3.3" -> the version in the same series as the installed one
        opts = [x.strip() for x in str(v.get("fixed") or "").split(",") if x.strip()]
        major = re.match(r"v?(\d+)", v.get("installed") or "")
        same = [x for x in opts if major and re.match(rf"v?{major.group(1)}\.", x)]
        return (same or opts or ["?"])[0]

    def top(lst):
        return "; ".join(f"{v['id']} in {v['pkg']} {v.get('installed') or ''} → {fixed(v)} ({ref})" for ref, v in lst[:3])

    built = [ref for ref, _ in images if "/" not in ref.split(":")[0] and ":" not in ref]  # built locally
    fix = {"where": "Updates → security scan" + (f" · rebuild {', '.join(built)} from its repository" if built else ""),
           "text": ("Locally built images: update the base image in the Dockerfile (or pull it again without cache) and "
                    "redeploy the service. " if built else "") + "Images from a registry: install the update on the "
                   "Updates page. Then start the scan again.", "snippet": None, "action": None}
    if cfix:
        c = _chk("vuln-critical", "fail", f"{len(cfix)} critical vulnerabilit{'ies' if len(cfix) > 1 else 'y'} with a fix.",
                 f"{stamp}: {per}. With a fix: {top(cfix)}.", fix)
    elif crit:
        c = _chk("vuln-critical", "warn", f"{crit} critical vulnerabilit{'ies' if crit > 1 else 'y'}, no fix yet.",
                 f"{stamp}: {per}. There is no fixed version yet - check again after the next scan "
                 "or choose a different base image.", fix)
    else:
        c = _chk("vuln-critical", "ok", "No critical vulnerabilities.", f"{stamp}: {per}.")
    hn = len(hfix)
    more = " (at least - the scan lists at most 200 per image)" if any(len(i.get("vulns") or []) >= 200 for _, i in images) else ""
    if hn >= 10:
        h = _chk("vuln-high", "fail", f"{hn} high vulnerabilities with a fix{more}.", f"{stamp}: {per}. For example: {top(hfix)}.", fix)
    elif hn:
        h = _chk("vuln-high", "warn", f"{hn} high vulnerabilit{'ies' if hn > 1 else 'y'} with a fix.", f"{stamp}: {per}. {top(hfix)}.", fix)
    else:
        h = _chk("vuln-high", "ok", "No high vulnerabilities with an available fix." if high else "No high vulnerabilities.",
                 f"{stamp}: {per}." + (f" {high} high without a fixed version do not count." if high else ""))
    return c, h


# --------------------------------------------------------------------------- Score, grade

def grade_of(checks: list[dict], caps: list[tuple[str, str]]) -> dict:
    """Score = 100 - deductions (per category at most its points), then caps; the grade follows from the score."""
    cats = []
    for cat, title, ids in CATEGORIES:
        mine = [c for c in checks if c["category"] == cat]
        ded = sum(c["deduction"] for c in mine)
        mx = sum(ids.values())
        cats.append({"id": cat, "title": title, "max": mx, "points": round(max(mx - ded, 0), 1),
                     "problems": sum(1 for c in mine if c["status"] in ("warn", "fail")),
                     "skipped": bool(mine) and all(c["status"] == "skip" for c in mine)})
    raw = int(sum(c["points"] for c in cats) + 0.5)
    score, applied = raw, []
    for cap, why in caps:
        applied.append({"grade": cap, "max": CAP_MAX[cap], "reason": why})
        score = min(score, CAP_MAX[cap])
    grade = next(letter for limit, letter in GRADES if score >= limit)
    return {"score": max(score, 0), "raw": raw, "grade": grade, "caps": applied, "categories": cats}


def _app_kind(r: Resp, ctx: dict) -> str | None:
    pb = " ".join(r.all("X-Powered-By")).lower()
    if "next.js" in pb or r.one("x-nextjs-cache") or r.one("x-nextjs-prerender"):
        return "next"
    if "express" in pb:
        return "express"
    return None  # nginx or Node without X-Powered-By - cannot be told apart from outside


def _as_visitor(app: Resp, public: Resp) -> Resp:
    """What an allowed visitor would get: the app's headers, plus HSTS from the Proxy Manager (add_header
    always); nginx hides the app's Server header and sets its own."""
    keep = [(k, v) for k, v in app.headers if k.lower() not in ("server", "connection", "keep-alive", "date")]
    proxy = [(k, v) for k, v in public.headers if k.lower() in ("server", "strict-transport-security")]
    r = Resp(app.status, app.url, keep + proxy, app.body)
    return r


def _missing_page(home: Resp, verify: bool, via: dict | None) -> Resp | None:
    host = urlsplit(home.url).hostname
    try:
        return _request(f"https://{host}/keepwatch-grade-{secrets.token_hex(4)}", verify, via)
    except (OSError, http.client.HTTPException, ssl.SSLError):
        return None


def grade_site(domain: str, ctx: dict | None = None) -> dict:
    """Check one site. ctx: id, allowlist, hasCert, upstream {ip, port, scheme},
    app {container, containers, repo, stack} - all optional."""
    ctx = {**(ctx or {}), "domain": domain}
    t0 = time.time()
    out = {"schema": SCHEMA, "id": ctx.get("id"), "domain": domain, "checkedAt": int(t0), "grade": None,
           "score": None, "raw": None, "via": "public", "limited": False, "limitedNote": None, "status": None,
           "appStatus": None, "url": None, "loginUrl": None, "admin": [], "caps": [], "categories": [], "checks": [],
           "error": None, "durationMs": None}
    verify = True
    try:
        try:
            home, chain = _follow(f"https://{domain}/", True)
        except ssl.SSLCertVerificationError:
            verify = False
            home, chain = _follow(f"https://{domain}/", False)
    except (OSError, http.client.HTTPException, ssl.SSLError) as e:
        out["error"] = f"Not reachable over HTTPS: {e}"
        out["durationMs"] = int((time.time() - t0) * 1000)
        return out
    out["status"], out["url"] = home.status, home.url
    allow = ctx.get("allowlist")
    locked = home.status == 403 and (allow is None or allow > 0)

    # Behind the allow-list: fetch the app directly on the Docker network (GET only, like uptime.py).
    mode, page, via, pchain = "public", home, None, chain
    if locked:
        mode = "lock"
        up = ctx.get("upstream") or {}
        if up.get("ip") and up.get("port"):
            via = {"ip": up["ip"], "port": int(up["port"]), "scheme": up.get("scheme") or "http"}
            try:
                app_home, app_chain = _follow(f"https://{domain}/", False, 5, via)
                if app_home.status < 500:
                    mode, page = "app", _as_visitor(app_home, home)
                    pchain = app_chain
                    out["appStatus"] = app_home.status
            except (OSError, http.client.HTTPException, ssl.SSLError):
                pass
        if mode != "app":
            via = None
        out["limited"] = True
        out["limitedNote"] = APP_NOTE if mode == "app" else LOCKED_NOTE
    out["via"] = mode
    hidden = mode == "lock"  # only the block page is visible -> app headers "skip"
    ctx["appKind"] = _app_kind(page, ctx)

    checks, caps = [], []
    c = check_tls_versions(domain)
    checks.append(c)
    if c["status"] == "fail":
        caps.append(("B", "TLS 1.0/1.1 offered") if c["summary"].startswith("Outdated TLS") else ("F", "no TLS handshake"))
    for fn in (check_ciphers, check_cert, check_redirect):
        c, cp = fn(domain) if fn is check_ciphers else fn(domain, ctx)
        checks.append(c)
        caps += cp
    checks.append(check_hsts(page, ctx))
    app_checks = [check_csp(page, ctx, hidden), check_frame(page, ctx, hidden), check_xcto(page, ctx, hidden),
                  check_referrer(page, ctx, hidden), check_permissions(page, ctx, hidden), check_leak(page, ctx)]
    login = None if hidden else _find_login(home if mode == "public" else page, verify, via)
    if login:
        out["loginUrl"] = login.url
    app_checks.append(check_cookies(pchain + (getattr(login, "chain", []) if login else []), ctx, hidden,
                                    login.url if login else None))
    missing = home if mode == "lock" else _missing_page(page, verify, via)
    app_checks.append(check_errors(missing, ctx, mode))
    admin = _find_admin(home, missing, verify) if mode == "public" else []
    out["admin"] = [{"path": a["path"], "status": a["status"]} for a in admin]
    app_checks += [check_login(ctx, mode, login, admin), check_admin(ctx, mode, admin)]
    if mode == "app":
        for c in app_checks:
            if c["id"] not in ("login", "admin"):
                c["via"] = "app"
    checks += app_checks
    vc, vh = check_vulns(ctx)
    vc["via"] = vh["via"] = "scan"
    checks += [vc, vh]
    out.update(grade_of(checks, caps))
    out["checks"] = checks
    out["durationMs"] = int((time.time() - t0) * 1000)
    return out


# --------------------------------------------------------------------------- Proxy hosts, containers

def _npm_hosts() -> dict[int, dict]:
    """Enabled proxy hosts straight from the Proxy Manager database (read-only): target and allow-list."""
    con = sqlite3.connect(f"file:{NPM_DIR / 'database.sqlite'}?mode=ro", uri=True, timeout=5)
    try:
        rows = con.execute("SELECT id, domain_names, forward_scheme, forward_host, forward_port, certificate_id, "
                           "advanced_config FROM proxy_host WHERE is_deleted=0 AND enabled=1").fetchall()
    finally:
        con.close()
    out = {}
    for hid, doms, scheme, fhost, fport, cert, adv in rows:
        allow = len(re.findall(r"^\s*allow\s+[^;\s]+\s*;", adv or "", re.M))
        deny = bool(re.search(r"^\s*deny\s+[^;]+;", adv or "", re.M))
        out[hid] = {"id": hid, "domains": json.loads(doms or "[]"), "scheme": scheme or "http", "host": fhost,
                    "port": fport, "hasCert": bool(cert), "allowlist": allow if deny else 0}
    return out


def _docker() -> dict[str, dict]:
    """Running containers: name -> {ip, project}."""
    rc, out = _sh(["docker", "ps", "--format", "{{.Names}}\t{{.Label \"com.docker.compose.project\"}}"])
    names = {}
    for line in out.splitlines():
        n, _, proj = line.partition("\t")
        if n:
            names[n] = {"project": proj or None, "ip": None}
    if names:
        _, raw = _sh(["docker", "inspect", "--format", "{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
                      *sorted(names)], 20)
        for line in raw.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].lstrip("/") in names:
                names[parts[0].lstrip("/")]["ip"] = parts[1]
    return names


IP = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def _upstream(h: dict | None, conts: dict) -> dict | None:
    if not h or not h.get("host"):
        return None
    ip = h["host"] if IP.match(h["host"]) else (conts.get(h["host"]) or {}).get("ip")
    return {"ip": ip, "port": h["port"], "scheme": h["scheme"], "host": h["host"]} if ip else None


def _service_containers(cont: str | None, conts: dict) -> list[str]:
    proj = (conts.get(cont) or {}).get("project") if cont else None
    if not proj:
        return [cont] if cont else []
    return sorted(n for n, c in conts.items() if c.get("project") == proj)


def _targets() -> list[dict]:
    """Enabled sites with proxy host id, allow-list and app (containers, repository) from the dashboard collectors."""
    d = D()
    sites = d.COLLECTORS["sites"].get().get("sites") or []
    try:
        stacks = (d.COLLECTORS["stacks"].get().get("stacks") or []) if config.enabled("portainer") else []
    except Exception:  # noqa: BLE001 - without Portainer there is no repository
        stacks = []
    try:
        hosts = _npm_hosts()
    except (OSError, sqlite3.Error):
        hosts = {}
    conts = _docker()
    out = []
    for s in sites:
        if not s.get("enabled") or not s.get("domains"):
            continue
        cont = re.sub(r":\d+$", "", s.get("target") or "")
        proj = (conts.get(cont) or {}).get("project")
        st = next((x for x in stacks if cont in (x.get("containers") or []) or (proj and x.get("name") == proj)), None)
        repo = None
        if st and st.get("git"):
            repo = "repository " + re.sub(r"^https?://(www\.)?github\.com/|\.git$", "", st["git"]["url"])
        out.append({"id": s["id"], "domain": s["domains"][0], "allowlist": s.get("allowlist", 0),
                    "hasCert": bool(s.get("cert")), "hsts": s.get("hsts"), "sslForced": s.get("sslForced"),
                    "upstream": _upstream(hosts.get(s["id"]), conts),
                    "app": {"container": cont if cont in conts else None, "repo": repo,
                            "containers": _service_containers(cont if cont in conts else None, conts),
                            "stack": st.get("name") if st else proj}})
    return out


def _cli_targets(domains: list[str]) -> list[dict]:
    """Like _targets, but without the dashboard (command line on the server)."""
    hosts, conts = _npm_hosts(), _docker()
    out = []
    for h in sorted(hosts.values(), key=lambda x: x["id"]):
        if not h["domains"] or (domains and not set(domains) & set(h["domains"])):
            continue
        cont = h["host"] if h["host"] in conts else None
        out.append({"id": h["id"], "domain": h["domains"][0], "allowlist": h["allowlist"], "hasCert": h["hasCert"],
                    "upstream": _upstream(h, conts),
                    "app": {"container": cont, "containers": _service_containers(cont, conts), "repo": None,
                            "stack": (conts.get(cont) or {}).get("project")}})
    known = {d for t in out for d in [t["domain"]]}
    out += [{"domain": d} for d in domains if d not in known]
    return out


# --------------------------------------------------------------------------- Timeline

def _timeline_drop(prev: dict | None, res: dict, t: dict):
    """Worse score than at the last check (same schema) -> entry in the timeline."""
    if not prev or prev.get("schema") != SCHEMA or prev.get("score") is None or res.get("score") is None:
        return
    if res["score"] >= prev["score"]:
        return
    old = {c["id"]: c for c in prev.get("checks") or []}
    worse = sorted((c for c in res["checks"] if c["deduction"] > (old.get(c["id"]) or {}).get("deduction", 0)),
                   key=lambda c: -c["deduction"])
    detail = " · ".join(f"{c['title']}: {c['summary']} (−{c['deduction'] - (old.get(c['id']) or {}).get('deduction', 0):g})"
                        for c in worse[:3]) or None
    level = "warn" if ORDER.index(res["grade"]) > ORDER.index(prev["grade"]) else "info"
    try:
        import timeline  # noqa: PLC0415
        cont = (t.get("app") or {}).get("container")
        svc = timeline.service_of_container(cont) if cont else None
        timeline.add("security", f"Security grade {res['domain']}: {prev['score']} → {res['score']}",
                     detail=detail, level=level, service=svc, source="sitegrade",
                     key=f"sitegrade:{res['domain']}:{res['checkedAt']}", weight=40 if level == "warn" else 20,
                     meta={"domain": res["domain"], "from": prev["score"], "to": res["score"]})
    except Exception:  # noqa: BLE001 - the timeline must not hold up the check
        traceback.print_exc()


def _run_one(t: dict):
    dom = t["domain"]
    try:
        res = grade_site(dom, t)
    except Exception as e:  # noqa: BLE001 - one site must not hold up the others
        traceback.print_exc()
        res = {"schema": SCHEMA, "id": t.get("id"), "domain": dom, "checkedAt": int(time.time()), "grade": None,
               "score": None, "raw": None, "via": "public", "limited": False, "limitedNote": None, "caps": [],
               "categories": [], "checks": [], "error": f"Check aborted: {e}"}
    with STATE["lock"]:
        prev = STATE["sites"].get(dom)
        STATE["sites"][dom] = res
        STATE["checking"].discard(dom)
    _timeline_drop(prev, res, t)
    _save()


def check(only_id: int | None = None):
    """Check all sites (or one). Runs in the background; every finished site is saved right away."""
    _load()
    try:
        targets = _targets()
    except Exception as e:  # noqa: BLE001
        STATE["error"] = f"Sites not readable: {e}"
        return
    if only_id is not None:
        targets = [t for t in targets if t["id"] == only_id]
    with STATE["lock"]:
        targets = [t for t in targets if t["domain"] not in STATE["checking"]]
        STATE["checking"].update(t["domain"] for t in targets)
    if not targets:
        return
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="sitegrade") as ex:
        list(ex.map(_run_one, targets))
    with STATE["lock"]:
        if only_id is None:
            STATE["checkedAt"] = int(time.time())
            live = {t["domain"] for t in targets}
            STATE["sites"] = {k: v for k, v in STATE["sites"].items() if k in live}
        STATE["error"] = None
    _save()


def _start(only_id: int | None = None):
    threading.Thread(target=check, args=(only_id,), daemon=True, name="sitegrade-check").start()


def loop():
    _load()
    time.sleep(90)  # only after the other collectors have started
    while True:
        if not config.enabled("proxy"):  # no sites without the proxy
            time.sleep(WAKE_EVERY)
            continue
        try:
            stale = any(s.get("schema") != SCHEMA for s in STATE["sites"].values())  # new grading -> recompute
            due = STATE["checkedAt"] is None or stale or time.time() - STATE["checkedAt"] >= CHECK_EVERY
            if due:
                check()
            else:
                missing = [t for t in _targets() if t["domain"] not in STATE["sites"]]
                for t in missing:
                    check(t["id"])
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(WAKE_EVERY)


def _npm_write() -> bool:
    try:
        import hosts  # noqa: PLC0415 - "New site" wizard (Proxy Manager credentials)
        return hosts.npm_creds() is not None
    except Exception:  # noqa: BLE001
        return False


def status() -> dict:
    _load()
    with STATE["lock"]:
        sites = sorted((dict(s) for s in STATE["sites"].values()), key=lambda s: s["domain"])
        checking = sorted(STATE["checking"])
    for s in sites:
        s["checking"] = s["domain"] in checking
    return {"checkedAt": STATE["checkedAt"], "checking": checking, "error": STATE["error"],
            "every": CHECK_EVERY, "npmWrite": _npm_write(), "schema": SCHEMA, "alertBelow": ALERT_BELOW,
            "grades": [{"grade": g, "min": m} for m, g in GRADES],
            "categories": [{"id": c, "title": t, "max": sum(ids.values()),
                            "checks": [{"id": k, "title": TITLES[k], "weight": w} for k, w in ids.items()]}
                           for c, t, ids in CATEGORIES],
            "sites": sites}


FIXES = {
    "hsts": ({"ssl_forced": True, "hsts_enabled": True}, "HSTS is on"),
    "force-ssl": ({"ssl_forced": True}, "HTTPS is enforced"),
}


def apply_fix(body: dict) -> dict:
    """Turn on HSTS or Force SSL on the proxy host - through the Proxy Manager API (like its UI).

    The Proxy Manager rewrites the host's nginx conf from its database, tests it with nginx -t and
    reloads; if nginx refuses, the old state stays. The dashboard deliberately cannot turn it off.
    """
    d = D()
    kind = str(body.get("fix") or "")
    if kind not in FIXES:
        raise d.ApiError(400, "fix must be \"hsts\" or \"force-ssl\".")
    try:
        sid = int(body.get("id"))
    except (TypeError, ValueError):
        raise d.ApiError(400, "id is missing.") from None
    site = next((s for s in d.COLLECTORS["sites"].get().get("sites") or [] if s["id"] == sid), None)
    if not site:
        raise d.ApiError(404, "This proxy host does not exist.")
    if not site.get("cert"):
        raise d.ApiError(409, "The host has no certificate - without HTTPS there is neither HSTS nor Force SSL.")
    import hosts  # noqa: PLC0415
    if hosts.npm_creds() is None:
        raise d.ApiError(409, "No Proxy Manager credentials are stored (Settings → Proxy Manager access). "
                              "Until then, turn it on there by hand.")
    payload, done = FIXES[kind]
    hosts.npm("PUT", f"/api/nginx/proxy-hosts/{sid}", payload, timeout=90)
    try:
        d.COLLECTORS["sites"].refresh()
    except Exception:  # noqa: BLE001
        pass
    _start(sid)
    dom = (site.get("domains") or ["?"])[0]
    return {"ok": True, "message": f"{done} for {dom}. The grade is being recomputed."}


def route(method: str, path: str, body: dict):
    d = D()
    d.require("proxy")
    if method == "GET" and path == "/api/sitegrade":
        return status()
    if method == "POST" and path == "/api/sitegrade/check":
        sid = body.get("id")
        _start(int(sid) if sid is not None else None)
        time.sleep(0.2)
        return {"ok": True, "checking": True}
    if method == "POST" and path == "/api/sitegrade/fix":
        return apply_fix(body)
    raise d.ApiError(404, "Unknown endpoint.")


# --------------------------------------------------------------------------- Command line (read-only)

if __name__ == "__main__":
    doms = [a for a in sys.argv[1:] if not a.startswith("-")]
    full = "--json" in sys.argv
    try:
        targets = _cli_targets(doms)
    except (OSError, sqlite3.Error):  # not on the server: public view only
        targets = [{"domain": d} for d in doms]
    with ThreadPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(lambda t: grade_site(t["domain"], t), targets))
    if full:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    else:
        for r in results:
            print(f"\n{r['domain']}: {r['grade'] or '-'} · {r['score']}/100 (raw {r['raw']}, HTTP {r['status']}, "
                  f"checked: {r['via']}, {r['durationMs']} ms)" + (f" · {r['error']}" if r["error"] else ""))
            for c in r["categories"]:
                print(f"   {c['title']:<20} {c['points']:>5g}/{c['max']}")
            for cap in r["caps"]:
                print(f"   cap {cap['max']} ({cap['grade']}): {cap['reason']}")
            for c in sorted(r["checks"], key=lambda c: -c["deduction"]):
                if c["status"] != "ok":
                    print(f"   [{c['status']:4}] -{c['deduction']:<4g} {c['title']}: {c['summary']}")
