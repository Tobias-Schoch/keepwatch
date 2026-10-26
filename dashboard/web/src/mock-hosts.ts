/**
 * Mock for the "New site" wizard (/api/hosts/*, /api/settings/npm).
 * Hooked into mock.ts, which passes in its containers and access lists.
 *
 * Try it (domain input):
 *   example.com, photos.example.com …  → already exists
 *   …wrong…                            → A points elsewhere
 *   …v6…                               → AAAA points elsewhere
 *   …no-dns…                           → no record
 *   …fail…                             → certificate fails, host is rolled back
 *   anything else                      → works
 * Target: containers without the shared proxy network (blog-app-1, shop-db) are not reachable;
 * a port nothing listens on gives a 502 in the request test.
 * ?mock&npm=off starts without a Proxy Manager login. Without the proxy module: {"enabled": false}.
 */
import { has } from "./config";
import type { DnsResult, DomainCheck, HostDefaults, HostJob, IpList, NewHostBody, NpmStatus, Target, WizardData } from "./hosts";
import type { AccessEntry, AccessHost, Container, Site } from "./types";
import { addressCount, normalize } from "./ip";

export const NOT_MINE = Symbol("not-hosts");

export interface MockHostsCtx {
  containers: Container[];
  /** Target (container:port) and domains of the existing sites. */
  sites: () => Site[];
  access: AccessHost[];
  myIps: string[];
}

const now = () => Math.floor(Date.now() / 1000);
const SERVER = { v4: ["203.0.113.10"], v6: ["2001:db8:46:3a00::1"] };

/** Ports per container (listening / EXPOSE). */
const PORTS: Record<string, { listening: number[]; exposed: number[]; service: string; compose: string }> = {
  "keepwatch-portainer-1": { listening: [8000, 9000, 9443], exposed: [8000, 9000, 9443], service: "portainer", compose: "/opt/keepwatch/compose.yml" },
  web: { listening: [3000], exposed: [3000], service: "web", compose: "/data/compose/29/docker-compose.yml" },
  photos: { listening: [8080], exposed: [80, 8080], service: "photos", compose: "/data/compose/34/docker-compose.yml" },
  "shop-frontend": { listening: [3000], exposed: [3000], service: "frontend", compose: "/data/compose/13/docker-compose.yml" },
  "shop-api": { listening: [8000], exposed: [8000], service: "api", compose: "/data/compose/13/docker-compose.yml" },
  "shop-db": { listening: [5432], exposed: [5432], service: "db", compose: "/data/compose/13/docker-compose.yml" },
  wiki: { listening: [3000], exposed: [3000], service: "wiki", compose: "/data/compose/33/docker-compose.yml" },
  "blog-web": { listening: [8080], exposed: [80, 8080], service: "web", compose: "/data/compose/28/docker-compose.yml" },
  "blog-app-1": { listening: [9000], exposed: [9000], service: "app", compose: "/data/compose/28/docker-compose.yml" },
};

const npm: NpmStatus = {
  configured: !new URLSearchParams(location.search).has("npm"),
  email: new URLSearchParams(location.search).has("npm") ? null : "admin@example.com",
  connected: !new URLSearchParams(location.search).has("npm"),
  reason: null,
  checkedAt: now(),
  url: "http://127.0.0.1:9001",
};

const DEFAULTS: HostDefaults = {
  values: { certificate: true, sslForced: true, hsts: true, hstsSubdomains: true, http2: true, blockExploits: true, caching: true, websockets: false },
  counts: { certificate: 6, sslForced: 6, hsts: 5, hstsSubdomains: 3, http2: 4, blockExploits: 6, caching: 4, websockets: 1 },
  basis: 6,
};

/* ---------- newly created sites (for mock.ts → /api/sites) ------------------------------------------ */

const created: Site[] = [];
let nextId = 20;
export const mockNewSites = (): Site[] => created;

/* ---------- building blocks -------------------------------------------------------------------------- */

