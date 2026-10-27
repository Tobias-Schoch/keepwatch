import { useSyncExternalStore } from "react";
import { MOCK } from "./api";
import { setTimeZone } from "./format";

/**
 * Server configuration (GET /api/config): which modules are installed, the
 * user's timezone, ports for the tunnel. Loaded once before the first render
 * (see main.tsx). If the request fails (older backend, no server), every module
 * counts as enabled so the dashboard still works.
 *
 * Gating: `has("proxy")` anywhere (plain function, also outside React), or
 * `useConfig()` in components that should re-render when the config arrives.
 */

export const MODULES = [
  { id: "base", name: "Base system", summary: "Packages, hostname, timezone, journal size, login banner. Always on." },
  { id: "debloat", name: "Remove Ubuntu extras", summary: "Turns off crash reporter, Ubuntu Pro ads, motd news and other extras a server does not need." },
  { id: "auto-updates", name: "Automatic security updates", summary: "unattended-upgrades at a fixed time, optional reboot when an update needs it." },
  { id: "ssh-hardening", name: "SSH hardening", summary: "Keys only, no root password login, no agent forwarding, only local tunnels." },
  { id: "kernel-hardening", name: "Kernel hardening", summary: "sysctl hardening, no core dumps, unused network protocols blocked." },
  { id: "auditd", name: "Audit log", summary: "auditd rules for logins, sudo, SSH keys, cron and other sensitive files." },
  { id: "fail2ban", name: "fail2ban", summary: "Bans SSH brute force, web scanners and repeated failed logins." },
  { id: "ban-history", name: "Ban history", summary: "Remembers past SSH attackers and bans them again on every boot.", requires: ["fail2ban"] },
  { id: "tailscale", name: "Tailscale", summary: "Private access. Lets you close port 22 to the internet." },
  { id: "firewall", name: "Firewall", summary: "Allow-list firewall that also covers ports Docker publishes." },
  { id: "docker", name: "Docker", summary: "Docker Engine with log rotation, live-restore and a shared proxy network." },
  { id: "log-archive", name: "Container log archive", summary: "Keeps container logs for 14 days, even across recreates.", requires: ["docker"] },
  { id: "backup", name: "Backups", summary: "Daily restic backup, optional off-site copy, monthly test restore." },
  { id: "image-scan", name: "Image scan", summary: "Weekly Trivy scan of all container images.", requires: ["docker"] },
  { id: "lynis", name: "Lynis audit", summary: "Weekly Lynis hardening audit with a score." },
  { id: "proxy", name: "Reverse proxy", summary: "Nginx Proxy Manager on 80/443 with Let's Encrypt.", requires: ["docker"] },
  { id: "portainer", name: "Portainer", summary: "Docker stacks, deploy from Git with webhooks.", requires: ["docker"] },
  { id: "dashboard", name: "Dashboard", summary: "This dashboard, on 127.0.0.1 only." },
] as const satisfies readonly { id: string; name: string; summary: string; requires?: readonly string[] }[];

export type ModuleId = (typeof MODULES)[number]["id"];

export interface Config {
  hostname: string;
  modules: Partial<Record<ModuleId, boolean>>;
  /** The user's timezone (KW_LOCAL_TZ): schedules and day boundaries. */
  localTz: string;
  ports: { dashboard: number; proxyAdmin: number | null; portainer: number | null };
  extraUis: { name: string; port: number }[];
  /** Dangerous actions need a passkey (Touch ID, Windows Hello, security key). */
  passkey: boolean;
  version: string;
  /** Updates from the dashboard are on (KW_SELF_UPDATE_REPO is set). */
  selfUpdate: boolean;
  /** Set by the client when /api/config could not be loaded (everything assumed on). */
  fallback?: boolean;
}

const ALL_ON = Object.fromEntries(MODULES.map((m) => [m.id, true])) as Record<ModuleId, boolean>;

const FALLBACK: Config = {
  hostname: "server",
  modules: ALL_ON,
  localTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  ports: { dashboard: 9004, proxyAdmin: 9001, portainer: 9002 },
  extraUis: [],
  passkey: true,
  version: "",
  selfUpdate: false,
  fallback: true,
};

let config: Config = FALLBACK;
const listeners = new Set<() => void>();

function set(c: Config) {
  config = c;
  setTimeZone(c.localTz || undefined);
  listeners.forEach((l) => l());
}

/** Fetches /api/config (at most `timeoutMs`). Never throws. */
export async function loadConfig(timeoutMs = 3000): Promise<Config> {
  if (MOCK) {
    const { mockConfig } = await import("./mock-config");
    set(mockConfig());
    return config;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("/api/config", { headers: { Accept: "application/json" }, cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const c = (await res.json()) as Partial<Config>;
    set({ ...FALLBACK, ...c, modules: { ...ALL_ON, ...(c.modules ?? {}) }, ports: { ...FALLBACK.ports, ...(c.ports ?? {}) }, fallback: false });
  } catch {
    set(FALLBACK);
  }
  return config;
}

export const getConfig = () => config;

/** Is this module installed on the server? Unknown ids count as on. */
export const has = (id: ModuleId): boolean => config.modules[id] !== false;

/** Current config; re-renders when it changes. */
export const useConfig = (): Config =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => config,
  );

/** `useHas("proxy")` – hook form of `has`. */
export const useHas = (id: ModuleId): boolean => useConfig().modules[id] !== false;
