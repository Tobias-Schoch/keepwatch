/** Live logs: types and helpers for GET /api/logs (see API.md). */
import { has } from "../config";
import { dayKey, fmtDate, timeZone } from "../format";
import { ARCHIVE_RANGES, type SepKind } from "../logarchive/api";

export type LogLevel = "error" | "warn" | null;
export type LevelFilter = "all" | "problems";

export interface LiveLine {
  t: number;
  c: string;
  stream: "stdout" | "stderr";
  text: string;
  level: LogLevel;
  /** Only from the log archive: divider (recreated, restarted, stopped …), see logarchive/api.ts */
  sep?: SepKind;
}

export interface LogsResponse {
  now: number;
  since: number;
  lines: LiveLine[];
  /** Per container: send back as c=name@cursor on the next request. */
  cursor: Record<string, string>;
  /** Containers that hit the limit (older lines missing, or a gap while catching up). */
  truncated: string[];
  dropped: number;
  errors: Record<string, string>;
}

export const RANGES = [
  { id: "900", sec: 900, label: "15 min", since: "in the last 15 minutes" },
  { id: "3600", sec: 3600, label: "1 hr", since: "in the last hour" },
  { id: "86400", sec: 86400, label: "24 hr", since: "in the last 24 hours" },
  ...ARCHIVE_RANGES, // 7 and 14 days: from the log archive (logarchive/), across recreates
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** Ranges for the installed modules: 7 and 14 days only with log-archive. */
export const availableRanges = () => RANGES.filter((r) => r.sec <= 86400 || has("log-archive"));

export const LIMIT = 1000;
export const LIVE_MS = 2000;

export function logsPath(containers: string[], cursor: Record<string, string> | null, windowSec: number, level: LevelFilter): string {
  const p = new URLSearchParams();
  for (const c of containers) p.append("c", cursor?.[c] ? `${c}@${cursor[c]}` : c);
  p.set("window", String(windowSec));
  p.set("limit", String(LIMIT));
  if (level === "problems") p.set("level", "problems");
  return `/api/logs?${p.toString()}`;
}

/**
 * Short names for the chips: drop the common prefix ("shop-") and the replica number ("-1").
 * shop-api-1, shop-web → api, web. A single container keeps its full name.
 */
export function shortNames(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (names.length < 2) {
    for (const n of names) out[n] = n;
    return out;
  }
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = Math.max(prefix.lastIndexOf("-"), prefix.lastIndexOf("_")) + 1;
  for (const n of names) {
    const s = n.slice(cut).replace(/[-_]\d+$/, "");
    out[n] = s || n;
  }
  // Duplicate short forms (app-1, app-2) → full names
  const seen = new Set<string>();
  if (Object.values(out).some((s) => (seen.has(s) ? true : (seen.add(s), false)))) for (const n of names) out[n] = n.slice(cut) || n;
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Time of a line in the server's timezone; older days get the date in front. `today` = dayKey(now). */
export function lineTime(t: number, today: string): string {
  const clock = fmtDate(t, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return dayKey(t) === today ? clock : `${fmtDate(t, { month: "short", day: "numeric" })} ${clock}`;
}

/** For the file: 2026-10-23 21:44:49.123 +02:00 (server timezone). */
export function isoLocal(t: number): string {
  const d = new Date(t * 1000);
  const parts: Record<string, string> = {};
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
    for (const p of f.formatToParts(d)) parts[p.type] = p.value;
  } catch {
    return d.toISOString().replace("T", " ").replace("Z", " +00:00");
  }
  const off = (parts.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${pad(d.getMilliseconds(), 3)} ${off}`;
}

/** Name of the timezone the logs are shown in. */
export const localZone = () => timeZone();

export function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const fileSlug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "logs";
