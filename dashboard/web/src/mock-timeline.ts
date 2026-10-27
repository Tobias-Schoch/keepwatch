import { has, type ModuleId } from "./config";
import type { Timeline, TimelineRecent, TlEvent, TlKind, TlLevel, TlLink } from "./timeline";

/* Mock timeline (?mock): a typical night – backup at 03:00, updates at 04:00 with a reboot,
   a renewed certificate, bans – and two weeks of everyday life before that. Wired up in mock.ts.
   Events of disabled modules are left out, like the backend does. */

export const NOT_TIMELINE = Symbol("not timeline");

const SERVICES: Record<string, string> = {
  web: "Web",
  shop: "Shop",
  blog: "Blog",
  wiki: "Wiki",
  photos: "Photos",
  // Not managed by Portainer: Keepwatch's own two (stackNames.ts) and one started by hand.
  proxy: "Proxy Manager",
  portainer: "Portainer",
  vaultwarden: "Vaultwarden",
};

const L = {
  backup: { view: "backups" } as TlLink,
  f2b: { view: "security", sel: ".o-h2", text: "Banned addresses", up: ".o-panel" } as TlLink,
  ssh: { view: "security", sel: ".o-h2", text: "Logins", up: ".o-panel" } as TlLink,
  port22: { view: "settings", setting: "remote-access" } as TlLink,
  machine: { view: "overview", sel: ".d-fold-panel", text: "Machine" } as TlLink,
  site: (d: string): TlLink => ({ view: "services", sel: ".d-block td, .d-block a", text: d, up: "tr" }),
  svc: (s: string): TlLink => ({ view: "services", sel: ".d-block-title", text: SERVICES[s] ?? s, exact: true, up: ".d-block" }),
};

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

/** Unix time for "`daysAgo` days ago at hh:mm" (browser local time). */
function at(daysAgo: number, hh: number, mm: number, ss = 0): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, ss, 0);
  return Math.floor(d.getTime() / 1000);
}

interface Raw {
  t: number;
  kind: TlKind;
  title: string;
  detail?: string;
  level?: TlLevel;
  service?: string;
  source: string;
  count?: number;
  tEnd?: number;
  link?: TlLink | null;
  /** Modules the event needs (all of them). Defaults come from the source, see SOURCE_MODULE. */
  needs?: ModuleId[];
}

/** Which module produces events of a source. */
const SOURCE_MODULE: Record<string, ModuleId[]> = {
  backup: ["backup"],
  probe: ["backup"],
  f2b: ["fail2ban"],
  docker: ["docker"],
  updates: ["docker"],
  cert: ["proxy"],
  apt: ["auto-updates"],
  port22: ["tailscale"],
};

const IPS = ["192.0.2.14", "203.0.113.45", "203.0.113.121", "192.0.2.94", "203.0.113.81", "192.0.2.77", "192.0.2.51", "192.0.2.185"];

type Jail = "SSH" | "Web scanner" | "Port 22 (closed)";

function f2b(t: number, jail: Jail, n: number): Raw {
  const ips = IPS.slice(0, Math.min(3, n));
  return {
    t,
    tEnd: t + Math.min(3500, 300 + n * 240),
    kind: "security",
    title: `${n} ${n === 1 ? "ban" : "bans"} · ${jail}`,
    detail: ips.join(", ") + (n > 3 ? ` and ${n - 3} more` : ""),
    source: "f2b",
    count: n,
    link: L.f2b,
    needs: jail === "Web scanner" ? ["fail2ban", "proxy"] : jail === "Port 22 (closed)" ? ["fail2ban", "tailscale"] : ["fail2ban"],
  };
}

/** "local + off-site" when the off-site copy is part of the story. */
const WHERE = "local + off-site";

