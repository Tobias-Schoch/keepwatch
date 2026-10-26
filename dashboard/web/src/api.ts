import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { layersOpen } from "./design/layer";
import { assertTouchId, type TouchChallenge } from "./touchid";

/**
 * Everything goes through our own origin (/api). Writes carry X-Dashboard: 1 –
 * the backend rejects them without it (CSRF protection).
 * Mock mode for development and screenshots: ?mock in the address or VITE_MOCK=1.
 */
export const MOCK = new URLSearchParams(location.search).has("mock") || import.meta.env.VITE_MOCK === "1";

export class ApiError extends Error {}

/* ---------- Connection: dot in the top right -------------------------------- */

let online: boolean | null = null;
const listeners = new Set<() => void>();
function setOnline(v: boolean) {
  if (online === v) return;
  online = v;
  listeners.forEach((l) => l());
}
/** null = nothing heard yet, true = backend answers, false = no answer. */
export const useOnline = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => online,
  );

/* ---------- New version deployed: reload by ourselves ------------------------------
 * Every response carries X-Dashboard-Build. When the id changes, a new UI has
 * been deployed. We only reload when nothing would be lost: no dialog open, no
 * input focused, no action in flight. Until then <UpdateHint> shows a note at
 * the bottom. In mock mode and without the header (Vite dev server without a
 * backend) nothing happens.
 */

let build: string | null = null;
let newBuild = false;
const buildListeners = new Set<() => void>();
/** Writes in flight (every action is one; renewing a certificate takes minutes). */
let busyCount = 0;

function seeBuild(id: string | null) {
  if (MOCK || !id) return;
  if (build === null) {
    build = id;
    return;
  }
  if (id === build || newBuild) return;
  newBuild = true;
  buildListeners.forEach((l) => l());
  reloadIfIdle();
}

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export const canReloadNow = () => layersOpen() === 0 && !typing() && busyCount === 0;

/** Reloads when a new version is out and nothing is in the way. Returns true when reloading. */
export function reloadIfIdle(): boolean {
  if (!newBuild || !canReloadNow()) return false;
  location.reload();
  return true;
}

export const useNewBuild = () =>
  useSyncExternalStore(
    (l) => (buildListeners.add(l), () => buildListeners.delete(l)),
    () => newBuild,
  );

/* ---------- Requests --------------------------------------------------------- */

type Method = "GET" | "POST" | "PUT" | "DELETE";
interface Sent {
  ok: boolean;
  status: number;
  data: unknown;
}

/** One request, without throwing (except when the server does not answer). `proof` = X-Touch-ID header. */
async function send(method: Method, path: string, body: unknown, proof?: string): Promise<Sent> {
  if (MOCK) {
    const { mockTouchId } = await import("./mock-touchid");
    const gated = await mockTouchId(method, path, body, proof);
    setOnline(true);
    if (gated) return gated;
    const { mockRequest } = await import("./mock");
    try {
      return { ok: true, status: 200, data: await mockRequest(method, path, body) };
    } catch (e) {
      // Like the backend: errors are 4xx/5xx with { error }.
      const status = (e as { status?: number }).status ?? 400;
      return { ok: false, status, data: { error: e instanceof Error ? e.message : String(e) } };
    }
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Accept: "application/json",
        ...(method !== "GET" ? { "Content-Type": "application/json", "X-Dashboard": "1" } : {}),
        ...(proof ? { "X-Touch-ID": proof } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    setOnline(false);
    throw new ApiError("The server is not responding.");
  }
  setOnline(true);
  seeBuild(res.headers.get("X-Dashboard-Build"));
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

const errorOf = (r: Sent) =>
  r.data && typeof r.data === "object" && "error" in r.data ? String((r.data as { error: unknown }).error) : `Error ${r.status}`;

/**
 * Dangerous actions (server/touchid.py): the backend answers 428 with a challenge.
 * Sign it with the passkey and send the same request again with X-Touch-ID.
 */
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  if (write) busyCount++;
  try {
    let r = await send(method, path, body);
    const challenge = r.status === 428 ? (r.data as { touchid?: TouchChallenge } | null)?.touchid : undefined;
    if (challenge) {
      let proof: string;
      try {
        proof = await assertTouchId(challenge);
      } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : String(e));
      }
      r = await send(method, path, body, proof);
    }
    if (!r.ok) throw new ApiError(errorOf(r));
    return r.data as T;
  } finally {
    if (write) busyCount = Math.max(0, busyCount - 1);
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T = { ok: true }>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T = { ok: true }>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T = { ok: true }>(path: string) => request<T>("DELETE", path),
};

/** Refetch all running polls right away (button in the top right, after actions). */
const REFRESH_EVENT = "dash:refresh";
export const refreshAll = () => dispatchEvent(new Event(REFRESH_EVENT));

/* ---------- Polling ----------------------------------------------------------------- */

export interface Poll<T> {
  data: T | null;
  error: string | null;
  /** Time of the last successful response (ms). */
  at: number | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches `path` right away and then every `ms` milliseconds. Pauses while the
 * tab is hidden and catches up immediately on return. `ms` may change (e.g.
 * faster while a backup runs). `path` null = don't fetch (e.g. module off).
 */
export function usePoll<T>(path: string | null, ms: number): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!path || inflight.current) return;
    inflight.current = true;
    try {
      const d = await api.get<T>(path);
      if (!alive.current) return;
      setData(d);
      setError(null);
      setAt(Date.now());
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) return;
    void refresh();
    let timer = 0;
    const start = () => {
      clearInterval(timer);
      timer = window.setInterval(() => void refresh(), ms);
    };
    const onVis = () => {
      if (document.hidden) clearInterval(timer);
      else {
        void refresh();
        start();
      }
    };
    const onRefresh = () => void refresh();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [path, ms, refresh]);

  return { data, error, at, refresh };
}

/** Intervals from API.md. */
export const EVERY = {
  overview: 5_000,
  security: 30_000,
  docker: 10_000,
  stacks: 30_000,
  sites: 60_000,
  backups: 10_000,
  backupsRunning: 2_000,
  logins: 60_000,
  logs: 2_000,
} as const;
