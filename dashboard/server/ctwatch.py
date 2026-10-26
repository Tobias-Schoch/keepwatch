"""Certificate watch (Certificate Transparency) - dashboard add-on, needs the proxy module.

Every public TLS certificate ends up in the CT logs. Every 6 hours the watch asks them for
all certificates of your own domains (including subdomains) and reports every one that did
NOT come from this server - that catches phishing copies and taken-over DNS records.

Domains: the base domains of all proxy hosts and certificates in Nginx Proxy Manager (also
deleted and disabled ones). New hosts are picked up automatically.

Source: Cert Spotter (api.certspotter.com, SSLMate) - fast, current, returns the SHA-256
fingerprint and with expand=cert_der the certificate itself (-> serial number), and can be
resumed with `after=<id>` (usually one request per base domain and run). Without an account
10 requests/hour - plenty for a few base domains every 6 hours; a token in
<CONF_DIR>/certspotter.token is sent along if present.
If Cert Spotter fails (timeout, 5xx, 429), the watch asks crt.sh (JSON, exclude=expired,
deduplicate=Y). crt.sh is often slow (> 60 s) or answers 502 and sometimes lags weeks
behind - so it is only the fallback. Both: timeout, 3 retries with pauses (5/20/60 s,
Retry-After is honoured), 8 s between requests, results are kept (if a source fails, the
last state stays valid).

"From this server" - the rule (first match wins, recorded when first seen and only ever
upgraded, never back):
  1. serial       serial number equals a certificate stored by the proxy
                  (letsencrypt/archive/*/certN.pem, data/custom_ssl/*/*.pem). Own serials
                  are remembered - cleaning up the archive changes nothing.
  2. fingerprint  SHA-256 of the certificate equals one of these files (Cert Spotter returns it).
  3. run          issuer Let's Encrypt, the proxy requested ALL names of the certificate in a
                  renewal run, and issuance falls into that run: between 10 min before and
                  30 min after the run started. Issuance = NotBefore + 1 h (Let's Encrypt
                  backdates by an hour). Runs: every "Requesting/Renewing ... for <names>" line
                  and every "--cert-name npm-N" (-> names from the proxy database) in
                  data/logs/letsencrypt.log*, the creation of every proxy certificate (created_on)
                  and NotBefore of the stored certificates. Runs are remembered (the logs rotate).
                  Deliberately narrow: "LE + managed domain" alone would hide exactly the case
                  the watch exists for - whoever takes over the DNS record also gets an LE cert.
  otherwise       unknown. Once marked "known" (old server, previous host, CDN ...) it never
                  shows up again.

Only an unknown certificate that shows up NEW raises an alert: in the first run (baseline)
only if it is younger than 14 days - older ones sit quietly in the list and can be marked
known in bulk. Then: one timeline event per certificate and a health problem until it is
marked known.

Hooked into dashboard.py (import, route /api/ctwatch, thread, problems() in health()).
State: <STATE_DIR>/ctwatch.json. Schema in API.md.

Try it without the dashboard (read only, writes nothing):
  python3 /opt/keepwatch/dashboard/server/ctwatch.py            (with --json: everything)
"""
from __future__ import annotations

import base64
import datetime as dt
import glob
import hashlib
import json
import re
import socket
import sqlite3
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

CHECK_EVERY = 6 * 3600
WAKE_EVERY = 600          # new base domains are queried after 10 min at the latest
MANUAL_GAP = 900          # "Check now" queries the same base domain at most every 15 min
CS_URL = "https://api.certspotter.com/v1/issuances"
CRT_URL = "https://crt.sh/"
UA = f"{config.USER_AGENT} ctwatch"
PAUSE = 8                 # seconds between two requests
BACKOFF = (5, 20, 60)     # pauses before the 2nd, 3rd ... attempt
CS_TIMEOUT = 30
CRT_TIMEOUT = 75
RECENT_AT_START = 14 * 86400
LE_BACKDATE = 3600
RUN_BEFORE = 600          # issuance at most 10 min before the run started (clock skew)
RUN_AFTER = 1800          # ... and at most 30 min after
KEEP_RUNS = 800 * 86400
KEEP_EXPIRED = 180 * 86400
TWO_LEVEL = {"co.uk", "org.uk", "me.uk", "com.au", "net.au", "co.at", "or.at", "co.nz", "com.br", "co.jp", "com.tr"}