function targets(ctx: MockHostsCtx): Target[] {
  const npmC = ctx.containers.find((c) => c.image.startsWith("jc21/nginx-proxy-manager"));
  const nets = (npmC?.networks ?? []).filter((n) => n !== "bridge");
  const bySite = new Map<string, string[]>();
  for (const s of ctx.sites()) {
    const host = s.target.split(":")[0];
    bySite.set(host, [...(bySite.get(host) ?? []), ...s.domains]);
  }
  return ctx.containers
    .filter((c) => c !== npmC && c.state === "running")
    .map((c) => {
      const p = PORTS[c.name] ?? { listening: [3000], exposed: [3000], service: c.name, compose: null };
      const shared = c.networks.filter((n) => nets.includes(n));
      const cand = p.listening.length ? p.listening : p.exposed;
      return {
        name: c.name,
        image: c.image,
        project: c.project,
        service: p.service,
        composeFile: p.compose,
        networks: c.networks,
        shared,
        reachable: shared.length > 0,
        hostNetwork: false,
        listening: p.listening,
        exposed: p.exposed,
        suggestedPort: cand[0] ?? null,
        sites: bySite.get(c.name) ?? [],
      };
    })
    .sort((a, b) => (a.project ?? "~").localeCompare(b.project ?? "~", "en") || Number(a.sites.length > 0) - Number(b.sites.length > 0) || Number(!a.reachable) - Number(!b.reachable) || a.name.localeCompare(b.name));
}

function ipLists(ctx: MockHostsCtx): IpList[] {
  const byValue = new Map<string, { value: string; note: string; sites: string[] }>();
  for (const h of ctx.access) {
    if (h.mode !== "list") continue;
    for (const e of h.entries) {
      const cur = byValue.get(e.value) ?? { value: e.value, note: "", sites: [] };
      if (e.note && !cur.note) cur.note = e.note;
      if (!cur.sites.includes(h.domains[0])) cur.sites.push(h.domains[0]);
      byValue.set(e.value, cur);
    }
  }
  const groups = new Map<string, IpList>();
  for (const e of byValue.values()) {
    const name = e.note || e.value;
    const g = groups.get(name) ?? { name, named: !!e.note, entries: [], sites: [] };
    g.entries.push({ value: e.value, note: e.note, addresses: addressCount(e.value) });
    e.sites.forEach((s) => !g.sites.includes(s) && g.sites.push(s));
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => Number(!a.named) - Number(!b.named) || a.name.localeCompare(b.name));
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function cleanDomain(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].split(":")[0].replace(/^\.+|\.+$/g, "");
  if (!s) throw new Error("Enter a domain, e.g. app.example.com.");
  try {
    s = new URL(`http://${s}`).hostname;
  } catch {
    throw new Error(`"${raw}" is not a valid domain.`);
  }
  const labels = s.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) throw new Error(`"${raw}" is not a valid domain.`);
  return s;
}

const domainList = (d: string, www: boolean) => (www && !d.startsWith("www.") ? [d, `www.${d}`] : [d]);

function dns(name: string): DnsResult {
  const cname = name.endsWith(".example.com") ? "example.com" : null;
  if (name.includes("no-dns")) return { name, a: [], aaaa: [], cname: null, ok: false, problem: `No A record found. Add an A record "${name}" → ${SERVER.v4[0]} at your DNS provider.` };
  if (name.includes("wrong")) return { name, a: ["192.0.2.153"], aaaa: [], cname: null, ok: false, problem: `A points to 192.0.2.153 instead of ${SERVER.v4[0]}.` };
  if (name.includes("v6"))
    return { name, a: [SERVER.v4[0]], aaaa: ["2001:db8:8000::153"], cname, ok: false, problem: `AAAA points to 2001:db8:8000::153. Let's Encrypt prefers IPv6 and would not end up here – delete the AAAA record or set it to ${SERVER.v6[0]}.` };
  return { name, a: [SERVER.v4[0]], aaaa: [], cname, ok: true, problem: null };
}

function taken(ctx: MockHostsCtx, names: string[]) {
  const all = ctx.sites();
  return names.flatMap((n) => {
    const s = all.find((x) => x.domains.includes(n));
    return s ? [{ domain: n, kind: "proxy host", id: s.id }] : [];
  });
}

/* ---------- jobs --------------------------------------------------------------------------------------- */

interface MockJob {
  job: HostJob;
  start: number;
  body: NewHostBody;
  names: string[];
  fail: boolean;
  deadPort: boolean;
  entries: { value: string; note: string }[];
  hostId: number;
  done: boolean;
}
const jobs = new Map<string, MockJob>();

