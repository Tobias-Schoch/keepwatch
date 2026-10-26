/**
 * Mock for GET /api/logs and GET /api/security/ip (only with ?mock).
 * Each container gets 24 hours of history on first request; after that it
 * keeps growing over time so "live" has something to do.
 */
import type { LiveLine, LogLevel, LogsResponse } from "./logs/api";

type Gen = [text: string, level: LogLevel, stream?: "stdout" | "stderr"][];

const APP: Gen = [
  ["Worker started, 4 jobs registered", null],
  ["Blog API listening on :8080", null],
  ["POST /api/posts 201 38ms", null],
  ["GET /api/posts?page=2 200 12ms", null],
  ["GET /api/health 200 1ms", null],
  ["Rendered sitemap.xml (412 URLs) in 84 ms", null],
  ["Unhandled rejection: Error: SQLITE_READONLY: attempt to write a readonly database", "error", "stderr"],
  ["    at Statement.run (/app/server/db.js:169:3)", "error", "stderr"],
  ["Warning: slow response (812 ms) on /api/posts", "warn", "stderr"],
];
const WEB: Gen = [
  ['10.0.6.1 - - "GET / HTTP/1.1" 200 2269 "-" "Mozilla/5.0"', null],
  ['10.0.6.1 - - "GET /assets/index-4f2a.js HTTP/1.1" 200 81234 "-" "Mozilla/5.0"', null],
  ['10.0.6.1 - - "GET /favicon.ico HTTP/1.1" 404 146 "-" "Mozilla/5.0"', null],
  ['10.0.6.1 - - "POST /api/admin/login HTTP/1.1" 502 157 "-" "Mozilla/5.0"', "error"],
  ["2026/10/23 21:47:54 [warn] 29#29: *812 upstream prematurely closed connection … POST /api/admin/login", "warn", "stderr"],
];
const DB: Gen = [
  ["LOG:  checkpoint starting: time", null, "stderr"],
  ["LOG:  checkpoint complete: wrote 37 buffers (0.2%); 0 WAL file(s) added, 0 removed, 1 recycled", null, "stderr"],
  ['ERROR:  syntax error at or near "\\" at character 77', "error", "stderr"],
  ["STATEMENT:  select count(*) from orders;", "error", "stderr"],
  ["LOG:  checkpoints are occurring too frequently (5 seconds apart)", null, "stderr"],
];
const PY: Gen = [
  ['INFO:     127.0.0.1:46934 - "GET /health HTTP/1.1" 200 OK', null],
  ['INFO:     10.0.7.5:51234 - "GET /api/products?limit=24 HTTP/1.1" 200 OK', null],
  ["20:10:04 [INFO] app.jobs.inventory: Stock sync completed: 214 products checked, 3 price changes", null],
  ["20:12:44 [WARNING] app.payments: Payment provider slow to respond (2.4 s), retrying", "warn"],
  ["Traceback (most recent call last):", "error", "stderr"],
  ['  File "/app/app/jobs/inventory.py", line 214, in run', "error", "stderr"],
  ["httpx.ConnectTimeout: timed out", "error", "stderr"],
];
const NPM: Gen = [
  ["[10/23/2026] [3:43:54 PM] [Setup    ] › ℹ  info      Logrotate completed.", null],
  ["[10/23/2026] [3:43:56 PM] [Global   ] › ⬤  debug     Backend PID 165 listening on port 3000 ...", null],
  ["2026/10/23 16:14:22 [error] 249#249: *220 access forbidden by rule, client: 192.0.2.94, server: wiki.example.com", "error", "stderr"],
  ['nginx: [emerg] host not found in upstream "shop-api" in /data/nginx/proxy_host/3.conf:45', "error", "stderr"],
];
const GENERIC: Gen = [
  ["Server listening on port 3000", null],
  ["GET / 200 4ms", null],
  ["GET /healthz 200 1ms", null],
  ["Warning: slow response (812 ms) on /api/list", "warn", "stderr"],
];

function genFor(name: string): Gen {
  if (/-db\b/.test(name)) return DB;
  if (/proxy/.test(name)) return NPM;
  if (/backend|-api\b/.test(name)) return PY;
  if (/-app-\d|app$/.test(name)) return APP;
  if (/web|frontend|site|photos/.test(name)) return WEB;
  return GENERIC;
}

interface Store {
  lines: (LiveLine & { ns: number })[];
  until: number;
  seed: number;
}
const STORES = new Map<string, Store>();

const rand = (s: Store) => ((s.seed = (s.seed * 9301 + 49297) % 233280) / 233280);

