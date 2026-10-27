/**
 * Backend responses – exactly as in dashboard/API.md.
 * Sections of disabled modules arrive as `{ enabled: false }` (objects) or empty lists. The UI gates
 * them with `has(<module>)` from config.tsx before reading them, so the types below describe the
 * enabled shape; `enabled?: true` marks such sections.
 */

/** A section of a disabled module. */
export interface Off {
  enabled: false;
}

/** The section, or null when its module is off (`{ enabled: false }`) or it is missing. */
export function on<T extends object>(x: T | Off | null | undefined): T | null {
  return x && !("enabled" in x && (x as { enabled?: unknown }).enabled === false) ? (x as T) : null;
}

export type Area = "security" | "docker" | "sites" | "backups" | "system" | "stacks";

export interface Problem {
  level: "crit" | "warn";
  area: Area;
  title: string;
  detail: string;
  /** Stable id, e.g. "backup.remote-missing" (table in API.md under /api/overview). */
  key: string;
  /** Settings row that fixes it: "settings/<row>" (rows: see SettingRow in pages/settingsOpen.ts). */
  target?: string;
}

export interface Overview {
  host: { hostname: string; ip: string; os: string; kernel: string; uptimeSec: number; bootTime: number; cpus: number; memTotal: number };
  now: {
    cpu: number;
    load: [number, number, number];
    mem: { total: number; used: number; available: number };
    swap: { total: number; used: number };
    disks: { mount: string; total: number; used: number }[];
    net: { rxBps: number; txBps: number };
    procs: number;
  };
  history: { t: number[]; cpu: number[]; mem: number[]; rx: number[]; tx: number[]; load1: number[] };
  live: { t: number[]; cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
  updates: { pending: number; security: number; rebootRequired: boolean; lastUpgrade: number | null; release: string; newRelease: string | null };
  health: Problem[];
}

/** Country of an IP (looked up locally in DB-IP). `cc` is null for tailnet, internal, unknown. */
export interface Country {
  cc: string | null;
  name: string;
}

export interface CountryCount {
  cc: string | null;
  name: string;
  attempts: number;
  ips: number;
}

export type BanKind = "ssh" | "web" | "repeat";

export interface Security {
  jails: { name: string; currentlyFailed: number; totalFailed: number; currentlyBanned: number; totalBanned: number }[];
  /** Ban history: past SSH attackers banned again on every boot (module ban-history), null = status unreadable. */
  pastAttackers?: { active: boolean; banned: number; until: number | null; builtAt?: number | null; dropped: number; days?: number; released?: number } | Off | null;
  bans: { ip: string; jail: string; bannedAt: number; expiresAt: number | null; banCount: number; active: boolean; country: Country }[];
  sshAttempts: { t: number[]; count: number[]; total24h: number; uniqueIps24h: number };
  /** byKind: bans per kind (ssh = SSH jails, web = web scanners + admin logins, repeat = recidive) */
  banHistory: { enabled?: true; t: number[]; count: number[]; byKind?: Record<BanKind, number[]> };
  topIps: { ip: string; count: number; lastSeen: number; banned: boolean; country: Country }[];
  logins: { user: string; ip: string; at: number; method: string; country: Country }[];
  countries24h: CountryCount[];
  ports: { proto: "tcp" | "udp"; addr: string; port: number; process: string; exposure: "public" | "local" | "internal" }[];
  firewall: { enabled?: true; allowedTcp: number[]; dockerUserActive: boolean | null };
  audit: {
    enabled?: true;
    total24h: number;
    byKey: { key: string; count: number }[];
    recent: { at: number; key: string; exe: string | null; path: string | null }[];
  };
}

export type ContainerState = "running" | "exited" | "restarting" | "paused" | "created" | "dead";

export interface Container {
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  startedAt: number | null;
  restartCount: number;
  cpuPct: number | null;
  memUsed: number | null;
  memLimit: number | null;
  netRx: number | null;
  netTx: number | null;
  ports: string[];
  networks: string[];
  project: string | null;
  readOnly: boolean;
  user: string | null;
  privileged: boolean;
  dockerSock: boolean;
}

export interface Docker {
  containers: Container[];
  disk: { images: number; containers: number; volumes: number; buildCache: number };
}

export interface LogLine {
  t: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface Stack {
  id: number | null;
  /** Portainer environment of the stack (links into Portainer); null when unknown. */
  endpointId: number | null;
  name: string;
  source: "git" | "file" | "compose";
  git: { url: string; ref: string } | null;
  autoUpdate: string | null;
  containers: string[];
  envCount: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
  managed: boolean;
}

export interface Stacks {
  portainer: { connected: boolean; reason: string | null };
  stacks: Stack[];
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface Site {
  id: number;
  domains: string[];
  target: string;
  enabled: boolean;
  sslForced: boolean;
  hsts: boolean;
  allowlist: number;
  /** Paths locked to the admin allow-list (empty = none) */
  pathLock?: string[];
  cert: { expiresAt: number; daysLeft: number; issuer: string } | null;
  check: { code: number; ms: number } | null;
  requests24h: number;
  errors4xx24h: number;
  errors5xx24h: number;
  blocked24h: number;
}

export interface Sites {
  defaultSite: string;
  sites: Site[];
}

export interface Backups {
  enabled?: true;
  /** The local target is always named "Local"; the remote one has the repository's display name. */
  targets: { name: string; kind: "local" | "remote"; configured: boolean; location: string; snapshots: number; size: number | null; lastSnapshot: number | null }[];
  running: boolean;
  lastRun: { startedAt: number; finishedAt: number | null; ok: boolean | null; durationSec: number | null } | null;
  nextRun: number | null;
  /** target = "Local" or the remote's name */
  snapshots: { id: string; time: number; paths: string[]; tags: string[]; target: string }[];
  log: string[];
  /** Self-test (test restore of the latest snapshot). */
  probe?: { at: number; running: boolean; ok: boolean | null; durationSec: number | null } | null;
  probeNext?: number | null;
}

/* ---------- Settings ------------------------------------------------------------------ */

export interface Settings {
  /** keep*: local, remoteKeep*: off-site – set separately, off-site ≥ local per tier. */
  backup: {
    enabled?: true;
    schedule: string; keepDaily: number; keepWeekly: number; keepMonthly: number;
    remoteKeepDaily: number; remoteKeepWeekly: number; remoteKeepMonthly: number; passwordSet: boolean;
  };
  remote: RemoteRepo;
  portainer: { enabled?: true; tokenSet: boolean; connected: boolean; reason: string | null };
  fail2ban: {
    enabled?: true;
    /** Failed SSH logins from the internet before a ban (jail sshd; KW_F2B_SSH_MAXRETRY, default 7). */
    sshMaxretry?: number;
    /** Failed SSH logins through Tailscale before a ban (jail sshd-tailscale; null without the tailscale module). */
    maxretry: number | null; findtimeHours: number; bantimeHours: number;
    recidiveMaxretry: number; recidiveFindtimeDays: number; recidiveBantimeDays: number;
    /** KW_F2B_MAX_BANTIME in days: no ban may be longer (older servers: missing). */
    maxBantimeDays?: number;
    ignoreip: string[];
  };
  updates: { enabled?: true; autoReboot: boolean; rebootTime: string };
  myIps: string[];
  tailscale: Tailscale;
  ssh: { enabled?: true; public: boolean; revertAt: number | null };
}

/**
 * Off-site restic repository (any restic backend: s3:, b2:, sftp:, rest:, rclone:, …).
 * Credentials are environment variables for restic (AWS_ACCESS_KEY_ID, B2_ACCOUNT_KEY, …):
 * the server only ever returns their names, never their values.
 */
export interface RemoteRepo {
  configured: boolean;
  /** Display name (REMOTE_NAME or derived from the URL: "S3", "Backblaze B2", …). */
  name: string;
  /** restic repository URL, credentials in the URL masked (//***@). */
  repo: string | null;
  /** Names of the stored credential variables. */
  env: string[];
  /** /etc/keepwatch/backup/rclone.conf exists. */
  rcloneConf: boolean;
  check: { ok: boolean; at: number; message: string } | null;
}

/**
 * PUT /api/settings/remote. `env` is the full list: a missing/empty `value` keeps the stored
 * secret, names left out are removed. `rcloneConf`: contents of rclone.conf (write-only).
 */
export interface RemoteRepoInput {
  repo: string;
  name?: string;
  env?: { name: string; value?: string | null }[];
  rcloneConf?: string;
}

export interface Tailscale {
  enabled?: true;
  installed: boolean;
  state: "NeedsLogin" | "Running" | "Stopped" | "Starting" | "NoState" | null;
  ip: string | null;
  dnsName: string | null;
  keyExpiry: number | null;
  loginUrl: string | null;
  /** What `tailscale serve` still exposes in the tailnet – should be empty (access only via SSH tunnel). */
  urls: { port: number; name: string; url: string }[];
  /** The request came via Tailscale: a tailnet address, or the SSH tunnel while an SSH session from the tailnet is open. */
  viaTailscale: boolean;
}

/* ---------- Access lists -------------------------------------------------------------- */

export interface AccessEntry {
  value: string;
  note: string;
  addresses: number;
}

export interface AccessHost {
  id: number;
  domains: string[];
  mode: "open" | "list";
  entries: AccessEntry[];
  /** Admin paths: allow-list only for these paths (empty = off). The list is kept while off. */
  pathLock: { paths: string[]; entries: AccessEntry[] };
}

export interface Access {
  myIps: string[];
  hosts: AccessHost[];
}

export interface SecurityHistory {
  firstDay: string | null;
  building: boolean;
  /** blocked: attempts from addresses that are banned today (ban history + fail2ban) */
  days: { day: string; t: number; attempts: number | null; uniqueIps: number | null; bans: number | null; bansByKind?: Partial<Record<BanKind, number>> | null; blocked?: number | null }[];
  total: { attempts: number; uniqueIps: number; bans: number | null; bansByKind?: Partial<Record<BanKind, number>>; blocked?: number; blockedIps?: number };
  topIps: { ip: string; count: number; banned: boolean; country: Country }[];
  countries: CountryCount[];
}

/** GET /api/security/logins – every IP with a successful login since the journal began. */
export interface LoginIps {
  complete: boolean;
  firstDay: string | null;
  /** Since when port 22 is closed to the internet (SSH only via Tailscale), else null. */
  since: number | null;
  /** countSince: logins from this IP since `since` (null when `since` is null). */
  ips: { ip: string; first: number; last: number; count: number; countSince: number | null; users: string[]; methods: string[]; country: Country; tailnet: boolean }[];
}

/** POST /api/sites/<id>/renew */
export interface RenewResult {
  ok: boolean;
  message: string;
  renewed: boolean;
  expiresAt: number | null;
  daysLeft: number | null;
}
