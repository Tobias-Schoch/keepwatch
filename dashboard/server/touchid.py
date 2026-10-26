"""Passkey confirmation for dangerous actions - add-on module of the Keepwatch dashboard.

A stolen or taken-over device with tunnel access should not be enough to open port 22,
lift bans, change credentials and so on. So the backend requires a fresh confirmation
with a passkey (Touch ID, Face ID, Windows Hello, security key) for everything in DANGER.
No password fallback. Off with KW_DASHBOARD_PASSKEY="no" (then every action goes through).

Two kinds of devices, verified the same way (WebAuthn assertion, ES256):

  passkey  WebAuthn in the browser with a platform authenticator or security key.
  app      the macOS app: key in the Secure Enclave, signs only after Touch ID
           (bridge window.webkit.messageHandlers.serverTouchID).

Flow of a dangerous request:
  1. Request without header X-Touch-ID  -> 428 { error, touchid: { challenge, rpId, allow, action, timeout } }
     The challenge is random, valid for 2 minutes, single use and bound to method, path and body.
  2. The client has it signed and sends THE SAME request again,
     with X-Touch-ID: {"id","clientDataJSON","authenticatorData","signature"} (base64url).
  3. The backend checks challenge, origin, RP ID, "user verified" and the signature.

As long as no device is registered, none of this applies - everything works without it.
Registering the first device needs no confirmation; exactly one device is allowed.

Only the public key is stored: CONF_DIR/passkeys.json (600, part of the backup).
Signatures are verified with python3-cryptography (Ubuntu package), no home-made crypto.

Emergency (device lost): on the server `keepwatch-passkey reset` (over SSH).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import config

try:  # Ubuntu package python3-cryptography. Without it, dangerous actions stay locked once a device exists.
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
except ImportError:  # pragma: no cover
    ec = None

STORE = Path(os.environ.get("DASHBOARD_PASSKEYS", config.CONF_DIR / "passkeys.json"))
TTL = 120            # seconds a challenge is valid
RP_NAME = "Keepwatch"
FLAG_UP, FLAG_UV, FLAG_AT = 0x01, 0x04, 0x40
ONE_DEVICE = (f"A device is already registered - exactly one is allowed. To switch: run "
              f"\"{config.PASSKEY_CLI}\" on the server over SSH, then register the new device here.")
NO_CRYPTO = "python3-cryptography is missing on the server - run ./keepwatch deploy."

LOCK = threading.Lock()
CHALLENGES: dict[str, dict] = {}


def D():
    return sys.modules.get("dashboard")


class _LocalError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra or {}


def _err(status: int, message: str, extra: dict | None = None):
    d = D()
    if d is None:
        return _LocalError(status, message, extra)
    try:
        return d.ApiError(status, message, extra)
    except TypeError:  # older ApiError without extra
        e = d.ApiError(status, message)
        e.extra = extra or {}
        return e


# --------------------------------------------------------------------------- What is dangerous?
# The one list. Method(s), path (full path, regex), label, condition (None = always), module.
# A condition gets the request body; if it raises, the action counts as dangerous.
# Module: the endpoint answers 404 while that module is off, so the gate skips it (its condition
# might need settings that do not exist then). None = always checked.
# Not in the list and so without passkey: starting checks and scans, "Back up now", verify run,
# acknowledging (certificate watch, secrets), renewing certificates, starting/restarting containers,
# closing port 22, site grade fixes (only make things stricter), longer retention, stricter fail2ban.

def _int(v) -> int:
    if isinstance(v, bool) or v is None:
        raise ValueError("not a number")
    return int(v)


def _f2b_looser(body: dict) -> bool:
    d = D()
    cur = d.fail2ban_settings()
    if cur["maxretry"] is not None and _int(body.get("maxretry")) > cur["maxretry"]:  # None: no Tailscale jail
        return True
    if _int(body.get("recidiveMaxretry")) > cur["recidiveMaxretry"]:
        return True
    for k in ("findtimeHours", "bantimeHours", "recidiveFindtimeDays", "recidiveBantimeDays"):
        if _int(body.get(k)) < cur[k]:
            return True
    norm = lambda v: d._net_str(d._ipnet(str(v)))  # noqa: E731
    old = {norm(v) for v in cur["ignoreip"]}
    return bool({norm(v) for v in body.get("ignoreip") or []} - old)  # new "never ban" entries


def _backup_shorter(body: dict) -> bool:
    d = D()
    cfg = d.read_env_file(d.BACKUP_ENV)
    keys = [(k, env, d.KEEP_DEFAULT[env]) for k, env in d.LOCAL_KEEP]
    keys += [(k, env, d.REMOTE_KEEP_DEFAULT[env]) for k, env, _, _ in d.REMOTE_KEEP]
    return any(k in body and _int(body[k]) < int(cfg.get(env) or default) for k, env, default in keys)


def _archive_shorter(body: dict) -> bool:
    import logarchive
    conf = logarchive._conf()
    return any(f in body and _int(body[f]) < conf[key] for f, (key, _, _) in logarchive.SETTINGS.items())


DANGER: list[tuple[str, str, str, object, str | None]] = [
    # Access to the server
    ("PUT", r"/api/settings/ssh", "Open port 22", lambda b: b.get("public") is not False, None),
    ("POST", r"/api/settings/tailscale/login", "Log in to Tailscale again (logs the server out)", None, "tailscale"),
    ("PUT", r"/api/settings/fail2ban", "Loosen fail2ban settings", _f2b_looser, "fail2ban"),
    ("POST", r"/api/security/unban", "Lift a ban", None, None),  # fail2ban and ban history
    ("PUT", r"/api/access/\d+", "Change IP allowlist", None, "proxy"),
    ("PUT", r"/api/access/\d+/paths", "Change path allowlist", None, "proxy"),  # allowlist for single paths
    ("POST", r"/api/hosts", "Create proxy host", None, "proxy"),
    # Services
    ("POST", r"/api/stacks/\d+/redeploy", "Redeploy stack", None, "portainer"),
    ("PUT", r"/api/stacks/\d+/env", "Change environment variables", None, "portainer"),
    ("GET", r"/api/stacks/\d+/env", "View environment variables", None, "portainer"),  # plain-text secrets
    ("POST", r"/api/containers/[^/]+/stop", "Stop container", None, "docker"),
    ("POST", r"/api/updates/(apply|rollback)", "Update or roll back an image", None, "docker"),
    ("POST", r"/api/cleanup", "Clean up (prune)", None, "docker"),
    # Credentials
    ("PUT|DELETE", r"/api/settings/npm", "Change Proxy Manager credentials", None, "proxy"),
    ("PUT", r"/api/settings/portainer", "Change Portainer token", None, "portainer"),
    ("PUT|DELETE", r"/api/settings/remote", "Change off-site backup target", None, "backup"),
    ("POST", r"/api/settings/backup/password", "Show backup password", None, "backup"),
    # Retention
    ("PUT", r"/api/settings/backup", "Shorten backup retention", _backup_shorter, "backup"),
    ("PUT", r"/api/logarchive/settings", "Shorten log archive", _archive_shorter, "log-archive"),
    # Passkeys themselves (not listed in "protects")
    ("POST", r"/api/touchid/register/start", "Add another passkey device", None, None),
    ("DELETE", r"/api/touchid/devices/[^/]+", "Remove passkey device", None, None),
]
_DANGER = [(set(m.split("|")), re.compile(p), label, cond, mod) for m, p, label, cond, mod in DANGER]
_SELF = ("/api/touchid/",)


def _rule(method: str, path: str) -> tuple[str, object] | None:
    for methods, rx, label, cond, mod in _DANGER:
        if method in methods and rx.fullmatch(path):
            if mod and not config.enabled(mod):
                return None  # endpoint answers 404 anyway
            return label, cond
    return None


def danger(method: str, path: str, body: dict) -> str | None:
    """Label of the dangerous action - or None. Unclear means dangerous."""
    r = _rule(method, path)
    if not r:
        return None
    label, cond = r
    if cond is None:
        return label
    try:
        return label if cond(body if isinstance(body, dict) else {}) else None
    except Exception:  # noqa: BLE001 - better ask once too often
        return label


def protects() -> list[str]:
    """Labels of what is protected (enabled modules only), for the settings page."""
    seen: list[str] = []
    for _, p, label, _, mod in DANGER:
        if label not in seen and not p.startswith(_SELF) and (not mod or config.enabled(mod)):
            seen.append(label)
    return seen


# --------------------------------------------------------------------------- Storage

def _load() -> dict:
    try:
        data = json.loads(STORE.read_text())
        if isinstance(data, dict) and isinstance(data.get("devices"), list):
            return data
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        # Broken file: do not silently turn off - everything would be open then.
        raise _err(503, f"{STORE} is unreadable. Check it on the server or run \"{config.PASSKEY_CLI}\".")
    return {"devices": []}


def _save(data: dict):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_name(f"{STORE.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o600)
    tmp.replace(STORE)


def _public(dev: dict, rp: str | None) -> dict:
    return {"id": dev["id"], "name": dev.get("name") or "Device", "kind": dev.get("kind", "passkey"),
            "rpId": dev.get("rpId"), "created": dev.get("created"), "lastUsed": dev.get("lastUsed"),
            "here": dev.get("rpId") == rp}


# --------------------------------------------------------------------------- Helpers

def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s) -> bytes:
    if not isinstance(s, str) or len(s) > 20000:
        raise ValueError("base64url expected")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rp_id(handler) -> str:
    host = (handler.headers.get("Host") or "").strip().lower()
    if host.startswith("["):
        return host
    return host.rsplit(":", 1)[0] if ":" in host else host


def _where(rp: str | None) -> str:
    """Where a device works - for hints. RP "localhost" = through the SSH tunnel."""
    if rp == "localhost":
        return "through the SSH tunnel (http://localhost:<port>)"
    return f"at https://{rp}:{config.ports()['dashboard']}"


def _rp_usable(rp: str) -> bool:
    """WebAuthn needs a domain name (no IP)."""
    return bool(re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*", rp)) and not re.fullmatch(r"[\d.]+", rp)


def _origin_ok(origin, rp: str) -> bool:
    try:
        u = urlsplit(str(origin))
    except ValueError:
        return False
    if (u.hostname or "") != rp:
        return False
    return u.scheme == "https" or (u.scheme == "http" and rp == "localhost")


def _binding(handler, method: str, path: str, body: dict) -> str:
    if method in ("GET", "HEAD", "DELETE"):
        extra = urlsplit(handler.path).query
    else:
        extra = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(f"{method} {path}\n{extra}".encode()).hexdigest()


def _new_challenge(purpose: str, rp: str, **info) -> str:
    now = time.time()
    ch = b64e(secrets.token_bytes(32))
    with LOCK:
        for k in [k for k, v in CHALLENGES.items() if v["exp"] < now]:
            del CHALLENGES[k]
        while len(CHALLENGES) >= 200:
            CHALLENGES.pop(next(iter(CHALLENGES)))
        CHALLENGES[ch] = {"purpose": purpose, "rp": rp, "exp": now + TTL, **info}
    return ch


def _take_challenge(ch) -> dict | None:
    with LOCK:
        c = CHALLENGES.pop(str(ch), None) if isinstance(ch, str) else None
    return c if c and c["exp"] >= time.time() else None


def _parse_auth_data(ad: bytes, rp: str) -> tuple[int, int]:
    """(flags, counter). Checks RP ID, "user present" and "user verified" (biometric/PIN, not just a tap)."""
    if len(ad) < 37:
        raise ValueError("authenticatorData too short")
    if not hmac.compare_digest(ad[:32], hashlib.sha256(rp.encode()).digest()):
        raise ValueError("RP ID does not match")
    flags = ad[32]
    if not flags & FLAG_UP or not flags & FLAG_UV:
        raise ValueError("confirmed without user verification")
    return flags, int.from_bytes(ad[33:37], "big")


def _verify_sig(spki_b64: str, ad: bytes, cdj: bytes, sig: bytes):
    key = serialization.load_der_public_key(b64d(spki_b64))
    key.verify(sig, ad + hashlib.sha256(cdj).digest(), ec.ECDSA(hashes.SHA256()))


# Minimal CBOR reader - only for attestationObject and the COSE key (no cryptography).
def _cbor(b: bytes, i: int = 0, depth: int = 0):
    if depth > 8 or i >= len(b):
        raise ValueError("broken CBOR")
    ib = b[i]
    mt, ai = ib >> 5, ib & 31
    i += 1
    if ai < 24:
        n = ai
    elif ai in (24, 25, 26, 27):
        size = 1 << (ai - 24)
        if i + size > len(b):
            raise ValueError("broken CBOR")
        n = int.from_bytes(b[i:i + size], "big")
        i += size
    else:
        raise ValueError("CBOR: indefinite length")
    if mt == 0:
        return n, i
    if mt == 1:
        return -1 - n, i
    if mt in (2, 3):
        if i + n > len(b):
            raise ValueError("broken CBOR")
        v = b[i:i + n]
        return (v if mt == 2 else v.decode()), i + n
    if mt == 4:
        out = []
        for _ in range(n):
            v, i = _cbor(b, i, depth + 1)
            out.append(v)
        return out, i
    if mt == 5:
        m = {}
        for _ in range(n):
            k, i = _cbor(b, i, depth + 1)
            v, i = _cbor(b, i, depth + 1)
            m[k] = v
        return m, i
    if mt == 7:
        return {20: False, 21: True, 22: None}.get(n), i
    raise ValueError("CBOR: type not supported")


def _cose_to_spki(cose: dict) -> str:
    if cose.get(1) != 2 or cose.get(3) != -7 or cose.get(-1) != 1:
        raise ValueError("only ES256 (P-256) is supported")
    x, y = cose.get(-2), cose.get(-3)
    if not (isinstance(x, bytes) and isinstance(y, bytes) and len(x) == len(y) == 32):
        raise ValueError("incomplete key")
    key = ec.EllipticCurvePublicNumbers(int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()).public_key()
    return b64e(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))


# --------------------------------------------------------------------------- Check (handler)

def gate(handler, method: str, path: str, body: dict):
    """Before every endpoint: dangerous and a passkey registered -> fresh, matching assertion needed."""
    if not config.passkey() or not _rule(method, path):
        return  # turned off in keepwatch.conf, or not dangerous
    data = _load()
    if not data["devices"]:
        return  # not set up yet: everything works without
    label = danger(method, path, body)
    if not label:
        return
    if ec is None:
        raise _err(503, f"\"{label}\" needs a passkey, but {NO_CRYPTO}")
    rp = rp_id(handler)
    devs = [d for d in data["devices"] if d.get("rpId") == rp]
    if not devs:
        where = ", ".join(sorted({_where(d.get("rpId")) for d in data["devices"]}))
        raise _err(403, f"\"{label}\" needs a passkey, but no device is registered for this address ({rp}). "
                        f"Open the dashboard {where}.")
    bind = _binding(handler, method, path, body)
    raw = handler.headers.get("X-Touch-ID")
    msg = f"\"{label}\" needs a passkey."
    if raw:
        stale = _check_assertion(raw, rp, bind)
        if not stale:
            handler._touchid_ok = label  # for the timeline
            return
        msg = "The passkey confirmation expired - please confirm again."
    ch = _new_challenge("action", rp, bind=bind, label=label)
    raise _err(428, msg, {"touchid": {"challenge": ch, "rpId": rp, "allow": [d["id"] for d in devs],
                                      "action": label, "timeout": TTL * 1000}})


def _check_assertion(raw: str, rp: str, bind: str) -> bool:
    """True = challenge unknown/expired (get a new one). Raises on anything that does not match."""
    try:
        a = json.loads(raw)
        cdj, ad, sig = b64d(a["clientDataJSON"]), b64d(a["authenticatorData"]), b64d(a["signature"])
        cid = str(a["id"])
        cd = json.loads(cdj)
    except (ValueError, KeyError, TypeError):
        raise _err(400, "The passkey response is unreadable.")
    if not isinstance(cd, dict) or cd.get("type") != "webauthn.get":
        raise _err(403, "Passkey: wrong response type.")
    ch = _take_challenge(cd.get("challenge"))
    if not ch:
        return True
    if ch["purpose"] != "action" or ch["rp"] != rp or ch.get("bind") != bind:
        raise _err(403, "This passkey confirmation belongs to a different action.")
    if not _origin_ok(cd.get("origin"), rp) or cd.get("crossOrigin") is True:
        raise _err(403, "Passkey: foreign origin.")
    with LOCK:
        data = _load()
        dev = next((d for d in data["devices"] if d["id"] == cid and d.get("rpId") == rp), None)
        if not dev:
            raise _err(403, "This device is not (or no longer) registered.")
        try:
            _flags, count = _parse_auth_data(ad, rp)
            _verify_sig(dev["publicKey"], ad, cdj, sig)
        except InvalidSignature:
            raise _err(403, "Passkey: the signature does not match.")
        except ValueError as e:
            raise _err(403, f"Passkey: {e}.")
        old = int(dev.get("signCount") or 0)
        if (count or old) and count <= old:
            raise _err(403, "Passkey: the device counter went backwards (copied key?).")
        dev["signCount"] = count
        dev["lastUsed"] = time.time()
        _save(data)
    return False


# --------------------------------------------------------------------------- Endpoints

def status(handler) -> dict:
    rp = rp_id(handler)
    if not config.passkey():
        return {"enabled": False, "active": False, "crypto": ec is not None, "rpId": rp, "rpUsable": _rp_usable(rp),
                "here": False, "devices": [], "pairing": None, "protects": [], "ttl": TTL}
    data = _load()
    devs = [_public(d, rp) for d in data["devices"]]
    return {"enabled": True, "active": bool(devs), "crypto": ec is not None, "rpId": rp, "rpUsable": _rp_usable(rp),
            "here": any(d["here"] for d in devs), "devices": devs, "pairing": None, "protects": protects(),
            "ttl": TTL}


def _name(v) -> str:
    s = re.sub(r"\s+", " ", str(v or "")).strip()[:40]
    return s or "Device"


def _require_enabled():
    if not config.passkey():
        raise _err(404, "Passkeys are turned off (KW_DASHBOARD_PASSKEY=\"no\" in keepwatch.conf).", {"enabled": False})


def register_start(handler, body: dict) -> dict:
    _require_enabled()
    if ec is None:
        raise _err(503, NO_CRYPTO)
    rp = rp_id(handler)
    if not _rp_usable(rp):
        raise _err(409, f"Passkeys only work with a name, not with {rp or 'this address'} - "
                        "open the dashboard at http://localhost:<port> (SSH tunnel or the macOS app).")
    data = _load()
    # Exactly one device: once one is registered, the dashboard adds no other -
    # not even with a passkey confirmation.
    if data["devices"]:
        raise _err(409, ONE_DEVICE)
    uid = data.get("userId") or b64e(secrets.token_bytes(16))
    ch = _new_challenge("register", rp, name=_name(body.get("name")), userId=uid)
    user = f"keepwatch@{config.hostname()}"
    return {"challenge": ch, "rp": {"id": rp, "name": RP_NAME},
            "user": {"id": uid, "name": user, "displayName": user},
            "exclude": [d["id"] for d in data["devices"] if d.get("rpId") == rp], "timeout": TTL * 1000}


def register_finish(handler, body: dict) -> dict:
    _require_enabled()
    if ec is None:
        raise _err(503, NO_CRYPTO)
    if _load()["devices"]:
        raise _err(409, ONE_DEVICE)
    rp = rp_id(handler)
    try:
        cdj = b64d(body.get("clientDataJSON"))
        cd = json.loads(cdj)
    except (ValueError, TypeError):
        raise _err(400, "clientDataJSON is unreadable.")
    if not isinstance(cd, dict) or cd.get("type") != "webauthn.create":
        raise _err(400, "Wrong response type.")
    ch = _take_challenge(cd.get("challenge"))
    if not ch or ch["purpose"] != "register" or ch["rp"] != rp:
        raise _err(409, "The registration expired - please try again.")
    if not _origin_ok(cd.get("origin"), rp) or cd.get("crossOrigin") is True:
        raise _err(403, "Foreign origin.")
    kind = "app" if body.get("kind") == "app" else "passkey"
    try:
        if kind == "app":
            cid = str(body.get("id") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{16,200}", cid):
                raise ValueError("device id missing")
            spki = str(body.get("publicKey") or "")
            key = serialization.load_der_public_key(b64d(spki))
            if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
                raise ValueError("only P-256 is supported")
            ad = b64d(body.get("authenticatorData"))
            _flags, count = _parse_auth_data(ad, rp)
            _verify_sig(spki, ad, cdj, b64d(body.get("signature")))
        else:
            att, _ = _cbor(b64d(body.get("attestationObject")))
            ad = att.get("authData") if isinstance(att, dict) else None
            if not isinstance(ad, bytes):
                raise ValueError("authData missing")
            flags, count = _parse_auth_data(ad, rp)
            if not flags & FLAG_AT or len(ad) < 55:
                raise ValueError("no key in the response")
            n = int.from_bytes(ad[53:55], "big")
            raw_id = ad[55:55 + n]
            cose, _ = _cbor(ad, 55 + n)
            cid = b64e(raw_id)
            if not raw_id or (body.get("id") and body.get("id") != cid):
                raise ValueError("id does not match")
            spki = _cose_to_spki(cose)
    except InvalidSignature:
        raise _err(403, "The signature does not match.")
    except (ValueError, TypeError, KeyError, UnicodeDecodeError) as e:
        raise _err(400, f"Registration rejected: {e}.")
    now = time.time()
    with LOCK:
        data = _load()
        if any(d["id"] == cid for d in data["devices"]):
            raise _err(409, "This device is already registered.")
        dev = {"id": cid, "name": ch["name"], "kind": kind, "rpId": rp, "publicKey": spki, "signCount": count,
               "created": now, "lastUsed": None}
        data["devices"].append(dev)
        data.setdefault("userId", ch["userId"])
        _save(data)
    return {"ok": True, "device": _public(dev, rp)}


def pair(handler) -> dict:
    """Pairing codes are gone (exactly one device); kept as an endpoint so old clients get a clear answer."""
    raise _err(409, "Pairing is turned off - exactly one passkey device is allowed.")


def remove(handler, dev_id: str) -> dict:
    _require_enabled()
    with LOCK:
        data = _load()
        rest = [d for d in data["devices"] if d["id"] != dev_id]
        if len(rest) == len(data["devices"]):
            raise _err(404, "This device is not registered.")
        # The last device stays: otherwise passkeys would be off and anyone with tunnel access
        # could register first. Switching only over SSH (keepwatch-passkey reset).
        if not rest:
            raise _err(409, f"The only device cannot be removed here. To switch: run \"{config.PASSKEY_CLI}\" on the server over SSH.")
        data["devices"] = rest
        _save(data)
    return {"ok": True, "active": bool(rest)}


def route(handler, method: str, path: str, body: dict):
    if method == "GET" and path == "/api/touchid":
        return status(handler)
    if method == "POST" and path == "/api/touchid/register/start":
        return register_start(handler, body)
    if method == "POST" and path == "/api/touchid/register/finish":
        return register_finish(handler, body)
    if method == "POST" and path == "/api/touchid/pair":
        return pair(handler)
    m = re.fullmatch(r"/api/touchid/devices/([A-Za-z0-9_-]{1,200})", path)
    if m and method == "DELETE":
        return remove(handler, m.group(1))
    raise _err(404, "Unknown endpoint.")


# --------------------------------------------------------------------------- Emergency (SSH)

def _cli(argv: list[str]) -> int:
    cmd = argv[0] if argv else "list"
    try:
        data = _load()
    except _LocalError as e:
        print(e.message, file=sys.stderr)
        data = None
    if cmd == "list":
        if data is None:
            return 1
        off = "" if config.passkey() else " (KW_DASHBOARD_PASSKEY=no: not enforced)"
        if not data["devices"]:
            print(f"Passkeys are off - no device registered. Dangerous actions need no confirmation.{off}")
            return 0
        print(f"Passkeys are on - {len(data['devices'])} device(s) ({STORE}){off}:")
        for d in data["devices"]:
            used = time.strftime("%Y-%m-%d %H:%M", time.localtime(d["lastUsed"])) if d.get("lastUsed") else "never"
            print(f"  {d.get('name') or 'Device':<28} {d.get('kind', 'passkey'):<8} {d.get('rpId')}  last used: {used}")
        return 0
    if cmd == "reset":
        if not STORE.exists():
            print("Passkeys are already off - nothing to do.")
            return 0
        bak = STORE.with_name(f"{STORE.name}.reset-{time.strftime('%Y%m%d-%H%M%S')}")
        STORE.replace(bak)
        n = len(data["devices"]) if data else "?"
        print(f"Passkeys are off: {n} device(s) removed (old file: {bak}).\n"
              "Dangerous actions now work without confirmation - register a device again\n"
              "right away in the dashboard under Settings -> Passkey.")
        return 0
    print("Usage: keepwatch-passkey list | reset", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
