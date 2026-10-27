/**
 * Mock of image updates & rollback and cleanup (?mock). Shows every state:
 * update available (Postgres as a security patch, Proxy Manager), major version jump
 * (Portainer), unknown (private ghcr package – with a previous version and an attempt that
 * rolled back), a running job after "Update". The Proxy Manager doesn't become healthy
 * after its update and rolls back by itself.
 * Without docker the endpoints answer {enabled: false}; without image-scan there is no scan,
 * without portainer no Git stacks.
 */
import { has } from "./config";
import type { Problem } from "./types";
import type { Cleanup, ImageUpdate, Scan, ScanImage, UpdateJob, Updates, Vuln } from "./updates";

const GB = 1e9;
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const PREV = "keepwatch-previous";

const img = (p: Partial<ImageUpdate> & Pick<ImageUpdate, "ref" | "containers" | "services" | "status">): ImageUpdate => ({
  key: p.ref,
  name: null,
  project: null,
  via: "portainer",
  kind: null,
  security: false,
  reason: null,
  local: { digest: "sha256:4393e642e233e5ef", version: null, created: now() - 30 * DAY },
  remote: null,
  notesUrl: null,
  previous: null,
  ...p,
});

const images: ImageUpdate[] = [
  img({
    ref: "postgres:16-alpine", containers: ["shop-db"], services: ["db"], project: "shop", status: "update", kind: "patch", security: true,
    local: { digest: "sha256:f46107955874", version: "16.15", created: now() - 2 * DAY },
    remote: { digest: "sha256:9a1c0be21d77", version: "16.16", updated: now() - 9 * 3600 },
    notesUrl: "https://www.postgresql.org/docs/release/16.16/",
  }),
  img({
    ref: "jc21/nginx-proxy-manager:latest", name: "Proxy Manager", containers: ["keepwatch-proxy-1"], services: ["proxy"], project: "proxy", via: "compose",
    status: "update", kind: "patch",
    local: { digest: "sha256:4393e642e233", version: "2.16.0", created: now() - 29 * DAY },
    remote: { digest: "sha256:52b2c59994f3", version: "2.16.2", updated: now() - 3 * DAY },
    notesUrl: "https://github.com/NginxProxyManager/nginx-proxy-manager/releases",
  }),
  img({
    ref: "portainer/portainer-ce:latest", name: "Portainer", containers: ["keepwatch-portainer-1"], services: ["portainer"], project: "portainer", via: "compose",
    status: "major", kind: "major",
    local: { digest: "sha256:3609c307943b", version: "2.45.3", created: now() - 2 * DAY },
    remote: { digest: "sha256:7e0d1f2a3b4c", version: "3.0.0", updated: now() - DAY },
    notesUrl: "https://github.com/portainer/portainer/releases",
  }),
  img({
    ref: "ghcr.io/example/web:latest", containers: ["web"], services: ["web"], project: "web", status: "unknown",
    reason: "private package – ghcr.io returns nothing without a login",
    local: { digest: "sha256:c786dcb3f835", version: null, created: now() - 5 * DAY },
    previous: { ref: `ghcr.io/example/web:${PREV}`, id: "sha256:11aa22bb33cc", created: now() - 12 * DAY, version: null, savedAt: now() - DAY },
  }),
];

const stacks: Updates["stacks"] = [
  { name: "blog", id: 28, commit: "7f9d98f69fecad8b9f930faf82c8307d76617735", branch: "main", deployedAt: now() - 4 * 60, autoUpdate: null, built: ["blog-app", "blog-web"] },
  { name: "shop", id: 13, commit: "d62b1f66e70518f1a9e8159f655ad01765790b20", branch: "main", deployedAt: now() - 2 * DAY, autoUpdate: null, built: ["shop-api", "shop-frontend"] },
  { name: "wiki", id: 33, commit: "38081ed124597851dcf64241b7e59d4b17498dd5", branch: "main", deployedAt: now() - 57 * DAY, autoUpdate: "5m", built: [] },
  { name: "photos", id: 34, commit: "aab2a7285e7e456293c17760d4332ce31defdbe0", branch: "main", deployedAt: now() - 20 * DAY, autoUpdate: null, built: ["photos-photos"] },
  { name: "web", id: 29, commit: "a93e7fb74f850042ea8588462c7644ceb43416ff", branch: "main", deployedAt: now() - 7 * DAY, autoUpdate: null, built: [] },
];

