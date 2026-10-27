/**
 * Mock of switching modules from the dashboard (/api/modules, server/modules_api.py).
 * keepwatch.conf = the modules from ?modules=… (mock-config.ts); switches here are overrides on
 * top, and mockConfig() applies them, so pages and the dock follow after "done".
 *
 *   ?mock                 Lynis audit was switched on here (override badge); switching runs
 *                         through to "done" (with a short dashboard restart on the way)
 *                         – switching on Image scan fails and is rolled back
 *                         – switching off Automatic security updates is refused once (server busy)
 *   ?mock&mods=running    Lynis audit is being switched on right now (stays there, for screenshots)
 *   ?mock&mods=failed     the last switch failed a minute ago (Image scan, rolled back)
 *   ?mock&mods=deploy     a deploy is running on the server (switches paused)
 *   ?mock&mods=nocli      an older server without keepwatch-modules (nothing switchable)
 *   ?mock&modules=-lynis  as on a real server: Lynis off, no override
 */
import { MODULES, type ModuleId } from "./config";
import type { ModuleInfo, ModulesResponse, ModulesRun } from "./modules";
import { TOGGLEABLE } from "./modules";

const now = () => Date.now() / 1000;
const scenario = new URLSearchParams(location.search).get("mods") ?? "";
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const WHY: Partial<Record<ModuleId, string>> = {
  "ssh-hardening": "Changes how you log in to the server – a mistake here locks you out.",
  firewall: "Decides which ports are reachable – a mistake here locks you out.",
  tailscale: "Needs a login on your computer and can close port 22.",
  docker: "Every container and most other modules depend on it.",
  proxy: "Takes over ports 80 and 443 for every site.",
  dashboard: "This dashboard itself.",
};
const IDLE: ModulesRun = { state: "idle", module: null, name: null, action: null, step: null, startedAt: null, endedAt: null, log: [], error: null, rolledBack: false, by: null };

let conf: Set<ModuleId> | null = null;
const ovr = new Map<ModuleId, "on" | "off">();
let run: ModulesRun = { ...IDLE };
let refused = false;
/** Override of the module being switched before the switch – put back when it fails. */
let prev: "on" | "off" | null = null;

const nameOf = (id: string) => MODULES.find((m) => m.id === id)?.name ?? id;
const requires = (id: ModuleId): string[] => {
  const m = MODULES.find((x) => x.id === id);
  return m && "requires" in m ? [...m.requires] : [];
};
const isOn = (id: ModuleId) => id === "base" || id === "dashboard" || (ovr.has(id) ? ovr.get(id) === "on" : conf!.has(id));

/** Called by mockConfig(): `base` = keepwatch.conf from the address, overrides on top. */
export function applyMockModules(base: Record<ModuleId, boolean>): Record<ModuleId, boolean> {
  if (!conf) init(base);
  const out = { ...base };
  for (const [id, v] of ovr) out[id] = v === "on";
  return out;
}

function init(base: Record<ModuleId, boolean>) {
  conf = new Set((Object.keys(base) as ModuleId[]).filter((k) => base[k]));
  // Lynis audit was switched on here, keepwatch.conf on the computer doesn't have it yet.
  if (conf.has("lynis") && scenario !== "nocli") {
    conf.delete("lynis");
    ovr.set("lynis", "on");
  }
  const t = now();
  if (scenario === "running" && conf.has("lynis") === false) {
    run = { ...IDLE, state: "running", module: "lynis", name: nameOf("lynis"), action: "on", step: "apply", startedAt: t - 14, log: ["-- Switch on Lynis audit (from the dashboard)", "== Lynis audit", "   installing lynis (apt) …"], by: "dashboard" };
  }
  if (scenario === "failed") {
    run = failedRun(t - 120, t - 70);
  }
}

function failedRun(start: number, end: number): ModulesRun {
  return {
    ...IDLE,
    state: "failed",
    module: "image-scan",
    name: nameOf("image-scan"),
    action: "on",
    startedAt: start,
    endedAt: end,
    rolledBack: true,
    by: "dashboard",
    error: "Switching Image scan on failed, so it was switched back and the server set up again (rolled back). Where: downloading Trivy - github.com did not answer within 60 s.",
    log: [
      "-- Switch on Image scan (from the dashboard)",
      "== Image scan",
      "   fetching trivy 0.56.2 from github.com …",
      "   curl: (28) Connection timed out after 60001 milliseconds",
      "  error: module image-scan stopped at a failing command (line 23) - nothing after it ran",
      "-- Putting the previous state back: Image scan off",
      "== Image scan (removing)",
      "-- Done: nothing changed on the server",
    ],
  };
}

