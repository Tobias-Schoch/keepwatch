"""Interactive setup: asks what the server is for and writes keepwatch.conf.

    ./keepwatch setup                     interactive
    ./keepwatch setup --preset web --host 203.0.113.10 --yes    no questions

Nothing on the server changes here. With your permission it looks at the
server over SSH (read-only) to suggest what fits: OS, memory, Docker,
Tailscale, what already listens on 80/443, and your own IP as the server sees it.
"""
from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kwconf  # noqa: E402

TTY = sys.stdout.isatty()
B, D, G, Y, R, X = (("\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m") if TTY
                    else ("",) * 6)

PRESETS = {
    "web": ("Websites and apps in Docker, behind a reverse proxy with HTTPS",
            "base debloat auto-updates ssh-hardening kernel-hardening auditd fail2ban ban-history firewall "
            "docker log-archive backup image-scan lynis proxy dashboard"),
    "docker": ("Docker apps without public websites (APIs over Tailscale, workers, databases)",
               "base debloat auto-updates ssh-hardening kernel-hardening auditd fail2ban ban-history firewall "
               "docker log-archive backup image-scan lynis dashboard"),
    "server": ("A hardened Linux server without Docker",
               "base debloat auto-updates ssh-hardening kernel-hardening auditd fail2ban ban-history firewall "
               "backup lynis dashboard"),
    "minimal": ("Bare minimum: automatic updates, SSH hardening, fail2ban, firewall",
                "base auto-updates ssh-hardening fail2ban firewall"),
}

BACKENDS = {
    "s3": ("S3 or S3-compatible (AWS, Wasabi, Hetzner, Cloudflare R2, MinIO, ...)",
           "s3:https://s3.eu-central-1.amazonaws.com/my-bucket/keepwatch"),
    "b2": ("Backblaze B2", "b2:my-bucket:keepwatch"),
    "sftp": ("SFTP (another server, a storage box, a NAS)", "sftp:user@backup.example.com:/backups/keepwatch"),
    "rest": ("restic REST server", "rest:https://user:pass@backup.example.com/keepwatch"),
    "rclone": ("rclone remote (Google Drive, OneDrive, Dropbox, WebDAV, ... 70+ providers)", "rclone:myremote:keepwatch"),
}

PROBE = r"""
. /etc/os-release 2>/dev/null
echo "os=$ID $VERSION_ID"
echo "pretty=$PRETTY_NAME"
echo "arch=$(uname -m)"
echo "cpus=$(nproc 2>/dev/null)"
echo "mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
echo "disk_free_gb=$(df -P -BG / 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
if [ "$(id -u)" = 0 ]; then S=""; echo "priv=root"
elif sudo -n true 2>/dev/null; then S="sudo -n"; echo "priv=sudo"
else S="false"; echo "priv=none"; fi
echo "client_ip=${SSH_CLIENT%% *}"
command -v docker >/dev/null && echo "docker=yes" || echo "docker=no"
echo "containers=$($S docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
echo "published=$($S docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE '(0\.0\.0\.0|\[::\]|:::?):[0-9]+' | grep -oE '[0-9]+$' | sort -un | tr '\n' ' ')"
command -v tailscale >/dev/null && echo "tailscale=yes" || echo "tailscale=no"
tailscale status >/dev/null 2>&1 && echo "tailscale_up=yes" || echo "tailscale_up=no"
echo "tailscale_name=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
echo "web_ports=$($S ss -tlnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | tr '\n' ';')"
echo "ufw=$($S ufw status 2>/dev/null | head -1 | awk '{print $2}')"
[ -f /etc/keepwatch/keepwatch.conf ] && echo "keepwatch=yes" || echo "keepwatch=no"
echo "tz=$(timedatectl show -p Timezone --value 2>/dev/null)"
"""


# --- Terminal helpers --------------------------------------------------------------

