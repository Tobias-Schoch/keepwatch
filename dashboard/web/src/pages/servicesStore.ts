import { useSyncExternalStore } from "react";

/**
 * Expanded state of the Services page: which service blocks are open (remembered in the browser,
 * may be missing) and whether "Maintenance" is open. Its own module so the command palette can
 * expand a block without importing the page.
 */

const KEY = "dash.services.open";

function load(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let open = load();
let maint = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...open]));
  } catch {
    /* no storage – this session only */
  }
}

export function setServiceOpen(key: string, v: boolean) {
  if (open.has(key) === v) return;
  open = new Set(open);
  if (v) open.add(key);
  else open.delete(key);
  save();
  emit();
}

export const useServiceOpen = () => useSyncExternalStore(subscribe, () => open);

/** Site the command palette wants to show: the Services page expands the service that holds it
 * (only the page knows which one) and clears the wish. */
let wantedSite: string | null = null;

export function showSite(domain: string) {
  wantedSite = domain.toLowerCase();
  emit();
}

export function takeWantedSite(): string | null {
  const v = wantedSite;
  wantedSite = null;
  return v;
}

export const useWantedSite = () => useSyncExternalStore(subscribe, () => wantedSite);

export function setMaintenanceOpen(v: boolean) {
  if (maint === v) return;
  maint = v;
  emit();
}

export const useMaintenanceOpen = () => useSyncExternalStore(subscribe, () => maint);