/** Timeline (ms from start): host 0.9 s · certificate until 5.2 s · HTTPS 1 s · test 1 s. */
function advance(m: MockJob, ctx: MockHostsCtx): HostJob {
  const t = Date.now() - m.start;
  const j = m.job;
  const cert = m.body.ssl.certificate;
  const st = (k: string) => j.steps.find((s) => s.key === k)!;
  const T = { host: 900, cert: cert ? 5200 : 900, https: cert ? 6200 : 900, test: cert ? 7300 : 2000 };
  if (j.state !== "running") return j;
  const host = st("host");
  if (t < T.host) {
    host.state = "running";
    return j;
  }
  host.state = "ok";
  host.detail = `#${m.hostId} · ${m.body.forwardScheme}://${m.body.forwardHost}:${m.body.forwardPort} · ${m.entries.length ? `${m.entries.length} allow-list entries` : "public"}`;
  j.hostId = m.hostId;
  const c = st("cert");
  const h = st("https");
  if (!cert) {
    c.state = "skipped";
    c.detail = "no certificate requested";
    h.state = "skipped";
    h.detail = "HTTP only";
  } else {
    if (t < T.cert) {
      c.state = "running";
      c.detail = "Let's Encrypt is validating the domain (up to a minute)…";
      return j;
    }
    if (m.fail) {
      const msg = `The Proxy Manager returned 500: Detail: ${SERVER.v4[0]}: Invalid response from http://${m.names[0]}/.well-known/acme-challenge/pE3m9QxYc2: 404`;
      c.state = "failed";
      c.detail = msg;
      h.state = "cancelled";
      st("test").state = "cancelled";
      j.error = msg;
      j.rollback = [{ label: `Host #${m.hostId} removed again`, ok: true }];
      j.hostId = null;
      j.state = "failed";
      j.finishedAt = now();
      return j;
    }
    c.state = "ok";
    c.detail = `npm-${m.hostId + 3} · valid until ${new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10)}`;
    if (t < T.https) {
      h.state = "running";
      return j;
    }
    const on = [m.body.ssl.sslForced && "HTTPS forced", m.body.ssl.hsts && "HSTS", m.body.ssl.http2 && "HTTP/2"].filter(Boolean);
    h.state = "ok";
    h.detail = on.length ? on.join(" · ") : "Certificate installed, HTTP still allowed";
  }
  const test = st("test");
  if (t < T.test) {
    test.state = "running";
    return j;
  }
  if (m.deadPort) {
    test.state = "warning";
    test.detail = `502: the Proxy Manager can't reach ${m.body.forwardHost}:${m.body.forwardPort}. Does the container listen on this port?`;
  } else if (m.entries.length) {
    test.state = "ok";
    test.detail = "403 in 9 ms – the allow-list works (the server itself is not on it).";
  } else {
    test.state = "ok";
    test.detail = "200 in 47 ms";
  }
  j.url = `${cert ? "https" : "http"}://${m.names[0]}/`;
  j.state = "done";
  j.finishedAt = now();
  if (!m.done) {
    m.done = true;
    created.push({
      id: m.hostId,
      domains: m.names,
      target: `${m.body.forwardHost}:${m.body.forwardPort}`,
      enabled: true,
      sslForced: m.body.ssl.sslForced,
      hsts: m.body.ssl.hsts,
      allowlist: m.entries.length,
      cert: cert ? { expiresAt: now() + 90 * 86400, daysLeft: 90, issuer: "Let's Encrypt R11" } : null,
      check: { code: m.deadPort ? 502 : m.entries.length ? 403 : 200, ms: 40 },
      requests24h: 0,
      errors4xx24h: 0,
      errors5xx24h: 0,
      blocked24h: 0,
    });
    const entries: AccessEntry[] = m.entries.map((e) => ({ value: e.value, note: e.note, addresses: addressCount(e.value) }));
    ctx.access.push({ id: m.hostId, domains: m.names, mode: entries.length ? "list" : "open", entries, pathLock: { paths: [], entries: [] } });
  }
  return j;
}

/* ---------- Router ------------------------------------------------------------------------------ */