const jobs: Record<string, UpdateJob & { _steps?: { at: number; step: string }[]; _end?: number; _result?: () => void }> = {
  "ghcr.io/example/web:latest": {
    key: "ghcr.io/example/web:latest", action: "update", state: "rolledBack", step: null,
    startedAt: now() - 25 * 60, finishedAt: now() - 22 * 60,
    message: "Not healthy after 2 min (web: unhealthy) – rolled back to the previous version automatically.",
  },
};

/* ---------- Security scan ---------------------------------------------------------------------------- */

const v = (id: string, pkg: string, installed: string, fixed: string | null, severity: Vuln["severity"], title: string, target = "alpine 3.22"): Vuln => ({ id, pkg, installed, fixed, severity, title, url: null, target });
const scanImg = (containers: string[], vulns: Vuln[], error: string | null = null): ScanImage => ({
  containers, vulns, error, scannedAt: now() - 2 * DAY,
  critical: vulns.filter((x) => x.severity === "CRITICAL").length, high: vulns.filter((x) => x.severity === "HIGH").length,
});
const scanImages: Record<string, ScanImage> = {
  "postgres:16-alpine": scanImg(["shop-db"], [
    v("CVE-2026-31337", "libpq", "16.15-r0", "16.16-r0", "CRITICAL", "PostgreSQL: SQL injection via crafted connection parameters"),
    v("CVE-2026-29011", "openssl", "3.5.4-r0", "3.5.5-r0", "HIGH", "OpenSSL: memory error while verifying certificate chains"),
  ]),
  "jc21/nginx-proxy-manager:latest": scanImg(["keepwatch-proxy-1"], [
    v("CVE-2026-21004", "github.com/golang-jwt/jwt/v5", "v5.2.1", "v5.2.3", "HIGH", "jwt: expiry check can be bypassed", "usr/bin/certbot"),
    v("CVE-2026-18822", "cross-spawn", "7.0.3", "7.0.5", "HIGH", "cross-spawn: ReDoS", "app/package-lock.json"),
    v("CVE-2026-17710", "libexpat", "2.6.4-r0", "2.7.0-r0", "HIGH", "expat: stack overflow on nested XML", "debian 12"),
    v("CVE-2026-16001", "perl", "5.36.0-7", null, "HIGH", "Perl: heap overflow in tr///", "debian 12"),
    v("CVE-2026-15555", "zlib1g", "1:1.2.13", null, "HIGH", "zlib: integer overflow in inflate", "debian 12"),
  ]),
  "blog-app": scanImg(["blog-app-1"], [
    v("CVE-2026-40404", "next", "15.1.2", "15.1.6", "CRITICAL", "Next.js: middleware bypass via x-middleware-subrequest", "app/package-lock.json"),
  ]),
  "ghcr.io/example/web:latest": scanImg(["web"], [], "unable to initialize the image source: context deadline exceeded"),
};
let scanUntil = 0;
let scanStart = 0;
const scanTotal = () => Object.keys(scanImages).length + 6;

function scan(): Scan {
  if (!has("image-scan")) return { enabled: false } as Scan;
  const t = Date.now();
  const running = scanUntil > t;
  if (!running && scanUntil) scanUntil = 0;
  const done = running ? Math.min(scanTotal() - 1, Math.floor(((t - scanStart) / (scanUntil - scanStart)) * scanTotal())) : 0;
  return {
    enabled: true, installed: true, running, lastResult: "success",
    progress: running ? { startedAt: Math.floor(scanStart / 1000), current: done === 0 ? "database" : `${["postgres:16-alpine", "blog-web", "photos-photos", "jc21/nginx-proxy-manager:latest"][done % 4]}`, done, total: scanTotal() } : null,
    startedAt: now() - 2 * DAY - 600, finishedAt: running ? now() - 2 * DAY : scanStart ? Math.floor(scanUntil / 1000) || now() : now() - 2 * DAY,
    ok: false, error: "Not every image could be scanned.",
    images: structuredClone(scanImages),
  };
}

