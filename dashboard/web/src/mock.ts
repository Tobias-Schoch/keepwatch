/**
 * Mock backend for development and screenshots (?mock in the address or VITE_MOCK=1).
 * A made-up server "keep" (203.0.113.10) with a few typical self-hosted apps.
 * Time series are random but reproducible. Writes are simulated in memory.
 *
 * Disabled modules behave like on a real server: their endpoints answer
 * {"enabled": false} and their data and problems are left out
 * (?mock&modules=-proxy,-portainer, see mock-config.ts).
 *
 * More switches in the address:
 *   ?fresh   a fresh install: Tailscale not logged in, no Portainer token, no off-site backup
 *   ?ts      the request comes via Tailscale (allows closing port 22)
 *   ?closed  port 22 was closed two hours ago
 */
import type { Access, AccessEntry, AccessHost, Backups, Container, Country, CountryCount, Docker, EnvVar, LoginIps, LogLine, Overview, Problem, RemoteRepoInput, Security, SecurityHistory, Settings, Sites, Stacks } from "./types";
import { has, type ModuleId } from "./config";
import { fmtDate } from "./format";
import { addressCount, normalize } from "./ip";
import { mockUpdateProblems, mockUpdates } from "./mock-updates";
import { mockHosts, mockNewSites, NOT_MINE } from "./mock-hosts";
import { mockUptime } from "./mock-uptime";
import { mockSiteGrade } from "./mock-sitegrade";
import { mockIp, mockLogs } from "./mock-logs";
import { mockLogArchive } from "./mock-logarchive";
import { mockTimeline, NOT_TIMELINE } from "./mock-timeline";
import { mockCtProblems, mockCtWatch } from "./mock-ctwatch";
import { mockSecretProblems, mockSecrets } from "./mock-secrets";
import { mockLynis } from "./mock-lynis";

const GB = 1024 ** 3;
const now = () => Math.floor(Date.now() / 1000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = new URLSearchParams(location.search);
const FRESH = q.has("fresh");

let seed = 7;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);

function walk(n: number, base: number, spread: number, min = 0, max = Infinity) {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (rnd() - 0.5) * spread;
    v += (base - v) * 0.08;
    if (rnd() > 0.985) v += spread * 3 * rnd();
    out.push(Math.max(min, Math.min(max, v)));
  }
  return out;
}

/* ---------- State ------------------------------------------------------------------ */

const BOOT = now() - (8 * 86400 + 1 * 3600 + 38 * 60);
const HIST_N = 1440;
const LIVE_N = 180;

const hist = (() => {
  const end = Math.floor(now() / 60) * 60;
  const t = Array.from({ length: HIST_N }, (_, i) => end - (HIST_N - 1 - i) * 60);
  return { t, cpu: walk(HIST_N, 6, 4, 0.5, 100), mem: walk(HIST_N, 21, 1.2, 10, 90), rx: walk(HIST_N, 180_000, 140_000, 2_000), tx: walk(HIST_N, 320_000, 220_000, 2_000), load1: walk(HIST_N, 0.45, 0.35, 0.02) };
})();
const live = (() => {
  const end = Math.floor(now() / 5) * 5;
  const t = Array.from({ length: LIVE_N }, (_, i) => end - (LIVE_N - 1 - i) * 5);
  return { t, cpu: walk(LIVE_N, 7, 6, 0.5, 100), mem: walk(LIVE_N, 21.5, 0.4, 10, 90), rx: walk(LIVE_N, 160_000, 160_000, 1_000), tx: walk(LIVE_N, 280_000, 260_000, 1_000) };
})();

function tickLive() {
  const end = Math.floor(now() / 5) * 5;
  while (live.t[live.t.length - 1] < end) {
    const last = live.t[live.t.length - 1];
    live.t.push(last + 5);
    live.cpu.push(Math.max(0.5, Math.min(100, live.cpu[live.cpu.length - 1] + (rnd() - 0.5) * 6 + (7 - live.cpu[live.cpu.length - 1]) * 0.1)));
    live.mem.push(Math.max(10, live.mem[live.mem.length - 1] + (rnd() - 0.5) * 0.3));
    live.rx.push(Math.max(1000, live.rx[live.rx.length - 1] + (rnd() - 0.5) * 140_000 + (160_000 - live.rx[live.rx.length - 1]) * 0.1));
    live.tx.push(Math.max(1000, live.tx[live.tx.length - 1] + (rnd() - 0.5) * 220_000 + (280_000 - live.tx[live.tx.length - 1]) * 0.1));
    (Object.keys(live) as (keyof typeof live)[]).forEach((k) => live[k].length > LIVE_N && live[k].shift());
  }
}

/* ---------- Countries (as DB-IP returns them: long names, tailnet without a code) ---------- */

const CC_NAME: Record<string, string> = {
  IN: "India", NL: "Netherlands", ID: "Indonesia", US: "United States of America", IL: "Israel", CN: "China",
  DE: "Germany", SG: "Singapore", BR: "Brazil", VN: "Viet Nam", RU: "Russian Federation", KR: "Korea (Republic of)",
  PY: "Paraguay", GB: "United Kingdom of Great Britain and Northern Ireland", FR: "France", CH: "Switzerland", BD: "Bangladesh",
};
const IP_CC: Record<string, string> = {
  "203.0.113.45": "IN", "203.0.113.77": "IN", "203.0.113.81": "ID", "192.0.2.14": "NL", "192.0.2.15": "NL",
  "203.0.113.120": "CN", "203.0.113.121": "CN", "192.0.2.201": "PY", "192.0.2.64": "US", "192.0.2.165": "DE",
  "192.0.2.77": "IL", "192.0.2.94": "DE", "192.0.2.51": "FR", "192.0.2.185": "GB", "198.51.100.23": "NL",
  "198.51.100.24": "NL", "198.51.100.140": "NL", "203.0.113.151": "BD",
};
function geo(ip: string): Country {
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return { cc: null, name: "Tailnet" };
  if (/^(10|127)\.|^192\.168\./.test(ip)) return { cc: null, name: "internal" };
  const cc = IP_CC[ip];
  return cc ? { cc, name: CC_NAME[cc] } : { cc: null, name: "unknown" };
}
/** Attempts per country in 24 h (a typical distribution for a public VPS). */
const COUNTRIES_24H: [string, number, number][] = [
  ["IN", 2559, 6], ["NL", 270, 18], ["ID", 195, 2], ["US", 181, 27], ["IL", 129, 6], ["CN", 118, 14], ["DE", 96, 9],
  ["SG", 74, 8], ["GB", 52, 4], ["BR", 48, 7], ["VN", 44, 5], ["RU", 38, 6], ["KR", 22, 3], ["FR", 19, 4],
];
const countries = (scale: number): CountryCount[] => [
  ...COUNTRIES_24H.map(([cc, a, n]) => ({ cc, name: CC_NAME[cc], attempts: Math.round(a * scale), ips: Math.max(n, Math.round(n * Math.sqrt(scale) * 2.2)) })),
  { cc: null, name: "unknown", attempts: Math.round(9 * scale), ips: 2 },
];

