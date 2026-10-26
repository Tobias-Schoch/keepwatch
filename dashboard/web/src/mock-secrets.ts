/**
 * Mock of the secrets check (?mock). Never values – like the backend, only name, stack, finding, age.
 * Shows: duplicate (RESEND_API_KEY in two stacks), weak (ADMIN_TOKEN), test key in production,
 * due (GHCR_TOKEN), a note (same value within one stack) and quiet secrets.
 * "Acknowledge" silences a finding; reminder periods can be changed.
 */
import { has } from "./config";
import type { SecretFinding, SecretItem, Secrets, SecretType } from "./secrets/api";

const now = () => Math.floor(Date.now() / 1000);
const D = 86400;
let checkingUntil = 0;
const acks = new Map<string, number>();
const custom: Record<string, number> = {};

const TYPES: Omit<SecretType, "maxAgeDays">[] = [
  { id: "stripe-live", label: "Stripe secret key (live)", defaultDays: 365, where: "Stripe Dashboard → Developers → API keys → Secret key → Roll key", url: "https://dashboard.stripe.com/apikeys", steps: ["When rolling, pick an expiry for the old key (e.g. 1 hour).", "Enter the new key here, save and redeploy."] },
  { id: "stripe-test", label: "Stripe test key", defaultDays: 0, where: "Stripe Dashboard → turn off Test mode → Developers → API keys", url: "https://dashboard.stripe.com/apikeys", steps: ["Production needs the live keys (sk_live_ / pk_live_).", "Don't forget the webhook secret (whsec_) of the live endpoint."] },
  { id: "stripe-webhook", label: "Stripe webhook secret", defaultDays: 365, where: "Stripe Dashboard → Developers → Webhooks → endpoint → Signing secret → Roll secret", url: "https://dashboard.stripe.com/webhooks", steps: ["Stripe signs with both secrets for a while – no downtime.", "Enter the new whsec_ here, save and redeploy."] },
  { id: "resend", label: "Resend API key", defaultDays: 365, where: "Resend → API Keys → Create API Key", url: "https://resend.com/api-keys", steps: ["Create a new key (sending only, your domain only) and enter it here.", "After the redeploy, delete the old key in Resend."] },
  { id: "github", label: "GitHub token", defaultDays: 90, where: "GitHub → Settings → Developer settings → Personal access tokens", url: "https://github.com/settings/tokens", steps: ["Create a fine-grained token with an expiry and only the repos it needs.", "Enter it here, then delete the old token."] },
  { id: "jwk", label: "JSON Web Key (private)", defaultDays: 365, where: "Generate a new one, e.g. with jose: npx jose newkey -s 2048 -t RSA (or in the app's code)", url: null, steps: ["A new signing key invalidates all issued tokens (everyone gets signed out)."] },
  { id: "password", label: "Password", defaultDays: 365, where: "Generate one: openssl rand -base64 32", url: null, steps: ["Change it where it applies first (database: ALTER USER … PASSWORD '…').", "Then enter it here in every variable that uses it (including …_URL), save and redeploy."] },
  { id: "secret", label: "Secret / key", defaultDays: 365, where: "Generate one: openssl rand -hex 32", url: null, steps: ["Session/JWT secrets: changing them signs out all users."] },
  { id: "openai", label: "OpenAI API key", defaultDays: 180, where: "OpenAI Platform → API keys", url: "https://platform.openai.com/api-keys", steps: ["Create a new project key, enter it here, delete the old one."] },
];

const days = (id: string) => custom[id] ?? TYPES.find((t) => t.id === id)!.defaultDays;

