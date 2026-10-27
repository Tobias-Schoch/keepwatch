/**
 * Mock of the passkey check (?mock). Roughly mirrors server/touchid.py: 428 with a challenge
 * for dangerous actions once a device is registered; more devices with a passkey confirmation
 * or a pairing code (6 digits, 5 min, single use, 5 wrong attempts); removal, never the last device.
 * The signature is NOT verified here – only challenge and device. The DANGER list in the
 * backend is authoritative; the rules below only mimic it for the UI. Off with
 * ?modules=-passkey (no challenges at all), and rules of disabled modules don't apply.
 * Test with real WebAuthn: localhost + a virtual authenticator (Chrome DevTools/Playwright).
 *
 * Without an authenticator, start with demo devices (they have no key, so the mock counts a
 * confirmation as given while only demo devices exist for this address):
 *   ?mock&passkeys=demo        two devices here – pairing code, adding and removing work by click
 *   ?mock&passkeys=elsewhere   two devices at another address and a pending pairing code 123456 –
 *                              this browser can only be added with the code
 */
import { getConfig, has, type ModuleId } from "./config";
import { b64u, fromB64u, type TouchDevice, type TouchStatus } from "./touchid";

interface Sent {
  ok: boolean;
  status: number;
  data: unknown;
}
interface State {
  devices: (TouchDevice & { signCount: number; demo?: boolean })[];
  userId: string | null;
}
type Body = Record<string, unknown>;

const KEY = "mock-touchid";
const TTL = 120;
const PAIR_TTL = 300;
const PAIR_TRIES = 5;
const DEMO = new URLSearchParams(location.search).get("passkeys");
const challenges = new Map<string, { purpose: "action" | "register"; bind?: string; exp: number; name?: string; first?: boolean }>();
/** The one pending pairing code (in memory, like the backend). */
let pairing: { code: string; exp: number; tries: number } | null = DEMO === "elsewhere" ? { code: "123456", exp: Date.now() / 1000 + PAIR_TTL, tries: 0 } : null;

function demoState(): State {
  const now = Date.now() / 1000;
  const rp = DEMO === "elsewhere" ? "keepwatch.example.net" : location.hostname;
  const dev = (id: string, name: string, kind: "app" | "passkey", days: number, used: number | null) =>
    ({ id, name, kind, rpId: rp, created: now - days * 86400, lastUsed: used === null ? null : now - used, here: rp === location.hostname, signCount: 0, demo: true });
  // Ids are base64url (they end up in WebAuthn options).
  return { devices: [dev("ZGVtby1hcHAtZGV2aWNlLTE", "macOS app", "app", 40, 3600), dev("ZGVtby1rZXktZGV2aWNlLTI", "iPhone – Safari", "passkey", 12, null)], userId: "ZGVtby11c2VyLWlk" };
}

function load(): State {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as State | null;
    if (s && Array.isArray(s.devices)) return s;
  } catch {
    /* empty */
  }
  if (DEMO === "demo" || DEMO === "elsewhere") {
    const s = demoState();
    save(s);
    return s;
  }
  return { devices: [], userId: null };
}
const save = (s: State) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* fine in the mock */
  }
};