export async function mockHosts(method: string, url: URL, body: unknown, ctx: MockHostsCtx): Promise<unknown> {
  const p = url.pathname;
  if (!p.startsWith("/api/hosts") && !p.startsWith("/api/settings/npm")) return NOT_MINE;
  if (!has("proxy")) return { enabled: false };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  if (p === "/api/settings/npm") {
    if (method === "GET") return { ...npm };
    if (method === "PUT") {
      const { email, password } = body as { email: string; password: string };
      await wait(700);
      if (!/^[^@\s]+@[^@\s]+$/.test(email ?? "")) throw new Error("Enter the email address of the Proxy Manager user.");
      if (!password && !(npm.configured && npm.email === email)) throw new Error("Enter the password.");
      if (password === "wrong") {
        throw new Error("The Proxy Manager rejects the email or password.");
      }
      Object.assign(npm, { configured: true, email, connected: true, reason: null, checkedAt: now() });
      return { ok: true, message: "Connected to the Proxy Manager as admin@example.com." };
    }
    if (method === "DELETE") {
      Object.assign(npm, { configured: false, email: null, connected: false, reason: null, checkedAt: null });
      return { ok: true };
    }
  }
  if (p === "/api/settings/npm/test" && method === "POST") {
    await wait(600);
    if (!npm.configured) throw new Error("No login saved yet.");
    npm.checkedAt = now();
    return { ok: true, message: "Connected as admin@example.com · Proxy Manager 2.16.0." };
  }

  if (method === "GET" && p === "/api/hosts/new") {
    const npmC = ctx.containers.find((c) => c.image.startsWith("jc21/nginx-proxy-manager"));
    const nets = (npmC?.networks ?? []).filter((n) => n !== "bridge");
    return {
      npm: { ...npm },
      serverIps: SERVER,
      defaults: DEFAULTS,
      targets: { npm: { name: npmC?.name ?? null, networks: nets, join: nets.includes("proxy-net") ? "proxy-net" : nets[0] ?? null }, containers: targets(ctx) },
      ipLists: ipLists(ctx),
      myIps: ctx.myIps,
    } satisfies WizardData;
  }

  if (method === "GET" && p === "/api/hosts/check") {
    await wait(500);
    const domain = cleanDomain(url.searchParams.get("domain") ?? "");
    const names = domainList(domain, url.searchParams.get("www") === "1");
    const t = taken(ctx, names);
    const d = names.map(dns);
    return { domain, domains: names, taken: t, dns: d, serverIps: SERVER, ok: !t.length && d.every((x) => x.ok) } satisfies DomainCheck;
  }

  const jm = p.match(/^\/api\/hosts\/jobs\/([0-9a-f]{12})$/);
  if (method === "GET" && jm) {
    const m = jobs.get(jm[1]);
    if (!m) throw new Error("This job doesn't exist (anymore).");
    return structuredClone(advance(m, ctx));
  }

  if (method === "POST" && p === "/api/hosts") {
    const b = body as NewHostBody;
    const domain = cleanDomain(b.domain);
    const names = domainList(domain, b.www);
    const t = taken(ctx, names);
    if (t.length) throw new Error(`${t[0].domain} already exists in the Proxy Manager (${t[0].kind} #${t[0].id}).`);
    const target = targets(ctx).find((x) => x.name === b.forwardHost);
    if (!target) throw new Error(`The container "${b.forwardHost}" isn't running.`);
    if (!target.reachable) throw new Error(`"${b.forwardHost}" shares no network with the Proxy Manager – add the network proxy-net to the compose file and redeploy first.`);
    if (!Number.isInteger(b.forwardPort) || b.forwardPort < 1 || b.forwardPort > 65535) throw new Error("The port must be between 1 and 65535.");
    if (b.ssl.certificate) {
      const bad = names.map(dns).find((x) => !x.ok);
      if (bad) throw new Error(`${bad.name}: ${bad.problem} Without matching DNS the certificate will fail.`);
    }
    if (!npm.configured) throw new Error("No Proxy Manager login saved yet (Settings → Proxy Manager login).");
    const seen = new Set<string>();
    const entries = (b.access.mode === "list" ? b.access.entries : [])
      .map((e) => ({ value: normalize(e.value), note: e.note.replace(/[\r\n{};#]/g, " ").trim().slice(0, 80) }))
      .filter((e) => (seen.has(e.value) ? false : (seen.add(e.value), true)));
    if (b.access.mode === "list" && !entries.length) throw new Error("An empty list would lock everyone out. Open to everyone: \"Public\".");
    if ([...jobs.values()].some((x) => x.job.state === "running")) throw new Error("A site is already being created.");
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const job: HostJob = {
      id,
      state: "running",
      domain,
      domains: names,
      url: null,
      hostId: null,
      error: null,
      rollback: [],
      startedAt: now(),
      finishedAt: null,
      steps: [
        { key: "host", label: "Create host", state: "pending", detail: null },
        { key: "cert", label: "Get certificate", state: "pending", detail: null },
        { key: "https", label: "Force HTTPS", state: "pending", detail: null },
        { key: "test", label: "Test request", state: "pending", detail: null },
      ],
    };
    jobs.set(id, { job, start: Date.now(), body: b, names, fail: domain.includes("fail"), deadPort: !target.listening.includes(b.forwardPort), entries, hostId: nextId++, done: false });
    return { ok: true, job: id };
  }
  throw new Error(`Mock doesn't know ${method} ${p}.`);
}
