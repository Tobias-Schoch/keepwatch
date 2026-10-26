/**
 * Mock for the log archive (only with ?mock): GET /api/logarchive, GET /api/logarchive/lines,
 * PUT /api/logarchive/settings. The last 24 hours come from the live log mock (mock-logs.ts);
 * before that this mock produces quieter lines. To look at: the blog stack is recreated every
 * few days (update, redeploy, one crash), blog-worker and shop-importer no longer exist.
 * Without the log-archive module every endpoint answers {"enabled": false}.
 */
import { has } from "./config";
import type { ArchiveContainer, ArchiveOverview, ArchiveSettings, SepKind } from "./logarchive/api";
import type { LiveLine } from "./logs/api";
import { mockLogs } from "./mock-logs";

const DAY = 86400;
/** Fixed time axis: recreates and removals don't shift with every request. */
const T0 = Date.now() / 1000;
interface Sep {
  ago: number;
  kind: SepKind;
  text: string;
}
interface Arch {
  name: string;
  stack: string;
  image: string;
  /** removed this many seconds ago (no longer exists) */
  goneAgo?: number;
  /** archive starts this many days ago */
  days: number;
  kb: number;
  seps: Sep[];
}

const ARCH: Arch[] = [
  { name: "keepwatch-proxy-1", stack: "keepwatch", image: "jc21/nginx-proxy-manager:latest", days: 14, kb: 2900, seps: [{ ago: 9 * DAY + 4100, kind: "created", text: "recreated · update: new image for jc21/nginx-proxy-manager:latest" }] },
  { name: "keepwatch-portainer-1", stack: "keepwatch", image: "portainer/portainer-ce:latest", days: 14, kb: 11800, seps: [{ ago: 9 * DAY + 4000, kind: "created", text: "recreated · update: new image for portainer/portainer-ce:latest" }] },
  { name: "web", stack: "web", image: "ghcr.io/example/web:latest", days: 14, kb: 4100, seps: [] },
  { name: "photos", stack: "photos", image: "photos-photos", days: 14, kb: 310, seps: [] },
  { name: "wiki", stack: "wiki", image: "ghcr.io/example/wiki:latest", days: 14, kb: 120, seps: [] },
  { name: "shop-frontend", stack: "shop", image: "shop-frontend", days: 14, kb: 260, seps: [{ ago: 3 * DAY + 7200, kind: "created", text: "recreated · settings changed, redeployed" }] },
  { name: "shop-api", stack: "shop", image: "shop-api", days: 14, kb: 8200, seps: [{ ago: 3 * DAY + 7200, kind: "created", text: "recreated · settings changed, redeployed" }] },
  { name: "shop-db", stack: "shop", image: "postgres:16-alpine", days: 14, kb: 1700, seps: [] },
  {
    name: "shop-importer", stack: "shop", image: "shop-importer", days: 14, kb: 5300, goneAgo: 3 * DAY + 7300,
    seps: [{ ago: 3 * DAY + 7300, kind: "removed", text: "container removed · service taken out of the stack" }],
  },
  {
    name: "blog-web", stack: "blog", image: "blog-web", days: 14, kb: 1900,
    seps: [
      { ago: 11 * DAY + 3600 * 5, kind: "created", text: "recreated · redeployed, same image" },
      { ago: 6 * DAY + 3600 * 2, kind: "created", text: "recreated · update: new image for blog-web" },
      { ago: 2 * DAY + 600, kind: "created", text: "recreated · update: new image for blog-web" },
      { ago: 3 * 3600 + 400, kind: "created", text: "recreated · redeployed, same image" },
    ],
  },
  {
    name: "blog-app-1", stack: "blog", image: "blog-app", days: 14, kb: 2400,
    seps: [
      { ago: 11 * DAY + 3600 * 5, kind: "created", text: "recreated · redeployed, same image" },
      { ago: 8 * DAY + 3600 * 9, kind: "restarted", text: "restarted · exited with code 137" },
      { ago: 6 * DAY + 3600 * 2, kind: "created", text: "recreated · update: new image for blog-app · crashed before (code 1)" },
      { ago: 2 * DAY + 600, kind: "created", text: "recreated · update: new image for blog-app" },
      { ago: 3 * 3600 + 400, kind: "created", text: "recreated · redeployed, same image" },
    ],
  },
  {
    name: "blog-worker", stack: "blog", image: "blog-worker", days: 14, kb: 900, goneAgo: 6 * DAY + 3600 * 2,
    seps: [{ ago: 6 * DAY + 3600 * 2 + 30, kind: "exited", text: "container stopped · exited with code 0" }, { ago: 6 * DAY + 3600 * 2, kind: "removed", text: "container removed" }],
  },
];

let SETTINGS: ArchiveSettings = { days: 14, maxPerContainerMb: 300, maxTotalMb: 2000 };

const OLD: Record<string, [string, LiveLine["level"], "stdout" | "stderr"][]> = {
  worker: [
    ["Job newsletter-digest started", null, "stdout"],
    ["Job newsletter-digest done (3 emails, 412 ms)", null, "stdout"],
    ["Warning: SMTP is slow to respond (2.1 s)", "warn", "stderr"],
    ["Error: connect ECONNREFUSED 10.0.7.3:5432", "error", "stderr"],
  ],
  importer: [
    ["Import run started: 14 feeds", null, "stdout"],
    ["Feed suppliers.csv: 212 products", null, "stdout"],
    ["WARNING feed partner-b unreachable – skipped", "warn", "stderr"],
    ["ERROR httpx.ConnectTimeout: timed out (partner-a)", "error", "stderr"],
  ],
  any: [
    ["GET / 200 4ms", null, "stdout"],
    ["GET /healthz 200 1ms", null, "stdout"],
    ["Warning: slow response (812 ms)", "warn", "stderr"],
    ["Error: attempt to write a readonly database", "error", "stderr"],
  ],
};

