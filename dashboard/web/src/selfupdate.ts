import { useCallback, useEffect, useState } from "react";
import { api, usePoll } from "./api";
import { useConfig } from "./config";

/**
 * Keepwatch updates from the dashboard (server/selfupdate.py, API.md "Keepwatch updates").
 * The server installs the update in its own unit; the dashboard restarts on the way, so while
 * one runs the page keeps polling through the gap and picks the result up from the server.
 */

export type RunState = "idle" | "running" | "done" | "failed";
export type RunStep = "starting" | "prepare" | "download" | "install" | "apply" | "rollback" | null;

export interface SelfUpdateRun {
  state: RunState;
  step: RunStep;
  /** Section of lib/apply.sh in progress ("Firewall"). */
  module: string | null;
  target: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
  rolledBack: boolean;
  log: string[];
}

export interface SelfUpdate {
  enabled: true;
  repo: string;
  branch: string;
  url: string;
  autoCheck: boolean;
  installed: { commit: string | null; date: number | null; subject: string | null; dirty: boolean; source: "deploy" | "dashboard" | null; at: number | null; repo: string | null };
  latest: { commit: string; date: number | null; subject: string | null } | null;
  /** The last check was made for the version that runs now. */
  current: boolean;
  available: boolean;
  localBuild: boolean;
  /** Deployed from another GitHub repository than the one updates come from. */
  otherRepo: boolean;
  changes: string[];
  moreChanges: number;
  checkedAt: number | null;
  error: string | null;
  errorAt: number | null;
  retryAt: number | null;
  run: SelfUpdateRun;
}

export type SelfUpdateResponse = SelfUpdate | { enabled: false };

export const isOn = (s: SelfUpdateResponse | null | undefined): s is SelfUpdate => !!s && s.enabled === true;

const EVERY = 60_000;
const EVERY_RUNNING = 2_000;

/** Polls /api/self-update (every 2 s while an update runs). `null` path when the feature is off. */
export function useSelfUpdate() {
  const cfg = useConfig();
  const [fast, setFast] = useState(false);
  const p = usePoll<SelfUpdateResponse>(cfg.selfUpdate ? "/api/self-update" : null, fast ? EVERY_RUNNING : EVERY);
  const running = isOn(p.data) && p.data.run.state === "running";
  useEffect(() => setFast(running), [running]);
  return { ...p, s: isOn(p.data) ? p.data : null, fast: setFast };
}

/** "Downloading from GitHub" etc. – what the updater is doing right now. */
export function stepLabel(run: SelfUpdateRun): string {
  switch (run.step) {
    case "download":
      return "Downloading the new version from GitHub";
    case "install":
      return "Putting the new version in place";
    case "apply":
      return run.module && run.module !== "Done" ? `Setting up the server · ${run.module}` : "Setting up the server";
    case "rollback":
      return "Something failed – putting the previous version back";
    default:
      return "Preparing";
  }
}

/* ---------- "Later" and "dismiss": per version / per finished run, in this browser ------------------ */

const KEY = "kw.selfupdate.dismissed";

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function useDismissed() {
  const [list, setList] = useState<string[]>(readDismissed);
  const dismiss = useCallback((key: string) => {
    setList((old) => {
      const next = [...old.filter((k) => k !== key), key].slice(-20);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode: dismissed for this page view only */
      }
      return next;
    });
  }, []);
  return { has: (key: string) => list.includes(key), dismiss };
}

/** Keys for useDismissed: an offered version, a finished run. */
export const offerKey = (s: SelfUpdate) => `offer:${s.latest?.commit ?? ""}`;
export const runKey = (s: SelfUpdate) => `run:${s.run.target ?? ""}:${s.run.finishedAt ?? ""}`;

export const checkNow = () => api.post<SelfUpdateResponse>("/api/self-update/check");
export const installUpdate = (sha: string) => api.post<SelfUpdateResponse>("/api/self-update/apply", { sha });
export const setAutoCheck = (autoCheck: boolean) => api.put<SelfUpdateResponse>("/api/self-update/settings", { autoCheck });
