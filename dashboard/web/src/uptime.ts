import { useSyncExternalStore } from "react";
import { api } from "./api";
import { has } from "./config";
import { num } from "./format";

/** Uptime per site – /api/uptime and /api/uptime/site (API.md → "Uptime", backend: server/uptime.py). Module proxy. */

/** Uptime percentage for display: always 4 decimals ("99.9988"), the API sends 6. Without the % sign. */
export const fmtUptime = (v: number) => num(v, 4);

export interface UptimeDay {
  /** YYYY-MM-DD, in the server's local timezone */
  day: string;
  /** Checks that day (one per minute) */
  total: number;
  ok: number;
  /** Seconds down that day */
  downSec: number;
}

export interface UptimeSite {
  domain: string;
  hostId: number;
  /** What counts as "up", e.g. "200 on /update.json". */
  expect: string;
  url: string;
  last: { t: number; ok: boolean; ms: number | null; code: number | null; reason: string | null } | null;
  down: boolean;
  downSince: number | null;
  downReason: string | null;
  /** % of checks in the last 30 days with the expected response; null = no data yet */
  uptime30: number | null;
  avgMs24h: number | null;
  /** 90 days, oldest first */
  days: UptimeDay[];
}

export interface UptimeSummary {
  interval: number;
  since: number | null;
  sites: UptimeSite[];
}

export interface UptimeDetail {
  domain: string;
  range: "24h" | "7d";
  bucket: number;
  from: number;
  to: number;
  points: { t: number; ms: number | null; maxMs: number | null; fails: number; n: number }[];
  outages: { start: number; end: number | null; durationSec: number; reason: string | null; lastReason: string | null }[];
}

/* ---------- one shared poll for all site rows -------------------------------------------------- */

let state: { data: UptimeSummary | null; error: string | null } = { data: null, error: null };
const subs = new Set<() => void>();
let timer = 0;
let busy = false;

async function pull() {
  if (busy || document.hidden || !has("proxy")) return;
  busy = true;
  try {
    state = { data: await api.get<UptimeSummary>("/api/uptime"), error: null };
  } catch (e) {
    state = { ...state, error: e instanceof Error ? e.message : String(e) };
  } finally {
    busy = false;
    subs.forEach((f) => f());
  }
}

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) {
    void pull();
    timer = window.setInterval(() => void pull(), 60_000);
  }
  return () => {
    subs.delete(f);
    if (subs.size === 0) clearInterval(timer);
  };
}

export const useUptime = () => useSyncExternalStore(subscribe, () => state);
export const refreshUptime = () => void pull();

/* ---------- rating a day ------------------------------------------------------------------------ */

export type DayTone = "ok" | "sand" | "rose" | "none";

/** green: no downtime · yellow: under 30 min down · red: 30 min or more · grey: no checks */
export function dayTone(d: UptimeDay): DayTone {
  if (d.total === 0) return "none";
  if (d.downSec >= 1800 || d.ok / d.total < 0.97) return "rose";
  if (d.downSec > 0 || d.ok < d.total) return "sand";
  return "ok";
}
