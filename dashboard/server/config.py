"""Keepwatch configuration and paths for the dashboard.

keepwatch.conf is shell syntax (KEY="value"), shared with bash on the server and
lib/kwconf.py on your computer. Defaults come from keepwatch.conf.example in the
repository root (the dashboard runs from <root>/dashboard/server/), the real
configuration (/etc/keepwatch/keepwatch.conf, or $KW_CONF) goes on top. The
file is re-read when it changes, so a deploy needs no restart for new values.

Every file the dashboard reads from or writes to another module is listed below,
so the contract with modules/ lives in one place.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "keepwatch.conf.example"
CONF = Path(os.environ.get("KW_CONF", "/etc/keepwatch/keepwatch.conf"))
PROJECT_URL = "https://github.com/Tobias-Schoch/keepwatch"

# Module ids = directory names in modules/ (fixed list: the server copy may lack modules/).
MODULES = ("base", "debloat", "auto-updates", "ssh-hardening", "kernel-hardening", "auditd", "fail2ban",
           "ban-history", "tailscale", "docker", "firewall", "log-archive", "backup", "image-scan", "lynis",
           "proxy", "portainer", "dashboard")
MODULE_NAMES = {"base": "Base system", "debloat": "Debloat", "auto-updates": "Automatic updates",
                "ssh-hardening": "SSH hardening", "kernel-hardening": "Kernel hardening", "auditd": "Audit log",
                "fail2ban": "fail2ban", "ban-history": "Ban history", "tailscale": "Tailscale", "docker": "Docker",
                "firewall": "Firewall", "log-archive": "Log archive", "backup": "Backup", "image-scan": "Image scan",
                "lynis": "Lynis", "proxy": "Reverse proxy", "portainer": "Portainer", "dashboard": "Dashboard"}
# Add-ons the dashboard may switch on and off (keepwatch-modules decides; this is the fallback when it is missing).
TOGGLEABLE = ("lynis", "image-scan", "log-archive", "ban-history", "auditd", "auto-updates", "backup")

# --- Paths (contract with modules/) -----------------------------------------------
# KW_ETC / KW_VAR only for running the dashboard outside a server (tests); production uses the defaults.
ETC = Path(os.environ.get("KW_ETC") or "/etc/keepwatch")
VAR = Path(os.environ.get("KW_VAR") or "/var/lib/keepwatch")
CONF_DIR = ETC / "dashboard"                       # dashboard secrets (tokens, passkeys, salt)
STATE_DIR = VAR / "dashboard"                      # dashboard state (history, databases)
LYNIS_JSON = VAR / "lynis.json"                    # written by keepwatch-lynis
LYNIS_EXCEPTIONS = [ETC / "lynis-exceptions.conf", ROOT / "modules" / "lynis" / "files" / "exceptions.conf"]
IMAGE_SCAN_JSON = VAR / "image-scan.json"          # written by keepwatch-image-scan
IMAGE_SCAN_PROGRESS = VAR / "image-scan.progress.json"
BAN_HISTORY_JSON = VAR / "ban-history.json"        # written by keepwatch-ban-history
BAN_HISTORY_BIN = Path("/usr/local/sbin/keepwatch-ban-history")
DEPLOY_LOG = VAR / "deploys.jsonl"                 # written by lib/apply.sh
VERSION_JSON = ROOT / "VERSION.json"               # what runs: written by deploy and keepwatch-self-update
UPDATE_JSON = VAR / "update.json"                  # last update check + last update (keepwatch-self-update)
UPDATE_LOG = VAR / "self-update.log"
MODULES_OVERRIDE = ETC / "modules-override.json"   # modules switched in the dashboard (keepwatch-modules)
MODULES_APPLY_JSON = VAR / "modules-apply.json"    # progress of keepwatch-modules-apply.service
MODULES_CLI = Path("/usr/local/sbin/keepwatch-modules")  # list/enable/disable/status (on PATH first: tests)
DEPLOY_LOCK = Path("/run/keepwatch.lock")          # held by lib/apply.sh, deploys and the updaters
LOG_ARCHIVE_DIR = Path("/var/log/keepwatch/containers")
LOG_ARCHIVE_STATUS = VAR / "log-archive" / "status.json"
LOG_ARCHIVE_CONF = ETC / "log-archive.conf"
BACKUP_ENV = ETC / "backup" / "env"
RCLONE_CONF = ETC / "backup" / "rclone.conf"
RESTIC_PASSWORD_FILE = ETC / "backup" / "restic.pass"
LOCAL_REPO = Path("/var/backups/keepwatch/restic")
BACKUP_REMOTE_OK = VAR / "backup" / "remote-last-ok"  # Unix time of the last good off-site copy
PRE_UPDATE_DUMPS = Path("/var/backups/keepwatch/pre-update")
PROXY_DATA = Path("/srv/keepwatch/proxy/data")
PROXY_LE = Path("/srv/keepwatch/proxy/letsencrypt")
FIREWALL_ENV = ETC / "firewall.env"                # SSH_PUBLIC=yes|no, read by keepwatch-firewall
FALLBACK_MARK = "SSH_FALLBACK_OPENED"              # "# SSH_FALLBACK_OPENED=<unix time> <reason>" from keepwatch-ssh-fallback
FW_LOG_PREFIX = "ssh-closed:"                      # kernel log prefix for packets to a closed port 22
JAIL_SSH = "sshd"                                  # fail2ban jails (modules/fail2ban)
JAIL_SSH_TAILNET = "sshd-tailscale"
JAIL_SSH_CLOSED = "ssh-closed"
JAIL_RECIDIVE = "recidive"
JAILS_WEB = ("web-scanner", "app-login")

UNITS = {"backup": "keepwatch-backup", "backup-verify": "keepwatch-backup-verify", "firewall": "keepwatch-firewall",
         "ssh-fallback": "keepwatch-ssh-fallback", "log-archive": "keepwatch-log-archive",
         "image-scan": "keepwatch-image-scan", "lynis": "keepwatch-lynis", "ban-history": "keepwatch-ban-history",
         "dashboard": "keepwatch-dashboard", "self-update": "keepwatch-self-update",
         "self-update-check": "keepwatch-self-update-check", "modules-apply": "keepwatch-modules-apply"}
PASSKEY_CLI = "keepwatch-passkey reset"


def version() -> str:
    """VERSION file in the repository root, else the deployed commit (VERSION.json, older
    deploys: .deploy-info), else "dev"."""
    for p in (ROOT / "VERSION", VERSION_JSON, ROOT / ".deploy-info"):
        try:
            text = p.read_text().strip()
        except OSError:
            continue
        if p.name == "VERSION" and text:
            return text
        m = re.search(r'"commit"\s*:\s*"([0-9a-f]{7,40})"', text)
        if m:
            return m.group(1)[:7] + ("+dirty" if re.search(r'"dirty"\s*:\s*true', text) else "")
    return "dev"


VERSION = version()
USER_AGENT = f"keepwatch/{VERSION} (+{PROJECT_URL})"

# --- Parsing ------------------------------------------------------------------------

LINE = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|\'([^\']*)\'|([^\s#]*))')


def parse(text: str) -> dict[str, str]:
    """KEY="value" / KEY='value' / KEY=value lines; comments and everything else ignored."""
    out = {}
    for line in text.splitlines():
        m = LINE.match(line)
        if m:
            dq, sq, bare = m.group(2), m.group(3), m.group(4)
            out[m.group(1)] = re.sub(r"\\(.)", r"\1", dq) if dq is not None else sq if sq is not None else bare
    return out


def parse_file(path: Path) -> dict[str, str]:
    try:
        return parse(path.read_text())
    except (OSError, UnicodeDecodeError):
        return {}


def quote(v: str) -> str:
    """Value for a shell env file (double quotes, safe for `source`)."""
    return '"' + re.sub(r'(["\\$`])', r"\\\1", str(v)) + '"'


_CACHE = {"key": None, "values": {}}
_LOCK = threading.Lock()


def _mtime(p: Path):
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return None


def values() -> dict[str, str]:
    """Defaults from the example, the real configuration on top (cached until a file changes)."""
    key = (_mtime(EXAMPLE), _mtime(CONF), str(CONF))
    with _LOCK:
        if _CACHE["key"] != key:
            _CACHE["values"] = {**parse_file(EXAMPLE), **parse_file(CONF)}
            _CACHE["key"] = key
        return _CACHE["values"]


# --- Getters -------------------------------------------------------------------------

def get(key: str, default: str = "") -> str:
    v = values().get(key)
    return default if v is None else v


def get_int(key: str, default: int) -> int:
    try:
        return int(get(key, str(default)).strip())
    except ValueError:
        return default


def get_bool(key: str, default: bool = False) -> bool:
    v = get(key, "").strip().lower()
    if v in ("yes", "true", "1", "on"):
        return True
    if v in ("no", "false", "0", "off"):
        return False
    return default


def get_list(key: str) -> list[str]:
    return get(key).split()


_EFF = {"key": None, "modules": set(), "overrides": {}}


def _kwmodules():
    """lib/kwmodules.py of this copy (the server runs the dashboard from /opt/keepwatch), or None."""
    try:
        if str(ROOT / "lib") not in sys.path:
            sys.path.append(str(ROOT / "lib"))
        import kwmodules
        return kwmodules
    except Exception:  # noqa: BLE001 - an older copy without it: KW_MODULES alone
        return None


def _effective() -> dict:
    """KW_MODULES with the dashboard's switches on top (MODULES_OVERRIDE, {"on": [...], "off": [...]},
    written by keepwatch-modules), worked out like lib/apply.sh does (kwmodules.effective: only
    toggleable add-ons, requirements respected). Cached until keepwatch.conf or the override changes."""
    key = (_mtime(EXAMPLE), _mtime(CONF), str(CONF), _mtime(MODULES_OVERRIDE))
    with _LOCK:
        if _EFF["key"] == key:
            return _EFF
    conf = [m for m in get_list("KW_MODULES") if m in MODULES]
    try:
        raw = json.loads(MODULES_OVERRIDE.read_text())
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    ov = {k: [m for m in raw.get(k) or [] if isinstance(m, str) and m in MODULES] if isinstance(raw.get(k), list) else []
          for k in ("on", "off")}
    ov["log"] = []
    km = _kwmodules()
    mods, plus, minus = None, [], []
    if km:
        try:
            mods, plus, minus, _ = km.effective(conf, ov, km.catalog(ROOT))
        except Exception:  # noqa: BLE001
            mods = None
    if mods is None:  # without kwmodules: the same rule, minus the requirement check
        plus = [m for m in ov["on"] if m in TOGGLEABLE and m not in conf]
        minus = [m for m in ov["off"] if m in TOGGLEABLE and m in conf and m not in plus]
        mods = [m for m in conf if m not in minus] + plus
    with _LOCK:
        _EFF.update(key=key, modules=(set(mods) & set(MODULES)) | {"base", "dashboard"},
                    overrides={**{m: True for m in plus}, **{m: False for m in minus}})
        return _EFF


def overrides() -> dict[str, bool]:
    """Modules switched in the dashboard that keepwatch.conf does not have yet: {id: on?}."""
    return _effective()["overrides"]


def modules() -> set[str]:
    """Enabled modules: KW_MODULES with what was switched in the dashboard on top (base is always on,
    the dashboard is on while it runs)."""
    return _effective()["modules"]


def module_name(mid: str) -> str:
    """NAME from modules/<id>/module.conf, else MODULE_NAMES."""
    return parse_file(ROOT / "modules" / mid / "module.conf").get("NAME") or MODULE_NAMES.get(mid, mid)


def enabled(module: str) -> bool:
    return module in modules()


def local_tz() -> ZoneInfo:
    """KW_LOCAL_TZ: schedules and day boundaries. Falls back to UTC if unknown."""
    try:
        return ZoneInfo(get("KW_LOCAL_TZ", "Etc/UTC") or "Etc/UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("Etc/UTC")


def local_tz_name() -> str:
    return local_tz().key


def hostname() -> str:
    return get("KW_HOSTNAME") or os.uname().nodename


def trusted_ips() -> list[str]:
    return get_list("KW_TRUSTED_IPS")


def ports() -> dict[str, int]:
    return {"dashboard": int(os.environ.get("DASHBOARD_PORT") or get_int("KW_DASHBOARD_PORT", 9004)),
            "proxyAdmin": get_int("KW_PROXY_ADMIN_PORT", 9001), "portainer": get_int("KW_PORTAINER_PORT", 9002)}


def extra_uis() -> list[dict]:
    """KW_EXTRA_UIS="Name=port Other_name=port/some/path/" (underscores become spaces, as in lib/kwconf.py):
    [{name, port, path}], path "/" unless given (for a UI whose "/" redirects somewhere unreachable)."""
    out = []
    for item in get_list("KW_EXTRA_UIS"):
        name, _, rest = item.rpartition("=")
        port, slash, path = rest.partition("/")
        if name and port.isdigit():
            out.append({"name": name.replace("_", " "), "port": int(port), "path": "/" + path if slash else "/"})
    return out


def admin_uis() -> list[dict]:
    """Local web UIs of enabled modules plus KW_EXTRA_UIS: [{name, port}]."""
    p = ports()
    uis = [{"name": "Dashboard", "port": p["dashboard"]}]
    if enabled("portainer"):
        uis.append({"name": "Portainer", "port": p["portainer"]})
    if enabled("proxy"):
        uis.append({"name": "Proxy Manager", "port": p["proxyAdmin"]})
    return uis + extra_uis()


def tools() -> list[dict]:
    """Admin UIs the dashboard links to (Overview "Tools", quick search): Portainer and the Proxy Manager
    while their module is on, then KW_EXTRA_UIS. [{id, name, port, path}], port on the server (127.0.0.1)."""
    p = ports()
    out = []
    if enabled("portainer"):
        out.append({"id": "portainer", "name": "Portainer", "port": p["portainer"], "path": "/"})
    if enabled("proxy"):
        out.append({"id": "proxy", "name": "Proxy Manager", "port": p["proxyAdmin"], "path": "/"})
    for i, ui in enumerate(extra_uis(), 1):
        out.append({"id": f"extra-{i}", **ui})
    return out


def portainer_url() -> str:
    return os.environ.get("PORTAINER_URL") or f"http://127.0.0.1:{ports()['portainer']}"


def proxy_url() -> str:
    return os.environ.get("NPM_URL") or f"http://127.0.0.1:{ports()['proxyAdmin']}"


def passkey() -> bool:
    return get_bool("KW_DASHBOARD_PASSKEY", True)


def self_update_repo() -> str:
    """KW_SELF_UPDATE_REPO (GitHub owner/repo the dashboard offers updates from); "" = off."""
    return get("KW_SELF_UPDATE_REPO").strip()


def public() -> dict:
    """GET /api/config."""
    return {"hostname": hostname(), "modules": {m: enabled(m) for m in MODULES}, "localTz": local_tz_name(),
            "ports": ports(), "extraUis": extra_uis(), "tools": tools(), "passkey": passkey(), "version": version(),
            "selfUpdate": bool(self_update_repo())}