function oldLines(a: Arch, from: number, to: number): LiveLine[] {
  const set = a.name.includes("worker") ? OLD.worker : a.name.includes("importer") ? OLD.importer : OLD.any;
  const out: LiveLine[] = [];
  let seed = a.name.length * 97;
  const step = 900; // one line every 15 min
  for (let t = Math.ceil(from / step) * step; t < to; t += step) {
    seed = (seed * 9301 + 49297) % 233280;
    const r = seed / 233280;
    const g = r < 0.03 ? set[3] : r < 0.08 ? set[2] : set[r < 0.5 ? 0 : 1];
    out.push({ t: t + (seed % 600), c: a.name, stream: g[2], text: g[0], level: g[1] });
  }
  return out;
}

const find = (name: string) => ARCH.find((a) => a.name === name || `${a.stack}/${a.name}` === name);

function lines(url: URL) {
  const now = Date.now() / 1000;
  const windowSec = Math.max(60, Math.min(90 * DAY, Number(url.searchParams.get("window")) || 7 * DAY));
  const download = url.searchParams.get("download") === "1";
  const limit = Math.max(1, Math.min(download ? 50000 : 2000, Number(url.searchParams.get("limit")) || 1000));
  const problems = url.searchParams.get("level") === "problems";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const floor = now - windowSec;
  const out: (LiveLine & { sep?: SepKind })[] = [];
  const cursor: Record<string, string> = {};
  const truncated: string[] = [];
  const errors: Record<string, string> = {};
  const gone: string[] = [];
  for (const item of url.searchParams.getAll("c")) {
    const [name, cur] = item.split("@");
    const a = find(name);
    if (!a) {
      errors[name] = "The archive has nothing for this container.";
      cursor[name] = (now - 5).toFixed(6);
      continue;
    }
    if (a.goneAgo) gone.push(name);
    const since = cur ? Number(cur) : floor;
    const end = a.goneAgo ? T0 - a.goneAgo : now;
    let ls: LiveLine[] = [];
    if (!a.goneAgo) {
      // the last 24 hours as in the live logs
      const u = new URL("/api/logs", location.origin);
      u.searchParams.append("c", cur ? `${a.name}@${cur}` : a.name);
      u.searchParams.set("window", String(Math.min(windowSec, DAY)));
      u.searchParams.set("limit", "2000");
      ls = mockLogs(u).lines;
    }
    if (!cur) ls = oldLines(a, Math.max(floor, now - a.days * DAY), Math.min(end, now - DAY)).concat(ls);
    ls = ls.filter((l) => l.t >= since && l.t <= end && (!problems || l.level) && (!q || l.text.toLowerCase().includes(q)));
    if (ls.length > limit) {
      if (!cur) truncated.push(name);
      ls = ls.slice(-limit);
    }
    const oldest = ls.length && truncated.includes(name) ? ls[0].t : since;
    const seps = a.seps.map((s) => ({ t: T0 - s.ago, c: name, stream: "stdout" as const, text: s.text, level: null, sep: s.kind })).filter((s) => s.t >= oldest && s.t >= since);
    out.push(...ls.map((l) => ({ ...l, c: name })), ...seps);
    const tl = [...ls.map((l) => l.t), ...seps.map((x) => x.t)];
    const last = tl.length ? Math.max(...tl) : null; // like the backend: dividers count for the cursor too
    cursor[name] = (last !== null ? last + 0.000001 : Math.max(since, now - 5)).toFixed(6);
  }
  out.sort((x, y) => x.t - y.t);
  return { now, since: floor, lines: out, cursor, truncated, dropped: 0, errors, archive: true, gone, running: true, retentionDays: SETTINGS.days };
}

function overview(): ArchiveOverview {
  const now = Date.now() / 1000;
  const day = (ago: number) => new Date((now - ago) * 1000).toISOString().slice(0, 10);
  const containers: ArchiveContainer[] = ARCH.map((a) => ({
    key: `${a.stack}/${a.name}`,
    name: a.name,
    stack: a.stack,
    exists: !a.goneAgo,
    bytes: a.kb * 1024,
    days: a.days + 1,
    from: day(a.days * DAY),
    to: day(a.goneAgo ?? 0),
    lastWrite: a.goneAgo ? T0 - a.goneAgo : now - 1,
    dropped: 0,
    trimmed: null,
    image: a.image,
  }));
  return {
    installed: true,
    running: true,
    statusAt: now - 20,
    since: now - 15 * DAY,
    dir: "/var/lib/keepwatch/log-archive",
    settings: SETTINGS,
    bytes: containers.reduce((s, c) => s + c.bytes, 0),
    containers,
    skipped: {},
    notes: [],
  };
}

/** undefined = not for this mock */
export async function mockLogArchive(method: string, url: URL, body: unknown): Promise<unknown> {
  const p = url.pathname;
  if (!p.startsWith("/api/logarchive")) return undefined;
  if (!has("log-archive")) return { enabled: false };
  if (method === "GET" && p === "/api/logarchive") return overview();
  if (method === "GET" && p === "/api/logarchive/lines") return lines(url);
  if (method === "PUT" && p === "/api/logarchive/settings") {
    SETTINGS = { ...SETTINGS, ...(body as Partial<ArchiveSettings>) };
    return overview();
  }
  throw new Error("This endpoint doesn’t exist.");
}
