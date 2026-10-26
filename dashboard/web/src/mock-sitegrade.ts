/**
 * Mock for the security grade (?mock). Shaped like a real run of sitegrade.py:
 * example.com / old.example.com A 95 · blog.example.com B 82 · shop.example.com D, wiki.example.com D,
 * photos.example.com C (behind allow-lists, checked "app directly"). One state is there to try things out:
 * wiki.example.com without HSTS – "Turn on HSTS" brings back 6 points. "Check now" shows the checking state;
 * sites created by the wizard show up as "not checked" and then as "unreachable". Score and grade are
 * calculated like sitegrade.py. Without image-scan there are no software (Trivy) checks; without proxy: {"enabled": false}.
 */
import { has } from "./config";
import type { Site } from "./types";
import type { CategoryId, CheckStatus, CheckVia, Grade, GradeCategory, GradeCheck, GradeFix, SiteGrade, SiteGrades, SiteVia } from "./sitegrade";

const now = () => Math.floor(Date.now() / 1000);

const CATS: { id: CategoryId; title: string; checks: Record<string, number> }[] = [
  { id: "transport", title: "Transport", checks: { "tls-versions": 6, "tls-ciphers": 5, cert: 8, "https-redirect": 5, hsts: 6 } },
  { id: "header", title: "Headers", checks: { csp: 10, frame: 5, xcto: 4, referrer: 3, permissions: 3 } },
  { id: "cookies", title: "Cookies & session", checks: { cookies: 10 } },
  { id: "leak", title: "Information leaks", checks: { leak: 3, errors: 2 } },
  { id: "access", title: "Access protection", checks: { login: 10, admin: 5 } },
  { id: "software", title: "Software", checks: { "vuln-critical": 10, "vuln-high": 5 } },
];
const TITLES: Record<string, string> = {
  "tls-versions": "TLS versions", "tls-ciphers": "Cipher suites", cert: "Certificate", "https-redirect": "HTTP → HTTPS",
  hsts: "HSTS", csp: "Content-Security-Policy", xcto: "X-Content-Type-Options", frame: "Clickjacking protection", referrer: "Referrer-Policy",
  permissions: "Permissions-Policy", leak: "Version disclosure", errors: "Error pages", cookies: "Cookies", login: "Login protection",
  admin: "Admin area", "vuln-critical": "Critical vulnerabilities", "vuln-high": "High vulnerabilities",
};
const CAP_MAX: Record<string, number> = { B: 89, C: 79, D: 69, E: 59, F: 49 };
const LIMITS: [number, Grade][] = [[90, "A"], [80, "B"], [70, "C"], [60, "D"], [50, "E"], [0, "F"]];

type Raw = [string, string] | { id: string; status: CheckStatus; summary: string; detail?: string; fix?: GradeFix; via?: CheckVia };
interface RawSite {
  id: number;
  domain: string;
  via: SiteVia;
  status: number;
  appStatus?: number;
  admin?: { path: string; status: number }[];
  caps?: { grade: Grade; max: number; reason: string }[];
  checks: Raw[];
}

/* ---------- building blocks (the same findings repeat across sites) ---------------------------------- */

const TLS: Raw[] = [
  ["tls-versions", "Only TLS 1.2 and 1.3 – 1.0 and 1.1 are off."],
  ["tls-ciphers", "Only modern ciphers with forward secrecy."],
];
const cert = (days: number): Raw => ["cert", `Valid for ${days} more days, chain complete.`];
const REDIRECT: Raw = ["https-redirect", "Permanently redirects to HTTPS."];
const HSTS_OK: Raw = ["hsts", "HSTS for 730 days including subdomains."];
const HEADERS_OK: Raw[] = [
  ["csp", "Strict CSP without unsafe-inline/unsafe-eval for scripts."],
  ["frame", "frame-ancestors 'none'."],
  ["xcto", "nosniff set."],
  ["referrer", "Referrer-Policy set."],
  ["permissions", "Permissions-Policy set."],
];
const NO_COOKIES: Raw = ["cookies", "Sets no cookies."];
const NO_LEAK: Raw = ["leak", "No versions disclosed."];
const ERRORS_OK: Raw = ["errors", "Error pages without versions or stack traces."];
const NO_LOGIN: Raw = ["login", "No login found – nothing to guess."];
const NO_ADMIN: Raw = ["admin", "No public admin area found."];
const NO_CRIT: Raw = ["vuln-critical", "No critical vulnerabilities."];