function build(): TlEvent[] {
  seed = 7;
  const ev: Raw[] = [];
  const push = (r: Raw) => ev.push(r);

  /* ---------- last night ---------- */
  push({ t: at(1, 20, 23, 41), kind: "dashboard", title: "Redeploy Blog", detail: "POST /api/stacks/28/redeploy", service: "blog", source: "audit", needs: ["portainer"] });
  push({
    t: at(1, 20, 24, 3),
    tEnd: at(1, 20, 24, 31),
    kind: "services",
    title: "Blog redeployed (2 containers)",
    detail: "blog-app-1, blog-web · triggered in the dashboard · via Portainer · commit 7f9d98f (main) · by admin",
    service: "blog",
    source: "docker",
    needs: ["docker", "portainer"],
  });
  push({ t: at(1, 21, 10, 12), kind: "dashboard", title: "Allow-list of photos.example.com changed", detail: "PUT /api/access/12", source: "audit", link: L.site("photos.example.com"), needs: ["proxy"] });
  push({
    t: at(1, 22, 41, 7),
    kind: "services",
    level: "warn",
    title: "Shop: shop-api crashed (exit 137 – killed) and restarted",
    detail: "Restarted by the restart policy after 4 s",
    service: "shop",
    source: "docker",
  });
  push({ t: at(0, 0, 36, 20), kind: "system", title: "Certificate renewed: example.com", detail: "Let’s Encrypt · 3rd issuance", source: "cert", link: L.site("example.com") });
  push({
    t: at(0, 3, 0, 4),
    tEnd: at(0, 3, 4, 22),
    kind: "backup",
    title: "Backup finished",
    detail: `+212 MiB new · 8.4 GiB backed up · 4 min · ${WHERE}`,
    source: "backup",
    link: L.backup,
  });
  push({
    t: at(0, 4, 0, 12),
    tEnd: at(0, 4, 3, 40),
    kind: "system",
    title: "Automatic updates: 12 packages, new kernel",
    detail: "Kernel 6.8.0-150-generic (active after reboot) · libssl3t64, linux-image-6.8.0-150-generic, linux-modules-6.8.0-150-generic, openssl, python3-urllib3, systemd, tzdata, udev and 4 more",
    source: "apt",
    link: L.machine,
  });
  push({
    t: at(0, 4, 5, 51),
    kind: "system",
    title: "Rebooted into kernel 6.8.0-150-generic",
    detail: "Down for 38 s · previously 6.8.0-147-generic · after automatic updates",
    source: "boot",
    link: L.machine,
    needs: ["auto-updates"],
  });
  push({
    t: at(0, 4, 6, 14),
    tEnd: at(0, 4, 7, 2),
    kind: "services",
    title: "After boot: 11 containers started in 8 services",
    detail: "Blog, Photos, Portainer, Proxy Manager, Shop, Vaultwarden, Web, Wiki",
    source: "docker",
    link: { view: "services" },
  });
  push({ t: at(0, 4, 8, 30), kind: "services", level: "warn", title: "Shop: shop-api unhealthy", detail: "Health check /api/health is not answering", service: "shop", source: "docker" });
  push({ t: at(0, 4, 11, 2), kind: "services", title: "Shop: shop-api healthy again", service: "shop", source: "docker" });
  push({ t: at(0, 7, 42, 9), kind: "security", title: "SSH login: root from the tailnet", detail: "100.64.0.5 (MacBook Pro)", source: "ssh", link: L.ssh, needs: ["tailscale"] });
  push({ t: at(0, 8, 15, 33), kind: "dashboard", title: "Checked for updates", detail: "POST /api/updates/check", source: "audit", link: { view: "services" }, needs: ["docker"] });

  // Bans of the night, bundled per hour and jail
  for (const [d, h, jail, n] of [
    [1, 20, "SSH", 6], [1, 21, "SSH", 11], [1, 22, "Web scanner", 2], [1, 23, "SSH", 9], [0, 0, "SSH", 14], [0, 1, "Port 22 (closed)", 3],
    [0, 2, "SSH", 7], [0, 3, "SSH", 5], [0, 5, "Web scanner", 1], [0, 6, "SSH", 8], [0, 7, "SSH", 4],
  ] as [number, number, Jail, number][])
    push(f2b(at(d, h, 3 + Math.floor(rnd() * 20)), jail, n));

  // Rest of yesterday
  push({ t: at(1, 3, 0, 3), tEnd: at(1, 3, 3, 51), kind: "backup", title: "Backup finished", detail: `+148 MiB new · 8.4 GiB backed up · 4 min · ${WHERE}`, source: "backup", link: L.backup });
  push({ t: at(1, 4, 0, 9), kind: "system", title: "Automatic updates: 3 packages", detail: "distro-info-data, libcares2, libnss3", source: "apt", link: L.machine });
  push({ t: at(1, 11, 2, 40), kind: "security", title: "SSH login: root from the tailnet (3×)", detail: "100.64.0.5 (MacBook Pro)", source: "ssh", count: 3, tEnd: at(1, 11, 48), link: L.ssh, needs: ["tailscale"] });
  push({ t: at(1, 14, 31, 2), kind: "dashboard", title: "Ban lifted: 198.51.100.24", detail: "SSH · POST /api/security/unban", source: "audit", link: L.f2b, needs: ["fail2ban"] });

  /* ---------- two weeks of everyday life ---------- */
  for (let d = 2; d <= 15; d++) {
    const failed = d === 5;
    push({
      t: at(d, 3, 0, 2),
      tEnd: at(d, 3, failed ? 12 : 4, 10),
      kind: "backup",
      level: failed ? "crit" : "info",
      title: failed ? "Backup failed" : "Backup finished",
      detail: failed
        ? `restic copy -> off-site: Fatal: unable to open repository: dial tcp: i/o timeout · 12 min · ${WHERE}`
        : `+${Math.round(90 + rnd() * 200)} MiB new · 8.${3 + Math.floor(rnd() * 2)} GiB backed up · 4 min · ${WHERE}`,
      source: "backup",
      link: L.backup,
    });
    if (rnd() < 0.55)
      push({ t: at(d, 4, 0, 10), kind: "system", title: `Automatic updates: ${1 + Math.floor(rnd() * 6)} packages`, detail: "ca-certificates, liblzma5, xz-utils", source: "apt", link: L.machine });
    for (let h = 0; h < 24; h++) if (rnd() < 0.35) push(f2b(at(d, h, Math.floor(rnd() * 50)), rnd() < 0.8 ? "SSH" : "Web scanner", 1 + Math.floor(rnd() * 12)));
    if (rnd() < 0.5) push({ t: at(d, 9 + Math.floor(rnd() * 10), Math.floor(rnd() * 59)), kind: "security", title: "SSH login: root from the tailnet", detail: "100.64.0.5 (MacBook Pro)", source: "ssh", link: L.ssh, needs: ["tailscale"] });
  }
  push({ t: at(2, 16, 12, 5), kind: "services", title: "Web redeployed (1 container)", detail: "web · via Portainer · commit a93e7fb (main) · by admin", service: "web", source: "docker", needs: ["docker", "portainer"] });
  push({ t: at(2, 17, 40, 18), kind: "services", title: "Shop redeployed (3 containers)", detail: "shop-api, shop-db, shop-frontend · GitHub webhook · via Portainer · commit 4c1e0b2 (main) · by admin", service: "shop", source: "docker", needs: ["docker", "portainer"] });
  push({ t: at(3, 19, 48, 30), kind: "system", title: "Keepwatch deployed · ce714fc", detail: "./keepwatch deploy · changed: dashboard, fail2ban, firewall", source: "deploy", link: null });
  push({ t: at(3, 19, 49, 2), kind: "services", title: "Proxy Manager redeployed (1 container)", detail: "keepwatch-proxy-1 · during ./keepwatch deploy", service: "proxy", source: "docker", needs: ["docker", "proxy"] });
  push({ t: at(3, 19, 49, 9), kind: "services", title: "Portainer redeployed (1 container)", detail: "keepwatch-portainer-1 · during ./keepwatch deploy", service: "portainer", source: "docker", needs: ["docker", "portainer"] });
  push({ t: at(6, 21, 14, 37), kind: "services", title: "Vaultwarden redeployed (1 container)", detail: "vaultwarden", service: "vaultwarden", source: "docker", needs: ["docker"] });
  push({ t: at(4, 10, 5, 0), kind: "dashboard", title: "Update started: postgres:16-alpine", detail: "POST /api/updates/apply", service: "shop", source: "audit", needs: ["docker"] });
  push({ t: at(4, 10, 5, 2), tEnd: at(4, 10, 6, 40), kind: "services", title: "Update applied: postgres:16-alpine", detail: "postgres:16-alpine updated to 16.6.", service: "shop", source: "updates" });
  push({ t: at(5, 3, 12, 30), kind: "dashboard", title: "Backup started manually", detail: "POST /api/backups/run", source: "audit", link: L.backup, needs: ["backup"] });
  push({ t: at(5, 3, 13, 0), tEnd: at(5, 3, 17, 10), kind: "backup", title: "Backup finished", detail: `+3.1 MiB new · 8.4 GiB backed up · 4 min · ${WHERE}`, source: "backup", link: L.backup });
  push({ t: at(6, 5, 30, 1), tEnd: at(6, 5, 41, 20), kind: "backup", title: "Test restore passed", detail: "11 min", source: "probe", link: L.backup });
  push({ t: at(8, 0, 36, 12), kind: "system", title: "Certificate renewed: blog.example.com", detail: "Let’s Encrypt · 2nd issuance", source: "cert", link: L.site("blog.example.com") });
  push({ t: at(8, 13, 36, 11), kind: "system", level: "warn", title: "Certificate renewal failed: status.example.com", detail: "DNS problem: NXDOMAIN looking up A for status.example.com", source: "cert" });
  push({ t: at(9, 19, 40, 2), kind: "security", level: "warn", title: "Port 22 open again – SSH reachable from the internet", detail: "Reachable from outside: 22, 80, 443", source: "port22", link: L.port22 });
  push({ t: at(9, 20, 0, 53), kind: "security", title: "Port 22 closed – SSH only via Tailscale", detail: "Reachable from outside: 80, 443", source: "port22", link: L.port22 });
  push({ t: at(9, 19, 59, 40), kind: "dashboard", title: "Close port 22 (SSH only via Tailscale)", detail: "PUT /api/settings/ssh", source: "audit", link: L.port22, needs: ["tailscale"] });
  push({ t: at(12, 4, 5, 30), kind: "system", title: "Server rebooted", detail: "Down for 41 s · after automatic updates", source: "boot", link: L.machine, needs: ["auto-updates"] });
  push({ t: at(13, 22, 14, 0), kind: "services", level: "crit", title: "Wiki: out of memory (OOM) – wiki", detail: "wiki crashed (exit 137 – killed) · restarted", service: "wiki", source: "docker" });

  const now = Date.now() / 1000;
  const backfilledAt = at(6, 18, 0);
  return ev
    .filter((r) => r.t <= now && (r.needs ?? SOURCE_MODULE[r.source] ?? []).every(has))
    .sort((a, b) => b.t - a.t)
    .map((r, i) => ({
      id: 10_000 - i,
      t: r.t,
      tEnd: r.tEnd ?? null,
      kind: r.kind,
      title: r.title,
      detail: r.detail ?? null,
      level: r.level ?? "info",
      service: r.service ?? null,
      serviceTitle: r.service ? SERVICES[r.service] ?? r.service : null,
      source: r.source,
      count: r.count ?? 1,
      backfill: r.t < backfilledAt,
      link: r.link === undefined ? (r.service && has("docker") ? L.svc(r.service) : null) : r.link,
    }));
}

