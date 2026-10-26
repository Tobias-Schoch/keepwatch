/**
 * Passkey confirmation for dangerous actions (backend: server/touchid.py, list DANGER).
 *
 * The backend answers a dangerous request without confirmation with 428 and a challenge
 * (2 min, single use, bound to method + path + body). `request` in api.ts has it signed here
 * and sends the same request again with X-Touch-ID – every call through api.post/put/del/get
 * gets the confirmation for free.
 *
 * Two ways to sign:
 *  - macOS app: native bridge window.webkit.messageHandlers.keepwatchTouchID (older apps: serverTouchID)
 *    (Secure Enclave key, Touch ID only).
 *  - Browser: WebAuthn with a platform authenticator (Touch ID, Face ID, Windows Hello).
 * There is no password fallback.
 */

export interface TouchChallenge {
  challenge: string;
  rpId: string;
  allow: string[];
  action: string;
  timeout: number;
}

export interface RegisterOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  exclude: string[];
  timeout: number;
}

export interface TouchDevice {
  id: string;
  name: string;
  kind: "passkey" | "app";
  rpId: string;
  created: number;
  lastUsed: number | null;
  /** Set up for the address the dashboard is open at right now. */
  here: boolean;
}

export interface TouchStatus {
  active: boolean;
  crypto: boolean;
  rpId: string;
  rpUsable: boolean;
  here: boolean;
  devices: TouchDevice[];
  pairing: { expires: number } | null;
  protects: string[];
  ttl: number;
}

/** Result of the setup, as POST /api/touchid/register/finish expects it. */
export type RegisterResult =
  | { kind: "passkey"; id: string; clientDataJSON: string; attestationObject: string }
  | { kind: "app"; id: string; publicKey: string; clientDataJSON: string; authenticatorData: string; signature: string };

export class TouchIdError extends Error {}

