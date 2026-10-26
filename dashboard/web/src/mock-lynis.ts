import { timeZone } from "./format";
/**
 * Mock of the hardening audit (?mock): a realistic first run (index 71, 7 open, 22 accepted on purpose).
 * States via the address:
 *   ?mock                  index 71, 7 recommendations, calm
 *   ?mock&lynis=warn       a new Lynis warning, index dropped (71 → 68) – the row turns red
 *   ?mock&lynis=empty      never ran (run: null); "Check now" then delivers a run
 *   ?mock&lynis=missing    not set up on the server
 * "Check now" runs for 8 s, then a fresh run is there.
 */
import { has } from "./config";
import type { Lynis, LynisFinding, LynisItem } from "./lynis/api";

const now = () => Math.floor(Date.now() / 1000);
const MODE = new URLSearchParams(location.search).get("lynis");
const DOC = (id: string) => `https://cisofy.com/lynis/controls/${id}/`;

/** [test id, title, explanation, reason (accepted on purpose), parts [name, detail, reason, key?]] */
type Row = [string, string, string | null, string | null, [string, string | null, string | null, string?][]?];
const ROWS: Row[] = [
  ["KRNL-5820", "Core dumps allowed", "A crashing process can write its memory – keys and passwords included – to disk. Turn off with \"* hard core 0\" in /etc/security/limits.d, Storage=none for systemd-coredump and fs.suid_dumpable=0.", null],
  ["BOOT-5264", "Services without a sandbox", "systemd can lock services in (ProtectSystem, PrivateTmp, NoNewPrivileges …). Score per service: systemd-analyze security <service>. Worth it mostly for your own units.", null, [["keepwatch-dashboard", "9.0 UNSAFE", null], ["keepwatch-log-archive", "6.6 MEDIUM", null], ["30 services from Ubuntu packages", "auditd, containerd, cron, dbus, docker, fail2ban, ssh, systemd-journald, systemd-logind, systemd-networkd, systemd-resolved, tailscaled …", "Units from Ubuntu packages (ssh, docker, containerd, cron …) ship with their packages and need broad privileges; only Keepwatch's own units stay open.", "package-services"]]],
  ["FILE-7524", "File permissions looser than recommended", "Some system files are world-readable although only root needs them (chmod).", null, [["/etc/crontab", "644 → 600", null], ["/etc/ssh/sshd_config", "644 → 600", null], ["/etc/cron.d", "755 → 700", null], ["/etc/cron.daily", "755 → 700", null], ["/etc/cron.hourly", "755 → 700", null], ["/etc/cron.weekly", "755 → 700", null], ["/etc/cron.monthly", "755 → 700", null]]],
  ["HRDN-7222", "Compilers executable by everyone", "gcc and friends help an intruder build their own code. Best removed (build-essential, gcc, g++, make, dpkg-dev) if nothing is built on the host – builds happen in containers.", null, [["/usr/bin/x86_64-linux-gnu-as", null, null], ["/usr/bin/x86_64-linux-gnu-gcc-13", null, null]]],
  ["KRNL-6000", "Kernel settings (sysctl) looser than recommended", "Some sysctl values differ from the hardening profile. Set them in a file under /etc/sysctl.d/.", null, [["dev.tty.ldisc_autoload", "1 → 0", null], ["fs.protected_fifos", "1 → 2", null], ["fs.suid_dumpable", "2 → 0", null], ["kernel.core_uses_pid", "0 → 1", "Only affects core dump file names; core dumps are off entirely (see KRNL-5820)."], ["kernel.kptr_restrict", "1 → 2", null], ["kernel.modules_disabled", "0 → 1", "Docker and Tailscale load kernel modules on demand (overlay, br_netfilter, nf_*, tun); locked, nothing would start after a reboot."], ["kernel.perf_event_paranoid", "4 → 3", "Ubuntu sets 4 – stricter than the 3 Lynis expects."], ["kernel.sysrq", "176 → 0", "176 only allows sync, read-only remount and reboot from the provider console – the last resort when the server hangs."], ["kernel.unprivileged_bpf_disabled", "2 → 1", "Ubuntu sets 2 – also locked (only root can unlock it); Lynis only knows 1."], ["net.core.bpf_jit_harden", "0 → 2", null], ["net.ipv4.conf.all.forwarding", "1 → 0", "Docker forwards packets between its networks and to the outside; without forwarding every site would go down."], ["net.ipv4.conf.all.rp_filter", "2 → 1", "Ubuntu default 2 (loose); strict (1) drops valid packets on Tailscale and Docker networks."], ["net.ipv4.conf.all.send_redirects", "1 → 0", null], ["net.ipv4.conf.default.accept_redirects", "1 → 0", null], ["net.ipv4.conf.default.accept_source_route", "1 → 0", null], ["net.ipv6.conf.all.accept_redirects", "1 → 0", null], ["net.ipv6.conf.default.accept_redirects", "1 → 0", null]]],
  ["LOGG-2154", "Logs only on the server", "Whoever gets root can erase their tracks. Ship logs off the server promptly (remote syslog or log service), or at least back up /var/log/journal.", null],
  ["NETW-3200", "Rare network protocols loadable", "Nobody here needs DCCP, SCTP, RDS or TIPC, but they have had serious kernel bugs. Block them with \"install <module> /bin/false\" in /etc/modprobe.d/.", null, [["dccp", null, null], ["sctp", null, null], ["rds", null, null], ["tipc", null, null]]],
  ["ACCT-9622", "No process accounting", "acct logs every command that runs.", "Process accounting (acct) produces a lot of log for little value; what matters (accounts, sudo, keys, services) is watched by auditd."],
  ["ACCT-9626", "sysstat not collecting", "Performance data via sysstat/sar.", "sysstat is removed on purpose; the dashboard measures CPU, memory and network itself."],
  ["AUTH-9230", "Password hashing rounds not set", "SHA_CRYPT_MIN/MAX_ROUNDS in /etc/login.defs.", "Hashing rounds only matter for password logins, and apart from emergency access there are none (Ubuntu hashes with yescrypt anyway)."],
  ["AUTH-9262", "No password strength rules", "A PAM module such as pam_pwquality is missing.", "Strength rules apply when a password is changed; there are no users here who set passwords."],
  ["AUTH-9282", "Passwords never expire", "Accounts with a password have no expiry date.", "An expiry date on the root password would lock out exactly the emergency access when you need it."],
  ["AUTH-9286", "No minimum/maximum password age", "PASS_MIN_DAYS / PASS_MAX_DAYS in /etc/login.defs.", "AGE", [["minimum", null, "AGE"], ["maximum", null, "AGE"]]],
  ["AUTH-9328", "Default umask 022", "New files are world-readable; 027 would be stricter.", "Only root logs in, and Keepwatch installs files with explicit permissions (install -m); a stricter umask would add nothing."],
  ["BANN-7126", "No warning text in /etc/issue", "Legal notice before console login.", "A warning banner in /etc/issue is of no use on a private server without local logins."],
  ["BANN-7130", "No warning text in /etc/issue.net", "Legal notice before network login.", "sshd does not show /etc/issue.net (no banner set)."],
  ["BOOT-5122", "No boot loader password", "Anyone at the console can change the boot in the GRUB menu (e.g. single-user without a password).", "Only someone logged in to the provider's console reaches the boot menu – and they could mount the disk directly anyway."],
  ["FILE-6310", "No separate partitions", "If /home, /tmp or /var fills up, the whole system is affected.", "FP", [["/home", null, "FP"], ["/tmp", null, "FP"], ["/var", null, "FP"]]],
  ["FINT-4350", "No file integrity tool", "AIDE and similar tools regularly compare checksums of important files.", "auditd watches the important files (SSH keys, sudo, accounts, services, cron, firewall) in real time, and the dashboard shows every change."],
  ["FIRE-4513", "Firewall rules without hits", "Rules that never matched – unneeded, or for rare cases.", "Rules with a zero counter are intended: bans for rare cases (DOCKER-USER, emergency lock, ban history) and Docker's own chains."],
  ["HRDN-7230", "No malware scanner", "Lynis expects rkhunter, chkrootkit, ClamAV or similar.", "Trivy scans the container images every week; a malware scanner on the host (ClamAV, rkhunter) would mostly raise false alarms with Docker."],
  ["LOGG-2190", "Deleted files still in use", "Processes keep deleted files open – often old program versions after updates.", "DEL", [["/bin/busybox(nginx)", null, "DEL"], ["/data/database.sqlite(node)", null, "DEL"], ["/data/portainer.db(portainer)", null, "DEL"], ["/usr/bin/node(node)", null, "DEL"], ["/usr/local/bin/python3.12(uvicorn)", null, "DEL"], ["/usr/sbin/nginx(nginx)", null, "DEL"], ["/usr/lib/systemd/systemd-logind(systemd-l)", null, "DEL"]]],
  ["LYNIS", "Lynis is outdated", "A newer Lynis version knows more tests.", "Lynis comes from the Ubuntu package and is kept current with package updates; the version check against CISOfy is turned off in the profile."],
  ["NAME-4028", "No DNS domain name", "The server has no fully qualified domain name.", "The server is just called \"keep\" and is reached via its IP or Tailscale (MagicDNS); it needs no DNS domain name."],
  ["PKGS-7370", "debsums missing", "Checks installed package files against their checksums.", "debsums checks against checksums on the same system; auditd sees changes to important files right away, and packages only come from signed sources."],
  ["PKGS-7394", "apt-show-versions missing", "Helper to compare package versions.", "The dashboard shows pending updates itself and installs them automatically; apt-show-versions is not needed for that."],
  ["SSH-7408", "SSH settings looser than recommended", "Some sshd options differ from the hardening profile.", "SSH", [["AllowTcpForwarding", "LOCAL → NO", "Set to \"local\" on purpose: tunnels to the dashboard, Proxy Manager and Portainer (-L) must work, reverse tunnels (-R) don't."], ["LogLevel", "INFO → VERBOSE", "INFO already logs user, address and key fingerprint for every login; more log adds nothing with key-only logins."], ["MaxSessions", "10 → 2", "The macOS app and deploy open several sessions; a limit of 2 adds no protection with key-only logins."], ["Port", "22 → other value", "A different port only hides SSH; with Tailscale, port 22 can be closed to the internet entirely."], ["TCPKeepAlive", "YES → NO", "ClientAliveInterval cleans up dead sessions; TCPKeepAlive does no harm."]]],
  ["TOOL-5002", "No automation tool detected", "Lynis looks for Ansible, Puppet, Chef …", "Keepwatch itself is the automation (./keepwatch deploy); Lynis only knows Ansible, Puppet and friends."],
  ["USB-1000", "USB storage allowed", "The usb-storage driver is not blocked.", "A virtual machine without physical access; nobody plugs in a USB stick here."],
];

