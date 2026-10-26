/**
 * Mock for /api/uptime and /api/uptime/site (uptime per site).
 * Reproducible: fixed outages per domain, response times random with a fixed seed.
 *   blog.example.com   three outages (one of 47 min → red day)
 *   wiki.example.com   down right now (for 9 min)
 *   shop.example.com   checked for only 64 days
 *   old.example.com    no checks yet (like a freshly added site)
 * Without the proxy module there are no sites – the endpoints answer {"enabled": false}.
 */
import { has } from "./config";
import type { Site } from "./types";
import type { UptimeDay, UptimeDetail, UptimeSite, UptimeSummary } from "./uptime";

const now = () => Math.floor(Date.now() / 1000);
const MIN = 60;
const DAY = 86400;

interface Profile {
  baseMs: number;
  sinceDays: number;
  /** [started how many seconds ago, duration in s (null = ongoing), reason] */
  outages: [number, number | null, string][];
  expect: string;
  path: string;
}

const PROFILES: Record<string, Profile | null> = {
  "example.com": { baseMs: 31, sinceDays: 120, outages: [[23 * DAY + 5 * 3600, 12 * MIN, "502 instead of 200 on /healthz"]], expect: "200 on /healthz", path: "/healthz" },
  "old.example.com": null,
  "blog.example.com": {
    baseMs: 38,
    sinceDays: 120,
    outages: [
      [41 * DAY + 2 * 3600, 2 * MIN, "504 – container too slow to respond"],
      [12 * DAY + 9 * 3600, 47 * MIN, "502 – container unreachable"],
      [3 * DAY + 14 * 3600, 6 * MIN, "Timed out"],
    ],
    expect: "2xx/3xx on /",
    path: "/",
  },
  "shop.example.com": { baseMs: 33, sinceDays: 64, outages: [[30 * DAY + 3 * 3600, 18 * MIN, "Container not responding (connection refused)"]], expect: "403 (allow-list) and container responds", path: "/" },
  "wiki.example.com": {
    baseMs: 29,
    sinceDays: 120,
    outages: [
      [55 * DAY, 3 * 3600, "Container not responding (connection refused)"],
      [9 * MIN, null, "Container not responding (connection refused)"],
    ],
    expect: "403 (allow-list) and container responds",
    path: "/",
  },
  "photos.example.com": { baseMs: 28, sinceDays: 120, outages: [], expect: "403 (allow-list) and container responds", path: "/" },
};

const dayKey = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const midnight = (t: number) => {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let x = seed || 1;
  return () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296);
}

function outagesAbs(p: Profile) {
  const t = now();
  return p.outages.map(([ago, dur, reason]) => ({ start: t - ago, end: dur === null ? null : t - ago + dur, reason }));
}

function site(s: Site): UptimeSite {
  const domain = s.domains[0];
  const p = PROFILES[domain];
  if (!p) {
    return { domain, hostId: s.id, expect: "2xx/3xx on /", url: `https://${domain}/`, last: null, down: false, downSince: null, downReason: null, uptime30: null, avgMs24h: null, days: emptyDays() };
  }
  const t = now();
  const outs = outagesAbs(p);
  const start = midnight(t - (p.sinceDays - 1) * DAY);
  const days: UptimeDay[] = [];
  for (let i = 89; i >= 0; i--) {
    const d0 = midnight(t - i * DAY);
    const d1 = Math.min(d0 + DAY, t);
    const from = Math.max(d0, start);
    const total = from < d1 ? Math.floor((d1 - from) / MIN) : 0;
    const downSec = outs.reduce((a, o) => a + Math.max(0, Math.min(o.end ?? t, d1) - Math.max(o.start, from)), 0);
    days.push({ day: dayKey(d0), total, ok: Math.max(0, total - Math.round(downSec / MIN)), downSec: total ? downSec : 0 });
  }
  const last30 = days.slice(-30);
  const tot = last30.reduce((a, d) => a + d.total, 0);
  const open = outs.find((o) => o.end === null);
  return {
    domain,
    hostId: s.id,
    expect: p.expect,
    url: `https://${domain}${p.path}`,
    last: open ? { t: t - 20, ok: false, ms: 9, code: 403, reason: p.outages.find((o) => o[1] === null)![2] } : { t: t - 20, ok: true, ms: p.baseMs + 3, code: p.path === "/healthz" ? 200 : s.allowlist ? 403 : 200, reason: null },
    down: !!open,
    downSince: open?.start ?? null,
    downReason: open?.reason ?? null,
    uptime30: tot ? Math.round((1e8 * last30.reduce((a, d) => a + d.ok, 0)) / tot) / 1e6 : null, // 6 decimals like uptime.py
    avgMs24h: p.baseMs + 4,
    days,
  };
}

function emptyDays(): UptimeDay[] {
  const t = now();
  return Array.from({ length: 90 }, (_, i) => ({ day: dayKey(t - (89 - i) * DAY), total: 0, ok: 0, downSec: 0 }));
}

function detail(domain: string, range: "24h" | "7d"): UptimeDetail {
  const t = now();
  const [span, bucket] = range === "24h" ? [DAY, 300] : [7 * DAY, 3600];
  const from = Math.floor((t - span) / bucket) * bucket;
  const p = PROFILES[domain];
  if (!p) return { domain, range, bucket, from, to: t, points: [], outages: [] };
  const outs = outagesAbs(p);
  const r = rng(hash(domain + range));
  const points: UptimeDetail["points"] = [];
  for (let b = from; b <= t; b += bucket) {
    const n = Math.min(bucket, t - b) / MIN;
    if (n < 1) break;
    const down = outs.reduce((a, o) => a + Math.max(0, Math.min(o.end ?? t, b + bucket) - Math.max(o.start, b)), 0);
    const fails = Math.min(Math.round(n), Math.round(down / MIN));
    const hourOfDay = new Date(b * 1000).getHours();
    const load = hourOfDay >= 8 && hourOfDay <= 22 ? 1.25 : 1;
    const ms = fails >= n ? null : Math.round(p.baseMs * load + r() * 14 + (r() > 0.97 ? 120 * r() : 0));
    points.push({ t: b, ms, maxMs: ms === null ? null : ms + Math.round(r() * 40), fails, n: Math.round(n) });
  }
  return {
    domain,
    range,
    bucket,
    from,
    to: t,
    points,
    outages: outs
      .filter((o) => o.start >= t - 90 * DAY)
      .sort((a, b) => b.start - a.start)
      .map((o) => ({ start: o.start, end: o.end, durationSec: (o.end ?? t) - o.start, reason: o.reason, lastReason: null })),
  };
}

export function mockUptime(method: string, url: URL, sites: () => Site[]): unknown {
  if (method !== "GET" || !url.pathname.startsWith("/api/uptime")) return undefined;
  if (!has("proxy")) return { enabled: false };
  if (url.pathname === "/api/uptime") {
    return { interval: 60, since: now() - 120 * DAY, sites: sites().filter((s) => s.enabled).map(site) } satisfies UptimeSummary;
  }
  if (url.pathname === "/api/uptime/site") {
    const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
    return detail(url.searchParams.get("domain") ?? "", range);
  }
  throw new Error(`Mock doesn't know GET ${url.pathname}.`);
}