/** [method(s), path, label, condition, module]. Labels as in the backend's DANGER list. */
const RULES: [string, RegExp, string, ((b: Body) => boolean) | null, ModuleId | null][] = [
  ["PUT", /^\/api\/settings\/ssh$/, "Open port 22", (b) => b.public !== false, null],
  ["POST", /^\/api\/settings\/tailscale\/login$/, "Log in to Tailscale again (logs the server out)", null, "tailscale"],
  ["PUT", /^\/api\/settings\/fail2ban$/, "Loosen fail2ban settings", null, "fail2ban"],
  ["POST", /^\/api\/security\/unban$/, "Lift a ban", null, null],
  ["PUT", /^\/api\/access\/\d+$/, "Change IP allowlist", null, "proxy"],
  ["PUT", /^\/api\/access\/\d+\/(paths|pfade)$/, "Change path allowlist", null, "proxy"],
  ["POST", /^\/api\/hosts$/, "Create proxy host", null, "proxy"],
  ["POST", /^\/api\/modules\/[a-z0-9-]+$/, "Switch a module on or off", null, null],
  ["POST", /^\/api\/stacks\/\d+\/redeploy$/, "Redeploy stack", null, "portainer"],
  ["PUT", /^\/api\/stacks\/\d+\/env$/, "Change environment variables", null, "portainer"],
  ["GET", /^\/api\/stacks\/\d+\/env$/, "View environment variables", null, "portainer"],
  ["POST", /^\/api\/containers\/[^/]+\/stop$/, "Stop container", null, "docker"],
  ["POST", /^\/api\/updates\/(apply|rollback)$/, "Update or roll back an image", null, "docker"],
  ["POST", /^\/api\/cleanup$/, "Clean up (prune)", null, "docker"],
  ["POST", /^\/api\/self-update\/apply$/, "Install a Keepwatch update", null, null],
  ["PUT|DELETE", /^\/api\/settings\/npm$/, "Change Proxy Manager credentials", null, "proxy"],
  ["PUT", /^\/api\/settings\/portainer$/, "Change Portainer token", null, "portainer"],
  ["PUT|DELETE", /^\/api\/settings\/remote$/, "Change off-site backup target", null, "backup"],
  ["POST", /^\/api\/settings\/backup\/password$/, "Show backup password", null, "backup"],
  ["PUT", /^\/api\/settings\/backup$/, "Shorten backup retention", (b) => Number(b.keepDaily) < 7, "backup"],
  ["PUT", /^\/api\/logarchive\/settings$/, "Shorten log archive", (b) => Number(b.days) < 14, "log-archive"],
  ["POST", /^\/api\/touchid\/register\/start$/, "Add another passkey device", (b) => !b.pairCode, null],
  ["POST", /^\/api\/touchid\/pair$/, "Create pairing code", null, null],
  ["DELETE", /^\/api\/touchid\/devices\/[^/]+$/, "Remove passkey device", null, null],
];
/** What the settings list as protected: without the passkey rules themselves and without disabled modules. */
const protects = () =>
  RULES.filter((r) => !r[4] || has(r[4]))
    .map((r) => r[2])
    .filter((l, i, a) => a.indexOf(l) === i && !/passkey device|pairing code/i.test(l));

function danger(method: string, p: string, body: Body): string | null {
  for (const [m, rx, label, cond, mod] of RULES) {
    if (m.split("|").includes(method) && rx.test(p)) return (!mod || has(mod)) && (!cond || cond(body)) ? label : null;
  }
  return null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Sent => ({ ok: false, status, data: { error, ...extra } });
const okRes = (data: unknown): Sent => ({ ok: true, status: 200, data });
const rand = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const bindOf = (method: string, p: string, body: unknown) => `${method} ${p}\n${JSON.stringify(body ?? {})}`;

function newChallenge(purpose: "action" | "register", extra: { bind?: string; name?: string; first?: boolean } = {}) {
  const ch = rand(32);
  challenges.set(ch, { purpose, exp: Date.now() / 1000 + TTL, ...extra });
  return ch;
}
function take(ch: unknown) {
  const c = typeof ch === "string" ? challenges.get(ch) : undefined;
  if (typeof ch === "string") challenges.delete(ch);
  return c && c.exp >= Date.now() / 1000 ? c : null;
}
function clientData(v: unknown): { type?: string; challenge?: string; origin?: string } | null {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64u(String(v))));
  } catch {
    return null;
  }
}

function status(s: State): TouchStatus {
  const rp = location.hostname;
  const devices = s.devices.map(({ signCount: _sc, demo: _demo, ...d }) => ({ ...d, here: d.rpId === rp }));
  return {
    active: devices.length > 0,
    crypto: true,
    rpId: rp,
    rpUsable: !/^[\d.]+$/.test(rp),
    here: devices.some((d) => d.here),
    devices,
    pairing: pairing && pairing.exp > Date.now() / 1000 && devices.length ? { expires: pairing.exp } : null,
    protects: protects(),
    ttl: TTL,
  };
}

export async function mockTouchId(method: string, path: string, body: unknown, proof?: string): Promise<Sent | null> {
  const p = new URL(path, location.origin).pathname;
  const b = (body && typeof body === "object" ? body : {}) as Body;
  const s = load();
  const rp = location.hostname;
  const label = s.devices.length && getConfig().passkey ? danger(method, p, b) : null;
  if (label) {
    const devs = s.devices.filter((d) => d.rpId === rp);
    if (!devs.length) return fail(403, `"${label}" needs a passkey, but no device is set up for this address (${rp}).`);
    if (devs.every((d) => d.demo)) {
      // Demo devices have no key: count the confirmation as given.
      await wait(250);
      devs[0].lastUsed = Date.now() / 1000;
      save(s);
      return p.startsWith("/api/touchid") ? route(method, p, b, true) : null;
    }
    let msg = `"${label}" needs a passkey.`;
    if (proof) {
      let a: { id?: string; clientDataJSON?: string } = {};
      try {
        a = JSON.parse(proof);
      } catch {
        return fail(400, "The passkey response is unreadable.");
      }
      const cd = clientData(a.clientDataJSON);
      if (cd?.type !== "webauthn.get") return fail(403, "Passkey: wrong response type.");
      const c = take(cd.challenge);
      if (c) {
        if (c.purpose !== "action" || c.bind !== bindOf(method, p, body)) return fail(403, "This confirmation belongs to a different action.");
        const dev = devs.find((d) => d.id === a.id && !d.demo);
        if (!dev) return fail(403, "This device is not (or no longer) registered.");
        dev.lastUsed = Date.now() / 1000;
        save(s);
        return p.startsWith("/api/touchid") ? route(method, p, b, true) : null; // on to the actual mock
      }
      msg = "The confirmation expired – please confirm again.";
    }
    await wait(120);
    const challenge = newChallenge("action", { bind: bindOf(method, p, body) });
    return fail(428, msg, { touchid: { challenge, rpId: rp, allow: devs.filter((d) => !d.demo).map((d) => d.id), action: label, timeout: TTL * 1000 } });
  }
  return p.startsWith("/api/touchid") ? route(method, p, b, false) : null;
}