// Long shared reasons, filled in once.
const REASONS: Record<string, string> = {
  DEL: "Deleted but still open files are almost all inside containers (databases, programs from the images); whatever is left on the host after updates goes away with the next reboot.",
  FP: "A VPS with a single virtual disk; separate partitions for /home, /tmp and /var would only waste space – the dashboard watches the disk.",
  AGE: "Password age limits do nothing without password logins; the emergency access should not expire.",
  SSH: "Each option below is set on purpose – see the reason next to it.",
};
for (const r of ROWS) {
  if (r[3] && REASONS[r[3]]) r[3] = REASONS[r[3]];
  for (const it of r[4] ?? []) if (it[2] && REASONS[it[2]]) it[2] = REASONS[it[2]];
}

const WARN: Row = ["PKGS-7392", "Packages with known vulnerabilities", "Security updates are available but not installed yet.", null, [["openssl", "3.0.13-0ubuntu3.4 → 3.0.13-0ubuntu3.5", null], ["libssl3t64", null, null]]];

function finding([id, title, hint, reason, raw]: Row, kind: LynisFinding["kind"] = "suggestion", isNew = false): LynisFinding {
  const items: LynisItem[] = (raw ?? []).map(([label, detail, why, sub]) => ({ key: `${id}:${sub ?? label.toLowerCase()}`, label, detail, open: !why && !reason, reason: why ?? reason }));
  const open = !reason && (items.length ? items.some((i) => i.open) : true);
  return { id, kind, title, hint, text: null, detail: null, solution: null, url: id.includes("-") ? DOC(id) : null, open, reason: open ? null : reason, new: isNew, items };
}

