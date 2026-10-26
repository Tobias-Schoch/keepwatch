/** Hardening audit (Lynis) – types and polling (backend: server/lynis.py, API.md → "Hardening audit (Lynis)"). Module `lynis`. */
import { useEffect, useState } from "react";
import { api, usePoll, type Poll } from "../api";
import { has } from "../config";

export interface LynisItem {
  /** "TEST-ID:part" (lowercase); "TEST-ID:…" = "and n more" */
  key: string;
  label: string;
  /** e.g. "1 → 0" (current → recommended), "9.0 UNSAFE" */
  detail: string | null;
  open: boolean;
  reason: string | null;
}

export interface LynisFinding {
  id: string;
  kind: "warning" | "suggestion";
  /** Short title, else the text from Lynis. */
  title: string;
  hint: string | null;
  text: string | null;
  detail: string | null;
  solution: string | null;
  /** CISOfy docs for the test id */
  url: string | null;
  open: boolean;
  /** Reason from the exceptions file, when accepted on purpose */
  reason: string | null;
  /** Newly open since the previous run */
  new: boolean;
  items: LynisItem[];
}

export interface Lynis {
  installed: boolean;
  running: boolean;
  lastResult: string | null;
  error: string | null;
  checkedAt: number | null;
  /** KW_LYNIS_TIME, e.g. "Sun 00:30" (systemd calendar, in `timezone`). */
  schedule: string;
  /** KW_LOCAL_TZ the schedule is in. */
  timezone?: string;
  exceptionsFile: string | null;
  exceptions: number;
  run: { startedAt: number | null; finishedAt: number | null; index: number | null; tests: number | null; lynisVersion: string | null; vulnerablePackages: number | null } | null;
  previous: { finishedAt: number | null; index: number | null } | null;
  counts: { open: number; accepted: number; warnings: number; new: number };
  findings: LynisFinding[];
  history: { finishedAt: number | null; index: number | null; open: number; warnings: number }[];
}

/** Two weeks without a run – same as STALE_AFTER in the backend. */
export const LYNIS_STALE = 15 * 86400;

let last: Lynis | null = null;
let fetching = false;
/** Last known state for the command palette (⌘K). */
export const lynisLast = () => {
  if (!has("lynis")) return null;
  if (!last && !fetching) {
    fetching = true;
    void api
      .get<Lynis>("/api/lynis")
      .then((d) => (last = d))
      .catch(() => undefined)
      .finally(() => (fetching = false));
  }
  return last;
};

/** Every 3 s during a run (2–3 min), else every 5 min – scheduled runs are weekly. */
export function useLynis(): Poll<Lynis> {
  const [fast, setFast] = useState(false);
  const p = usePoll<Lynis>(has("lynis") ? "/api/lynis" : null, fast ? 3_000 : 5 * 60_000);
  useEffect(() => {
    if (p.data) last = p.data;
    setFast(!!p.data?.running);
  }, [p.data]);
  return p;
}