const APP_NOTE =
  "Best set in the app, so it applies everywhere. In the Proxy Manager it only works with a custom \"location /\" block under Advanced – nginx drops add_header from the server block as soon as the host sets HSTS.";
const REBUILD =
  "Locally built images: update the base image in the Dockerfile (or pull it again without cache) and redeploy the service. Images from a registry: apply the update on the Updates page. Then run the scan again.";
const REGISTRY = "Images from a registry: apply the update on the Updates page. Then run the scan again.";

/** Missing security headers, checked directly at the app. `next`: fix in next.config.js, else in the app's nginx.conf. */
function appHeaders(container: string, next: boolean): Raw[] {
  const where = next ? `next.config.js → headers() – container ${container}` : `App config (nginx.conf or server code) – container ${container}`;
  const snip = (key: string, value: string) =>
    next
      ? `// next.config.js\nasync headers() {\n  return [{ source: "/(.*)", headers: [\n    { key: "${key}", value: "${value}" },\n  ] }];\n}`
      : `add_header ${key} "${value}" always;`;
  const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  return [
    {
      id: "csp",
      status: "fail",
      summary: "No Content-Security-Policy.",
      detail: "Without a CSP any injected script may run (cross-site scripting). The CSP defines where scripts, images and connections may come from.",
      fix: { where, text: `Start with a strict base rule and allow what the site needs (the browser console shows violations). ${APP_NOTE}`, snippet: snip("Content-Security-Policy", CSP), action: null },
      via: "app",
    },
    {
      id: "frame",
      status: "fail",
      summary: "Can be embedded in other sites.",
      detail: "Neither X-Frame-Options nor frame-ancestors. A foreign page can embed this one invisibly and hijack clicks (clickjacking).",
      fix: { where, text: `Or set frame-ancestors 'none' (or 'self') in the CSP. ${APP_NOTE}`, snippet: snip("X-Frame-Options", "DENY"), action: null },
      via: "app",
    },
    {
      id: "xcto",
      status: "fail",
      summary: "X-Content-Type-Options missing.",
      detail: "Browsers may guess the file type and, for example, run an uploaded text file as a script.",
      fix: { where, text: APP_NOTE, snippet: snip("X-Content-Type-Options", "nosniff"), action: null },
      via: "app",
    },
    {
      id: "referrer",
      status: "warn",
      summary: "Referrer-Policy missing.",
      detail: "Browsers then use their default (usually strict-origin-when-cross-origin). Better set it explicitly, so paths with tokens or ids don't leak to other sites.",
      fix: { where, text: APP_NOTE, snippet: snip("Referrer-Policy", "strict-origin-when-cross-origin"), action: null },
      via: "app",
    },
    {
      id: "permissions",
      status: "warn",
      summary: "Permissions-Policy missing.",
      detail: "Defines which device features (camera, microphone, location) the site and embedded third-party content may use. Without the header the browser alone decides.",
      fix: { where, text: APP_NOTE, snippet: snip("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"), action: null },
      via: "app",
    },
  ];
}

const appOk = (id: string, summary: string): Raw => ({ id, status: "ok", summary, via: "app" });
const behindList = (n: number): Raw[] => [
  ["login", `Only allow-listed addresses (${n}) reach the app.`],
  ["admin", "Admin area only reachable through the allow-list."],
];

