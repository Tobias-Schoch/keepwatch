import { Blocks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, refreshAll, usePoll } from "./api";
import { getConfig, MODULES, reloadConfig, type ModuleId } from "./config";
import { nowSec } from "./format";
import { registerPalette } from "./palette/registry";
import { openSetting } from "./pages/settingsOpen";

/**
 * Switching modules from the dashboard (server/modules_api.py, API.md "Modules").
 * Only the add-ons in TOGGLEABLE; the server applies the change in its own unit and the
 * dashboard may restart on the way, so while it runs the page keeps polling through the gap.
 * When a switch ends, /api/config is loaded again – dock, pages and `useHas` follow.
 */

/** Add-ons the dashboard may switch (the server's `toggleable` is authoritative). */
export const TOGGLEABLE: readonly ModuleId[] = ["lynis", "image-scan", "log-archive", "ban-history", "auditd", "auto-updates", "backup"];

export interface ModuleInfo {
  id: string;
  name: string;
  summary: string | null;
  requires: string[];
  /** On right now (keepwatch.conf with the override on top). */
  enabled: boolean;
  /** In KW_MODULES of the keepwatch.conf the server got with the last deploy. */
  inConf: boolean;
  /** Switched here, not in keepwatch.conf yet: the next ./keepwatch deploy asks to take it over. */
  override: "on" | "off" | null;
  toggleable: boolean;
  /** Why it isn't switchable here (from keepwatch-modules), if it says. */
  why: string | null;
  /** Set up on the server right now (null: older keepwatch-modules). */
  installed: boolean | null;
  /** Why its switch is greyed out right now (a requirement is off / an enabled module needs it). */
  blocked: string | null;
  /** Enabled modules that need this one. */
  requiredBy: string[];
  /** What to run on the computer instead ("./keepwatch enable proxy && ./keepwatch deploy"); null for base. */
  command: string | null;
}

export interface ModulesRun {
  state: "idle" | "running" | "done" | "failed";
  module: string | null;
  name: string | null;
  action: "on" | "off" | null;
  step: string | null;
  startedAt: number | null;
  endedAt: number | null;
  log: string[];
  error: string | null;
  rolledBack: boolean;
  by: string | null;
}

export interface ModulesResponse {
  /** keepwatch-modules is installed (older servers: false, nothing switchable). */
  available: boolean;
  modules: ModuleInfo[];
  run: ModulesRun;
  /** Something running that a switch would collide with. */
  busy: "modules" | "self-update" | "deploy" | null;
  overrides: number;
}

const EVERY = 30_000;
const EVERY_RUNNING = 2_000;
/** A finished switch counts as news this long. */
export const RECENT = 15 * 60;

/** Polls /api/modules (every 2 s while a switch runs) and reloads /api/config when one ends. */
export function useModules(active = true) {
  const [fast, setFast] = useState(false);
  const p = usePoll<ModulesResponse>(active ? "/api/modules" : null, fast ? EVERY_RUNNING : EVERY);
  const running = p.data?.run.state === "running";
  useEffect(() => setFast(running), [running]);
  const ended = p.data?.run.endedAt ?? null;
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!p.data) return;
    const first = seen.current === undefined;
    if (ended === seen.current) return;
    seen.current = ended;
    if (!ended) return;
    // A switch ended: while we watched (or recently, before the page was open) → the module set changed.
    if (!first || nowSec() - ended < RECENT) void reloadConfig().then(() => !first && refreshAll());
  }, [ended, p.data]);
  return { ...p, m: p.data, fast: setFast };
}

export const switchModule = (id: string, enabled: boolean) => api.post<ModulesResponse>(`/api/modules/${encodeURIComponent(id)}`, { enabled });

/** "Switching Lynis audit on" etc. */
export function runTitle(r: ModulesRun): string {
  const name = r.name ?? r.module ?? "a module";
  return `Switching ${name} ${r.action ?? ""}`.trim();
}

/** What the server is doing right now: the step, else the last log line. */
export function runStep(r: ModulesRun): string {
  if (r.step === "starting" || (!r.step && !r.log.length)) return "Starting";
  const last = [...r.log].reverse().find((l) => l.trim());
  return (last ?? r.step ?? "Working").replace(/^[=\-\s]+/, "");
}

/* ---------- ⌘K: "Switch on Lynis audit" opens the confirmation in Settings → Modules ---------- */

let pendingFocus: { id: string; enabled: boolean } | null = null;

/** Set by the palette, read by the Modules dialog when it opens and cleared once used. */
export const peekModuleFocus = () => pendingFocus;
export const clearModuleFocus = () => void (pendingFocus = null);

registerPalette(() => {
  const cfg = getConfig();
  if (cfg.fallback) return [];
  return MODULES.filter((m) => TOGGLEABLE.includes(m.id)).map((m) => {
    const on = cfg.modules[m.id] !== false;
    return {
      id: `module:${m.id}`,
      group: "settings" as const,
      title: `Switch ${on ? "off" : "on"} ${m.name}`,
      hint: "Modules",
      keywords: `module ${m.id} ${on ? "disable off remove" : "enable on install add"} ${m.summary}`,
      icon: Blocks,
      searchOnly: true,
      run: (ctx) => {
        pendingFocus = { id: m.id, enabled: !on };
        ctx.go("settings");
        openSetting("modules");
      },
    };
  });
});