type Raw = [number, string, string, string, number, boolean, SecretFinding[]];
const RAW: Raw[] = [
  [29, "web", "RESEND_API_KEY", "resend", 74, true, [{ kind: "duplicate", level: "warn", text: "same value also in blog · RESEND_API_KEY" }]],
  [28, "blog", "RESEND_API_KEY", "resend", 75, true, [{ kind: "duplicate", level: "warn", text: "same value also in web · RESEND_API_KEY" }]],
  [28, "blog", "ADMIN_TOKEN", "secret", 75, true, [{ kind: "weak", level: "warn", text: "low entropy" }]],
  [13, "shop", "STRIPE_SECRET_KEY", "stripe-test", 12, false, [{ kind: "test-in-prod", level: "warn", text: "test key in production" }]],
  [29, "web", "GHCR_TOKEN", "github", 96, false, []],
  [13, "shop", "STRIPE_WEBHOOK_SECRET", "stripe-webhook", 75, true, []],
  [28, "blog", "SESSION_SECRET", "secret", 75, true, []],
  [29, "web", "JWT_PRIVATE_JWK", "jwk", 74, true, []],
  [33, "wiki", "OPENAI_API_KEY", "openai", 41, false, []],
  [13, "shop", "DATABASE_URL", "password", 257, true, [{ kind: "duplicate", level: "info", text: "same value as POSTGRES_PASSWORD" }]],
  [13, "shop", "POSTGRES_PASSWORD", "password", 257, true, [{ kind: "duplicate", level: "info", text: "same value as DATABASE_URL" }]],
];

function items(): SecretItem[] {
  const out = RAW.map(([stackId, stack, name, type, age, est, f]): SecretItem => {
    const id = `${stackId}/${name}`;
    const since = now() - age * D;
    const ackAt = acks.get(id) ?? null;
    const limit = days(type);
    const from = ackAt ? Math.max(since, ackAt) : since;
    const dueAt = limit ? from + limit * D : null;
    const findings: SecretFinding[] = f.map((x) => ({ ...x, ...(ackAt && x.level === "warn" ? { level: "info" as const, acked: true } : {}) }));
    if (dueAt && now() >= dueAt) findings.push({ kind: "due", level: "warn", text: ackAt ? "reminder: rotate" : `older than ${limit} days` });
    return { id, stackId, stack, name, type, typeLabel: TYPES.find((t) => t.id === type)!.label, production: true, since, estimated: est, ageDays: age, maxAgeDays: limit, dueAt, findings, acked: !!ackAt, ackedAt: ackAt };
  });
  return out.sort((a, b) => Number(!a.findings.some((f) => f.level === "warn")) - Number(!b.findings.some((f) => f.level === "warn")) || a.stack.localeCompare(b.stack, "en") || a.name.localeCompare(b.name, "en"));
}

function state(): Secrets {
  const list = items();
  const open = list.filter((i) => i.findings.some((f) => f.level === "warn"));
  return {
    checkedAt: now() - 240, checking: Date.now() < checkingUntil, error: null, every: 900, portainer: true, baselineAt: now() - 3 * D,
    types: TYPES.map((t) => ({ ...t, maxAgeDays: days(t.id) })), items: list,
    counts: { secrets: list.length, withFindings: open.length, due: list.filter((i) => i.findings.some((f) => f.kind === "due" && f.level === "warn")).length },
  };
}

export function mockSecrets(method: string, p: string, body: unknown): unknown {
  if (!p.startsWith("/api/secrets")) return undefined;
  if (!has("portainer")) return { enabled: false };
  if (method === "GET" && p === "/api/secrets") return state();
  if (method === "POST" && p === "/api/secrets/check") {
    checkingUntil = Date.now() + 2000;
    return { ok: true, checking: true };
  }
  if (method === "POST" && p === "/api/secrets/ack") {
    const b = (body ?? {}) as { stackId?: number; name?: string; undo?: boolean };
    const id = `${b.stackId}/${b.name}`;
    if (b.undo) acks.delete(id);
    else acks.set(id, now());
    return { ok: true, message: "ok" };
  }
  if (method === "PUT" && p === "/api/secrets/settings") {
    const m = ((body ?? {}) as { maxAgeDays?: Record<string, number> }).maxAgeDays ?? {};
    for (const [k, v] of Object.entries(m)) custom[k] = v;
    return { ok: true };
  }
  throw new Error("Unknown endpoint.");
}

/** For the health list (dock dot) in the mock. */
export function mockSecretProblems() {
  if (!has("portainer")) return [];
  const open = items().filter((i) => i.findings.some((f) => f.level === "warn"));
  if (!open.length) return [];
  return [{ level: "warn" as const, area: "security" as const, key: "secrets.findings", title: `Secrets: ${open.length} flagged`, detail: `${open[0].name} in ${open[0].stack} and ${open.length - 1} more. See Security → Secrets.` }];
}