const bans: Omit<Security["bans"][number], "country">[] = [
  { ip: "203.0.113.45", jail: "sshd", bannedAt: now() - 1500, expiresAt: now() - 1500 + 7 * 86400, banCount: 3, active: true },
  { ip: "203.0.113.81", jail: "sshd", bannedAt: now() - 1100, expiresAt: now() - 1100 + 7 * 86400, banCount: 1, active: true },
  { ip: "192.0.2.14", jail: "web-scanner", bannedAt: now() - 760, expiresAt: now() - 760 + 7 * 86400, banCount: 1, active: true },
  { ip: "203.0.113.120", jail: "sshd", bannedAt: now() - 420, expiresAt: now() - 420 + 7 * 86400, banCount: 1, active: true },
  { ip: "192.0.2.77", jail: "web-scanner", bannedAt: now() - 3 * 3600, expiresAt: now() - 3 * 3600 + 7 * 86400, banCount: 1, active: true },
  { ip: "192.0.2.15", jail: "app-login", bannedAt: now() - 5 * 3600, expiresAt: now() - 5 * 3600 + 14 * 86400, banCount: 2, active: true },
  { ip: "192.0.2.64", jail: "web-scanner", bannedAt: now() - 9 * 3600, expiresAt: now() - 9 * 3600 + 7 * 86400, banCount: 1, active: true },
  { ip: "192.0.2.201", jail: "sshd", bannedAt: now() - 6 * 86400, expiresAt: now() - 5 * 3600, banCount: 1, active: false },
  { ip: "203.0.113.77", jail: "sshd", bannedAt: now() - 8 * 86400, expiresAt: now() - 29 * 3600, banCount: 2, active: false },
];

/** Logins since the journal began: reading it takes a few seconds the first time. */
let loginsScanStart: number | null = null;
const LOGIN_IPS: Omit<LoginIps["ips"][number], "country" | "tailnet" | "countSince">[] = [
  { ip: "100.64.0.5", first: now() - 21 * 86400, last: now() - 600, count: 214, users: ["root"], methods: ["publickey (ED25519)"] },
  { ip: "198.51.100.23", first: now() - 160 * 86400, last: now() - 2 * 86400, count: 86, users: ["root"], methods: ["publickey (ED25519)"] },
  { ip: "198.51.100.24", first: now() - 240 * 86400, last: now() - 34 * 86400, count: 41, users: ["root"], methods: ["publickey (RSA)", "publickey (ED25519)"] },
  { ip: "100.64.0.12", first: now() - 19 * 86400, last: now() - 4 * 86400, count: 12, users: ["root"], methods: ["publickey (ED25519)"] },
  { ip: "198.51.100.140", first: now() - 200 * 86400, last: now() - 120 * 86400, count: 3, users: ["root", "deploy"], methods: ["publickey (RSA)"] },
];
/** Since when port 22 is closed: via "SSH from the internet → close", or ?closed in the address (2 h ago). */
let sshClosedAt: number | null = q.has("closed") ? now() - 2 * 3600 : null;

function loginIps(): LoginIps {
  loginsScanStart ??= Date.now();
  const complete = Date.now() - loginsScanStart > 8000;
  const since = sshClosedAt;
  const ips = (complete ? LOGIN_IPS : LOGIN_IPS.slice(0, 2))
    .filter((i) => has("tailscale") || !i.ip.startsWith("100.64."))
    .map((i) => {
      const country = geo(i.ip);
      // Spread roughly per IP: part of the logins happened after `since`.
      const countSince = since === null ? null : i.last < since ? 0 : Math.max(1, Math.round(i.count * Math.min(1, (i.last - since) / Math.max(1, i.last - i.first)) * 4));
      return { ...i, countSince: countSince === null ? null : Math.min(i.count, countSince), country, tailnet: country.name === "Tailnet" };
    });
  return { complete, firstDay: new Date((now() - 266 * 86400) * 1000).toISOString().slice(0, 10), since, ips };
}

const NET = "proxy-net";
const CONTAINERS: Container[] = [
  c("keepwatch-proxy-1", "jc21/nginx-proxy-manager:latest", 1.4, 182, ["0.0.0.0:80→80", "0.0.0.0:443→443", "127.0.0.1:9001→81"], [NET], "keepwatch", { module: "proxy" }),
  c("keepwatch-portainer-1", "portainer/portainer-ce:latest", 0.3, 41, ["127.0.0.1:9002→9000"], [NET], "keepwatch", { dockerSock: true, module: "portainer" }),
  c("web", "ghcr.io/example/web:latest", 0.1, 23, [], [NET], "web", { health: "healthy", user: "node" }),
  c("photos", "photos-photos", 0, 9, [], [NET], "photos", { health: "healthy" }),
  c("shop-frontend", "shop-frontend", 0.2, 96, [], [NET, "shop_default"], "shop", { health: "healthy", user: "nextjs" }),
  c("shop-api", "shop-api", 3.1, 412, [], [NET, "shop_default"], "shop", { health: "healthy", user: "app" }),
  c("shop-db", "postgres:16-alpine", 1.8, 1340, [], ["shop_default"], "shop", { health: "healthy" }),
  c("wiki", "ghcr.io/example/wiki:latest", 0, 48, [], [NET], "wiki", { health: "healthy", user: "node" }),
  c("blog-web", "blog-web", 0, 7, [], [NET, "blog_internal"], "blog", { health: "healthy", readOnly: true }),
  c("blog-app-1", "blog-app", 0.1, 31, [], ["blog_internal"], "blog", { readOnly: true, user: "app" }),
].filter((x): x is Container => x !== null);

function c(name: string, image: string, cpu: number, memMb: number, ports: string[], networks: string[], project: string, extra: Partial<Container> & { module?: ModuleId } = {}): Container | null {
  const { module, ...rest } = extra;
  if (module && !has(module)) return null;
  return {
    name,
    image,
    state: "running",
    status: "running",
    health: null,
    startedAt: now() - 1250,
    restartCount: 0,
    cpuPct: cpu,
    memUsed: memMb * 1024 * 1024,
    memLimit: 31 * GB,
    netRx: Math.round(memMb * 91_000),
    netTx: Math.round(memMb * 47_000),
    ports,
    networks,
    project,
    readOnly: false,
    user: null,
    privileged: false,
    dockerSock: false,
    ...rest,
  };
}

