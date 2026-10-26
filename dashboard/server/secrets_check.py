"""Secrets check - dashboard add-on, needs the portainer module.

Checks the environment variables of the Portainer stacks (GET /api/stacks, the same way as
stack_env) - read only, every 15 min and on demand:

  age        since when the value is unchanged. Per stack and variable only a salted hash is
             stored (PBKDF2-SHA256, 120 000 rounds, 32 byte salt in
             <CONF_DIR>/secrets-check.salt, 0600) plus the time it was first seen - never the
             value. On the very first run the age is unknown: then the creation of the stack in
             Portainer counts as the start ("estimated", an upper bound).
  weak       too short, little randomness (estimated from character pool and Shannon entropy),
             common words, obvious placeholders ("changeme", "test", "<...>" ...)
  duplicate  the same value in another stack (warning) or in another variable of the same
             stack (hint only - DB_PASSWORD + POSTGRES_PASSWORD is normal).
             Compared via the hashes; for URLs with credentials the password counts.
  type       by prefix (Stripe sk_live_/rk_live_/sk_test_/whsec_, Resend re_, GitHub ghp_/
             github_pat_, OpenAI, Anthropic, Slack, SendGrid, GitLab, npm, JWK, PEM, JWT ...),
             otherwise by name (PASSWORD -> password, SECRET/TOKEN/KEY -> secret).
  test in    Stripe test key in a stack that looks like production (NODE_ENV/APP_ENV
  production = production, or neither environment nor stack name say test/dev/staging).
  due        older than the limit for its type (configurable, 0 = no reminder).

Privacy: values never leave this process and never appear in logs, responses or files.
The UI gets variable name, stack, type, finding and age. Findings never mention lengths
or characters. "Acknowledge" applies to the current value (via its hash): once it changes
it no longer applies; a due reminder comes back after another full period.

Hooked into dashboard.py (import, route /api/secrets, thread, problems() in health()).
State: <STATE_DIR>/secrets-check.json. Schema in API.md.

Try it on the server (read only, prints findings only, writes nothing):
  python3 /opt/keepwatch/dashboard/server/secrets_check.py --dry
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import math
import os
import re
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

CHECK_EVERY = 900
ITER = 120_000

# id: (label, limit in days (0 = off), where to create a new one, link, steps)
TYPES: dict[str, tuple[str, int, str, str | None, list[str]]] = {
    "stripe-live": ("Stripe secret key (live)", 365,
                    "Stripe Dashboard -> Developers -> API keys -> Secret key -> \"Roll key\"",
                    "https://dashboard.stripe.com/apikeys",
                    ["When rolling, pick an expiry for the old key (e.g. 1 hour).",
                     "Enter the new key here, save & redeploy.",
                     "Restricted keys (rk_live_) are on the same page below."]),
    "stripe-test": ("Stripe test key", 0,
                    "Stripe Dashboard -> turn off \"Test mode\" at the top -> Developers -> API keys",
                    "https://dashboard.stripe.com/apikeys",
                    ["Production needs the live keys (sk_live_ / pk_live_).",
                     "Don't forget the webhook secret (whsec_) of the live endpoint."]),
    "stripe-webhook": ("Stripe webhook secret", 365,
                       "Stripe Dashboard -> Developers -> Webhooks -> endpoint -> Signing secret -> \"Roll secret\"",
                       "https://dashboard.stripe.com/webhooks",
                       ["Stripe then signs with both secrets for a while - no downtime.",
                        "Enter the new whsec_ here, save & redeploy."]),
    "resend": ("Resend API key", 365, "Resend -> API Keys -> \"Create API Key\"", "https://resend.com/api-keys",
               ["Create a new key (sending only, your own domain only) and enter it here.",
                "After the redeploy, delete the old key at Resend."]),
    "github": ("GitHub token", 90, "GitHub -> Settings -> Developer settings -> Personal access tokens",
               "https://github.com/settings/tokens",
               ["Create a fine-grained token with an expiry and only the repositories it needs.",
                "Enter it here, then delete the old token."]),
    "gitlab": ("GitLab token", 90, "GitLab -> Preferences -> Access Tokens", "https://gitlab.com/-/user_settings/personal_access_tokens",
               ["Create a new token with an expiry, enter it, revoke the old one."]),
    "openai": ("OpenAI API key", 180, "OpenAI Platform -> API keys", "https://platform.openai.com/api-keys",
               ["Create a new project key, enter it, delete the old one."]),
    "anthropic": ("Anthropic API key", 180, "Claude Console -> API Keys", "https://console.anthropic.com/settings/keys",
                  ["Create a new key, enter it, disable the old one."]),
    "slack": ("Slack token", 365, "api.slack.com -> Your Apps -> app -> OAuth & Permissions", "https://api.slack.com/apps",
              ["Regenerate the token (rotate/reinstall), enter it."]),
    "sendgrid": ("SendGrid API key", 365, "SendGrid -> Settings -> API Keys", "https://app.sendgrid.com/settings/api_keys",
                 ["Create a new key, enter it, delete the old one."]),
    "google": ("Google API key", 365, "Google Cloud Console -> APIs & Services -> Credentials",
               "https://console.cloud.google.com/apis/credentials",
               ["Regenerate the key (\"Regenerate key\"), enter it."]),
    "npm": ("npm token", 90, "npmjs.com -> Access Tokens", "https://www.npmjs.com/settings/~/tokens",
            ["Create a granular token with an expiry, enter it, delete the old one."]),
    "aws": ("AWS access key", 90, "AWS Console -> IAM -> Users -> Security credentials",
            "https://console.aws.amazon.com/iam/home#/security_credentials",
            ["Create a second access key, enter key ID and secret, deactivate and delete the old one."]),
    "jwk": ("JSON Web Key (private)", 365, "Generate a new one, e.g. with jose: npx jose newkey -s 2048 -t RSA (or in the app's code)", None,
            ["A new signing key invalidates all issued tokens (everyone gets logged out).",
             "Whoever verifies tokens needs the new public key (JWKS) - publish the old one alongside for a while if needed."]),
    "pem": ("Private key (PEM)", 365, "Generate a new one: openssl genpkey -algorithm ed25519 (or RSA 3072)", None,
            ["Replace the public key everywhere it is registered (remote side, deploy key ...)."]),
    "jwt": ("JWT / service key", 365, "Regenerate it at the provider (e.g. Supabase -> Settings -> API -> JWT Secret)", None,
            ["A new JWT secret invalidates all issued tokens."]),
    "password": ("Password", 365, "Generate it yourself: openssl rand -base64 32", None,
                 ["First change it where it applies (database: ALTER USER ... PASSWORD '...'; mail account; service).",
                  "Then enter it here in every variable that uses it (also ..._URL), save & redeploy."]),
    "secret": ("Secret / key", 365, "Generate it yourself: openssl rand -hex 32", None,
               ["Session/JWT secrets: changing them logs out every user.",
                "Never just swap encryption keys (ENCRYPTION_KEY ...) - re-encrypt the data first."]),
}

PREFIX: list[tuple[re.Pattern, str]] = [(re.compile(p, f), t) for p, t, f in [
    (r"^(sk|rk)_live_[0-9A-Za-z]{8,}", "stripe-live", 0),
    (r"^(sk|rk|pk)_test_[0-9A-Za-z]{8,}", "stripe-test", 0),
    (r"^whsec_[0-9A-Za-z]{16,}", "stripe-webhook", 0),
    (r"^re_[0-9A-Za-z_]{16,}$", "resend", 0),
    (r"^(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}$|^github_pat_[0-9A-Za-z_]{40,}$", "github", 0),
    (r"^glpat-[0-9A-Za-z_-]{20,}$", "gitlab", 0),
    (r"^sk-ant-[0-9A-Za-z_-]{20,}$", "anthropic", 0),
    (r"^sk-(proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20,}$", "openai", 0),
    (r"^xox[abposre]-[0-9A-Za-z-]{10,}$|^xapp-[0-9A-Za-z-]{10,}$", "slack", 0),
    (r"^SG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}$", "sendgrid", 0),
    (r"^AIza[0-9A-Za-z_-]{35}$", "google", 0),
    (r"^npm_[0-9A-Za-z]{36}$", "npm", 0),
    (r"-----BEGIN ([A-Z]+ )?PRIVATE KEY-----", "pem", 0),
    (r"^eyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{16,}$", "jwt", 0),
]]
GENERATED = {"stripe-live", "stripe-test", "stripe-webhook", "resend", "github", "gitlab", "anthropic", "openai", "slack",
             "sendgrid", "google", "npm", "pem", "jwt", "jwk"}

SECRET_NAME = re.compile(r"SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|(^|_)PASS($|_)|(^|_)PWD($|_)|PRIVATE|CREDENTIAL|"
                         r"API_?KEY|ACCESS_KEY|(^|_)KEY$|SALT|SIGNING|ENCRYPTION|(^|_)DSN$|WEBHOOK", re.I)
PASS_NAME = re.compile(r"PASSWORD|PASSWD|PASSPHRASE|(^|_)PASS($|_)|(^|_)PWD($|_)", re.I)
PUBLIC_NAME = re.compile(r"PUBLIC|PUBLISHABLE|^NEXT_PUBLIC_|^VITE_|^NUXT_PUBLIC_|^EXPO_PUBLIC_|_KEY_ID$|_ID$|_FILE$|_PATH$|"
                         r"_URL$|_HOST$|_PORT$|_USER(NAME)?$|_NAME$|_EXPIRES?(_IN)?$|_TTL$|_ALG(ORITHM)?$|_LENGTH$|_ENABLED$", re.I)
URL_CRED = re.compile(r"^[a-z][a-z0-9+.-]*://[^:/@\s]*:([^@\s/]+)@", re.I)
ENV_NAMES = ("NODE_ENV", "APP_ENV", "ENVIRONMENT", "ENV", "STAGE", "RAILS_ENV", "MIX_ENV", "VERCEL_ENV", "ASPNETCORE_ENVIRONMENT")
NONPROD = re.compile(r"^(dev|development|staging|stage|test|testing|preview|local|sandbox|demo)$", re.I)
NONPROD_NAME = re.compile(r"(^|[-_.])(test|testing|staging|stage|dev|demo|preview|sandbox)($|[-_.])", re.I)
# Wordlists (detection data, not UI text). They include a few common non-English words
# ("passwort", "geheim", "willkommen") because they show up in real weak values.
PLACEHOLDERS = {
    "changeme", "change_me", "change-me", "changethis", "change_this", "change-this", "replaceme", "replace_me", "replace-me",
    "secret", "secrets", "password", "passwort", "pass", "passwd", "test", "testing", "test123", "example", "sample", "dummy",
    "default", "admin", "root", "todo", "tbd", "fixme", "placeholder", "none", "null", "undefined", "foo", "bar", "foobar",
    "demo", "123456", "12345678", "123456789", "1234", "qwerty", "letmein", "geheim", "supersecret", "mysecret",
    "yoursecret", "your-secret", "your_secret", "xxx", "abc", "abc123", "token", "key", "apikey", "api_key", "insecure",
}
PLACEHOLDER_RE = re.compile(r"^(x+|\*+|\.+|0+|1+|-+|_+)$|^<.*>$|^\{\{.*\}\}$|^\$\{.*\}$|change[_-]?me|replace[_-]?me|"
                            r"your[_-]?(own[_-]?)?(secret|key|token|password|api)|^(sk|pk|rk|re|whsec)_(test_|live_)?x+$|"
                            r"example|placeholder|dummy|insecure|not[_-]?secret", re.I)
COMMON_WORDS = re.compile(r"password|passwort|secret|geheim|admin|qwert|letmein|welcome|willkommen|12345|abcdef|"
                          r"iloveyou|monkey|dragon|master|login|test", re.I)

STATE: dict = {"loaded": False, "lock": threading.RLock(), "checking": False, "error": None, "data": None,
               "items": [], "connected": None}
_MEM_KEY = os.urandom(32)        # memory only: key for the cache of the slow hashes
_HCACHE: dict[bytes, str] = {}


def D():
    return sys.modules.get("dashboard")


def _now() -> float:
    return time.time()


# --------------------------------------------------------------------------- State

def _empty() -> dict:
    return {"baselineAt": None, "checkedAt": None, "saltId": None, "vars": {}, "acks": {}, "settings": {"maxAgeDays": {}}}


def _state_file() -> Path:
    return config.STATE_DIR / "secrets-check.json"


def _load() -> dict:
    with STATE["lock"]:
        if STATE["loaded"]:
            return STATE["data"]
        STATE["loaded"] = True
        data = _empty()
        if D() and not STATE.get("dry"):
            try:
                raw = json.loads(_state_file().read_text())
                if isinstance(raw, dict):
                    data.update({k: raw[k] for k in data if k in raw})
            except (OSError, ValueError):
                pass
        STATE["data"] = data
        return data


def _save():
    if not D() or STATE.get("dry"):
        return
    with STATE["lock"]:
        text = json.dumps(STATE["data"], ensure_ascii=False, separators=(",", ":"))
    try:
        D().write_atomic(_state_file(), text, 0o600)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


_SALT: bytes | None = None


def _salt() -> bytes:
    """32 byte salt in CONF_DIR (0600). In a dry run only in memory."""
    global _SALT
    if _SALT is not None:
        return _SALT
    if STATE.get("dry") or not D():
        _SALT = os.urandom(32)
        return _SALT
    path = config.CONF_DIR / "secrets-check.salt"
    try:
        _SALT = bytes.fromhex(path.read_text().strip())
        if len(_SALT) < 16:
            raise ValueError
    except (OSError, ValueError):
        _SALT = os.urandom(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        D().write_atomic(path, _SALT.hex() + "\n", 0o600)
    return _SALT


def _hash(material: str) -> str:
    """Salted, slow hash (PBKDF2). Result cached in memory - the cache key is an HMAC, not the value."""
    b = material.encode("utf-8", "surrogatepass")
    ck = hmac.new(_MEM_KEY, b, hashlib.sha256).digest()
    h = _HCACHE.get(ck)
    if h is None:
        h = hashlib.pbkdf2_hmac("sha256", b, _salt(), ITER, dklen=16).hex()
        _HCACHE[ck] = h
    return h


# --------------------------------------------------------------------------- Classifying

def _jwk_private(v: str) -> bool:
    if not v.lstrip().startswith(("{", "[")):
        return False
    try:
        j = json.loads(v)
    except ValueError:
        return False
    keys = j.get("keys") if isinstance(j, dict) and isinstance(j.get("keys"), list) else j if isinstance(j, list) else [j]
    return any(isinstance(k, dict) and "kty" in k and "d" in k for k in keys)


def kind_of(name: str, value: str) -> tuple[str | None, str]:
    """(type, material) - type None = not a secret. Material: what gets compared and rated."""
    v = value.strip()
    if not v:
        return None, ""
    for rx, t in PREFIX:
        if rx.search(v):
            return t, v
    if _jwk_private(v):
        return "jwk", v
    if v.startswith("pk_live_"):  # public Stripe key - not a secret
        return None, ""
    m = URL_CRED.match(v)
    if m:
        return "password", m.group(1)
    up = name.upper()
    if re.match(r"^AWS_SECRET", up):
        return "aws", v
    if PUBLIC_NAME.search(up) or not SECRET_NAME.search(up):
        return None, ""
    if v.lower() in ("true", "false", "yes", "no", "on", "off") or re.fullmatch(r"\d{1,6}", v) or re.match(r"^(https?|wss?)://", v) \
            or v.startswith(("/", "./")):
        return None, ""
    return ("password" if PASS_NAME.search(up) else "secret"), v


def entropy_bits(s: str) -> float:
    if not s:
        return 0.0
    if re.fullmatch(r"[0-9a-f]+", s) or re.fullmatch(r"[0-9A-F]+", s):
        pool = 16
    else:
        pool = (26 if re.search(r"[a-z]", s) else 0) + (26 if re.search(r"[A-Z]", s) else 0) + \
               (10 if re.search(r"\d", s) else 0) + (33 if re.search(r"[^A-Za-z0-9]", s) else 0)
    n = len(s)
    shannon = -sum(c / n * math.log2(c / n) for c in collections.Counter(s).values()) * n
    return min(n * math.log2(max(pool, 2)), shannon)


def weakness(kind: str, material: str) -> list[dict]:
    low = material.strip().lower()
    if low in PLACEHOLDERS or PLACEHOLDER_RE.search(material.strip()):
        return [{"kind": "placeholder", "level": "warn", "text": "placeholder instead of a real value"}]
    if kind in GENERATED:
        return []
    need = 64 if kind == "password" else 96
    if len(material) < 12:
        return [{"kind": "weak", "level": "warn", "text": "too short"}]
    if COMMON_WORDS.search(material) and entropy_bits(material) < 128:
        return [{"kind": "weak", "level": "warn", "text": "contains a common word"}]
    if entropy_bits(material) < need:
        return [{"kind": "weak", "level": "warn", "text": "little randomness"}]
    return []


def is_production(stack_name: str, env: dict[str, str]) -> bool:
    for n in ENV_NAMES:
        v = (env.get(n) or "").strip()
        if v:
            return not NONPROD.match(v)
    return not NONPROD_NAME.search(stack_name)


def max_days(data: dict, kind: str) -> int:
    v = (data["settings"].get("maxAgeDays") or {}).get(kind)
    return int(v) if isinstance(v, int) else TYPES[kind][1]


# --------------------------------------------------------------------------- Checking

def _stacks() -> list[dict]:
    return D().portainer("GET", "/api/stacks") or []


def check(stacks: list[dict] | None = None) -> list[dict]:
    """One run. Values only live inside this function; hashes and times are stored."""
    data = _load()
    with STATE["lock"]:
        if STATE["checking"]:
            return STATE["items"]
        STATE["checking"] = True
        STATE["ran"] = True
    try:
        if stacks is None:
            try:
                stacks = _stacks()
                STATE["connected"] = True
            except Exception as e:  # noqa: BLE001
                STATE["connected"] = False
                STATE["error"] = getattr(e, "message", None) or "Portainer is unreachable"
                return STATE["items"]
        now = _now()
        baseline = data["baselineAt"] is None
        # New salt (file lost): hashes cannot be compared - re-hash silently, keep the ages.
        salt_id = hashlib.sha256(_salt()).hexdigest()[:16]
        resalt = data.get("saltId") not in (None, salt_id) and not STATE.get("dry")
        data["saltId"] = salt_id
        found = []        # (sid, stack, name, kind, hash, findings, prod, created)
        by_hash: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
        for s in stacks:
            sid, sname = s.get("Id"), str(s.get("Name") or "")
            env = {str(e.get("name") or ""): str(e.get("value") or "") for e in (s.get("Env") or []) if e.get("name")}
            prod = is_production(sname, env)
            for name, value in env.items():
                kind, material = kind_of(name, value)
                if not kind:
                    continue
                h = _hash(material)
                findings = weakness(kind, material)
                if kind == "stripe-test" and prod:
                    findings.append({"kind": "test-in-prod", "level": "warn", "text": "test key in production"})
                found.append([sid, sname, name, kind, h, findings, prod, s.get("CreationDate")])
                if len(material) >= 8:
                    by_hash[h].append((sname, name))
            del env
        changed = []
        seen_keys = set()
        items = []
        for sid, sname, name, kind, h, findings, prod, created in found:
            key = f"{sid}/{name}"
            seen_keys.add(key)
            rec = data["vars"].get(key)
            if rec is None:
                est = baseline and isinstance(created, (int, float)) and 0 < created < now
                rec = {"h": h, "first": int(created if est else now), "est": bool(est)}
                data["vars"][key] = rec
            elif resalt:
                if (data["acks"].get(key) or {}).get("h") == rec["h"]:
                    data["acks"][key]["h"] = h
                rec["h"] = h
            elif rec["h"] != h:
                changed.append((sname, name))
                rec.update({"h": h, "first": int(now), "est": False})
            others = [o for o in by_hash.get(h, []) if o != (sname, name)]
            other_stacks = [o for o in others if o[0] != sname]
            if other_stacks:
                where = ", ".join(f"{a} · {b}" for a, b in other_stacks[:3]) + (" ..." if len(other_stacks) > 3 else "")
                findings.append({"kind": "duplicate", "level": "warn", "text": f"same value also in {where}"})
            elif others:
                findings.append({"kind": "duplicate", "level": "info", "text": f"same value as {', '.join(b for _, b in others[:3])}"})
            ack = data["acks"].get(key)
            acked = bool(ack and ack.get("h") == h)
            limit = max_days(data, kind)
            age_from = max(rec["first"], ack["at"]) if acked else rec["first"]
            due_at = age_from + limit * 86400 if limit else None
            if due_at and now >= due_at:
                findings.append({"kind": "due", "level": "warn",
                                 "text": f"older than {limit} days" if not acked else "reminder: replace it"})
            if acked:
                for f in findings:
                    if f["kind"] != "due":
                        f["level"] = "info"
                        f["acked"] = True
            items.append({"id": key, "stackId": sid, "stack": sname, "name": name, "type": kind, "typeLabel": TYPES[kind][0],
                          "production": prod, "since": rec["first"], "estimated": rec["est"],
                          "ageDays": int((now - rec["first"]) // 86400), "maxAgeDays": limit, "dueAt": due_at,
                          "findings": findings, "acked": acked, "ackedAt": ack.get("at") if acked else None})
        for k in [k for k in data["vars"] if k not in seen_keys]:
            del data["vars"][k]
        for k in [k for k in data["acks"] if k not in seen_keys]:
            del data["acks"][k]
        items.sort(key=lambda i: (not any(f["level"] == "warn" for f in i["findings"]), i["stack"], i["name"]))
        with STATE["lock"]:
            data["checkedAt"] = int(now)
            if baseline:
                data["baselineAt"] = int(now)
            STATE["items"] = items
            STATE["error"] = None
        _save()
        if not STATE.get("dry"):
            for sname, name in changed:
                _timeline_changed(sname, name)
        return items
    finally:
        with STATE["lock"]:
            STATE["checking"] = False


def _timeline_changed(stack: str, name: str):
    try:
        import timeline  # noqa: PLC0415
        timeline.add("security", f"Secret replaced: {name}", detail=f"Stack {stack} · new value detected",
                     service=stack, source="secrets", weight=25,
                     link={"view": "security", "sel": ".sec-title", "text": "Secrets", "up": ".sec"})
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def loop():
    _load()
    time.sleep(120)
    while True:
        try:
            if config.enabled("portainer"):
                check()
            else:
                STATE["items"] = []
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(CHECK_EVERY)


def _start():
    threading.Thread(target=check, daemon=True, name="secrets-check").start()


# --------------------------------------------------------------------------- Reading (API)

def _open(items: list[dict]) -> list[tuple[dict, dict]]:
    return [(i, f) for i in items for f in i["findings"] if f["level"] == "warn"]


ORDER = {"test-in-prod": 0, "placeholder": 1, "weak": 2, "duplicate": 3, "due": 4}


def problems() -> list[dict]:
    """For health: one combined entry while there are open findings."""
    if not config.enabled("portainer"):
        return []
    try:
        open_ = sorted(_open(STATE["items"]), key=lambda x: ORDER.get(x[1]["kind"], 9))
    except Exception:  # noqa: BLE001
        return []
    if not open_:
        return []
    vars_ = {i["id"] for i, _ in open_}
    i, f = open_[0]
    title = f"Secret: {f['text']}" if len(vars_) == 1 else f"Secrets: {len(vars_)} with findings"
    detail = f"{i['name']} in {i['stack']}" + (f" and {len(vars_) - 1} more" if len(vars_) > 1 else "") + \
             ". See Security -> Secrets."
    return [{"level": "warn", "area": "security", "title": title, "detail": detail, "key": "secrets.findings"}]


def status() -> dict:
    data = _load()
    items = STATE["items"]
    types = [{"id": k, "label": v[0], "defaultDays": v[1], "maxAgeDays": max_days(data, k), "where": v[2], "url": v[3],
              "steps": v[4]} for k, v in TYPES.items()]
    open_ = _open(items)
    return {"checkedAt": data["checkedAt"], "checking": STATE["checking"], "error": STATE["error"], "every": CHECK_EVERY,
            "portainer": STATE["connected"], "baselineAt": data["baselineAt"], "types": types, "items": items,
            "counts": {"secrets": len(items), "withFindings": len({i["id"] for i, _ in open_}),
                       "due": sum(1 for _, f in open_ if f["kind"] == "due")}}


def ack(body: dict) -> dict:
    data = _load()
    key = f"{body.get('stackId')}/{body.get('name')}"
    rec = data["vars"].get(key)
    if not rec:
        raise D().ApiError(404, "The check does not know this variable (any more).")
    with STATE["lock"]:
        if body.get("undo"):
            data["acks"].pop(key, None)
        else:
            data["acks"][key] = {"h": rec["h"], "at": int(_now())}
    _save()
    check()
    return {"ok": True, "message": "Open again." if body.get("undo") else "Acknowledged - until the value changes."}


def put_settings(body: dict) -> dict:
    data = _load()
    m = body.get("maxAgeDays")
    if not isinstance(m, dict):
        raise D().ApiError(400, "maxAgeDays is missing.")
    clean = {}
    for k, v in m.items():
        if k not in TYPES:
            raise D().ApiError(400, f'Unknown type "{k}".')
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 3650:
            raise D().ApiError(400, f"{TYPES[k][0]}: a whole number of days from 0 to 3650.")
        if v != TYPES[k][1]:
            clean[k] = v
    with STATE["lock"]:
        data["settings"]["maxAgeDays"] = clean
    _save()
    check()
    return {"ok": True}


def route(method: str, path: str, body: dict):
    D().require("portainer")
    if method == "GET" and path == "/api/secrets":
        if not STATE.get("ran") and not STATE["checking"]:  # right after a restart, not only after 2 min
            _start()
        return status()
    if method == "POST" and path == "/api/secrets/check":
        _start()
        time.sleep(0.2)
        return {"ok": True, "checking": True}
    if method == "POST" and path == "/api/secrets/ack":
        return ack(body)
    if method == "PUT" and path == "/api/secrets/settings":
        return put_settings(body)
    raise D().ApiError(404, "No such endpoint.")


# --------------------------------------------------------------------------- Command line (read only)

if __name__ == "__main__":
    # Dry run on the server: reads with the dashboard's token, saves nothing, prints findings only.
    STATE["dry"] = True
    import dashboard as _d  # noqa: E402,F401 - brings portainer() and the paths
    sys.modules.setdefault("dashboard", _d)
    STATE["data"], STATE["loaded"] = _empty(), True
    res = check()
    if STATE["error"]:
        print("Error:", STATE["error"])
    print(f"{len(res)} secrets found")
    for i in res:
        fs = "; ".join(f"{f['text']}{' (hint)' if f['level'] == 'info' else ''}" for f in i["findings"]) or "-"
        age = f"{'~' if i['estimated'] else ''}{i['ageDays']} d"
        print(f"  {i['stack'][:22]:22} {i['name'][:34]:34} {i['typeLabel'][:26]:26} {'prod' if i['production'] else 'test':4} {age:>8}  {fs}")