/** Trivy findings. `local`: images built from a repo (rebuild), else registry images (update). */
function vuln(id: "vuln-critical" | "vuln-high", status: CheckStatus, summary: string, scan: string, examples: string, local: string[] = []): Raw {
  return {
    id,
    status,
    summary,
    detail: `Scan from Oct 23: ${scan}. ${examples}`,
    fix: { where: local.length ? `Updates → Security scan · rebuild ${local.join(", ")} from the repo` : "Updates → Security scan", text: local.length ? REBUILD : REGISTRY, snippet: null, action: null },
  };
}

const HSTS_TWICE = (container: string): Raw => ({
  id: "hsts",
  status: "warn",
  summary: "HSTS without includeSubDomains.",
  detail:
    "Sent: \"max-age=31536000\". There are 2 HSTS headers – browsers only honour the first one (the app's, not the Proxy Manager's). Subdomains (e.g. www.) aren't covered; an attacker could set cookies for the main domain through an unencrypted subdomain.",
  fix: {
    where: `App config (nginx.conf or server code) – container ${container}`,
    text: "The app sends its own HSTS header, and it comes before the Proxy Manager's. Remove the line from the app (the Proxy Manager already sets HSTS) or extend it like this:",
    snippet: 'add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;',
    action: null,
  },
});

const WEB_SCAN = "ghcr.io/example/web:latest: 0 critical, 1 high";
const WEB_HIGH = vuln("vuln-high", "warn", "1 high vulnerability with a fix.", WEB_SCAN, "CVE-2026-111497 in brotli-libs 1.2.0-r1 → 1.2.1-r0 (ghcr.io/example/web:latest).");

/* ---------- sites ----------------------------------------------------------------------------------- */

