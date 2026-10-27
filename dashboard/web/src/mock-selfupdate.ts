/**
 * Mock of Keepwatch updates from the dashboard (/api/self-update, server/selfupdate.py).
 *
 *   ?mock                    up to date
 *   ?mock&update=available   an update is offered; "Update now" runs through to "Keepwatch updated"
 *                            (the dashboard "restarts" on the way: a few seconds without answers)
 *   ?mock&update=fail        offered, but installing it fails and the previous version comes back
 *   ?mock&update=running     an update is being installed right now
 *   ?mock&update=done        an update finished a few minutes ago
 *   ?mock&update=failed      the last update failed (rolled back), the update is still offered
 *   ?mock&update=local       the server runs a local build (deployed with uncommitted changes)
 *   ?mock&update=error       the last check failed (GitHub's rate limit)
 *   ?mock&update=off         KW_SELF_UPDATE_REPO="" (see mock-config.ts)
 *
 * Commit ids are obvious placeholders.
 */
import type { SelfUpdate, SelfUpdateResponse } from "./selfupdate";

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const scenario = new URLSearchParams(location.search).get("update") ?? "uptodate";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const CHANGES = [
  "Dashboard: one-click Keepwatch updates",
  "Firewall: no gap while the rules are reloaded",
  "fail2ban: limits for failed logins in the settings",
  "Backups: clearer message when the off-site copy is not reachable",
];

const LOG = [
  "-- Download Tobias-Schoch/keepwatch at 222222222222",
  "   412 KB",
  "-- Dashboard interface",
  "   unchanged - the installed build stays",
  "-- Swap /opt/keepwatch for the new version (the previous one: /opt/keepwatch.prev)",
  "-- Set up the server (lib/apply.sh)",
];
const MODULES = ["Base system", "Automatic updates", "SSH hardening", "fail2ban", "Firewall", "Docker", "Backups", "Dashboard"];

function initial(): SelfUpdate {
  const t = now();
  const s: SelfUpdate = {
    enabled: true,
    repo: "Tobias-Schoch/keepwatch",
    branch: "main",
    url: "https://github.com/Tobias-Schoch/keepwatch",
    autoCheck: true,
    installed: { commit: OLD, date: t - 9 * DAY, subject: "Backups: monthly test restore", dirty: false, source: "deploy", at: t - 6 * DAY, repo: "Tobias-Schoch/keepwatch" },
    latest: { commit: NEW, date: t - 1 * DAY, subject: CHANGES[0] },
    current: true,
    available: true,
    localBuild: false,
    otherRepo: false,
    changes: CHANGES,
    moreChanges: 0,
    checkedAt: t - 2 * 3600,
    error: null,
    errorAt: null,
    retryAt: null,
    run: { state: "idle", step: null, module: null, target: null, startedAt: null, finishedAt: null, message: null, rolledBack: false, log: [] },
  };
  const upToDate = () => {
    s.installed = { ...s.installed, commit: NEW, date: s.latest!.date };
    s.available = false;
    s.changes = [];
  };
  switch (scenario) {
    case "available":
    case "fail":
      break;
    case "running":
      start(s, t - 48);
      Object.assign(s.run, { step: "apply", module: "Firewall", log: [...LOG, "== Base system", "== Automatic updates", "== SSH hardening", "== fail2ban", "== Firewall"] });
      break;
    case "done":
      upToDate();
      s.installed = { ...s.installed, source: "dashboard", at: t - 240 };
      s.run = { state: "done", step: null, module: null, target: NEW, startedAt: t - 300, finishedAt: t - 240, message: "Keepwatch is up to date.", rolledBack: false, log: [...LOG, "== Dashboard", "-- Done"] };
      break;
    case "failed":
      s.run = {
        state: "failed",
        step: null,
        module: null,
        target: NEW,
        startedAt: t - 700,
        finishedAt: t - 600,
        message: "The update failed while setting up the server, so the previous version was put back and set up again. The log shows where it stopped; the failed copy is in /opt/keepwatch.failed.",
        rolledBack: true,
        log: [...LOG, "== Firewall", "  error: module firewall stopped at a failing command (line 41) - nothing after it ran", "-- lib/apply.sh failed (exit code 1) - putting the previous version back", "== Done"],
      };
      break;
    case "local":
      s.installed = { ...s.installed, dirty: true };
      s.localBuild = true;
      break;
    case "error":
      upToDate();
      s.checkedAt = t - 8 * 3600;
      s.error = "GitHub's limit for requests without a login is used up for now.";
      s.errorAt = t - 1200;
      s.retryAt = t + 1500;
      break;
    default:
      upToDate();
  }
  return s;
}