let checkingUntil = 0;
let checkedAt = now() - 2 * 3600;

function tick() {
  const t = Date.now();
  for (const j of Object.values(jobs)) {
    if (j.state !== "running" || !j._steps) continue;
    const cur = [...j._steps].reverse().find((s) => t >= s.at);
    j.step = cur?.step ?? "starting …";
    if (j._end && t >= j._end) {
      j._result?.();
      j.finishedAt = now();
      j.step = null;
    }
  }
  if (checkingUntil && t >= checkingUntil) {
    checkingUntil = 0;
    checkedAt = now();
  }
}

/** Images as the server reports them: without Portainer, stacks are plain Compose projects. */
const visibleImages = () => images.map((i) => (has("portainer") || i.via !== "portainer" ? i : { ...i, via: "compose" as const }));

function status(): Updates {
  tick();
  const pub = (j: (typeof jobs)[string]): UpdateJob => ({ key: j.key, action: j.action, state: j.state, step: j.step, startedAt: j.startedAt, finishedAt: j.finishedAt, message: j.message });
  return {
    enabled: true,
    checkedAt,
    checking: checkingUntil > 0,
    error: null,
    available: images.filter((i) => i.status === "update").length,
    major: images.filter((i) => i.status === "major").length,
    images: structuredClone(visibleImages()),
    stacks: has("portainer") ? stacks : [],
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, pub(j)])),
    scan: scan(),
  };
}

const isProxy = (i: ImageUpdate) => i.ref.startsWith("jc21/nginx-proxy-manager");

function start(key: string, action: "update" | "rollback") {
  tick();
  const i = images.find((x) => x.key === key);
  if (!i) throw new Error("The update check doesn't know this image.");
  if (Object.values(jobs).some((j) => j.state === "running")) throw new Error("An update or cleanup is already running. Please wait a moment.");
  if (action === "update" && i.status === "major") throw new Error("Major version jump – this is never applied with one click.");
  if (action === "update" && i.status !== "update") throw new Error("No update is known for this image.");
  if (action === "rollback" && !i.previous) throw new Error(`There is no previous version (:${PREV}) of this image.`);
  const t = Date.now();
  const steps =
    action === "update"
      ? [
          { at: t, step: "saving the running version …" },
          ...(i.ref.startsWith("postgres") ? [{ at: t + 1500, step: `backing up the database (${i.containers[0]}) …` }] : []),
          { at: t + 3000, step: "pulling the new image and recreating …" },
          { at: t + 6000, step: `waiting for "healthy" – ${i.containers[0]}: starting` },
          ...(isProxy(i) ? [{ at: t + 9000, step: `rolling back to jc21/nginx-proxy-manager:${PREV} …` }] : []),
        ]
      : [
          { at: t, step: `rolling back to ${i.previous!.ref} …` },
          { at: t + 2500, step: `waiting for "healthy" – ${i.containers[0]}: starting` },
        ];
  const old = { ...i.local };
  jobs[key] = {
    key, action, state: "running", step: steps[0].step, startedAt: now(), finishedAt: null, message: null,
    _steps: steps,
    _end: t + (action === "update" ? (isProxy(i) ? 12000 : 9000) : 5000),
    _result: () => {
      const j = jobs[key];
      if (action === "rollback") {
        Object.assign(j, { state: "ok", message: `${i.ref} is running the previous version again.` });
        i.local = { digest: i.previous!.id, version: i.previous!.version, created: i.previous!.created };
        return;
      }
      i.previous = { ref: i.ref.replace(/:[^:/]+$/, `:${PREV}`), id: old.digest ?? "", created: old.created, version: old.version, savedAt: now() };
      if (isProxy(i)) {
        Object.assign(j, { state: "rolledBack", message: "Not healthy after 2 min (keepwatch-proxy-1: unhealthy) – rolled back to the previous version automatically." });
        return;
      }
      Object.assign(j, { state: "ok", message: `${i.ref} is updated to ${i.remote?.version}.` });
      if (scanImages[i.ref]) scanImages[i.ref] = scanImg(scanImages[i.ref].containers, scanImages[i.ref].vulns.filter((x) => !x.fixed));
      i.local = { digest: i.remote?.digest ?? null, version: i.remote?.version ?? null, created: now() };
      Object.assign(i, { status: "current", kind: null, security: false });
    },
  };
  return { ok: true, job: status().jobs[key] };
}