const WEIGHT: Record<string, number> = { boot: 60, port22: 55, backup: 40, deploy: 40, docker: 30, apt: 35, cert: 30, updates: 35, ssh: 20, audit: 15, f2b: 8, probe: 30 };

export function mockTimeline(method: string, url: URL): Timeline | TimelineRecent | typeof NOT_TIMELINE {
  if (method !== "GET" || !url.pathname.startsWith("/api/timeline")) return NOT_TIMELINE;
  const all = build();
  const now = Date.now() / 1000;
  if (url.pathname === "/api/timeline/recent") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    y.setHours(0, 0, 0, 0);
    const since = y.getTime() / 1000;
    const rows = all.filter((e) => e.t >= since);
    const score = (e: TlEvent) => (e.level === "crit" ? 1000 : e.level === "warn" ? 500 : 0) + (WEIGHT[e.source] ?? 30) + Math.min(e.count, 50) / 10;
    const top = [...rows].sort((a, b) => score(b) - score(a) || b.t - a.t).slice(0, 8).sort((a, b) => b.t - a.t);
    return { since, events: top, total: rows.length, problems: rows.filter((e) => e.level !== "info").length, backfilling: false };
  }
  const q = url.searchParams;
  const from = Number(q.get("from")) || now - 7 * 86400;
  const to = Number(q.get("to")) || now + 60;
  const before = q.get("before") ? Number(q.get("before")) : null;
  const limit = Math.min(1000, Number(q.get("limit")) || 300);
  const kinds = (q.get("kind") ?? "").split(",").filter(Boolean);
  const service = q.get("service");
  const problems = q.get("problems") === "1";
  const base = all.filter((e) => e.t >= from && e.t <= to && (before === null || e.t < before));
  const rows = base.filter((e) => (!kinds.length || kinds.includes(e.kind)) && (!service || e.service === service) && (!problems || e.level !== "info"));
  const counts: Timeline["counts"] = {};
  for (const e of base) {
    const c = (counts[e.kind] ??= { total: 0, problems: 0 });
    c.total++;
    if (e.level !== "info") c.problems++;
  }
  const svc = new Map<string, number>();
  for (const e of base) if (e.service) svc.set(e.service, (svc.get(e.service) ?? 0) + 1);
  return {
    events: rows.slice(0, limit),
    more: rows.length > limit,
    services: [...svc].map(([id, count]) => ({ id, title: SERVICES[id] ?? id, count })).sort((a, b) => a.title.localeCompare(b.title, "en")),
    counts,
    range: { from, to },
    oldest: all[all.length - 1]?.t ?? null,
    keepDays: 120,
    backfilledAt: at(6, 18, 0),
    backfilling: false,
  };
}