/* ---------- base64url ---------------------------------------------------------- */

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): ArrayBuffer {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(t);
  const out = new ArrayBuffer(bin.length);
  const v = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) v[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- macOS app: native bridge ---------------------------------------------- */

interface BridgeReply {
  error?: string;
  id?: string;
  publicKey?: string;
  clientDataJSON?: string;
  authenticatorData?: string;
  signature?: string;
  available?: boolean;
  credentialId?: string | null;
}
interface Bridge {
  postMessage: (msg: unknown) => Promise<BridgeReply>;
}
type WebkitWindow = Window & { webkit?: { messageHandlers?: Record<string, Bridge | undefined> } };

/** Bridge of the macOS app (WKScriptMessageHandlerWithReply), else null. */
export function appBridge(): Bridge | null {
  const h = (window as WebkitWindow).webkit?.messageHandlers;
  return h?.keepwatchTouchID ?? h?.serverTouchID ?? null;
}

/** Running in a WKWebView (macOS app), with or without the bridge. */
export function inApp(): boolean {
  return !!(window as WebkitWindow).webkit?.messageHandlers;
}

export function webauthnAvailable(): boolean {
  return typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

async function callBridge(b: Bridge, msg: Record<string, unknown>): Promise<BridgeReply> {
  let r: BridgeReply;
  try {
    r = await b.postMessage(msg);
  } catch (e) {
    throw new TouchIdError(`Touch ID in the app: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r || r.error) {
    const code = r?.error ?? "unknown error";
    if (code === "cancelled") throw new TouchIdError("Touch ID cancelled – nothing changed.");
    if (code === "unknown") throw new TouchIdError("This app isn't set up for Touch ID yet – Settings → Passkey → \"Add this device\".");
    if (code === "unavailable") throw new TouchIdError("Touch ID isn't available on this Mac (no fingerprint enrolled, or the lid is closed).");
    throw new TouchIdError(`Touch ID in the app: ${code}`);
  }
  return r;
}

/* ---------- User gesture: Safari wants WebAuthn to come from a click ----------------
 * After the 428 answer the click is often "used up". Then <TouchIdPrompt> shows a button
 * whose click calls WebAuthn directly. Chrome usually doesn't need this.
 */

export interface GesturePrompt {
  title: string;
  text: string;
  go: () => void;
  cancel: () => void;
}
let prompt: GesturePrompt | null = null;
const promptListeners = new Set<() => void>();
const setPrompt = (p: GesturePrompt | null) => {
  prompt = p;
  promptListeners.forEach((l) => l());
};
export const touchPrompt = {
  get: () => prompt,
  subscribe: (l: () => void) => (promptListeners.add(l), () => void promptListeners.delete(l)),
};

const isNotAllowed = (e: unknown) => e instanceof DOMException && e.name === "NotAllowedError";

async function withGesture<T>(title: string, text: string, fn: () => Promise<T>): Promise<T> {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (!ua || ua.isActive) {
    const t0 = performance.now();
    try {
      return await fn();
    } catch (e) {
      // Immediate NotAllowed = the browser wanted a click, not "cancelled".
      if (!(isNotAllowed(e) && performance.now() - t0 < 800)) throw e;
    }
  }
  return new Promise<T>((resolve, reject) => {
    setPrompt({
      title,
      text,
      go: () => {
        setPrompt(null);
        fn().then(resolve, reject); // inside the click handler: has the gesture
      },
      cancel: () => {
        setPrompt(null);
        reject(new TouchIdError("Cancelled – nothing changed."));
      },
    });
  });
}

function webauthnError(e: unknown, rpId: string): TouchIdError {
  if (e instanceof TouchIdError) return e;
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return new TouchIdError("Passkey cancelled or timed out – nothing changed.");
    if (e.name === "InvalidStateError") return new TouchIdError("This device is already set up.");
    if (e.name === "SecurityError") return new TouchIdError(`Passkeys don't work at this address (${rpId}) – open the dashboard via localhost or in the macOS app.`);
    if (e.name === "NotSupportedError") return new TouchIdError("This device has no supported authenticator.");
  }
  return new TouchIdError(`Passkey: ${e instanceof Error ? e.message : String(e)}`);
}

function noWebauthn(): TouchIdError {
  return new TouchIdError(
    inApp()
      ? "This version of the macOS app can't use Touch ID yet. Confirm this action in your browser for now."
      : "This browser doesn't support passkeys (WebAuthn).",
  );
}

/* ---------- Confirm (assertion) ----------------------------------------------------- */

/** Signs the challenge with the passkey. Returns the value for the X-Touch-ID header. */
export async function assertTouchId(c: TouchChallenge): Promise<string> {
  const bridge = appBridge();
  if (bridge) {
    const r = await callBridge(bridge, { op: "sign", challenge: c.challenge, rpId: c.rpId, allow: c.allow, reason: c.action });
    return JSON.stringify({ id: r.id, clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature });
  }
  if (!webauthnAvailable()) throw noWebauthn();
  try {
    const cred = (await withGesture(c.action, "This action needs your passkey.", () =>
      navigator.credentials.get({
        publicKey: {
          challenge: fromB64u(c.challenge),
          rpId: c.rpId,
          allowCredentials: c.allow.map((id) => ({ type: "public-key", id: fromB64u(id) })),
          userVerification: "required",
          timeout: c.timeout,
        },
      }),
    )) as PublicKeyCredential | null;
    if (!cred) throw new TouchIdError("Passkey cancelled – nothing changed.");
    const r = cred.response as AuthenticatorAssertionResponse;
    return JSON.stringify({
      id: b64u(cred.rawId),
      clientDataJSON: b64u(r.clientDataJSON),
      authenticatorData: b64u(r.authenticatorData),
      signature: b64u(r.signature),
    });
  } catch (e) {
    throw webauthnError(e, c.rpId);
  }
}

/* ---------- Setup ----------------------------------------------------------------- */

/** Creates the key on this device (app: Secure Enclave, browser: passkey). */
export async function createCredential(o: RegisterOptions, name: string): Promise<RegisterResult> {
  const bridge = appBridge();
  if (bridge) {
    const r = await callBridge(bridge, { op: "register", challenge: o.challenge, rpId: o.rp.id, name, reason: "Set up this device for Keepwatch" });
    return { kind: "app", id: r.id!, publicKey: r.publicKey!, clientDataJSON: r.clientDataJSON!, authenticatorData: r.authenticatorData!, signature: r.signature! };
  }
  if (!webauthnAvailable()) throw noWebauthn();
  try {
    const cred = (await withGesture("Set up passkey", `Register "${name}" for dangerous actions.`, () =>
      navigator.credentials.create({
        publicKey: {
          challenge: fromB64u(o.challenge),
          rp: o.rp,
          user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
          excludeCredentials: o.exclude.map((id) => ({ type: "public-key", id: fromB64u(id) })),
          attestation: "none",
          timeout: o.timeout,
        },
      }),
    )) as PublicKeyCredential | null;
    if (!cred) throw new TouchIdError("Setup cancelled.");
    const r = cred.response as AuthenticatorAttestationResponse;
    return { kind: "passkey", id: b64u(cred.rawId), clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject) };
  } catch (e) {
    throw webauthnError(e, o.rp.id);
  }
}

/** Suggested name for this device. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (appBridge() || inApp()) return "macOS app";
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? `${dev} – ${br}` : dev;
}