/** The made-up apply moves on with the clock. "restarting": the dashboard is gone for a moment. */
function tick(): "restarting" | null {
  const r = run;
  if (r.state !== "running" || !r.startedAt || scenario === "running") return null;
  const e = now() - r.startedAt;
  const id = r.module as ModuleId;
  const name = nameOf(id);
  const steps = [`-- Switch ${r.action} ${name} (from the dashboard)`, `== ${name}`, r.action === "on" ? `   installing ${id} …` : `   removing ${id} …`, "== Dashboard", "   restarting the dashboard"];
  if (id === "image-scan" && r.action === "on") {
    if (e < 6) {
      Object.assign(r, { step: "apply", log: failedRun(0, 0).log.slice(0, Math.min(4, Math.floor(e) + 1)) });
      return null;
    }
    if (prev) ovr.set("image-scan", prev);
    else ovr.delete("image-scan");
    run = failedRun(r.startedAt, now());
    return null;
  }
  if (e < 1) return null;
  if (e < 7) {
    Object.assign(r, { step: "apply", log: steps.slice(0, Math.min(steps.length, Math.floor(e))) });
    return e >= 4.5 && e < 6.5 ? "restarting" : null;
  }
  Object.assign(r, { state: "done", step: null, endedAt: now(), log: [...steps, "-- Done"] });
  return null;
}

function list(): ModuleInfo[] {
  const cli = scenario !== "nocli";
  const rows = MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    summary: m.summary,
    requires: requires(m.id),
    enabled: isOn(m.id),
    inConf: m.id === "base" || m.id === "dashboard" || conf!.has(m.id),
    override: ovr.get(m.id) ?? null,
    toggleable: cli && TOGGLEABLE.includes(m.id),
    why: WHY[m.id] ?? null,
    installed: isOn(m.id),
  }));
  return rows.map((r) => {
    const requiredBy = rows.filter((x) => x.enabled && x.requires.includes(r.id)).map((x) => x.id);
    let blocked: string | null = null;
    if (r.toggleable && !r.enabled) {
      const missing = r.requires.filter((x) => !isOn(x as ModuleId));
      // Wording as keepwatch-modules (lib/kwmodules.py blocked()).
      if (missing.length) blocked = `${r.name} needs ${missing.map(nameOf).join(", ")}, which is off. That is switched on your computer: ./keepwatch enable ${missing.join(" ")}, then ./keepwatch deploy.`;
    } else if (r.toggleable && requiredBy.length) blocked = `${requiredBy.map(nameOf).join(", ")} needs ${r.name} - switch that off first.`;
    return { ...r, requiredBy, blocked, command: r.id === "base" ? null : `./keepwatch ${r.enabled ? "disable" : "enable"} ${r.id} && ./keepwatch deploy` };
  });
}

function status(): ModulesResponse {
  const modules = list();
  return {
    available: scenario !== "nocli",
    modules,
    run: structuredClone(run),
    busy: run.state === "running" ? "modules" : scenario === "deploy" ? "deploy" : null,
    overrides: modules.filter((m) => m.override).length,
  };
}

/** undefined = not a modules endpoint. */
export function mockModules(method: string, p: string, body: unknown): ModulesResponse | undefined {
  if (p !== "/api/modules" && !p.startsWith("/api/modules/")) return undefined;
  if (!conf) throw fail(503, "Mock config not loaded.");
  if (tick() === "restarting") throw fail(502, "The server is not responding.");
  if (method === "GET" && p === "/api/modules") return status();
  const m = p.match(/^\/api\/modules\/([a-z0-9-]+)$/);
  if (method !== "POST" || !m) throw fail(404, "Unknown endpoint.");
  const id = m[1] as ModuleId;
  const want = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof want !== "boolean") throw fail(400, '"enabled" must be true or false.');
  const st = status();
  const it = st.modules.find((x) => x.id === id);
  if (!it) throw fail(404, `Unknown module "${id}".`);
  if (!st.available) throw fail(503, "keepwatch-modules is not installed on the server - run ./keepwatch deploy once.");
  if (st.busy === "modules") throw fail(409, `${run.name} is being switched ${run.action} right now - wait until that is done.`);
  if (st.busy === "deploy") throw fail(409, "A deploy is running on the server right now - try again when it is done.");
  if (!it.toggleable) throw fail(409, `${it.name} can't be switched from the dashboard. On your computer: ./keepwatch ${want ? "enable" : "disable"} ${id}, then ./keepwatch deploy.`);
  if (it.enabled === want) throw fail(409, `${it.name} is already ${want ? "on" : "off"}.`);
  if (it.blocked) throw fail(409, it.blocked);
  // The server refuses once: another Keepwatch run holds the lock (as keepwatch-modules says it).
  if (id === "auto-updates" && !want && !refused) {
    refused = true;
    throw fail(409, "Keepwatch is being set up right now (a deploy or an update from the dashboard). Try again in a few minutes.");
  }
  const v = want ? "on" : "off";
  prev = ovr.get(id) ?? null;
  if (conf.has(id) === want) ovr.delete(id);
  else ovr.set(id, v);
  run = { ...IDLE, state: "running", module: id, name: it.name, action: v, step: "starting", startedAt: now(), by: "dashboard" };
  return { ...status(), ok: true } as ModulesResponse;
}