const ENV: Record<number, EnvVar[]> = {
  13: [
    { name: "POSTGRES_USER", value: "shop" },
    { name: "POSTGRES_PASSWORD", value: "x9Qe-3vLk-PmRt-77aa" },
    { name: "POSTGRES_DB", value: "shop" },
    { name: "PAYMENT_API_KEY", value: "example-not-a-real-key" },
    { name: "SMTP_HOST", value: "smtp.example.com" },
    { name: "IMAGE_TAG", value: "latest" },
  ],
  29: [
    { name: "IMAGE_TAG", value: "latest" },
    { name: "DATA_DIR", value: "/srv/data" },
    { name: "ADMIN_TOKEN", value: "adm_5c1f0e2b9a7d4e" },
  ],
  28: [
    { name: "APP_SECRET", value: "bl-8d1c77f0ab33" },
    { name: "ANALYTICS_URL", value: "https://blog.example.com/stats" },
  ],
  33: [],
  34: [],
};

const BACKUP_PATHS = ["/etc", "/root", "/opt", "/srv", "/var/lib/docker/volumes", "/var/lib/keepwatch", "/var/backups/db"];
let backupRun: { start: number; lines: string[] } | null = null;
let probe: Backups["probe"] = null;
let probeStart: number | null = null;
let lastRun: Backups["lastRun"] = { startedAt: now() - 12 * 3600, finishedAt: now() - 12 * 3600 + 214, ok: true, durationSec: 214 };
const snapshots: Backups["snapshots"] = [
  { id: "a3f9c2d1e8b74f06", time: now() - 12 * 3600, paths: BACKUP_PATHS, tags: ["daily"], target: "Local" },
  { id: "7be10c44d2a9e513", time: now() - 36 * 3600, paths: BACKUP_PATHS, tags: ["daily"], target: "Local" },
  { id: "e0c55a91f3b26d78", time: now() - 60 * 3600, paths: BACKUP_PATHS.slice(0, 5), tags: ["manual"], target: "Local" },
];

/* ---------- Settings & access ------------------------------------------------------------------ */

const MY_IPS = ["198.51.100.23"];
const REMOTE_REPO = "s3:https://s3.eu-central-1.amazonaws.com/example-backups/keep";

const settings: Settings = {
  backup: { schedule: "03:00", keepDaily: 7, keepWeekly: 4, keepMonthly: 6, remoteKeepDaily: 14, remoteKeepWeekly: 13, remoteKeepMonthly: 24, passwordSet: true },
  remote: FRESH
    ? { configured: false, name: "Remote", repo: null, env: [], rcloneConf: false, check: null }
    : { configured: true, name: "S3", repo: REMOTE_REPO, env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], rcloneConf: false, check: { ok: true, at: now() - 11 * 3600, message: "Repository reachable and readable (14 snapshots)." } },
  portainer: FRESH ? { tokenSet: false, connected: false, reason: "No access token yet." } : { tokenSet: true, connected: true, reason: null },
  fail2ban: { maxretry: 2, findtimeHours: 24, bantimeHours: 168, recidiveMaxretry: 2, recidiveFindtimeDays: 30, recidiveBantimeDays: 365, ignoreip: [] },
  updates: { autoReboot: true, rebootTime: "04:00" },
  myIps: MY_IPS,
  tailscale: FRESH
    ? { installed: true, state: "NeedsLogin", ip: null, dnsName: null, keyExpiry: null, loginUrl: null, urls: [], viaTailscale: q.has("ts") }
    : { installed: true, state: "Running", ip: "100.64.0.1", dnsName: "keep.tailnet.example", keyExpiry: now() + 170 * 86400, loginUrl: null, urls: [], viaTailscale: q.has("ts") },
  ssh: { public: !q.has("closed"), revertAt: null },
};

/** Tailscale login: after ~6 s the server counts as logged in. */
let tsLoginAt: number | null = null;

function tickTailscale() {
  const ts = settings.tailscale;
  if (tsLoginAt && Date.now() - tsLoginAt >= 6000 && ts.state !== "Running") {
    Object.assign(ts, { state: "Running", ip: "100.64.0.1", dnsName: "keep.tailnet.example", keyExpiry: now() + 170 * 86400, loginUrl: null, urls: [] });
    tsLoginAt = null;
  }
  if (settings.ssh.revertAt && now() >= settings.ssh.revertAt) settings.ssh = { public: true, revertAt: null };
}

const entry = (value: string, note = ""): AccessEntry => ({ value, note, addresses: addressCount(value) });

const noLock = (): AccessHost["pathLock"] => ({ paths: [], entries: [] });

const access: AccessHost[] = [
  {
    id: 3,
    domains: ["shop.example.com"],
    mode: "list",
    entries: [
      entry("198.51.100.128/25", "Office"),
      entry("198.51.100.23", "Home"),
      entry("198.51.100.24", "Home, before the new router"),
      entry("198.51.100.25"),
      entry("198.51.100.26"),
      entry("104.28.40.12", "iPhone"),
      entry("172.225.80.44", "iPad"),
    ],
    pathLock: noLock(),
  },
  { id: 7, domains: ["old.example.com"], mode: "open", entries: [], pathLock: noLock() },
  { id: 8, domains: ["blog.example.com"], mode: "open", entries: [], pathLock: noLock() },
  {
    id: 10,
    domains: ["example.com"],
    mode: "open",
    entries: [],
    pathLock: { paths: ["/admin"], entries: [entry("198.51.100.128/25", "Office"), entry("198.51.100.23", "Home")] },
  },
  {
    id: 11,
    domains: ["wiki.example.com"],
    mode: "list",
    entries: [entry("198.51.100.128/25", "Office"), entry("198.51.100.23", "Home"), entry("198.51.100.27"), entry("198.51.100.28")],
    pathLock: noLock(),
  },
  {
    id: 12,
    domains: ["photos.example.com"],
    mode: "list",
    entries: [entry("198.51.100.29", "Mom"), entry("198.51.100.30", "Alex"), entry("198.51.100.23", "Home")],
    pathLock: noLock(),
  },
];

const lockPaths = (id: number) => access.find((x) => x.id === id)?.pathLock.paths ?? [];
const allowCount = (id: number) => {
  const h = access.find((x) => x.id === id);
  return h && h.mode === "list" ? new Set(h.entries.map((e) => normalize(e.value))).size : 0;
};

/** Endpoint of a disabled module. */
const OFF = { enabled: false } as const;

/* ---------- Responses -------------------------------------------------------------------- */

function health(): Problem[] {
  const out: Problem[] = [];
  if (has("backup") && !settings.remote.configured)
    out.push({ level: "warn", area: "backups", key: "backup.remote-missing", target: "settings/backup-remote", title: "No off-site backup", detail: "Backups only go to the same disk as the data. Add an off-site restic repository in Settings." });
  if (has("portainer") && !settings.portainer.connected)
    out.push({ level: "warn", area: "stacks", key: "portainer.disconnected", target: "settings/portainer", title: "Portainer not connected", detail: "Without an access token, redeploys and environment variables don’t work." });
  return out;
}

