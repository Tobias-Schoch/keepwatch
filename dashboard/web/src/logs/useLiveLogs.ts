import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { archivePath, isArchiveWindow } from "../logarchive/api";
import { LIVE_MS, logsPath, type LevelFilter, type LiveLine, type LogsResponse } from "./api";

export interface Row extends LiveLine {
  id: number;
  /** Notice row: lines are missing here (more new output in one tick than the limit allows). */
  gap?: boolean;
}

/** The UI keeps no more than this; the oldest drop out. */
export const MAX_ROWS = 5000;

/**
 * Reads the containers' logs: first the whole range, then only new lines every 2 s
 * (a cursor per container). The next request waits for the previous one.
 * `running` = follow live; off means no requests. On resume, whatever came in
 * during the pause is fetched right away (up to the limit per request).
 * Hidden tab: no requests.
 */
export function useLiveLogs({ containers, windowSec, level, running }: { containers: string[]; windowSec: number; level: LevelFilter; running: boolean }) {
  const key = `${containers.join("|")}#${windowSec}#${level}`;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The first load hit the limit: older lines in the range are missing. */
  const [capped, setCapped] = useState<string[]>([]);
  const [at, setAt] = useState<number | null>(null);

  const cursor = useRef<Record<string, string> | null>(null);
  const gen = useRef(0);
  const inflight = useRef(-1);
  const nextId = useRef(1);
  const failed = useRef(false);
  const args = useRef({ containers, windowSec, level });
  args.current = { containers, windowSec, level };

  const fetchOnce = useCallback(async () => {
    const g = gen.current;
    if (inflight.current === g) return;
    inflight.current = g;
    const initial = cursor.current === null;
    const { containers: cs, windowSec: w, level: lv } = args.current;
    try {
      // Over 24 hours: from the log archive (same response, same cursor; logarchive/api.ts)
      const r = await api.get<LogsResponse>(isArchiveWindow(w) ? archivePath(cs, cursor.current, w, lv) : logsPath(cs, cursor.current, w, lv));
      if (g !== gen.current) return;
      cursor.current = { ...(cursor.current ?? {}), ...r.cursor };
      const add: Row[] = r.lines.map((l) => ({ ...l, id: nextId.current++ }));
      if (!initial && r.truncated.length && add.length) {
        add.unshift({
          t: add[0].t,
          c: "",
          stream: "stdout",
          level: null,
          text: `… lines missing here: more new output at once than one request fetches (${r.truncated.join(", ")})`,
          id: nextId.current++,
          gap: true,
        });
      }
      setRows((prev) => {
        const next = initial ? add : add.length ? prev.concat(add) : prev;
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      });
      if (initial) setCapped(r.truncated);
      setErrors(r.errors);
      setError(null);
      failed.current = false;
      setAt(Date.now());
    } catch (e) {
      if (g !== gen.current) return;
      failed.current = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (inflight.current === g) inflight.current = -1;
      if (g === gen.current) setLoading(false);
    }
  }, []);

  // New range, level or containers: start over.
  useEffect(() => {
    gen.current++;
    cursor.current = null;
    setRows([]);
    setCapped([]);
    setErrors({});
    setError(null);
    setLoading(true);
    void fetchOnce();
  }, [key, fetchOnce]);

  useEffect(() => {
    if (!running) return;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) await fetchOnce();
      if (!stop) timer = window.setTimeout(tick, failed.current ? LIVE_MS * 2.5 : LIVE_MS);
    };
    // When resuming after a pause, catch up right away.
    timer = window.setTimeout(tick, cursor.current ? 0 : LIVE_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [running, key, fetchOnce]);

  return { rows, loading, error, errors, capped, at };
}