const DATA: RawSite[] = [
  {
    id: 3,
    domain: "shop.example.com",
    via: "app",
    status: 403,
    appStatus: 200,
    checks: [
      ...TLS,
      cert(72),
      REDIRECT,
      HSTS_OK,
      ...appHeaders("shop-frontend", true),
      {
        id: "leak",
        status: "warn",
        summary: "Discloses software.",
        detail: "X-Powered-By: Next.js. Helps attackers look up matching known vulnerabilities.",
        fix: { where: "next.config.js – container shop-frontend", text: "Turn it off in the app, or hide it in the Proxy Manager under Advanced (proxy_hide_header also works for location / there).", snippet: "// next.config.js\npoweredByHeader: false,", action: null },
        via: "app",
      },
      appOk("cookies", "Sets no cookies."),
      appOk("errors", "Error pages without versions or stack traces."),
      ...behindList(3),
      vuln(
        "vuln-critical",
        "fail",
        "6 critical vulnerabilities with a fix.",
        "postgres:16-alpine: 1 critical, 25 high · shop-api: 2 critical, 22 high · shop-frontend: 5 critical, 14 high",
        "With a fix: CVE-2025-68121 in stdlib v1.24.6 → 1.24.13 (postgres:16-alpine); CVE-2026-75604 in next 16.3.0 → 16.3.3 (shop-frontend); GHSA-2464-fhr4-w9xw in next 16.3.0 → 16.4.1 (shop-frontend).",
        ["shop-api", "shop-frontend"],
      ),
      vuln(
        "vuln-high",
        "fail",
        "38 high vulnerabilities with a fix.",
        "postgres:16-alpine: 1 critical, 25 high · shop-api: 2 critical, 22 high · shop-frontend: 5 critical, 14 high",
        "For example: CVE-2025-61726 in stdlib v1.24.6 → 1.24.12 (postgres:16-alpine); CVE-2025-61729 in stdlib v1.24.6 → 1.24.11 (postgres:16-alpine); CVE-2026-111943 in stdlib v1.24.6 → 1.26.10 (postgres:16-alpine).",
        ["shop-api", "shop-frontend"],
      ),
    ],
  },
  {
    id: 7,
    domain: "old.example.com",
    via: "public",
    status: 404,
    checks: [...TLS, cert(65), REDIRECT, HSTS_TWICE("web"), ...HEADERS_OK, NO_LEAK, NO_COOKIES, ERRORS_OK, NO_LOGIN, NO_ADMIN, NO_CRIT, WEB_HIGH],
  },
  {
    id: 8,
    domain: "blog.example.com",
    via: "public",
    status: 200,
    admin: [{ path: "/admin", status: 200 }],
    checks: [
      ...TLS,
      cert(74),
      REDIRECT,
      ["hsts", "HSTS for 365 days including subdomains."],
      ...HEADERS_OK,
      NO_LEAK,
      NO_COOKIES,
      {
        id: "errors",
        status: "warn",
        summary: "Error page discloses nginx 1.30.6.",
        detail: "A page that doesn't exist (/keepwatch-38b34803 → 404) names \"nginx/1.30.6\". Knowing the version makes it easy to look for matching vulnerabilities.",
        fix: { where: "App config (nginx.conf or server code) – container blog-web", text: "Set \"server_tokens off;\" in the app's nginx config (http or server block); error pages then only say \"nginx\".", snippet: "server_tokens off;", action: null },
      },
      ["login", "Login is protected against brute force."],
      {
        id: "admin",
        status: "warn",
        summary: "/admin is reachable from the internet.",
        detail: "https://blog.example.com/admin → 200, asks for a login. Anyone can try passwords there; a flaw in the login would hit right away.",
        fix: { where: "Services → blog.example.com (#8) → Access → Admin paths", text: "Add /admin there and allow only your own addresses – everyone else gets a 403, the rest of the site stays public.", snippet: null, action: null },
      },
      vuln(
        "vuln-critical",
        "fail",
        "1 critical vulnerability with a fix.",
        "blog-app: 0 critical, 4 high · blog-web: 1 critical, 44 high",
        "With a fix: CVE-2026-31789 in libcrypto3 3.3.3-r0 → 3.3.7-r0 (blog-web).",
        ["blog-app", "blog-web"],
      ),
      vuln(
        "vuln-high",
        "fail",
        "47 high vulnerabilities with a fix.",
        "blog-app: 0 critical, 4 high · blog-web: 1 critical, 44 high",
        "For example: CVE-2026-102276 in brace-expansion 5.0.9 → 5.0.10 (blog-app); CVE-2026-102278 in brace-expansion 5.0.9 → 5.0.11 (blog-app); CVE-2026-19534 in undici 6.28.0 → 6.28.1 (blog-app).",
        ["blog-app", "blog-web"],
      ),
    ],
  },
  {
    id: 10,
    domain: "example.com",
    via: "public",
    status: 200,
    admin: [{ path: "/admin", status: 403 }],
    checks: [
      ...TLS,
      cert(75),
      REDIRECT,
      HSTS_TWICE("web"),
      ...HEADERS_OK,
      NO_LEAK,
      NO_COOKIES,
      ERRORS_OK,
      ["login", "Login only reachable from the allow-list (/admin)."],
      ["admin", "/admin answers 403 for everyone not on the list."],
      NO_CRIT,
      WEB_HIGH,
    ],
  },
  {
    id: 11,
    domain: "wiki.example.com",
    via: "app",
    status: 403,
    appStatus: 200,
    checks: [
      ...TLS,
      cert(5),
      REDIRECT,
      HSTS_OK,
      ...appHeaders("wiki", false),
      appOk("leak", "No versions disclosed."),
      appOk("cookies", "Sets no cookies."),
      appOk("errors", "Error pages without versions or stack traces."),
      ...behindList(2),
      vuln("vuln-critical", "fail", "1 critical vulnerability with a fix.", "ghcr.io/example/wiki:latest: 1 critical, 4 high", "With a fix: CVE-2026-90711 in proxy-addr 2.0.7 → 2.0.8 (ghcr.io/example/wiki:latest)."),
      vuln(
        "vuln-high",
        "warn",
        "3 high vulnerabilities with a fix.",
        "ghcr.io/example/wiki:latest: 1 critical, 4 high",
        "CVE-2026-102276 in brace-expansion 5.0.9 → 5.0.10; CVE-2026-102278 in brace-expansion 5.0.9 → 5.0.11; CVE-2026-19534 in undici 6.28.0 → 6.28.1 (ghcr.io/example/wiki:latest).",
      ),
    ],
  },
  {
    id: 12,
    domain: "photos.example.com",
    via: "app",
    status: 403,
    appStatus: 200,
    checks: [
      ...TLS,
      cert(64),
      REDIRECT,
      HSTS_OK,
      ...appHeaders("photos", false),
      appOk("leak", "No versions disclosed."),
      appOk("cookies", "Sets no cookies."),
      appOk("errors", "Error pages without versions or stack traces."),
      ...behindList(3),
      NO_CRIT,
      vuln("vuln-high", "warn", "1 high vulnerability with a fix.", "photos-photos: 0 critical, 1 high", "CVE-2026-111497 in brotli-libs 1.2.0-r1 → 1.2.1-r0 (photos-photos).", ["photos-photos"]),
    ],
  },
];