class Asker:
    def __init__(self, yes: bool):
        self.yes = yes

    def text(self, prompt: str, default: str = "", check=None) -> str:
        if self.yes:
            return default
        while True:
            hint = f" {D}[{default}]{X}" if default else ""
            try:
                v = input(f"  {prompt}{hint}: ").strip() or default
            except EOFError:
                v = default
            err = check(v) if check else None
            if not err:
                return v
            print(f"    {R}{err}{X}")

    def yesno(self, prompt: str, default: bool = True) -> bool:
        if self.yes:
            return default
        hint = "Y/n" if default else "y/N"
        while True:
            try:
                v = input(f"  {prompt} {D}[{hint}]{X} ").strip().lower()
            except EOFError:
                v = ""
            if not v:
                return default
            if v in ("y", "yes", "j", "ja"):
                return True
            if v in ("n", "no", "nein"):
                return False

    def choose(self, prompt: str, options: list, default: int = 0, recommend: bool = True) -> int:
        """options: [(label, hint)], returns the index."""
        print(f"\n  {prompt}")
        for i, (label, hint) in enumerate(options):
            rec = f" {G}(recommended){X}" if i == default and recommend else ""
            print(f"    {B}{i + 1}{X}) {label}{rec}")
            if hint:
                print(f"       {D}{hint}{X}")
        if self.yes:
            return default
        while True:
            try:
                v = input(f"  Choice {D}[{default + 1}]{X}: ").strip()
            except EOFError:
                v = ""
            if not v:
                return default
            if v.isdigit() and 1 <= int(v) <= len(options):
                return int(v) - 1


def section(title: str) -> None:
    print(f"\n{B}{title}{X}")


def note(text: str, color: str = D) -> None:
    print(f"    {color}{text}{X}")


def host_ok(v: str):
    if not v:
        return "Needed: the address deploy connects to."
    if not re.match(r"^[A-Za-z0-9.:\-\[\]]+$", v):
        return "That does not look like an IP or hostname."
    return None


def hhmm_ok(v: str):
    return None if re.match(r"^([01]\d|2[0-3]):[0-5]\d$", v) else "Use HH:MM, e.g. 04:00"


def local_tz() -> str:
    tz = os.environ.get("TZ", "")
    if "/" in tz:
        return tz.lstrip(":")
    try:
        link = os.readlink("/etc/localtime")
        m = re.search(r"zoneinfo/(.+)$", link)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "Etc/UTC"


# --- Probe ----------------------------------------------------------------------------

def probe(host: str, user: str, port: str) -> dict | None:
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
           "-p", port, f"{user}@{host}", "sh -s"]
    try:
        r = subprocess.run(cmd, input=PROBE, capture_output=True, text=True, timeout=40)
    except (OSError, subprocess.TimeoutExpired) as e:
        note(f"Could not run ssh: {e}", Y)
        return None
    if r.returncode != 0 and "os=" not in r.stdout:
        err = (r.stderr.strip().splitlines() or ["no output"])[-1]
        note(f"SSH failed: {err}", Y)
        if "Permission denied" in r.stderr:
            note("Keepwatch logs in with an SSH key. Copy yours first:  ssh-copy-id " + shlex.quote(f"{user}@{host}"), Y)
        return None
    out = {}
    for line in r.stdout.splitlines():
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def show_probe(p: dict) -> list:
    """Prints what was found, returns warnings that change suggestions."""
    mem = int(p.get("mem_mb") or 0)
    print(f"    {p.get('pretty') or p.get('os')} · {p.get('arch')} · {p.get('cpus')} CPU · "
          f"{mem / 1024:.1f} GB RAM · {p.get('disk_free_gb', '?')} GB free")
    dock = f"Docker with {p.get('containers', 0)} running container(s)" if p.get("docker") == "yes" else "no Docker"
    ts = ("Tailscale connected" if p.get("tailscale_up") == "yes" else
          "Tailscale installed, not logged in" if p.get("tailscale") == "yes" else "no Tailscale")
    print(f"    {dock} · {ts}")
    issues = []
    if p.get("os") not in ("ubuntu 24.04", "ubuntu 22.04"):
        issues.append(("os", f"Keepwatch is tested on Ubuntu 24.04/22.04 - this is {p.get('pretty')}. It may work, no promises."))
    if p.get("priv") == "none":
        issues.append(("priv", "This user is not root and has no passwordless sudo. Deploy needs one of the two."))
    if mem and mem < 1500:
        issues.append(("mem", f"Only {mem} MB RAM: the weekly image scan (Trivy) and Portainer are left off by default."))
    web = [w for w in p.get("web_ports", "").split(";") if w.strip()]
    foreign = [w for w in web if "docker-proxy" not in w]
    if foreign:
        issues.append(("web", "Ports 80/443 are already used by " + ", ".join(sorted({w.split()[-1] for w in foreign})) +
                       ". The reverse proxy needs them - stop that service or skip the proxy module."))
    pub = [x for x in p.get("published", "").split() if x not in ("80", "443")]
    if pub:
        issues.append(("published", f"Docker publishes port(s) {', '.join(pub)} to the internet. The firewall will close "
                                     "them (keep them in KW_PUBLIC_TCP if they must stay open)."))
    if p.get("ufw") == "active":
        issues.append(("ufw", "ufw is active. Keepwatch's firewall replaces it (ufw cannot see Docker's ports); "
                              "deploy leaves ufw alone - consider `ufw disable` afterwards."))
    if p.get("keepwatch") == "yes":
        issues.append(("kw", "This server is already managed by Keepwatch - deploy will update it."))
    for _, text in issues:
        note("! " + text, Y)
    return issues