STATE: dict = {"loaded": False, "lock": threading.RLock(), "checking": False, "error": None, "data": None}


def D():
    return sys.modules.get("dashboard")


def _now() -> float:
    return time.time()


def active() -> bool:
    return config.enabled("proxy")


# --------------------------------------------------------------------------- State

def _empty() -> dict:
    return {"baselineAt": None, "checkedAt": None, "source": None, "certs": {}, "own": {}, "runs": [],
            "after": {}, "fetchedAt": {}, "errors": {}}


def _state_file() -> Path:
    return config.STATE_DIR / "ctwatch.json"


def _load() -> dict:
    with STATE["lock"]:
        if STATE["loaded"]:
            return STATE["data"]
        STATE["loaded"] = True
        data = _empty()
        if D():
            try:
                raw = json.loads(_state_file().read_text())
                if isinstance(raw, dict):
                    data.update({k: raw[k] for k in data if k in raw})
            except (OSError, ValueError):
                pass
        STATE["data"] = data
        return data


def _save():
    if not D():
        return
    with STATE["lock"]:
        text = json.dumps(STATE["data"], ensure_ascii=False, separators=(",", ":"))
    try:
        D().write_atomic(_state_file(), text, 0o600)
    except Exception:  # noqa: BLE001 - saving must not abort the check
        traceback.print_exc()


def _paths() -> tuple[Path, Path]:
    return config.PROXY_DATA, config.PROXY_LE


# --------------------------------------------------------------------------- Reading certificates

def _der_len(b: bytes, i: int) -> tuple[int, int]:
    n = b[i]
    i += 1
    if n < 0x80:
        return n, i
    k = n & 0x7F
    return int.from_bytes(b[i:i + k], "big"), i + k


def norm_serial(s: str | None) -> str | None:
    if not s:
        return None
    s = re.sub(r"[^0-9a-f]", "", str(s).lower()).lstrip("0")
    return s or None


def der_serial(der: bytes) -> str | None:
    """Serial number of a DER certificate (Certificate -> tbsCertificate -> [0] version -> INTEGER)."""
    try:
        i = 0
        if der[i] != 0x30:
            return None
        _, i = _der_len(der, i + 1)
        if der[i] != 0x30:
            return None
        _, i = _der_len(der, i + 1)
        if der[i] == 0xA0:
            n, j = _der_len(der, i + 1)
            i = j + n
        if der[i] != 0x02:
            return None
        n, j = _der_len(der, i + 1)
        return norm_serial(der[j:j + n].hex())
    except IndexError:
        return None


