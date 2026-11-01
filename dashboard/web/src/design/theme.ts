import { useSyncExternalStore } from "react";

/**
 * Light or dark: Graphite as black glass on the Dot Field, or the same glass on paper with ink
 * Waves (light.css, html[data-mode="light"]). The choice belongs to this browser (localStorage),
 * not to the server. index.html sets the attribute before the first paint, so a reload never
 * flashes the wrong mode.
 */
export type Mode = "dark" | "light";

const KEY = "kw-mode";
const listeners = new Set<() => void>();

export const currentMode = (): Mode => (document.documentElement.dataset.mode === "light" ? "light" : "dark");

export function setMode(m: Mode) {
  if (m === currentMode()) return;
  const html = document.documentElement;
  // No transitions while every color changes at once – one clean cut.
  html.setAttribute("data-design-switch", "");
  if (m === "light") html.dataset.mode = "light";
  else delete html.dataset.mode;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", m);
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* private mode: the choice lasts until the reload */
  }
  listeners.forEach((l) => l());
  requestAnimationFrame(() => requestAnimationFrame(() => html.removeAttribute("data-design-switch")));
}

export function useMode(): Mode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentMode,
  );
}