# --- The questions -------------------------------------------------------------------------

def run(args) -> int:
    ask = Asker(args.yes)
    old = kwconf.parse(kwconf.CONF)
    conf = kwconf.load()
    mods = kwconf.modules()

    print(f"\n{B}Keepwatch setup{X}")
    print(f"  {D}A few questions, then keepwatch.conf is written. Nothing on your server changes until ./keepwatch deploy.{X}")
    if old:
        note(f"Found {kwconf.CONF.name} - your current values are the defaults.")

    # 1. Server
    section("1. Your server")
    host = args.host or ask.text("IP address or hostname", old.get("KW_HOST", ""), host_ok)
    user = args.user or ask.text("SSH user (root, or a user with passwordless sudo)", conf.get("KW_SSH_USER", "root"))
    port = ask.text("SSH port", conf.get("KW_SSH_PORT", "22"), lambda v: None if v.isdigit() else "A number, please")

    p, issues = None, []
    if not args.no_probe and (args.yes or ask.yesno("Look at the server now to tailor the setup? (read-only, over SSH)")):
        print(f"    {D}connecting to {user}@{host} ...{X}")
        p = probe(host, user, port)
        if p:
            issues = show_probe(p)
    kinds = {k for k, _ in issues}
    low_mem = "mem" in kinds

    # 2. Purpose
    section("2. What is this server for?")
    keys = list(PRESETS)
    if args.preset:
        preset = args.preset
    else:
        default = 0
        if p and p.get("docker") != "yes":
            default = 2
        elif p and "web" in kinds:
            default = 1
        preset = keys[ask.choose("Pick the closest one - you can fine-tune every module afterwards.",
                                 [(PRESETS[k][0], "") for k in keys], default)]
    chosen = set(PRESETS[preset][1].split())

    # 3. Access
    section("3. How do you want to reach the server?")
    access = ask.choose("Admin UIs (dashboard, proxy, Portainer) are never public - you reach them through an SSH tunnel.", [
        ("Tailscale + SSH key", "Port 22 closes to the internet once Tailscale is up. If Tailscale ever breaks, "
                                "port 22 reopens by itself after ~15 minutes, so you can't lock yourself out."),
        ("SSH key only", "Port 22 stays open; fail2ban bans an IP on its first failed login."),
    ], 0 if not old or "tailscale" in kwconf.active(conf) else 1)
    ssh_public = "yes"
    if access == 0:
        chosen.add("tailscale")
        if p and p.get("tailscale_up") == "yes":
            ssh_public = "no" if ask.yesno("Tailscale is already connected. Close port 22 to the internet right away?") else "yes"
        else:
            note("Port 22 stays open for the first deploy; deploy shows a Tailscale login link. "
                 "Close it afterwards in the dashboard or with KW_SSH_PUBLIC=\"no\".")
    else:
        chosen.discard("tailscale")

    # 4. Backups
    section("4. Backups")
    remote = conf.get("KW_BACKUP_REMOTE", "") if old else ""
    b = ask.choose("restic backups: daily, encrypted, deduplicated; databases are dumped consistently first.", [
        ("Local and off-site", "A copy on the server for quick restores, plus one somewhere else that survives losing the server."),
        ("Local only", "Protects against mistakes, not against losing the server. You can pull copies with ./keepwatch backup pull."),
        ("No backups", ""),
    ], 0 if remote or not old else (1 if "backup" in kwconf.active(conf) else 2))
    if b == 2:
        chosen.discard("backup")
        remote = ""
    else:
        chosen.add("backup")
        if b == 1:
            remote = ""
        else:
            bk = list(BACKENDS)
            current = next((i for i, k in enumerate(bk) if remote.startswith(k + ":")), 0)
            i = ask.choose("Where should the off-site copy go?", [(BACKENDS[k][0], "") for k in bk], current, recommend=False)
            example = BACKENDS[bk[i]][1]
            remote = ask.text(f"restic repository {D}(e.g. {example}){X}", remote if remote.startswith(bk[i] + ":") else "",
                              lambda v: None if v.startswith(bk[i] + ":") else f"Starts with {bk[i]}:")
            note("Credentials are not stored here: deploy asks for them on the server (they never leave it).")
            if bk[i] == "rclone":
                note("rclone: deploy runs `rclone config` on the server once to set up the remote.")

    # 5. Tools
    section("5. Tools")
    if "docker" in chosen:
        had = "portainer" in kwconf.active(conf) if old else True
        if ask.yesno("Portainer - web UI for Docker stacks, deploys from Git? (needs ~100 MB RAM)", had and not low_mem):
            chosen.add("portainer")
        if low_mem and "image-scan" in chosen:
            chosen.discard("image-scan")
    if not ask.yesno("Keepwatch dashboard - health, security, backups, updates and sites on one page?", True):
        chosen.discard("dashboard")
    if "web" in kinds and "proxy" in chosen:
        if not ask.yesno("Something else holds ports 80/443. Install the reverse proxy anyway?", False):
            chosen.discard("proxy")

    # 6. Schedule
    section("6. Schedule")
    tz = ask.text("Your timezone (for schedules and the dashboard)", conf.get("KW_LOCAL_TZ") if old else local_tz())
    upd = ask.text("Install security updates at", conf.get("KW_UPDATE_TIME", "04:00"), hhmm_ok) if "auto-updates" in chosen else conf.get("KW_UPDATE_TIME")
    reboot = conf.get("KW_AUTO_REBOOT", "yes")
    if "auto-updates" in chosen:
        reboot = "yes" if ask.yesno("Reboot right after an update that needs it (kernel, libc)?", reboot == "yes") else "no"
    btime = ask.text("Back up at", conf.get("KW_BACKUP_TIME", "03:00"), hhmm_ok) if "backup" in chosen else conf.get("KW_BACKUP_TIME")

    # 7. Trusted IPs
    section("7. Trusted addresses")
    trusted = conf.get("KW_TRUSTED_IPS", "")
    me = (p or {}).get("client_ip", "")
    if me and me not in trusted.split() and not me.startswith("100."):
        note(f"The server sees you as {me}.")
        if ask.yesno(f"Never ban {me}? (fine for a fixed home/office IP; skip it for mobile or changing IPs)", False):
            trusted = (trusted + " " + me).strip()
    trusted = ask.text("Never ban these IPs/ranges (space separated, optional)", trusted)

    # 8. Review
    final = review(ask, kwconf.with_requirements(chosen, mods), mods)

    values = {
        "KW_HOST": host, "KW_SSH_USER": user, "KW_SSH_PORT": port,
        "KW_LOCAL_TZ": tz, "KW_UPDATE_TIME": upd, "KW_AUTO_REBOOT": reboot, "KW_BACKUP_TIME": btime,
        "KW_BACKUP_REMOTE": remote, "KW_SSH_PUBLIC": ssh_public, "KW_TRUSTED_IPS": trusted,
        "KW_MODULES": " ".join(kwconf.ordered(final, mods)),
    }
    if not old:
        values["KW_HOSTNAME"] = conf.get("KW_HOSTNAME", "keep")
        # Without the proxy nothing needs 80/443; with an existing config the user's list wins.
        values["KW_PUBLIC_TCP"] = conf.get("KW_PUBLIC_TCP", "80 443") if "proxy" in final else ""

    section("Summary")
    for k in ("KW_HOST", "KW_SSH_USER", "KW_LOCAL_TZ", "KW_BACKUP_REMOTE", "KW_SSH_PUBLIC", "KW_TRUSTED_IPS"):
        print(f"    {k:<18} {values[k] or D + '-' + X}")
    verb = "Update" if kwconf.CONF.is_file() else "Write"
    if not args.yes and not ask.yesno(f"{verb} {kwconf.CONF.name}?", True):
        print("  Nothing written.")
        return 1
    kwconf.save(values)
    print(f"\n  {G}Wrote {kwconf.CONF.name}{X} {D}- every setting is explained in there.{X}")

    section("Next")
    if p and p.get("priv") == "none":
        note("First give your SSH user passwordless sudo or use root.", Y)
    print(f"    ./keepwatch deploy            {D}set up the server (takes a few minutes the first time){X}")
    if "dashboard" in final:
        print(f"    ./keepwatch tunnel            {D}open the dashboard and the admin UIs on your computer{X}")
    if sys.platform == "darwin" and "dashboard" in final:
        print(f"    ./keepwatch desktop           {D}optional: build the macOS app (tunnel + Touch ID lock){X}")
    print(f"    ./keepwatch modules           {D}see or change modules any time{X}")
    return 0