let wikiHsts = false;

/** The wiki without HSTS (made up, so "Turn on HSTS" has something to do). */
const NO_HSTS: Raw = {
  id: "hsts",
  status: "fail",
  summary: "No HSTS.",
  detail: "The browser may ask over plain HTTP again on the next visit; an attacker on the same network can exploit that.",
  fix: {
    where: "Proxy Manager → Proxy Hosts → wiki.example.com (#11) → SSL → \"HSTS Enabled\"",
    text: "Turn on HSTS in the Proxy Manager. Browsers then remember for 2 years to open the site over HTTPS only – even when someone types http:// or an attacker redirects.",
    snippet: null,
    action: "hsts",
  },
};

function build(r: RawSite, ago: number): SiteGrade {
  const catOf = (cid: string) => CATS.find((c) => cid in c.checks)!;
  const scan = has("image-scan");
  const checks: GradeCheck[] = r.checks
    .map((x) => {
      const raw = r.id === 11 && !wikiHsts && (Array.isArray(x) ? x[0] : x.id) === "hsts" ? NO_HSTS : x;
      const o = Array.isArray(raw) ? { id: raw[0], status: "ok" as CheckStatus, summary: raw[1] } : raw;
      const cat = catOf(o.id);
      const weight = cat.checks[o.id];
      return {
        id: o.id,
        category: cat.id,
        title: TITLES[o.id] ?? o.id,
        status: o.status,
        weight,
        deduction: o.status === "fail" ? weight : o.status === "warn" ? weight / 2 : 0,
        summary: o.summary,
        detail: ("detail" in o && o.detail) || "",
        fix: ("fix" in o && o.fix) || null,
        via: ("via" in o && o.via) || (cat.id === "software" ? "scan" : "public"),
      } satisfies GradeCheck;
    })
    // Without image-scan there is no Trivy scan to grade software with.
    .filter((c) => scan || c.via !== "scan");
  const cats = scan ? CATS : CATS.filter((c) => c.id !== "software");
  const categories: GradeCategory[] = cats.map((c) => {
    const mine = checks.filter((k) => k.category === c.id);
    const max = Object.values(c.checks).reduce((a, b) => a + b, 0);
    return {
      id: c.id,
      title: c.title,
      max,
      points: Math.max(0, max - mine.reduce((n, k) => n + k.deduction, 0)),
      problems: mine.filter((k) => k.status === "warn" || k.status === "fail").length,
      skipped: mine.length > 0 && mine.every((k) => k.status === "skip"),
    };
  });
  const total = categories.reduce((n, c) => n + c.max, 0);
  const raw = Math.floor((categories.reduce((n, c) => n + c.points, 0) * 100) / total + 0.5);
  const score = Math.min(raw, ...(r.caps ?? []).map((c) => CAP_MAX[c.grade] ?? 100));
  const grade = LIMITS.find(([min]) => score >= min)![1];
  const limited = r.via !== "public";
  return {
    schema: 2,
    id: r.id,
    domain: r.domain,
    checkedAt: now() - ago,
    grade,
    score,
    raw,
    via: r.via,
    limited,
    limitedNote: r.via === "app" ? "behind an allow-list – app checked directly" : r.via === "lock" ? "behind an allow-list, only the block page checked" : null,
    status: r.status,
    appStatus: r.appStatus ?? null,
    url: `https://${r.domain}/`,
    loginUrl: null,
    admin: r.admin ?? [],
    caps: r.caps ?? [],
    categories,
    checks,
    error: null,
    durationMs: 640,
  };
}