PEM_BLOCK = re.compile(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", re.S)


def _local_cert(path: str) -> dict | None:
    """First certificate of a PEM file: serial number, SHA-256, names, NotBefore."""
    try:
        text = Path(path).read_text(errors="replace")
    except OSError:
        return None
    m = PEM_BLOCK.search(text)
    if not m:
        return None
    try:
        raw = ssl.PEM_cert_to_DER_cert(m.group(0))
    except ValueError:
        return None
    names, nb = [], None
    try:
        info = ssl._ssl._test_decode_cert(path)  # noqa: SLF001 - standard library, read only
        names = [v.lower() for k, v in info.get("subjectAltName", ()) if k == "DNS"]
        nb = ssl.cert_time_to_seconds(info["notBefore"])
    except Exception:  # noqa: BLE001
        pass
    return {"serial": der_serial(raw), "sha256": hashlib.sha256(raw).hexdigest(), "names": names, "nb": nb}


def _npm_db() -> sqlite3.Connection | None:
    npm, _ = _paths()
    try:
        return sqlite3.connect(f"file:{npm / 'database.sqlite'}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None


def _utc(s: str) -> float | None:
    try:
        return dt.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


def npm_inventory() -> dict:
    """Domains and certificates from the proxy database (read only)."""
    hosts, cert_names, created = [], {}, []
    con = _npm_db()
    if con is None:
        return {"hosts": hosts, "certNames": cert_names, "created": created}
    try:
        for table in ("proxy_host", "redirection_host", "dead_host"):
            try:
                for doms, deleted in con.execute(f"SELECT domain_names, is_deleted FROM {table}"):  # noqa: S608
                    for d in json.loads(doms or "[]"):
                        hosts.append({"domain": str(d).lower(), "deleted": bool(deleted)})
            except sqlite3.Error:
                pass
        try:
            for cid, doms, created_on in con.execute("SELECT id, domain_names, created_on FROM certificate"):
                names = [str(d).lower() for d in json.loads(doms or "[]")]
                cert_names[f"npm-{cid}"] = names
                t = _utc(created_on or "")
                if t and names:
                    created.append([t, names])
        except sqlite3.Error:
            pass
    except ValueError:
        pass
    finally:
        con.close()
    return {"hosts": hosts, "certNames": cert_names, "created": created}


LOG_LINE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+:(.*)$")
LOG_FOR = re.compile(r"(?:Requesting a certificate|Renewing an existing certificate|Simulating renewal of an existing certificate) for (.+)$")
LOG_NAME = re.compile(r"'--cert-name', '([^']+)'")
_LOG_SEEN: dict[str, float] = {}


def _split_names(s: str) -> list[str]:
    return [x.strip().lower() for x in re.split(r",\s*(?:and\s+)?|\s+and\s+", s.strip().rstrip(".")) if x.strip()]


def scan_runs(cert_names: dict) -> list[list]:
    """Renewal runs of the proxy from letsencrypt.log* (timestamps in UTC): [[t, [names]], ...]."""
    npm, _ = _paths()
    runs = []
    for path in glob.glob(str(npm / "logs" / "letsencrypt.log*")):
        try:
            mt = Path(path).stat().st_mtime
            if _LOG_SEEN.get(path) == mt:
                continue
            text = Path(path).read_text(errors="replace")[:2_000_000]
        except OSError:
            continue
        for line in text.splitlines():
            m = LOG_LINE.match(line)
            if not m:
                continue
            t = _utc(m.group(1))
            if t is None:
                continue
            f = LOG_FOR.search(m.group(2))
            if f:
                runs.append([t, _split_names(f.group(1))])
                continue
            n = LOG_NAME.search(m.group(2))
            if n and cert_names.get(n.group(1)):
                runs.append([t, cert_names[n.group(1)]])
        _LOG_SEEN[path] = mt
    return runs


def local_certs() -> list[dict]:
    npm, le = _paths()
    out = []
    for path in sorted(glob.glob(str(le / "archive" / "*" / "cert*.pem")) + glob.glob(str(le / "live" / "*" / "cert.pem"))
                       + glob.glob(str(npm / "custom_ssl" / "*" / "*.pem"))):
        c = _local_cert(path)
        if c and c["serial"]:
            c["file"] = re.sub(r"^.*/(archive|live|custom_ssl)/", "", path)
            out.append(c)
    return out


# --------------------------------------------------------------------------- Domains

def base_of(name: str) -> str | None:
    name = name.lower().strip().lstrip("*.").rstrip(".")
    parts = [p for p in name.split(".") if p]
    if len(parts) < 2 or re.fullmatch(r"[\d.]+", name):
        return None
    n = 3 if ".".join(parts[-2:]) in TWO_LEVEL and len(parts) >= 3 else 2
    return ".".join(parts[-n:])


def domains(inv: dict | None = None) -> dict:
    inv = inv or npm_inventory()
    active = sorted({h["domain"] for h in inv["hosts"] if not h["deleted"]})
    bases = set()
    for h in inv["hosts"]:
        b = base_of(h["domain"])
        if b:
            bases.add(b)
    for names in inv["certNames"].values():
        for n in names:
            b = base_of(n)
            if b:
                bases.add(b)
    return {"hosts": active, "bases": sorted(bases)}


# --------------------------------------------------------------------------- Querying the CT logs

class FetchError(Exception):
    pass


def _cs_token() -> str | None:
    try:
        tok = (config.CONF_DIR / "certspotter.token").read_text().strip()
        return tok or None
    except OSError:
        return None


def _get_json(url: str, timeout: float, headers: dict | None = None):
    """GET with timeout and retries. 429 -> Retry-After (at most 2 min, otherwise give up)."""
    last = "no answer"
    for attempt in range(len(BACKOFF) + 1):
        if attempt:
            time.sleep(BACKOFF[attempt - 1])
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read(30_000_000) or b"null")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                try:
                    wait = int(e.headers.get("Retry-After") or 60)
                except ValueError:
                    wait = 60
                if wait > 120:
                    raise FetchError(f"rate limit reached, retry in {wait // 60} min") from None
                time.sleep(wait)
                last = "HTTP 429"
                continue
            if e.code >= 500:
                last = f"HTTP {e.code}"
                continue
            raise FetchError(f"HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as e:
            last = "timeout" if "timed out" in str(e) else f"unreachable ({str(getattr(e, 'reason', e))[:80]})"
        except ValueError:
            last = "no valid JSON answer"
    raise FetchError(last)


def _iso(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        return None


def _cn_of(dn: str) -> str:
    m = re.search(r"CN=([^,]+)", dn or "")
    return m.group(1).strip() if m else ""


def _o_of(dn: str) -> str:
    m = re.search(r"O=(\"[^\"]+\"|[^,]+)", dn or "")
    return m.group(1).strip().strip('"') if m else ""


def fetch_certspotter(base: str, after: str | None) -> tuple[list[dict], str | None]:
    """All issuances (or those new since `after`) for base and subdomains. Returns (certificates, last id)."""
    tok = _cs_token()
    headers = {"Authorization": f"Bearer {tok}"} if tok else {}
    out, last = [], after
    for page in range(20):
        q = [("domain", base), ("include_subdomains", "true"), ("expand", "dns_names"), ("expand", "issuer"),
             ("expand", "cert_der")]
        if last:
            q.append(("after", last))
        if page:
            time.sleep(PAUSE)
        items = _get_json(f"{CS_URL}?{urllib.parse.urlencode(q)}", CS_TIMEOUT, headers)
        if not isinstance(items, list):
            raise FetchError("unexpected answer")
        if not items:
            break
        for it in items:
            serial = None
            try:
                serial = der_serial(base64.b64decode(it.get("cert_der") or ""))
            except (ValueError, TypeError):
                pass
            iss = it.get("issuer") or {}
            out.append({"serial": serial, "sha256": (it.get("cert_sha256") or "").lower() or None,
                        "names": sorted({str(n).lower() for n in it.get("dns_names") or []}),
                        "issuer": iss.get("friendly_name") or _o_of(iss.get("name", "")) or "unknown",
                        "issuerCn": _cn_of(iss.get("name", "")), "notBefore": _iso(it.get("not_before")),
                        "notAfter": _iso(it.get("not_after")), "revoked": bool(it.get("revoked")),
                        "src": "certspotter", "crtId": None})
        last = str(items[-1].get("id") or last)
    return out, last


def fetch_crtsh(base: str) -> list[dict]:
    q = urllib.parse.urlencode({"q": f"%.{base}", "output": "json", "exclude": "expired", "deduplicate": "Y"})
    items = _get_json(f"{CRT_URL}?{q}", CRT_TIMEOUT)
    if not isinstance(items, list):
        raise FetchError("unexpected answer")
    by_serial: dict[str, dict] = {}
    for it in items:
        serial = norm_serial(it.get("serial_number"))
        if not serial:
            continue
        names = {str(n).strip().lower() for n in str(it.get("name_value") or "").split("\n") if n.strip()}
        if it.get("common_name"):
            names.add(str(it["common_name"]).lower())
        c = by_serial.get(serial)
        if c:
            c["names"] = sorted(set(c["names"]) | names)
            continue
        dn = it.get("issuer_name") or ""
        by_serial[serial] = {"serial": serial, "sha256": None, "names": sorted(names),
                             "issuer": _o_of(dn) or _cn_of(dn) or "unknown", "issuerCn": _cn_of(dn),
                             "notBefore": _iso(it.get("not_before")), "notAfter": _iso(it.get("not_after")),
                             "revoked": False, "src": "crt.sh", "crtId": it.get("id")}
    return list(by_serial.values())


# --------------------------------------------------------------------------- Classifying

def is_le(c: dict) -> bool:
    return bool(re.search(r"let'?s ?encrypt|isrg", f"{c.get('issuer', '')} {c.get('issuerCn', '')}", re.I)) and \
        "staging" not in str(c.get("issuerCn", "")).lower()


def classify(c: dict, own: dict, own_sha: set, runs: list) -> tuple[str | None, str | None]:
    """(reason, explanation) - reason None = not from this server."""
    if c.get("serial") and c["serial"] in own:
        return "serial", f"same serial number as {own[c['serial']].get('file') or 'a certificate'} in the Proxy Manager"
    if c.get("sha256") and c["sha256"] in own_sha:
        return "fingerprint", "same fingerprint as a certificate in the Proxy Manager"
    if is_le(c) and c.get("notBefore") and c.get("names"):
        issued = c["notBefore"] + LE_BACKDATE
        names = set(c["names"])
        for t, rnames in runs:
            if t - RUN_BEFORE <= issued <= t + RUN_AFTER and names <= set(rnames):
                when = dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                return "run", f"requested in the Proxy Manager renewal run on {when}"
    return None, None


def _key(c: dict) -> str | None:
    return c.get("serial") or (f"sha:{c['sha256']}" if c.get("sha256") else None)


def crtsh_link(c: dict) -> str:
    if c.get("crtId"):
        return f"https://crt.sh/?id={c['crtId']}"
    if c.get("sha256"):
        return f"https://crt.sh/?sha256={c['sha256']}"
    if c.get("serial"):
        return f"https://crt.sh/?serial={c['serial']}"
    return f"https://crt.sh/?q={urllib.parse.quote((c.get('names') or [''])[0])}"


def _label(c: dict) -> str:
    names = c.get("names") or ["?"]
    return names[0] + (f" (+{len(names) - 1})" if len(names) > 1 else "")


def _day(t: float | None) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d") if t else "?"


# --------------------------------------------------------------------------- Checking

def check(manual: bool = False, dry: bool = False) -> dict:
    """One run. dry=True: save nothing, no timeline (command line)."""
    data = _load() if not dry else _empty()
    with STATE["lock"]:
        if STATE["checking"] and not dry:
            return data
        STATE["checking"] = True
    try:
        inv = npm_inventory()
        doms = domains(inv)
        # Own certificates (remembered) and renewal runs (remembered)
        own = data["own"]
        for lc in local_certs():
            own.setdefault(lc["serial"], {"sha256": lc["sha256"], "names": lc["names"], "file": lc["file"], "nb": lc["nb"]})
        own_sha = {v.get("sha256") for v in own.values() if v.get("sha256")}
        runs = {(int(t), tuple(n)) for t, n in data["runs"]}
        runs |= {(int(t), tuple(n)) for t, n in scan_runs(inv["certNames"])}
        runs |= {(int(t), tuple(n)) for t, n in inv["created"]}
        runs |= {(int(v["nb"] + LE_BACKDATE - 60), tuple(v["names"])) for v in own.values() if v.get("nb") and v.get("names")}
        cutoff = _now() - KEEP_RUNS
        data["runs"] = sorted([t, list(n)] for t, n in runs if t >= cutoff)
        run_list = data["runs"]

        # CT logs per base domain
        found, errors, sources = [], {}, set()
        first = True
        for base in doms["bases"]:
            if manual and _now() - (data["fetchedAt"].get(base) or 0) < MANUAL_GAP:
                continue
            if not first:
                time.sleep(PAUSE)
            first = False
            try:
                items, last = fetch_certspotter(base, data["after"].get(base))
                data["after"][base] = last
                sources.add("certspotter")
                found += items
                data["fetchedAt"][base] = int(_now())
                errors.pop(base, None)
                continue
            except FetchError as e:
                errors[base] = f"Cert Spotter: {e}"
            time.sleep(PAUSE)
            try:
                found += fetch_crtsh(base)
                sources.add("crt.sh")
                data["fetchedAt"][base] = int(_now())
                errors[base] += " - crt.sh stepped in"
            except FetchError as e:
                errors[base] += f"; crt.sh: {e}"
        data["errors"] = errors

        # Classify and remember
        now = _now()
        baseline = data["baselineAt"] is None
        fresh_alerts = []
        with STATE["lock"]:
            certs = data["certs"]
            for c in found:
                k = _key(c)
                if not k:
                    continue
                old = certs.get(k)
                if old:  # merge (other source, more names, fingerprint added later)
                    for f in ("sha256", "crtId", "serial"):
                        if c.get(f) and not old.get(f):
                            old[f] = c[f]
                    old["names"] = sorted(set(old["names"]) | set(c["names"]))
                    old["revoked"] = old.get("revoked") or c["revoked"]
                    continue
                c["firstSeen"] = int(now)
                c["baseline"] = baseline
                c["known"] = None
                c["alerted"] = False
                certs[k] = c
            for k, c in certs.items():
                if not c.get("own"):
                    why, note = classify(c, own, own_sha, run_list)
                    if why:
                        c["own"], c["ownNote"] = why, note
                if c.get("own") or c.get("known") or c.get("alerted"):
                    continue
                recent = (c.get("notBefore") or 0) >= now - RECENT_AT_START
                if not c.get("baseline") or recent:
                    c["alerted"] = True
                    c["alertedAt"] = int(now)
                    fresh_alerts.append(c)
            # forget expired ones after half a year (except open alerts)
            for k in [k for k, c in certs.items() if (c.get("notAfter") or now) < now - KEEP_EXPIRED
                      and not (c.get("alerted") and not c.get("known"))]:
                del certs[k]
            if found or not errors:
                data["checkedAt"] = int(now)
                if baseline and not errors:
                    data["baselineAt"] = int(now)
            data["source"] = "certspotter" if sources == {"certspotter"} else "crt.sh" if sources == {"crt.sh"} else \
                ("mixed" if sources else data.get("source"))
            STATE["error"] = (f"{len(errors)} of {len(doms['bases'])} domains could not be queried: "
                              + "; ".join(f"{b}: {e}" for b, e in errors.items())) if errors else None
        if not dry:
            _save()
            for c in fresh_alerts:
                _timeline_alert(c)
            if baseline and data["baselineAt"]:
                _timeline_baseline(data)
        return data
    finally:
        with STATE["lock"]:
            STATE["checking"] = False


LINK = {"view": "security", "sel": ".ctw-title", "text": "Certificates", "up": ".ctw"}


def _timeline_alert(c: dict):
    try:
        import timeline  # noqa: PLC0415
        timeline.add("security", f"Foreign certificate: {_label(c)}",
                     detail=f"{c['issuer']}{' ' + c['issuerCn'] if c.get('issuerCn') else ''} · issued {_day(c.get('notBefore'))}"
                            f" · not from this server · {crtsh_link(c)}",
                     level="warn", source="ct", key=f"ct:{_key(c)}", link=LINK, weight=50,
                     meta={"names": c["names"][:20], "serial": c.get("serial")})
    except Exception:  # noqa: BLE001 - the timeline must not stop the watch
        traceback.print_exc()


def _timeline_baseline(data: dict):
    try:
        import timeline  # noqa: PLC0415
        certs = list(data["certs"].values())
        quiet = sum(1 for c in certs if not c.get("own") and not c.get("alerted"))
        timeline.add("security", "Certificate watch set up",
                     detail=f"{len(certs)} certificates in the CT logs, {sum(1 for c in certs if c.get('own'))} from this server"
                            + (f", {quiet} older unknown ones to review" if quiet else ""),
                     source="ct", key="ct:baseline", link=LINK, weight=20)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def _start(manual: bool = True):
    threading.Thread(target=check, kwargs={"manual": manual}, daemon=True, name="ctwatch-check").start()


def loop():
    _load()
    time.sleep(150)  # only after the other collectors have started
    while True:
        try:
            if not active():
                time.sleep(WAKE_EVERY)
                continue
            data = _load()
            due = data["checkedAt"] is None or _now() - data["checkedAt"] >= CHECK_EVERY
            new_base = any(b not in data["fetchedAt"] for b in domains()["bases"])
            if due or new_base:
                check()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(WAKE_EVERY)


# --------------------------------------------------------------------------- Reading (API)

def _open_alerts(data: dict) -> list[dict]:
    return [c for c in data["certs"].values() if c.get("alerted") and not c.get("known") and not c.get("own")]


def problems() -> list[dict]:
    """For health (dock dot, overview): unknown certificates that showed up new."""
    if not active():
        return []
    try:
        alerts = sorted(_open_alerts(_load()), key=lambda c: -(c.get("notBefore") or 0))
    except Exception:  # noqa: BLE001
        return []
    if not alerts:
        return []
    c = alerts[0]
    title = f"Foreign certificate for {_label(c)}" if len(alerts) == 1 else f"{len(alerts)} foreign certificates"
    detail = f"{c['issuer']}, issued {_day(c.get('notBefore'))}, not from this server. " \
             "Review it under Security -> Certificates or mark it as known."
    return [{"level": "warn", "area": "security", "title": title, "detail": detail, "key": "ctwatch.foreign-cert"}]


def _public(c: dict, now: float) -> dict:
    return {"key": _key(c), "names": c["names"], "issuer": c.get("issuer"), "issuerCn": c.get("issuerCn") or None,
            "notBefore": c.get("notBefore"), "notAfter": c.get("notAfter"), "expired": (c.get("notAfter") or now) < now,
            "revoked": bool(c.get("revoked")), "firstSeen": c.get("firstSeen"),
            "own": bool(c.get("own")), "ownBy": c.get("own"), "ownNote": c.get("ownNote"),
            "known": bool(c.get("known")), "knownAt": c.get("known"),
            "alert": bool(c.get("alerted") and not c.get("known") and not c.get("own")),
            "baseline": bool(c.get("baseline")), "src": c.get("src"), "crtsh": crtsh_link(c)}


def status() -> dict:
    data = _load()
    now = _now()
    with STATE["lock"]:
        certs = [_public(c, now) for c in data["certs"].values()]
        checking = STATE["checking"]
        error = STATE["error"]
    certs.sort(key=lambda c: (not c["alert"], c["own"] or c["known"], -(c["notBefore"] or 0)))
    try:
        doms = domains()
    except Exception:  # noqa: BLE001
        doms = {"hosts": [], "bases": []}
    unknown = [c for c in certs if not c["own"] and not c["known"]]
    return {"checkedAt": data["checkedAt"], "checking": checking, "error": error, "every": CHECK_EVERY,
            "source": data.get("source"), "baselineAt": data["baselineAt"], "bases": doms["bases"], "hosts": doms["hosts"],
            "counts": {"total": len(certs), "own": sum(1 for c in certs if c["own"]),
                       "known": sum(1 for c in certs if c["known"] and not c["own"]),
                       "unknown": len(unknown), "alerts": sum(1 for c in certs if c["alert"])},
            "certs": certs}


def mark_known(body: dict) -> dict:
    data = _load()
    keys = body.get("keys")
    every = body.get("all")
    undo = bool(body.get("undo"))
    if not isinstance(keys, list) and every not in ("baseline", "all"):
        raise D().ApiError(400, 'Missing keys (list) or all: "baseline" | "all".')
    n = 0
    now = int(_now())
    with STATE["lock"]:
        for k, c in data["certs"].items():
            if c.get("own"):
                continue
            hit = (isinstance(keys, list) and k in keys) or every == "all" or \
                (every == "baseline" and c.get("baseline") and not c.get("alerted"))
            if not hit:
                continue
            if undo:
                if c.get("known"):
                    c["known"] = None
                    n += 1
            elif not c.get("known"):
                c["known"] = now
                n += 1
    _save()
    word = "certificate" if n == 1 else "certificates"
    return {"ok": True, "count": n, "message": f"{n} {word} marked as {'unknown again' if undo else 'known'}."}


def route(method: str, path: str, body: dict):
    d = D()
    d.require("proxy")
    if method == "GET" and path == "/api/ctwatch":
        return status()
    if method == "POST" and path == "/api/ctwatch/check":
        _start(manual=True)
        time.sleep(0.2)
        return {"ok": True, "checking": True}
    if method == "POST" and path == "/api/ctwatch/known":
        return mark_known(body)
    raise d.ApiError(404, "No such endpoint.")


# --------------------------------------------------------------------------- Command line (read only)

if __name__ == "__main__":
    res = check(dry=True)
    if "--json" in sys.argv:
        print(json.dumps({**res, "error": STATE["error"]}, ensure_ascii=False, indent=1, default=str))
        sys.exit(0)
    print(f"Base domains: {', '.join(domains()['bases'])} · source: {res['source']} · own serials: {len(res['own'])}"
          f" · runs: {len(res['runs'])}")
    if STATE["error"]:
        print("Error:", STATE["error"])
    for c in sorted(res["certs"].values(), key=lambda c: c.get("notBefore") or 0):
        tag = c.get("own") or ("ALERT" if c.get("alerted") else "unknown")
        print(f"  {_day(c.get('notBefore'))}  {tag:11}  {c['issuer'][:22]:22} {c.get('issuerCn', '')[:6]:6}  {', '.join(c['names'])[:70]}")