function overview(): Overview {
  tickLive();
  const last = (a: number[]) => a[a.length - 1];
  return {
    host: { hostname: "keep", ip: "203.0.113.10", os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-85-generic", uptimeSec: now() - BOOT, bootTime: BOOT, cpus: 8, memTotal: 31.3 * GB },
    now: {
      cpu: last(live.cpu),
      load: [0.42 + rnd() * 0.3, 0.51, 0.47],
      mem: { total: 31.3 * GB, used: (last(live.mem) / 100) * 31.3 * GB, available: 31.3 * GB * (1 - last(live.mem) / 100) },
      swap: { total: 0, used: 0 },
      disks: [
        { mount: "/", total: 464 * GB, used: 71.4 * GB },
        { mount: "/boot", total: 0.88 * GB, used: 0.19 * GB },
      ],
      net: { rxBps: last(live.rx), txBps: last(live.tx) },
      procs: 312,
    },
    history: hist,
    live,
    updates: { pending: 0, security: 0, rebootRequired: false, lastUpgrade: now() - 3 * 3600, release: "Ubuntu 24.04.3 LTS", newRelease: "26.04 LTS" },
    health: [...health(), ...mockUpdateProblems(), ...mockCtProblems(), ...mockSecretProblems()],
  };
}

function security(): Security {
  const end = Math.floor(now() / 3600) * 3600;
  const t = Array.from({ length: 24 }, (_, i) => end - (23 - i) * 3600);
  const s0 = seed;
  seed = 11;
  const count = t.map(() => Math.round(150 + rnd() * 120 + (rnd() > 0.85 ? 260 : 0)));
  const banCount = t.map((_, i) => (i > 19 ? Math.round(rnd() * 3) : i === 23 ? 2 : 0));
  seed = s0;
  const f2b = has("fail2ban");
  const activeBan = (ip: string) => f2b && bans.some((b) => b.ip === ip && b.active);
  const webJails = has("proxy");
  const shownBans = bans.filter((b) => webJails || b.jail === "sshd");
  return {
    jails: f2b
      ? [
          { name: "sshd", currentlyFailed: 3, totalFailed: 412, currentlyBanned: bans.filter((b) => b.active && b.jail === "sshd").length, totalBanned: 9 },
          ...(webJails
            ? [
                { name: "web-scanner", currentlyFailed: 1, totalFailed: 96, currentlyBanned: bans.filter((b) => b.active && b.jail === "web-scanner").length, totalBanned: 14 },
                { name: "app-login", currentlyFailed: 0, totalFailed: 22, currentlyBanned: bans.filter((b) => b.active && b.jail === "app-login").length, totalBanned: 2 },
              ]
            : []),
          { name: "recidive", currentlyFailed: 0, totalFailed: 0, currentlyBanned: 0, totalBanned: 0 },
        ]
      : [],
    pastAttackers: has("ban-history") ? { active: true, banned: 1284, until: now() + 41 * 86400, builtAt: now() - 19 * 86400, dropped: 37, days: 60 } : OFF,
    bans: f2b ? shownBans.map((b) => ({ ...b, country: geo(b.ip) })) : [],
    sshAttempts: { t, count, total24h: count.reduce((a, b) => a + b, 0), uniqueIps24h: 141 },
    banHistory: (f2b ? { t, count: banCount, byKind: { ssh: banCount.map((n) => Math.ceil(n / 2)), web: banCount.map((n) => (webJails ? Math.floor(n / 2) : 0)), repeat: banCount.map(() => 0) } } : OFF) as Security["banHistory"],
    topIps: [
      { ip: "203.0.113.45", count: 2502, lastSeen: now() - 1520 },
      { ip: "192.0.2.14", count: 214, lastSeen: now() - 780 },
      { ip: "203.0.113.81", count: 190, lastSeen: now() - 1130 },
      { ip: "192.0.2.77", count: 129, lastSeen: now() - 3 * 3600 },
      { ip: "203.0.113.120", count: 87, lastSeen: now() - 440 },
      { ip: "192.0.2.165", count: 61, lastSeen: now() - 5400 },
      { ip: "192.0.2.201", count: 54, lastSeen: now() - 6 * 3600 },
      { ip: "203.0.113.77", count: 54, lastSeen: now() - 9 * 3600 },
      { ip: "203.0.113.121", count: 38, lastSeen: now() - 2 * 3600 },
      { ip: "192.0.2.64", count: 22, lastSeen: now() - 5 * 3600 },
    ].map((i) => ({ ...i, banned: activeBan(i.ip), country: geo(i.ip) })),
    logins: [
      { user: "root", ip: "100.64.0.5", at: now() - 600, method: "publickey (ED25519)" },
      { user: "root", ip: "100.64.0.5", at: now() - 640, method: "publickey (ED25519)" },
      { user: "root", ip: "100.64.0.5", at: now() - 700, method: "publickey (ED25519)" },
      { user: "root", ip: "100.64.0.5", at: now() - 3 * 3600, method: "publickey (ED25519)" },
      { user: "root", ip: "100.64.0.5", at: now() - 3 * 3600 - 90, method: "publickey (ED25519)" },
      { user: "root", ip: "100.64.0.12", at: now() - 4 * 86400, method: "publickey (ED25519)" },
      { user: "root", ip: "198.51.100.23", at: now() - 2 * 86400, method: "publickey (ED25519)" },
      { user: "root", ip: "198.51.100.23", at: now() - 2 * 86400 - 3600, method: "publickey (ED25519)" },
    ]
      .filter((l) => has("tailscale") || !l.ip.startsWith("100.64."))
      .sort((a, b) => b.at - a.at)
      .map((l) => ({ ...l, country: geo(l.ip) })),
    countries24h: countries(1),
    ports: [
      { proto: "tcp" as const, addr: "0.0.0.0", port: 22, process: "sshd", exposure: "public" as const },
      ...(has("proxy")
        ? [
            { proto: "tcp" as const, addr: "0.0.0.0", port: 80, process: "docker-proxy (nginx-proxy-manager)", exposure: "public" as const },
            { proto: "tcp" as const, addr: "0.0.0.0", port: 443, process: "docker-proxy (nginx-proxy-manager)", exposure: "public" as const },
            { proto: "tcp" as const, addr: "127.0.0.1", port: 9001, process: "docker-proxy (Proxy Manager admin)", exposure: "local" as const },
          ]
        : []),
      ...(has("portainer") ? [{ proto: "tcp" as const, addr: "127.0.0.1", port: 9002, process: "docker-proxy (Portainer)", exposure: "local" as const }] : []),
      { proto: "tcp" as const, addr: "127.0.0.1", port: 9004, process: "keepwatch-dashboard", exposure: "local" as const },
      ...(has("tailscale") ? [{ proto: "udp" as const, addr: "0.0.0.0", port: 41641, process: "tailscaled", exposure: "internal" as const }] : []),
      { proto: "udp" as const, addr: "127.0.0.53", port: 53, process: "systemd-resolved", exposure: "local" as const },
    ],
    firewall: (has("firewall") ? { enabled: true, allowedTcp: [22, ...(has("proxy") ? [80, 443] : [])], dockerUserActive: has("docker") ? true : null } : OFF) as Security["firewall"],
    audit: (has("auditd")
      ? {
          enabled: true,
          total24h: 14,
          byKey: [
            { key: "services", count: 6 },
            { key: "fail2ban", count: 3 },
            { key: "ssh", count: 2 },
            { key: "firewall", count: 2 },
            { key: "docker", count: 1 },
          ],
          recent: [
            { at: now() - 900, key: "fail2ban", exe: "/usr/bin/python3.12", path: "/etc/fail2ban/jail.d/keepwatch.local" },
            { at: now() - 1800, key: "services", exe: "/usr/bin/systemctl", path: "/etc/systemd/system/keepwatch-dashboard.service" },
            { at: now() - 2400, key: "services", exe: "/usr/bin/rm", path: "/etc/systemd/system/old-tunnel.service" },
            { at: now() - 4000, key: "ssh", exe: "/usr/bin/vim.basic", path: "/root/.ssh/authorized_keys" },
          ],
        }
      : OFF) as Security["audit"],
  };
}

function docker(): Docker {
  for (const ct of CONTAINERS) {
    if (ct.state === "running" && ct.cpuPct !== null) ct.cpuPct = Math.max(0, ct.cpuPct + (rnd() - 0.5) * 0.6);
  }
  return { containers: CONTAINERS, disk: { images: 6.8 * GB, containers: 0.21 * GB, volumes: 10.4 * GB, buildCache: 2.3 * GB } };
}

const repo = (name: string) => ({ url: `https://github.com/example/${name}`, ref: "refs/heads/main" });

function stacks(): Stacks {
  const infra = CONTAINERS.filter((x) => x.project === "keepwatch").map((x) => x.name);
  return {
    portainer: { connected: settings.portainer.connected, reason: settings.portainer.reason },
    stacks: [
      { id: 13, name: "shop", source: "git", git: repo("shop"), autoUpdate: null, containers: ["shop-frontend", "shop-api", "shop-db"], envCount: ENV[13].length, updatedAt: now() - 2 * 86400, updatedBy: "admin", managed: true },
      { id: 29, name: "web", source: "git", git: repo("web"), autoUpdate: null, containers: ["web"], envCount: ENV[29].length, updatedAt: now() - 7 * 86400, updatedBy: "admin", managed: true },
      { id: 28, name: "blog", source: "git", git: repo("blog"), autoUpdate: null, containers: ["blog-web", "blog-app-1"], envCount: ENV[28].length, updatedAt: now() - 12 * 86400, updatedBy: "admin", managed: true },
      { id: 33, name: "wiki", source: "git", git: repo("wiki"), autoUpdate: "5m", containers: ["wiki"], envCount: 0, updatedAt: now() - 57 * 86400, updatedBy: "admin", managed: true },
      { id: 34, name: "photos", source: "git", git: repo("photos"), autoUpdate: null, containers: ["photos"], envCount: 0, updatedAt: now() - 20 * 86400, updatedBy: "admin", managed: true },
      { id: null, name: "keepwatch", source: "compose", git: null, autoUpdate: null, containers: infra, envCount: null, updatedAt: null, updatedBy: null, managed: false },
    ],
  };
}

/** Days until expiry per site (from page load); "Renew" sets it to 90. */
const certDays: Record<number, number> = { 10: 61, 7: 44, 8: 17, 3: 73, 11: 5, 12: 80 };
const SITE_NAME: Record<number, string> = { 10: "example.com", 7: "old.example.com", 8: "blog.example.com", 3: "shop.example.com", 11: "wiki.example.com", 12: "photos.example.com" };
const renewCount: Record<number, number> = {};
const dmy = (days: number) => fmtDate(now() + days * 86400, { day: "numeric", month: "short", year: "numeric" });

function sites(): Sites {
  const d = (id: number) => ({ expiresAt: now() + certDays[id] * 86400, daysLeft: certDays[id], issuer: id % 2 ? "Let's Encrypt E7" : "Let's Encrypt E8" });
  const site = (id: number, target: string, check: { code: number; ms: number }, traffic: [number, number, number, number], extra: { hsts?: boolean } = {}) => ({
    id,
    domains: [SITE_NAME[id]],
    target,
    enabled: true,
    sslForced: true,
    hsts: extra.hsts ?? true,
    allowlist: allowCount(id),
    pathLock: lockPaths(id),
    cert: d(id),
    check,
    requests24h: traffic[0],
    errors4xx24h: traffic[1],
    errors5xx24h: traffic[2],
    blocked24h: traffic[3],
  });
  return {
    defaultSite: "444",
    sites: [
      site(10, "web:3000", { code: 200, ms: 38 }, [18_240, 412, 0, 96]),
      site(7, "web:3000", { code: 404, ms: 41 }, [183, 183, 0, 0]),
      site(8, "blog-web:8080", { code: 200, ms: 54 }, [3_120, 288, 2, 155]),
      site(3, "shop-frontend:3000", { code: 403, ms: 12 }, [410, 390, 0, 371], { hsts: false }),
      site(11, "wiki:3000", { code: 403, ms: 9 }, [77, 70, 0, 70]),
      site(12, "photos:8080", { code: 403, ms: 8 }, [23, 23, 0, 23]),
      ...mockNewSites(), // created by the "New site" wizard (mock-hosts.ts)
    ],
  };
}

const RUN_LINES = [
  "Backup started (manual)",
  "pg_dump shop-db → /var/backups/db/shop.dump",
  "pg_dump done: 1.38 GB in 41 s",
  "sqlite3 .backup wiki → wiki.db",
  "sqlite3 .backup nginx-proxy-manager → database.sqlite",
  "restic backup (local) …",
  "Files:         412 new,  1904 changed, 38211 unmodified",
  "Added to the repository: 214.522 MiB (61.208 MiB stored)",
  "snapshot 5d2e91ac saved",
  "restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune",
  "restic copy → off-site …",
  "Backup finished",
];

function backups(): Backups {
  let running = false;
  let log: string[] = [];
  const lines = settings.remote.configured ? RUN_LINES : RUN_LINES.map((l) => (l.startsWith("restic copy") ? "No off-site repository – skipped" : l));
  if (backupRun) {
    const elapsed = (Date.now() - backupRun.start) / 1000;
    const k = Math.min(lines.length, Math.floor(elapsed / 0.85) + 1);
    log = lines.slice(0, k).map((l, i) => `${fmtDate(Math.floor((backupRun!.start + i * 850) / 1000), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}  ${l}`);
    running = elapsed < 10.5;
    if (!running) {
      const startedAt = Math.floor(backupRun.start / 1000);
      lastRun = { startedAt, finishedAt: now(), ok: true, durationSec: now() - startedAt };
      snapshots.unshift({ id: "5d2e91ac7f0b3e44", time: now(), paths: snapshots[0].paths, tags: ["manual"], target: "Local" });
      backupRun = null;
    } else {
      lastRun = { startedAt: Math.floor(backupRun.start / 1000), finishedAt: null, ok: null, durationSec: null };
    }
  } else {
    log = lines.map((l, i) => `03:00:${String(10 + i * 4)}  ${l.replace("manual", "scheduled")}`);
  }
  const tomorrow = new Date();
  tomorrow.setHours(27, 0, 0, 0);
  const r = settings.remote;
  return {
    targets: [
      { name: "Local", kind: "local", configured: true, location: "/var/backups/keepwatch/restic", snapshots: snapshots.length, size: 3.62 * GB, lastSnapshot: snapshots[0].time },
      r.configured
        ? { name: r.name, kind: "remote", configured: true, location: r.repo ?? "", snapshots: 14, size: 3.58 * GB, lastSnapshot: r.check?.at ?? now() }
        : { name: r.name, kind: "remote", configured: false, location: "", snapshots: 0, size: null, lastSnapshot: null },
    ],
    running,
    lastRun,
    nextRun: Math.floor(tomorrow.getTime() / 1000) - 86400 > now() ? Math.floor(tomorrow.getTime() / 1000) - 86400 : Math.floor(tomorrow.getTime() / 1000),
    snapshots,
    log,
    probe: probe ?? { at: now() - 3 * 86400, running: false, ok: true, durationSec: 184 },
    probeNext: now() + 4 * 86400,
  };
}

const LOG_SAMPLES: Record<string, [string, "stdout" | "stderr"][]> = {
  "keepwatch-proxy-1": [
    ["[10/23/2026] [3:43:52 PM] [Global   ] › ℹ  info      Using Sqlite: /data/database.sqlite", "stdout"],
    ["[10/23/2026] [3:43:53 PM] [Migrate  ] › ℹ  info      Current database version: none", "stdout"],
    ["[10/23/2026] [3:43:54 PM] [Setup    ] › ℹ  info      Logrotate completed.", "stdout"],
    ["[10/23/2026] [3:43:54 PM] [IP Ranges] › ℹ  info      Fetching IP Ranges from online services...", "stdout"],
    ["[10/23/2026] [3:43:56 PM] [Global   ] › ⬤  debug     Backend PID 165 listening on port 3000 ...", "stdout"],
    ["2026/10/23 16:14:22 [error] 249#249: *220 access forbidden by rule, client: 192.0.2.94, server: wiki.example.com", "stderr"],
  ],
  "shop-api": [
    ["INFO:     Started server process [1]", "stdout"],
    ["INFO:     Application startup complete.", "stdout"],
    ["INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)", "stdout"],
    ["worker: payment webhook retry 2/5 for order 10482", "stderr"],
    ["worker: 214 orders synced, 3 price changes", "stdout"],
    ["INFO:     10.0.7.5:51234 - \"GET /api/health HTTP/1.1\" 200 OK", "stdout"],
  ],
};
const GENERIC: [string, "stdout" | "stderr"][] = [
  ["Listening on port 3000", "stdout"],
  ["GET / 200 4ms", "stdout"],
  ["GET /healthz 200 1ms", "stdout"],
  ["GET /favicon.ico 404 1ms", "stdout"],
  ["warn: slow response (812 ms) on /api/list", "stderr"],
];

function logs(name: string, since: number | null, tail: number): { lines: LogLine[] } {
  const sample = LOG_SAMPLES[name] ?? GENERIC;
  if (since) {
    const n = rnd() > 0.4 ? 1 + Math.floor(rnd() * 2) : 0;
    return { lines: Array.from({ length: n }, (_, i) => { const [text, stream] = sample[Math.floor(rnd() * sample.length)]; return { t: now() + i * 0.001, stream, text }; }) };
  }
  const start = now() - 1200;
  const n = Math.min(tail, 120);
  return {
    lines: Array.from({ length: n }, (_, i) => {
      const [text, stream] = sample[i % sample.length];
      return { t: start + i * 9, stream, text };
    }),
  };
}

/** Which module an endpoint belongs to (disabled → {"enabled": false}). */
const ENDPOINT_MODULE: [RegExp, ModuleId][] = [
  [/^\/api\/(docker|containers|logs|cleanup)\b/, "docker"],
  [/^\/api\/stacks\b/, "portainer"],
  [/^\/api\/settings\/portainer\b/, "portainer"],
  [/^\/api\/(sites|access|hosts|sitegrade|uptime|ctwatch|nginx|settings\/npm)\b/, "proxy"],
  [/^\/api\/backups\b|^\/api\/settings\/(backup|remote)\b/, "backup"],
  [/^\/api\/logarchive\b/, "log-archive"],
  [/^\/api\/lynis\//, "lynis"],
  [/^\/api\/secrets\b/, "portainer"],
  [/^\/api\/settings\/tailscale\b/, "tailscale"],
  [/^\/api\/settings\/fail2ban\b|^\/api\/security\/unban\b/, "fail2ban"],
  [/^\/api\/settings\/updates\b/, "auto-updates"],
  [/^\/api\/updates\/scan\b/, "image-scan"],
  [/^\/api\/updates\//, "docker"],
];

/* ---------- Router ------------------------------------------------------------------------- */

export async function mockRequest(method: string, path: string, body: unknown): Promise<unknown> {
  await wait(method === "GET" ? 120 + rnd() * 160 : 500 + rnd() * 500);
  const url = new URL(path, location.origin);
  const p = url.pathname;
  // Like the backend: endpoints of a disabled module answer 404 (lynis and updates: { enabled: false }).
  const off = ENDPOINT_MODULE.find(([re, m]) => re.test(p) && !has(m));
  if (off) throw new Error(`The ${off[1]} module is not enabled (KW_MODULES in keepwatch.conf).`);
  if (method === "GET" && ((p === "/api/lynis" && !has("lynis")) || (p === "/api/updates" && !has("docker")))) return OFF;
  const tl = mockTimeline(method, url); // timeline: mock-timeline.ts
  if (tl !== NOT_TIMELINE) return tl;
  const upd = await mockUpdates(method, p, body); // updates & cleanup: mock-updates.ts
  if (upd !== undefined) return upd;
  const nh = await mockHosts(method, url, body, { containers: CONTAINERS, sites: () => sites().sites, access, myIps: MY_IPS }); // new site: mock-hosts.ts
  if (nh !== NOT_MINE) return nh;
  const sg = await mockSiteGrade(method, p, body, () => sites().sites); // security grade: mock-sitegrade.ts
  if (sg !== undefined) return sg;
  const ct = mockCtWatch(method, p, body); // certificate watch: mock-ctwatch.ts
  if (ct !== undefined) return ct;
  const sc = mockSecrets(method, p, body); // secrets check: mock-secrets.ts
  if (sc !== undefined) return sc;
  const ly = mockLynis(method, p); // hardening audit: mock-lynis.ts
  if (ly !== undefined) return ly;
  const up = mockUptime(method, url, () => sites().sites); // uptime: mock-uptime.ts
  if (up !== undefined) return up;
  const la = await mockLogArchive(method, url, body); // log archive: mock-logarchive.ts
  if (la !== undefined) return la;
  if (method === "GET" && p === "/api/logs") return mockLogs(url); // live logs: mock-logs.ts
  if (method === "GET" && p === "/api/security/ip") {
    const sec = security();
    return mockIp(url.searchParams.get("ip") ?? "", { banned: sec.bans.filter((b) => b.active), top: sec.topIps, logins: sec.logins, geo });
  }
  if (method === "GET") {
    if (p === "/api/overview") return overview();
    if (p === "/api/security") return security();
    if (p.startsWith("/api/security/history")) {
      const n = Number(url.searchParams.get("days")) || 266;
      const days = Array.from({ length: n }, (_, i) => {
        const t = Math.floor(Date.now() / 1000 / 86400 - (n - 1 - i)) * 86400;
        const attempts = Math.round(3500 + 2500 * Math.sin(i / 5) + Math.random() * 1500);
        return { day: new Date(t * 1000).toISOString().slice(0, 10), t, attempts, uniqueIps: Math.round(attempts / 35), bans: has("fail2ban") && n - i < 36 ? Math.round(Math.random() * 60) : null };
      });
      const total = days.reduce((a, d) => a + (d.attempts ?? 0), 0);
      return {
        firstDay: days[0].day,
        building: false,
        days,
        total: { attempts: total, uniqueIps: Math.round(160 * Math.sqrt(n) * 4), bans: has("fail2ban") ? 1605 : null },
        topIps: [
          { ip: "203.0.113.45", count: Math.round(total * 0.11), banned: true },
          { ip: "203.0.113.81", count: Math.round(total * 0.012), banned: true },
          { ip: "203.0.113.151", count: Math.round(total * 0.007), banned: false },
          { ip: "203.0.113.77", count: Math.round(total * 0.006), banned: false },
          { ip: "192.0.2.201", count: Math.round(total * 0.005), banned: true },
          { ip: "192.0.2.165", count: Math.round(total * 0.003), banned: false },
        ].map((i) => ({ ...i, banned: has("fail2ban") && i.banned, country: geo(i.ip) })),
        countries: countries(n * 0.9),
      } satisfies SecurityHistory;
    }
    if (p === "/api/security/logins") return loginIps();
    if (p === "/api/docker") return docker();
    if (p === "/api/stacks") return stacks();
    if (p === "/api/sites") return sites();
    if (p === "/api/backups") return backups();
    let m = p.match(/^\/api\/containers\/([^/]+)\/logs$/);
    if (m) return logs(decodeURIComponent(m[1]), url.searchParams.get("since") ? Number(url.searchParams.get("since")) : null, Number(url.searchParams.get("tail") ?? 300));
    m = p.match(/^\/api\/stacks\/(\d+)\/env$/);
    if (m) return { env: ENV[Number(m[1])] ?? [] };
    if (p === "/api/settings") {
      tickTailscale();
      // Like the backend: sections of disabled modules are { enabled: false }.
      const s = structuredClone(settings) as unknown as Record<string, unknown>;
      const sect = (k: string, ok: boolean) => (s[k] = ok ? { enabled: true, ...(s[k] as object) } : OFF);
      sect("backup", has("backup"));
      if (!has("backup")) s.remote = OFF;
      sect("portainer", has("portainer"));
      sect("fail2ban", has("fail2ban"));
      if (has("fail2ban") && !has("tailscale")) (s.fail2ban as Settings["fail2ban"]).maxretry = null;
      sect("updates", has("auto-updates"));
      sect("tailscale", has("tailscale"));
      sect("ssh", has("firewall") && has("tailscale"));
      return s;
    }
    if (p === "/api/access") return { myIps: MY_IPS, hosts: structuredClone(access) } satisfies Access;
  }
  if (method === "POST") {
    if (p === "/api/security/unban") {
      const { ip } = body as { ip: string };
      const b = bans.find((x) => x.ip === ip && x.active);
      if ((body as { jail?: string }).jail === "ban-history") return { ok: true };
      if (!b) throw new Error(`${ip} is not banned.`);
      b.active = false;
      b.expiresAt = now();
      return { ok: true };
    }
    if (p === "/api/sites/renew-due") {
      await wait(3000);
      const due = Object.keys(certDays).map(Number).filter((id) => certDays[id] < 30);
      due.forEach((id) => (certDays[id] = 90));
      return { ok: true, renewed: due.length, message: due.length ? `Renewed ${due.length} certificate${due.length === 1 ? "" : "s"}.` : "No certificate is due (all valid for more than 30 days)." };
    }
    const r = p.match(/^\/api\/sites\/(\d+)\/renew$/);
    if (r) {
      const id = Number(r[1]);
      if (!(id in certDays)) throw new Error("This site has no certificate.");
      await wait(4000);
      const force = (body as { force?: boolean })?.force ?? true;
      renewCount[id] = (renewCount[id] ?? 0) + 1;
      if (renewCount[id] > 5) throw new Error("Renewal failed: too many certificates (5) already issued for this exact set of identifiers in the last 168h");
      if (!force && certDays[id] >= 30) return { ok: true, renewed: false, message: `${SITE_NAME[id]}: not due yet (valid until ${dmy(certDays[id])}).`, expiresAt: now() + certDays[id] * 86400, daysLeft: certDays[id] };
      certDays[id] = 90;
      return { ok: true, renewed: true, message: `${SITE_NAME[id]}: new certificate, valid until ${dmy(90)}.`, expiresAt: now() + 90 * 86400, daysLeft: 90 };
    }
    if (p === "/api/backups/probe") {
      probeStart = Date.now();
      probe = { at: now(), running: true, ok: null, durationSec: null };
      setTimeout(() => (probe = { at: Math.floor(probeStart! / 1000), running: false, ok: true, durationSec: 9 }), 9000);
      return { ok: true };
    }
    if (p === "/api/backups/run") {
      if (backupRun) throw new Error("A backup is already running.");
      backupRun = { start: Date.now(), lines: [] };
      return { ok: true };
    }
    let m = p.match(/^\/api\/containers\/([^/]+)\/(start|stop|restart)$/);
    if (m) {
      const ct = CONTAINERS.find((x) => x.name === decodeURIComponent(m![1]));
      if (!ct) throw new Error("No such container.");
      ct.state = m[2] === "stop" ? "exited" : "running";
      ct.status = m[2] === "stop" ? "exited (code 0)" : "running";
      ct.startedAt = m[2] === "stop" ? ct.startedAt : now();
      ct.cpuPct = m[2] === "stop" ? null : 0.4;
      ct.memUsed = m[2] === "stop" ? null : ct.memUsed ?? 30 * 1024 * 1024;
      return { ok: true };
    }
    m = p.match(/^\/api\/stacks\/(\d+)\/redeploy$/);
    if (m) {
      if (!settings.portainer.connected) throw new Error("Portainer is not connected – add the access token in Settings first.");
      await wait(1500);
      return { ok: true };
    }
    if (p === "/api/settings/tailscale/login") {
      if (!settings.tailscale.installed) throw new Error("Tailscale is not installed on the server.");
      tsLoginAt = Date.now();
      settings.tailscale.state = "NeedsLogin";
      settings.tailscale.loginUrl = "https://login.tailscale.com/a/1f3e9c2b7d4a";
      return { loginUrl: settings.tailscale.loginUrl };
    }
    if (p === "/api/settings/ssh/confirm") {
      if (!settings.ssh.revertAt) throw new Error("No countdown is running.");
      settings.ssh.revertAt = null;
      return { ok: true };
    }
    if (p === "/api/settings/backup/password") return { password: "example-password-not-real" };
    if (p === "/api/settings/remote/test") {
      if (!settings.remote.configured) throw new Error("No off-site repository is set up.");
      await wait(1200);
      settings.remote.check = { ok: true, at: now(), message: "Repository reachable and readable (14 snapshots)." };
      return { ok: true, message: settings.remote.check.message };
    }
  }
  if (method === "PUT") {
    let m = p.match(/^\/api\/stacks\/(\d+)\/env$/);
    if (m) {
      if (!settings.portainer.connected) throw new Error("Portainer is not connected – add the access token in Settings first.");
      ENV[Number(m[1])] = (body as { env: EnvVar[] }).env;
      await wait(1500);
      return { ok: true };
    }
    if (p === "/api/settings/backup") {
      Object.assign(settings.backup, body as Partial<Settings["backup"]>);
      return { ok: true };
    }
    if (p === "/api/settings/remote") {
      const { repo, name, env, rcloneConf } = body as RemoteRepoInput;
      await wait(1800);
      const url = repo?.trim() ?? "";
      if (!/^((s3|b2|sftp|rest|rclone|azure|gs|swift):\S+|\/\S+)$/.test(url)) throw new Error("That doesn’t look like a restic repository (e.g. s3:https://…, b2:bucket:path, sftp:user@host:/path).");
      const vars = env ?? [];
      if (vars.some((v) => !/^[A-Z][A-Z0-9_]*$/.test(v.name))) throw new Error("Variable names use A–Z, 0–9 and _ (e.g. AWS_ACCESS_KEY_ID).");
      const missing = vars.filter((v) => !v.value && !settings.remote.env.includes(v.name));
      if (missing.length) throw new Error(`No value for ${missing.map((v) => v.name).join(", ")}.`);
      if (vars.some((v) => v.value === "wrong")) throw new Error("restic can’t open the repository: access denied (check the credentials).");
      const type = url.split(":")[0];
      const derived = ({ s3: "S3", b2: "Backblaze B2", sftp: "SFTP", rest: "REST server", rclone: "rclone", azure: "Azure", gs: "Google Cloud Storage", swift: "Swift" } as Record<string, string>)[type] ?? "Remote";
      settings.remote = {
        configured: true,
        name: name?.trim() || derived,
        repo: url.replace(/\/\/[^/@]+@/, "//***@"),
        env: vars.map((v) => v.name),
        rcloneConf: settings.remote.rcloneConf || !!rcloneConf,
        check: { ok: true, at: now(), message: "Connected, repository initialized." },
      };
      return { ok: true, message: "Off-site repository saved. The first off-site copy is running – the first one takes a few minutes." };
    }
    if (p === "/api/settings/portainer") {
      const { token } = body as { token: string };
      await wait(900);
      if (!token.startsWith("ptr_")) {
        settings.portainer = { tokenSet: true, connected: false, reason: "Portainer rejected the token (401 Unauthorized)." };
        throw new Error("Portainer rejected the token (401). Tokens start with “ptr_”.");
      }
      settings.portainer = { tokenSet: true, connected: true, reason: null };
      return { ok: true };
    }
    if (p === "/api/settings/fail2ban") {
      Object.assign(settings.fail2ban, body as Partial<Settings["fail2ban"]>);
      return { ok: true };
    }
    if (p === "/api/settings/ssh") {
      const { public: pub } = body as { public: boolean };
      tickTailscale();
      if (pub) {
        settings.ssh = { public: true, revertAt: null };
        sshClosedAt = null;
        return { ok: true };
      }
      if (!has("tailscale")) throw new Error("Closing port 22 needs the tailscale module – otherwise you can’t get back in.");
      if (settings.tailscale.state !== "Running") throw new Error("Log the server in to Tailscale first – otherwise you can’t get back in after closing port 22.");
      if (!settings.tailscale.viaTailscale) throw new Error("This request came through the SSH tunnel from the internet. Open the dashboard via Tailscale before closing port 22.");
      settings.ssh = { public: false, revertAt: now() + 600 };
      sshClosedAt = now();
      return { ok: true };
    }
    if (p === "/api/settings/updates") {
      Object.assign(settings.updates, body as Partial<Settings["updates"]>);
      return { ok: true };
    }
    m = p.match(/^\/api\/access\/(\d+)\/paths$/);
    if (m) {
      const h = access.find((x) => x.id === Number(m![1]));
      if (!h) throw new Error("No such host.");
      const { paths, entries } = body as { paths: string[]; entries: { value: string; note: string }[] };
      const bad = paths.find((x) => !/^\/[A-Za-z0-9/_.-]+$/.test(x));
      if (bad) throw new Error(`“${bad}” is not a valid path (e.g. /admin or /api/admin/).`);
      if (paths.length && !entries.length) throw new Error("An empty list would lock these paths for everyone – including you.");
      await wait(700);
      const seen = new Map<string, AccessEntry>();
      for (const e of entries) if (!seen.has(normalize(e.value))) seen.set(normalize(e.value), entry(normalize(e.value), e.note));
      h.pathLock = { paths: [...new Set(paths)], entries: [...seen.values()] };
      return { ok: true };
    }
    m = p.match(/^\/api\/access\/(\d+)$/);
    if (m) {
      const h = access.find((x) => x.id === Number(m![1]));
      if (!h) throw new Error("No such host.");
      const { mode, entries } = body as { mode: AccessHost["mode"]; entries: { value: string; note: string }[] };
      if (mode === "list" && entries.length === 0) throw new Error("An empty list would lock everyone out – add at least one address or set it to open.");
      await wait(700);
      const seen = new Map<string, AccessEntry>();
      for (const e of mode === "open" ? [] : entries) {
        const v = normalize(e.value);
        const prev = seen.get(v);
        if (prev) prev.note = prev.note || e.note;
        else seen.set(v, entry(v, e.note));
      }
      h.mode = mode;
      h.entries = [...seen.values()];
      return { ok: true };
    }
  }
  if (method === "DELETE") {
    if (p === "/api/settings/remote") {
      settings.remote = { configured: false, name: "Remote", repo: null, env: [], rcloneConf: false, check: null };
      return { ok: true };
    }
  }
  throw new Error(`The mock doesn’t know ${method} ${p}.`);
}