let checkingUntil = 0;
let checkingIds: number[] | null = null;
const tried = new Set<number>();

function state(sites: Site[]): SiteGrades {
  const busy = Date.now() < checkingUntil;
  if (!busy && checkingIds) {
    checkingIds.forEach((id) => tried.add(id));
    checkingIds = null;
  }
  const known = DATA.map((r) => build(r, r.id === 11 && wikiHsts ? 0 : 2 * 3600));
  // Sites from the wizard: not checked at first, unreachable after "Check now" (certificate still missing).
  const extra: SiteGrade[] = sites
    .filter((s) => !known.some((g) => g.id === s.id) && tried.has(s.id))
    .map((s) => ({ schema: 2, id: s.id, domain: s.domains[0], checkedAt: now(), grade: null, score: null, raw: null, via: "public", limited: false, limitedNote: null, status: null, url: null, loginUrl: null, caps: [], categories: [], checks: [], error: "Not reachable over HTTPS: [SSL: TLSV1_UNRECOGNIZED_NAME] tlsv1 unrecognized name" }));
  const list = [...known, ...extra].filter((g) => sites.some((s) => s.id === g.id));
  const checking = busy ? sites.filter((s) => !checkingIds || checkingIds.includes(s.id)).map((s) => s.domains[0]) : [];
  return {
    checkedAt: now() - 2 * 3600,
    checking,
    error: null,
    every: 21600,
    npmWrite: true,
    schema: 2,
    alertBelow: 80,
    grades: LIMITS.map(([min, grade]) => ({ grade, min })),
    categories: (has("image-scan") ? CATS : CATS.filter((c) => c.id !== "software")).map((c) => ({ id: c.id, title: c.title, max: Object.values(c.checks).reduce((a, b) => a + b, 0), checks: Object.entries(c.checks).map(([id, weight]) => ({ id, title: TITLES[id], weight })) })),
    sites: list.map((g) => ({ ...g, checking: checking.includes(g.domain) })),
  };
}

export async function mockSiteGrade(method: string, p: string, body: unknown, sites: () => Site[]): Promise<unknown> {
  if (!p.startsWith("/api/sitegrade")) return undefined;
  if (!has("proxy")) return { enabled: false };
  const b = (body ?? {}) as { id?: number; fix?: string };
  if (method === "GET" && p === "/api/sitegrade") return state(sites());
  if (method === "POST" && p === "/api/sitegrade/check") {
    checkingUntil = Date.now() + 2800;
    checkingIds = typeof b.id === "number" ? [b.id] : sites().map((s) => s.id);
    return { ok: true, checking: true };
  }
  if (method === "POST" && p === "/api/sitegrade/fix") {
    if (b.fix !== "hsts" && b.fix !== "force-ssl") throw new Error('fix must be "hsts" or "force-ssl".');
    if (b.id === 11 && b.fix === "hsts") wikiHsts = true;
    checkingUntil = Date.now() + 2200;
    checkingIds = [b.id ?? 0];
    const dom = sites().find((s) => s.id === b.id)?.domains[0] ?? "?";
    return { ok: true, message: `${b.fix === "hsts" ? "HSTS is on" : "HTTPS is forced"} for ${dom}. The grade is being recalculated.` };
  }
  throw new Error("Unknown endpoint.");
}