/* ---------- Cleanup ------------------------------------------------------------------------------------ */

const clean = { images: 6.8 * GB, volumes: 7.6 * GB, buildCache: 5.5 * GB, containers: 0.21 * GB, cacheFree: 5.3 * GB, unused: 3.1 * GB, unusedCount: 4 };

function cleanup(): Cleanup {
  return {
    total: clean.images + clean.volumes + clean.buildCache + clean.containers,
    parts: { images: clean.images, volumes: clean.volumes, buildCache: clean.buildCache, containers: clean.containers },
    buildCache: { bytes: clean.cacheFree },
    images: {
      bytes: clean.unused, count: clean.unusedCount,
      items: clean.unusedCount ? [{ ref: "shop-api:<none>", size: 1.9 * GB }, { ref: "blog-app:<none>", size: 0.8 * GB }, { ref: "node:20-alpine", size: 0.25 * GB }, { ref: "sha256:5d2e91ac7f0b", size: 0.15 * GB }] : [],
    },
    kept: images.filter((i) => i.previous).map((i) => ({ ref: i.previous!.ref, size: 0.27 * GB })),
    containers: { bytes: 0, count: 0, items: [] },
  };
}

/* ---------- Router ------------------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFF = { enabled: false };

/** Answers the update/cleanup endpoints, otherwise undefined. */
export async function mockUpdates(method: string, path: string, body: unknown): Promise<unknown> {
  const mine = path === "/api/updates" || path === "/api/cleanup" || path.startsWith("/api/updates/");
  if (!mine) return undefined;
  if (path === "/api/updates/scan" && !has("image-scan")) throw new Error("The image-scan module is not enabled.");
  if (!has("docker")) {
    if (method === "GET" && path === "/api/updates") return OFF;
    throw new Error("The docker module is not enabled.");
  }
  if (method === "GET" && path === "/api/updates") return status();
  if (method === "GET" && path === "/api/cleanup") return cleanup();
  if (method !== "POST") return undefined;
  if (path === "/api/updates/scan") {
    if (scanUntil <= Date.now()) {
      scanStart = Date.now();
      scanUntil = scanStart + 20000;
    }
    return { ok: true, running: true };
  }
  if (path === "/api/updates/check") {
    checkingUntil = Date.now() + 2500;
    return { ok: true, checking: true };
  }
  if (path === "/api/updates/apply" || path === "/api/updates/rollback") {
    return start(String((body as { key?: string })?.key ?? ""), path.endsWith("apply") ? "update" : "rollback");
  }
  if (path === "/api/cleanup") {
    const b = body as { buildCache?: boolean; images?: boolean; containers?: boolean };
    await wait(2500);
    let freed = 0;
    if (b.buildCache) {
      freed += clean.cacheFree;
      clean.buildCache -= clean.cacheFree;
      clean.cacheFree = 0;
    }
    if (b.images) {
      freed += clean.unused * 0.94; // real savings a bit smaller than estimated (shared layers)
      clean.images -= clean.unused * 0.94;
      clean.unused = 0;
      clean.unusedCount = 0;
    }
    return { ok: true, freed, message: `${(freed / GB).toFixed(1)} GB freed.` };
  }
  return undefined;
}

/** For the mock's health list (dock dot while a security patch is open). Nothing without docker. */
export function mockUpdateProblems(): Problem[] {
  if (!has("docker") || !has("image-scan")) return [];
  return images
    .filter((i) => i.status === "update" && i.security)
    .map((i) => ({
      level: "warn" as const,
      area: "docker" as const,
      key: "image.security-patch",
      title: `Security patch for ${i.ref}`,
      detail: `New version (${i.local.version} → ${i.remote?.version}). Update it under Services.`,
    }));
}