/** Uses up the pairing code – null if it fits, else the error (like _use_pair in the backend). */
function usePair(raw: unknown): Sent | null {
  const code = String(raw).replace(/[\s-]/g, "");
  if (!pairing || pairing.exp < Date.now() / 1000) {
    pairing = null;
    return fail(403, "No valid pairing code – create a new one on a registered device.");
  }
  if (/^\d{6}$/.test(code) && code === pairing.code) {
    pairing = null;
    return null;
  }
  if (++pairing.tries >= PAIR_TRIES) {
    pairing = null;
    return fail(403, "Wrong pairing code too often – create a new one on a registered device.");
  }
  return fail(403, "The pairing code is wrong.");
}

/** `confirmed`: the passkey step of this request passed (the backend's handler._touchid_ok). */
async function route(method: string, p: string, b: Body, confirmed: boolean): Promise<Sent> {
  await wait(method === "GET" ? 120 : 300);
  const s = load();
  const rp = location.hostname;
  if (method === "GET" && p === "/api/touchid") return okRes(status(s));
  if (method === "POST" && p === "/api/touchid/register/start") {
    const first = !s.devices.length;
    if (!first) {
      if (b.pairCode) {
        const bad = usePair(b.pairCode);
        if (bad) return bad;
      } else if (!confirmed) return fail(403, "Adding a device needs a passkey confirmation from a registered device or a pairing code.");
    }
    const name = String(b.name ?? "").trim().slice(0, 40) || "Device";
    const userId = s.userId ?? rand(16);
    return okRes({
      challenge: newChallenge("register", { name, first }),
      rp: { id: rp, name: "Keepwatch" },
      user: { id: userId, name: "Keepwatch", displayName: "Keepwatch" },
      exclude: s.devices.filter((d) => d.rpId === rp).map((d) => d.id),
      timeout: TTL * 1000,
    });
  }
  if (method === "POST" && p === "/api/touchid/register/finish") {
    const cd = clientData(b.clientDataJSON);
    if (cd?.type !== "webauthn.create") return fail(400, "Wrong response type.");
    const c = take(cd.challenge);
    if (!c || c.purpose !== "register") return fail(409, "The setup expired – please try again.");
    if (c.first && s.devices.length) return fail(409, "Another device was registered in the meantime – adding this one needs a passkey confirmation or a pairing code now.");
    const id = String(b.id ?? "");
    if (s.devices.some((d) => d.id === id)) return fail(409, "This device is already registered.");
    const dev = { id, name: c.name ?? "Device", kind: b.kind === "app" ? ("app" as const) : ("passkey" as const), rpId: rp, created: Date.now() / 1000, lastUsed: null, here: true, signCount: 0 };
    s.devices.push(dev);
    s.userId ??= rand(16);
    save(s);
    return okRes({ ok: true, device: dev });
  }
  if (method === "POST" && p === "/api/touchid/pair") {
    if (!s.devices.length) return fail(409, "No device is registered yet – the first one needs no code.");
    if (!confirmed) return fail(403, "A pairing code needs a passkey confirmation.");
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    pairing = { code, exp: Date.now() / 1000 + PAIR_TTL, tries: 0 };
    return okRes({ code, expires: pairing.exp });
  }
  const m = p.match(/^\/api\/touchid\/devices\/([^/]+)$/);
  if (method === "DELETE" && m) {
    if (!confirmed) return fail(403, "Removing a device needs a passkey confirmation.");
    const rest = s.devices.filter((d) => d.id !== decodeURIComponent(m[1]));
    if (rest.length === s.devices.length) return fail(404, "This device is not registered.");
    if (!rest.length) return fail(409, "The last device can't be removed – add another one first. All devices lost: run keepwatch-passkey reset on the server.");
    s.devices = rest;
    save(s);
    return okRes({ ok: true, active: rest.length > 0 });
  }
  return fail(404, "No such endpoint.");
}
