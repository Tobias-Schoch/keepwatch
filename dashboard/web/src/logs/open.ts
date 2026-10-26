import { useSyncExternalStore } from "react";

/**
 * The big log window exists once in the app (<LogsHost/> in App.tsx).
 * It opens from anywhere: a service header, container details, the command palette.
 */
export interface LogsTarget {
  /** Heading, e.g. "Shop" or the container name. */
  title: string;
  containers: string[];
}

let current: LogsTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openLogs(t: LogsTarget) {
  if (!t.containers.length) return;
  current = { title: t.title, containers: [...t.containers] };
  emit();
}

export function closeLogs() {
  current = null;
  emit();
}

export const useLogsTarget = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
