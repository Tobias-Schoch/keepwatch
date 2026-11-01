import { useSyncExternalStore } from "react";

/**
 * Designs: three looks on the same Obsidian base (obsidian.css). Each one sets html[data-design]
 * to "obsidian-<id>" and brings its own navigation, background and material:
 *
 *   graphit   – black glass, floating dock, Dot Field; with a light mode (html[data-mode="light"]):
 *               the same glass on paper, ink Waves behind it
 *   phosphor  – CRT terminal: sidebar with hotkeys, status line, Faulty Terminal
 *   paper     – light broadsheet: masthead with section tabs, ink Waves
 *
 * The choice belongs to this browser (localStorage), not to the server. index.html sets the
 * attributes before the first paint, so a reload never flashes the wrong design.
 */
export type Design = "graphit" | "phosphor" | "paper";
export type Mode = "dark" | "light";

export const DESIGNS: { id: Design; name: string; blurb: string; light?: boolean }[] = [
  { id: "graphit", name: "Graphite", blurb: "Glass, a dock and a dot field – dark or light." },
  { id: "phosphor", name: "Phosphor", blurb: "A CRT terminal: hotkeys, status line, glowing glyphs." },
  { id: "paper", name: "Paper", blurb: "A light broadsheet: serif headlines, ink waves.", light: true },
];

const KEY = "kw-design";
const MODE_KEY = "kw-mode";
const listeners = new Set<() => void>();

export const currentDesign = (): Design => {
  const d = document.documentElement.dataset.design?.replace(/^obsidian-/, "");
  return DESIGNS.some((x) => x.id === d) ? (d as Design) : "graphit";
};

/** Light or dark – only Graphite has both; Phosphor is always dark, Paper always light. */
export const currentMode = (): Mode => (document.documentElement.dataset.mode === "light" ? "light" : "dark");

/** Is the page light right now (design and mode together)? */
const isLight = () => {
  const d = currentDesign();
  return d === "paper" || (d === "graphit" && currentMode() === "light");
};

function apply(change: (html: HTMLElement) => void) {
  const html = document.documentElement;
  // No transitions while every color changes at once – one clean cut.
  html.setAttribute("data-design-switch", "");
  change(html);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", isLight() ? "light" : "dark");
  listeners.forEach((l) => l());
  requestAnimationFrame(() => requestAnimationFrame(() => html.removeAttribute("data-design-switch")));
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice lasts until the reload */
  }
}

export function setDesign(d: Design) {
  if (d === currentDesign()) return;
  apply((html) => (html.dataset.design = `obsidian-${d}`));
  store(KEY, d);
}

export function setMode(m: Mode) {
  if (m === currentMode()) return;
  apply((html) => {
    if (m === "light") html.dataset.mode = "light";
    else delete html.dataset.mode;
  });
  store(MODE_KEY, m);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useDesign(): Design {
  return useSyncExternalStore(subscribe, currentDesign);
}

export function useMode(): Mode {
  return useSyncExternalStore(subscribe, currentMode);
}