let st: SelfUpdate | null = null;
let failing = scenario === "fail";
/** ?update=running stays at one step (for screenshots); "Update now" elsewhere runs through. */
let frozen = scenario === "running";

function start(s: SelfUpdate, at: number) {
  s.run = { state: "running", step: "download", module: null, target: s.latest!.commit, startedAt: at, finishedAt: null, message: null, rolledBack: false, log: LOG.slice(0, 1) };
}

/** The made-up update moves on with the clock: download, swap, apply.sh, a restart, done or failed. */
function tick(s: SelfUpdate): "restarting" | null {
  const r = s.run;
  if (r.state !== "running" || !r.startedAt || frozen) return null;
  const e = now() - r.startedAt;
  if (e < 2) return null;
  if (e < 3) {
    Object.assign(r, { step: "install", log: LOG.slice(0, 5) });
    return null;
  }
  const mods = MODULES.slice(0, Math.min(MODULES.length, Math.floor((e - 3) / 0.9) + 1));
  if (failing && e >= 8 && e < 13) {
    Object.assign(r, { step: "rollback", module: null, log: [...LOG, "== Base system", "== Automatic updates", "== SSH hardening", "== fail2ban", "  error: module fail2ban stopped at a failing command (line 52) - nothing after it ran", "-- lib/apply.sh failed (exit code 1) - putting the previous version back", ...MODULES.map((m) => `== ${m}`).slice(0, Math.floor(e - 8) + 1)] });
    return null;
  }
  if (failing && e >= 13) {
    failing = false;
    Object.assign(r, { state: "failed", step: null, finishedAt: now(), rolledBack: true, message: "The update failed while setting up the server, so the previous version was put back and set up again. The log shows where it stopped; the failed copy is in /opt/keepwatch.failed." });
    return null;
  }
  if (e < 14) {
    Object.assign(r, { step: "apply", module: mods[mods.length - 1], log: [...LOG, ...mods.map((m) => `== ${m}`)] });
    // "Dashboard" restarts the dashboard: a few seconds without an answer.
    return e >= 10 ? "restarting" : null;
  }
  Object.assign(r, { state: "done", step: null, module: null, finishedAt: now(), message: "Keepwatch is up to date.", log: [...LOG, ...MODULES.map((m) => `== ${m}`), "-- Done"] });
  s.installed = { ...s.installed, commit: s.latest!.commit, date: s.latest!.date, dirty: false, source: "dashboard", at: now() };
  s.available = false;
  s.localBuild = false;
  s.changes = [];
  return null;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** undefined = not a self-update endpoint. */
export function mockSelfUpdate(method: string, p: string, body: unknown): SelfUpdateResponse | undefined {
  if (p !== "/api/self-update" && !p.startsWith("/api/self-update/")) return undefined;
  if (scenario === "off") throw fail(404, "Updates from the dashboard are off (KW_SELF_UPDATE_REPO is empty).");
  const s = (st ??= initial());
  if (tick(s) === "restarting") throw fail(502, "The server is not responding.");
  const b = (body ?? {}) as { sha?: unknown; autoCheck?: unknown };
  if (method === "GET" && p === "/api/self-update") return structuredClone(s);
  if (method === "POST" && p === "/api/self-update/check") {
    if (scenario === "error") {
      s.errorAt = now();
    } else {
      s.checkedAt = now();
      s.error = null;
    }
    return structuredClone(s);
  }
  if (method === "POST" && p === "/api/self-update/apply") {
    if (s.run.state === "running") throw fail(409, "An update is already being installed.");
    if (!s.available || b.sha !== s.latest?.commit) throw fail(409, "This is not the update the last check found. Check again.");
    start(s, now());
    return { ...structuredClone(s), ok: true } as SelfUpdate;
  }
  if (method === "PUT" && p === "/api/self-update/settings") {
    if (typeof b.autoCheck !== "boolean") throw fail(400, '"autoCheck" must be true or false.');
    s.autoCheck = b.autoCheck;
    return structuredClone(s);
  }
  throw fail(404, "Unknown endpoint.");
}
