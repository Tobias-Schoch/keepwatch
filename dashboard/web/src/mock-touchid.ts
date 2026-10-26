/**
 * Mock of the passkey check (?mock). Roughly mirrors server/touchid.py: 428 with a challenge
 * for dangerous actions once a device is registered; exactly one device, removal.
 * The signature is NOT verified here – only challenge and device. The DANGER list in the
 * backend is authoritative; the rules below only mimic it for the UI. Off with
 * ?modules=-passkey (no challenges at all), and rules of disabled modules don't apply.
 * Test with real WebAuthn: localhost + a virtual authenticator (Chrome DevTools/Playwright).
 */
import { getConfig, has, type ModuleId } from "./config";
import { b64u, fromB64u, type TouchDevice, type TouchStatus } from "./touchid";

interface Sent {
  ok: boolean;
  status: number;
  data: unknown;
}
interface State {
  devices: (TouchDevice & { signCount: number })[];
  userId: string | null;
}
type Body = Record<string, unknown>;

const KEY = "mock-touchid";
const TTL = 120;
const challenges = new Map<string, { purpose: "action" | "register"; bind?: string; exp: number; name?: string }>();

function load(): State {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as State | null;
    if (s && Array.isArray(s.devices)) return s;
  } catch {
    /* empty */
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
  ["POST", /^\/api\/stacks\/\d+\/redeploy$/, "Redeploy stack", null, "portainer"],
  ["PUT", /^\/api\/stacks\/\d+\/env$/, "Change environment variables", null, "portainer"],
  ["GET", /^\/api\/stacks\/\d+\/env$/, "View environment variables", null, "portainer"],
  ["POST", /^\/api\/containers\/[^/]+\/stop$/, "Stop container", null, "docker"],
  ["POST", /^\/api\/updates\/(apply|rollback)$/, "Update or roll back an image", null, "docker"],
  ["POST", /^\/api\/cleanup$/, "Clean up (prune)", null, "docker"],
  ["PUT|DELETE", /^\/api\/settings\/npm$/, "Change Proxy Manager credentials", null, "proxy"],
  ["PUT", /^\/api\/settings\/portainer$/, "Change Portainer token", null, "portainer"],
  ["PUT|DELETE", /^\/api\/settings\/remote$/, "Change off-site backup target", null, "backup"],
  ["POST", /^\/api\/settings\/backup\/password$/, "Show backup password", null, "backup"],
  ["PUT", /^\/api\/settings\/backup$/, "Shorten backup retention", (b) => Number(b.keepDaily) < 7, "backup"],
  ["PUT", /^\/api\/logarchive\/settings$/, "Shorten log archive", (b) => Number(b.days) < 14, "log-archive"],
  ["DELETE", /^\/api\/touchid\/devices\/[^/]+$/, "Remove passkey device", null, null],
];
/** What the settings list as protected: without the passkey rules themselves and without disabled modules. */
const protects = () =>
  RULES.filter((r) => !r[4] || has(r[4]))
    .map((r) => r[2])
    .filter((l, i, a) => a.indexOf(l) === i && !/passkey device/i.test(l));

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

function newChallenge(purpose: "action" | "register", extra: { bind?: string; name?: string } = {}) {
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
  const devices = s.devices.map(({ signCount: _sc, ...d }) => ({ ...d, here: d.rpId === rp }));
  return {
    active: devices.length > 0,
    crypto: true,
    rpId: rp,
    rpUsable: !/^[\d.]+$/.test(rp),
    here: devices.some((d) => d.here),
    devices,
    pairing: null,
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
        const dev = devs.find((d) => d.id === a.id);
        if (!dev) return fail(403, "This device is not (or no longer) registered.");
        dev.lastUsed = Date.now() / 1000;
        save(s);
        return p.startsWith("/api/touchid") ? route(method, p, b) : null; // on to the actual mock
      }
      msg = "The confirmation expired – please confirm again.";
    }
    await wait(120);
    const challenge = newChallenge("action", { bind: bindOf(method, p, body) });
    return fail(428, msg, { touchid: { challenge, rpId: rp, allow: devs.map((d) => d.id), action: label, timeout: TTL * 1000 } });
  }
  return p.startsWith("/api/touchid") ? route(method, p, b) : null;
}

async function route(method: string, p: string, b: Body): Promise<Sent> {
  await wait(method === "GET" ? 120 : 300);
  const s = load();
  const rp = location.hostname;
  if (method === "GET" && p === "/api/touchid") return okRes(status(s));
  if (method === "POST" && p === "/api/touchid/register/start") {
    if (s.devices.length) return fail(409, "A device is already set up. To switch devices, run keepwatch-passkey reset on the server.");
    const name = String(b.name ?? "").trim().slice(0, 40) || "Device";
    const userId = s.userId ?? rand(16);
    return okRes({
      challenge: newChallenge("register", { name }),
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
    const id = String(b.id ?? "");
    if (s.devices.some((d) => d.id === id)) return fail(409, "This device is already registered.");
    const dev = { id, name: c.name ?? "Device", kind: b.kind === "app" ? ("app" as const) : ("passkey" as const), rpId: rp, created: Date.now() / 1000, lastUsed: null, here: true, signCount: 0 };
    s.devices.push(dev);
    s.userId ??= rand(16);
    save(s);
    return okRes({ ok: true, device: dev });
  }
  if (method === "POST" && p === "/api/touchid/pair") {
    return fail(409, "Pairing codes were removed: exactly one device can be set up.");
  }
  const m = p.match(/^\/api\/touchid\/devices\/([^/]+)$/);
  if (method === "DELETE" && m) {
    if (s.devices.length <= 1) return fail(409, "The last device can't be removed here – switch devices with keepwatch-passkey reset on the server.");
    const rest = s.devices.filter((d) => d.id !== m[1]);
    if (rest.length === s.devices.length) return fail(404, "This device is not registered.");
    s.devices = rest;
    save(s);
    return okRes({ ok: true, active: rest.length > 0 });
  }
  return fail(404, "No such endpoint.");
}