def review(ask: Asker, chosen: set, mods: dict) -> set:
    section("8. Modules")
    note("Everything is optional except base. Toggle by number (e.g. \"4 12\"), Enter when done.")
    ids = list(mods)
    while True:
        for i, m in enumerate(ids):
            on = m in chosen
            mark = f"{G}[x]{X}" if on else "[ ]"
            need = f" {D}(needs {', '.join(mods[m]['requires'])}){X}" if mods[m]["requires"] else ""
            print(f"    {mark} {i + 1:>2} {m:<17}{D}{mods[m]['summary'][:78]}{X}{need}")
        if ask.yes:
            return chosen
        try:
            v = input("  Toggle: ").strip()
        except EOFError:
            v = ""
        if not v:
            return chosen
        for tok in re.split(r"[\s,]+", v):
            if not tok.isdigit() or not 1 <= int(tok) <= len(ids):
                continue
            m = ids[int(tok) - 1]
            if m == "base":
                note("base is always on.", Y)
            elif m in chosen:
                gone = kwconf.dependents({m}, chosen, mods)
                chosen -= gone
                if gone - {m}:
                    note(f"also off (they need {m}): {', '.join(sorted(gone - {m}))}", Y)
            else:
                new = kwconf.with_requirements(chosen | {m}, mods)
                if new - chosen - {m}:
                    note(f"also on ({m} needs it): {', '.join(sorted(new - chosen - {m}))}", Y)
                chosen = new
        print()


def main() -> int:
    ap = argparse.ArgumentParser(prog="keepwatch setup", description=__doc__.split("\n")[0])
    ap.add_argument("--preset", choices=list(PRESETS), help="skip the purpose question")
    ap.add_argument("--host")
    ap.add_argument("--user")
    ap.add_argument("--yes", action="store_true", help="accept all defaults, no questions")
    ap.add_argument("--no-probe", action="store_true", help="do not connect to the server")
    args = ap.parse_args()
    if args.yes and not (args.host or kwconf.parse(kwconf.CONF).get("KW_HOST")):
        ap.error("--yes needs --host (or an existing keepwatch.conf)")
    try:
        return run(args)
    except KeyboardInterrupt:
        print("\n  Cancelled, nothing written.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
