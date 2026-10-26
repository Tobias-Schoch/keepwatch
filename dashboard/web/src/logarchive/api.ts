/**
 * Log archive (module log-archive): types and helpers for GET /api/logarchive and
 * GET /api/logarchive/lines (see API.md). Ranges over 24 hours read the live logs from here
 * instead of `docker logs` – the archive survives container recreates and knows removed containers.
 */
import { usePoll } from "../api";
import { has } from "../config";
import { LOCALE } from "../format";
import type { LevelFilter, LogsResponse } from "../logs/api";

/** Refresh the overview (sizes change slowly). */
export const EVERY_ARCHIVE = 60_000;

/** Extra ranges for the live logs (appended to RANGES in logs/api.ts). */
export const ARCHIVE_RANGES = [
  { id: "604800", sec: 604800, label: "7 days", since: "in the last 7 days" },
  { id: "1209600", sec: 1209600, label: "14 days", since: "in the last 14 days" },
] as const;

/** Anything over 24 hours comes from the archive (`docker logs` only knows the current container). */
export const isArchiveWindow = (sec: number) => sec > 86400;

/** Divider kind: container recreated, restarted, exited, removed, or the size limit was hit. */
export type SepKind = "created" | "restarted" | "exited" | "removed" | "limit";

export interface ArchiveLinesResponse extends LogsResponse {
  archive: true;
  /** Requested containers that no longer exist (archive only). */
  gone: string[];
  /** Is the archive service writing right now (fresh status.json)? */
  running: boolean;
  retentionDays: number;
}

export function archivePath(
  containers: string[],
  cursor: Record<string, string> | null,
  windowSec: number,
  level: LevelFilter,
  extra: { limit?: number; q?: string; download?: boolean } = {},
): string {
  const p = new URLSearchParams();
  for (const c of containers) p.append("c", cursor?.[c] ? `${c}@${cursor[c]}` : c);
  p.set("window", String(windowSec));
  p.set("limit", String(extra.limit ?? 1000));
  if (level === "problems") p.set("level", "problems");
  if (extra.q) p.set("q", extra.q);
  if (extra.download) p.set("download", "1");
  return `/api/logarchive/lines?${p.toString()}`;
}

export interface ArchiveContainer {
  key: string;
  name: string;
  stack: string;
  /** null = unknown (Docker state not loaded yet) */
  exists: boolean | null;
  bytes: number;
  days: number;
  from: string;
  to: string;
  lastWrite: number | null;
  dropped: number;
  trimmed: string | null;
  image: string | null;
}

/** days = days to keep, maxPerContainerMb = MB per container, maxTotalMb = MB in total. */
export interface ArchiveSettings {
  days: number;
  maxPerContainerMb: number;
  maxTotalMb: number;
}

export interface ArchiveOverview {
  installed: boolean;
  running: boolean;
  statusAt: number | null;
  since: number | null;
  dir: string;
  settings: ArchiveSettings;
  bytes: number;
  containers: ArchiveContainer[];
  /** Containers without the json-file driver → reason */
  skipped: Record<string, string>;
  notes: string[];
}

/** Only polls with the log-archive module installed. */
export const useArchiveOverview = (enabled = true) => usePoll<ArchiveOverview>(enabled && has("log-archive") ? "/api/logarchive" : null, EVERY_ARCHIVE);

/** "2026-10-09" → "Oct 9" */
export const shortDay = (d: string | null | undefined) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", month: "short", day: "numeric" }) : "—";
