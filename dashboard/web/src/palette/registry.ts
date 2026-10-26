import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { View } from "../nav";
import type { Backups, Container, Docker, Security, Site, Sites, Stack, Stacks } from "../types";

/**
 * Command palette (⌘K): entries come from "sources". A source gets the loaded
 * data and returns its entries. Register new entries (updates, "New site", …) with
 *
 *   registerPalette((d) => [{ id: "…", group: "actions", title: "…", icon: Rocket, run: (ctx) => … }]);
 *
 * anywhere that is loaded at startup (palette/sources.tsx is the template).
 * Actions open existing dialogs via ctx.dialog(…) – never POST directly.
 * Gate entries of optional modules with `has("<module>")` from config.tsx.
 */

export type GroupId = "actions" | "services" | "sites" | "containers" | "backups" | "settings" | "pages";

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "actions", label: "Actions" },
  { id: "services", label: "Services" },
  { id: "sites", label: "Sites" },
  { id: "containers", label: "Containers" },
  { id: "backups", label: "Backups" },
  { id: "settings", label: "Settings" },
  { id: "pages", label: "Pages" },
];

/** What the palette loads when it opens (null while missing or when the module is off). */
export interface PaletteData {
  docker: Docker | null;
  stacks: Stacks | null;
  sites: Sites | null;
  backups: Backups | null;
  security: Security | null;
}

export interface Jump {
  /** CSS selector of the candidates, e.g. ".d-block-title". */
  sel: string;
  /** Text the candidate must contain (or, with exact, equal). */
  text: string;
  exact?: boolean;
  /** Which ancestor lights up (closest), default: the element itself. */
  up?: string;
}

export interface PaletteCtx {
  go: (v: View) => void;
  /** Switch to the page, find the element, scroll to it, flash it briefly. */
  jump: (v: View, j: Jump) => void;
  /** Show a dialog (after the palette closes). `close` removes it again. */
  dialog: (render: (close: () => void) => ReactNode) => void;
  openLogs: (title: string, containers: string[]) => void;
  openContainer: (c: Container) => void;
  /** Existing "Renew certificate" confirmation (Sites.tsx). */
  renew: (s: Site) => void;
}

export interface PaletteItem {
  id: string;
  group: GroupId;
  title: string;
  /** Shown to the right, dimmed. */
  hint?: string;
  /** Also searched, not shown. */
  keywords?: string;
  icon: LucideIcon;
  mono?: boolean;
  /** Weight for equally good matches (higher = further up). */
  rank?: number;
  run: (ctx: PaletteCtx) => void;
}

export type PaletteSource = (d: PaletteData) => PaletteItem[];

const SOURCES: PaletteSource[] = [];

export function registerPalette(source: PaletteSource) {
  SOURCES.push(source);
}

export function collect(d: PaletteData): PaletteItem[] {
  const out: PaletteItem[] = [];
  const seen = new Set<string>();
  for (const s of SOURCES) {
    try {
      for (const it of s(d)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    } catch {
      /* a broken source must not empty the palette */
    }
  }
  return out;
}

/** Container → service membership, as on the Services page. */
export function stackContainers(s: Stack, containers: Container[]): Container[] {
  return containers.filter((c) => s.containers.includes(c.name) || (c.project !== null && c.project === s.name));
}
