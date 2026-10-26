/** Image updates & rollback, cleanup – types and polling (backend: server/updates.py, API.md). */
import { useEffect, useRef } from "react";
import { usePoll, type Poll } from "./api";
import { has } from "./config";
import { useToast } from "./messages";

export type UpdateStatus = "current" | "update" | "major" | "unknown";

export interface ImageUpdate {
  key: string;
  ref: string;
  containers: string[];
  services: string[];
  name: string | null;
  project: string | null;
  via: "portainer" | "compose" | null;
  status: UpdateStatus;
  kind: "major" | "minor" | "patch" | "build" | null;
  security: boolean;
  reason: string | null;
  local: { digest: string | null; version: string | null; created: number | null };
  remote: { digest: string | null; version: string | null; updated: number | null } | null;
  notesUrl: string | null;
  previous: { ref: string; id: string; created: number | null; version: string | null; savedAt: number | null } | null;
}

export interface GitStack {
  name: string;
  id: number;
  commit: string | null;
  branch: string;
  deployedAt: number | null;
  autoUpdate: string | null;
  built: string[];
}

export interface UpdateJob {
  key: string;
  action: "update" | "rollback";
  state: "running" | "ok" | "rolledBack" | "error";
  step: string | null;
  startedAt: number;
  finishedAt: number | null;
  message: string | null;
}

export interface Vuln {
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: "CRITICAL" | "HIGH";
  title: string | null;
  url: string | null;
  target: string | null;
}

export interface ScanImage {
  containers: string[];
  critical: number;
  high: number;
  error: string | null;
  scannedAt: number;
  vulns: Vuln[];
}

/** Result of the weekly Trivy scan (module image-scan). `enabled: false` without that module. */
export interface Scan {
  enabled?: boolean;
  installed: boolean;
  running: boolean;
  lastResult: string | null;
  progress: { startedAt: number; current: string | null; done: number; total: number } | null;
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  error: string | null;
  images: Record<string, ScanImage>;
}

/** GET /api/updates – `{enabled: false}` without the docker module. */
export interface Updates {
  enabled?: boolean;
  checkedAt: number | null;
  checking: boolean;
  error: string | null;
  available: number;
  major: number;
  images: ImageUpdate[];
  stacks: GitStack[];
  jobs: Record<string, UpdateJob>;
  scan?: Scan;
}

export interface Cleanup {
  total: number;
  parts: { images: number; containers: number; volumes: number; buildCache: number };
  buildCache: { bytes: number };
  images: { bytes: number; count: number; items: { ref: string; size: number }[] };
  kept: { ref: string; size: number }[];
  containers: { bytes: number; count: number; items: string[] };
}

/** Is a job or a check running right now? */
export const busyUpdates = (u: Updates | null) => !!u && (u.checking || Object.values(u.jobs ?? {}).some((j) => j.state === "running"));

/** The scan part, only when the image-scan module is on and reported it. */
export const scanOf = (u: Updates | null | undefined): Scan | null => (u?.scan && u.scan.enabled !== false && has("image-scan") ? u.scan : null);

/**
 * Polls /api/updates: every 60 s, every 3 s during a job or a check. Nothing without docker.
 * When a job ends, its result shows as a toast (turn `toasts` on for one page only).
 */
export function useUpdates(toasts = false): Poll<Updates> {
  const every = useRef(60_000);
  const p = usePoll<Updates>(has("docker") ? "/api/updates" : null, every.current);
  const toast = useToast();
  const seen = useRef<Record<string, string>>({});
  const scanning = useRef<boolean | null>(null);
  // Jobs and checks: 3 s; scan (takes minutes): 15 s; otherwise 60 s.
  every.current = busyUpdates(p.data) ? 3_000 : scanOf(p.data)?.running ? 15_000 : 60_000;
  useEffect(() => {
    if (!p.data) return;
    const sc = scanOf(p.data);
    if (sc) {
      if (toasts && scanning.current && !sc.running) {
        const all = Object.values(sc.images ?? {});
        const crit = all.reduce((n, i) => n + i.critical, 0);
        const high = all.reduce((n, i) => n + i.high, 0);
        if (sc.error && !all.length) toast(sc.error, "warn", "Security scan failed");
        else toast(`Security scan done: ${crit} critical, ${high} high.${sc.error ? ` ${sc.error}` : ""}`, crit || sc.error ? "warn" : "success");
      }
      scanning.current = sc.running;
    }
    for (const j of Object.values(p.data.jobs ?? {})) {
      const before = seen.current[j.key];
      seen.current[j.key] = j.state;
      if (!toasts || before !== "running" || j.state === "running") continue;
      if (j.state === "ok") toast(j.message ?? "Updated.");
      else if (j.state === "rolledBack") toast(j.message ?? "Rolled back.", "warn", "Back on the previous version");
      else toast(j.message ?? "Failed.", "error", "Update failed");
    }
  }, [p.data, toast, toasts]);
  return p;
}

/** Version, falling back to the start of the digest. */
export const versionOf = (v: { version: string | null; digest: string | null } | null | undefined) =>
  v?.version ?? (v?.digest ? v.digest.replace(/^sha256:/, "").slice(0, 7) : "?");