/** Frequency: mostly normal lines, now and then a warning, rarely an error (with follow-up lines). */
function grow(name: string, s: Store, upto: number) {
  const gen = genFor(name);
  const normal = gen.filter((g) => !g[1]);
  const warn = gen.filter((g) => g[1] === "warn");
  const err = gen.filter((g) => g[1] === "error");
  let t = s.until;
  while (true) {
    t += 4 + rand(s) * (name.includes("portainer") ? 120 : 45);
    if (t > upto) break;
    const r = rand(s);
    const pick: Gen = r < 0.035 && err.length ? err : r < 0.09 && warn.length ? warn : normal;
    const g = pick[Math.floor(rand(s) * pick.length)];
    // An error comes with its follow-up lines (stack trace, STATEMENT …).
    const group = g[1] === "error" ? (name.includes("proxy") ? [g] : err) : [g];
    group.forEach(([text, level, stream], k) => {
      const tt = t + k * 0.001;
      s.lines.push({ t: tt, ns: Math.round(tt * 1e6), c: name, stream: stream ?? "stdout", text, level });
    });
  }
  s.until = Math.min(t, upto);
  if (s.lines.length > 20000) s.lines.splice(0, s.lines.length - 20000);
}

function store(name: string): Store {
  let s = STORES.get(name);
  const nowS = Date.now() / 1000;
  if (!s) {
    let seed = 7;
    for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 233280;
    s = { lines: [], until: nowS - 86400 - 60, seed };
    STORES.set(name, s);
  }
  grow(name, s, nowS);
  return s;
}

export function mockLogs(url: URL): LogsResponse {
  const nowS = Date.now() / 1000;
  const windowSec = Math.max(60, Math.min(7 * 86400, Number(url.searchParams.get("window")) || 3600));
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1000));
  const problems = url.searchParams.get("level") === "problems";
  const floor = nowS - windowSec;
  const out: LiveLine[] = [];
  const cursor: Record<string, string> = {};
  const truncated: string[] = [];
  const errors: Record<string, string> = {};
  for (const item of url.searchParams.getAll("c")) {
    const [name, cur] = item.split("@");
    if (name === "does-not-exist") {
      errors[name] = `There is no container “${name}”.`;
      continue;
    }
    const s = store(name);
    const since = Math.max(cur ? Number(cur) : floor, floor);
    const tail = cur ? 500 : problems ? 10000 : limit;
    const fresh = s.lines.filter((l) => l.t >= since);
    const scanned = fresh.slice(-tail);
    let keep = problems ? scanned.filter((l) => l.level) : scanned;
    keep = keep.slice(-limit);
    if (scanned.length >= tail) truncated.push(name);
    out.push(...keep.map(({ ns: _ns, ...l }) => l));
    const last = scanned.length ? scanned[scanned.length - 1].t : null;
    cursor[name] = (last !== null ? last + 0.000001 : Math.max(since, nowS - 5)).toFixed(6);
  }
  out.sort((a, b) => a.t - b.t);
  return { now: nowS, since: floor, lines: out.slice(-5000), cursor, truncated, dropped: Math.max(0, out.length - 5000), errors };
}

/* ---------- IP lookup ---------------------------------------------------------------------- */

export interface IpInfoMock {
  ip: string;
  country: { cc: string | null; name: string };
  tailnet: boolean;
  attempts: { total: number; days: number; first: string | null; last: string | null; since: string | null; last24h: number | null };
  banned: string[];
  bans: { jail: string; bannedAt: number; expiresAt: number | null; banCount: number }[];
  logins: { count: number; first: number; last: number; users: string[]; methods: string[] } | null;
  jails: string[];
}

export function mockIp(ip: string, ctx: { banned: { ip: string; jail: string; bannedAt: number | null; expiresAt: number | null; banCount: number }[]; top: { ip: string; count: number }[]; logins: { ip: string; at: number; user: string; method: string }[]; geo: (ip: string) => { cc: string | null; name: string } }): IpInfoMock {
  if (!/^(\d{1,3}\.){3}\d{1,3}$|:/.test(ip)) throw new Error("That isn’t a valid IP address.");
  const nowS = Math.floor(Date.now() / 1000);
  const top = ctx.top.find((t) => t.ip === ip);
  const mine = ctx.logins.filter((l) => l.ip === ip);
  const bans = ctx.banned.filter((b) => b.ip === ip);
  let h = 0;
  for (const ch of ip) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  const total = top ? top.count * 3 : mine.length ? 0 : h % 3 === 0 ? 0 : h % 400;
  return {
    ip,
    country: ctx.geo(ip),
    tailnet: ctx.geo(ip).name === "Tailnet",
    attempts: { total, days: total ? 1 + (h % 9) : 0, first: total ? "2026-09-30" : null, last: total ? "2026-10-22" : null, since: "2026-02-01", last24h: top?.count ?? null },
    banned: bans.map((b) => b.jail),
    bans: bans.map((b) => ({ jail: b.jail, bannedAt: b.bannedAt ?? nowS - 3600, expiresAt: b.expiresAt, banCount: b.banCount })),
    logins: mine.length ? { count: mine.length * 4, first: Math.min(...mine.map((l) => l.at)) - 30 * 86400, last: Math.max(...mine.map((l) => l.at)), users: [...new Set(mine.map((l) => l.user))], methods: [...new Set(mine.map((l) => l.method))] } : null,
    jails: ["sshd", "recidive"],
  };
}