let mode = MODE;
let runningUntil = 0;
let finishedAt = now() - 6 * 3600 - 23 * 60;
let pending = 0;

function state(): Lynis {
  const running = Date.now() < runningUntil;
  if (!running && pending) {
    finishedAt = pending;
    pending = 0;
    if (mode === "empty") mode = null;
  }
  const base: Lynis = {
    installed: mode !== "missing", running, lastResult: "success", error: null, checkedAt: null, schedule: "Sun 00:30", timezone: timeZone(),
    exceptionsFile: "/etc/keepwatch/lynis-exceptions.conf", exceptions: 34, run: null, previous: null,
    counts: { open: 0, accepted: 0, warnings: 0, new: 0 }, findings: [], history: [],
  };
  if (mode === "empty" || mode === "missing") return base;
  const warn = mode === "warn";
  const findings = [...(warn ? [finding(WARN, "warning", true)] : []), ...ROWS.map((r) => finding(r))];
  findings.sort((a, b) => Number(!a.open) - Number(!b.open) || Number(a.kind !== "warning") - Number(b.kind !== "warning") || Number(!a.new) - Number(!b.new) || a.id.localeCompare(b.id));
  const index = warn ? 68 : 71;
  const prev = { finishedAt: finishedAt - 7 * 86400, index: 71 };
  const open = findings.filter((f) => f.open);
  return {
    ...base,
    checkedAt: finishedAt,
    run: { startedAt: finishedAt - 142, finishedAt, index, tests: 276, lynisVersion: "3.0.9", vulnerablePackages: warn ? 2 : 0 },
    previous: prev,
    counts: { open: open.length, accepted: findings.length - open.length, warnings: open.filter((f) => f.kind === "warning").length, new: findings.filter((f) => f.new).length },
    findings,
    history: [
      { finishedAt, index, open: open.length, warnings: warn ? 1 : 0 },
      { ...prev, open: 7, warnings: 0 },
    ],
  };
}

export function mockLynis(method: string, p: string): unknown {
  if (!p.startsWith("/api/lynis")) return undefined;
  if (!has("lynis")) return { enabled: false };
  if (method === "GET" && p === "/api/lynis") return state();
  if (method === "POST" && p === "/api/lynis/run") {
    if (mode === "missing") throw new Error("The Lynis audit is not set up on the server (keepwatch-lynis.service is missing – run ./keepwatch deploy).");
    if (Date.now() >= runningUntil) {
      runningUntil = Date.now() + 8000;
      pending = Math.floor(runningUntil / 1000);
    }
    return { ok: true, running: true };
  }
  throw new Error("Unknown endpoint.");
}
