import { Boxes, DatabaseBackup, LayoutGrid, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { has, useConfig, type ModuleId } from "./config";
import { openSetting, settingOfRow } from "./pages/settingsOpen";
import type { Area, Overview } from "./types";

export type View = "overview" | "services" | "backups" | "security" | "settings" | "timeline";

export const ALL_VIEWS: readonly View[] = ["overview", "services", "backups", "security", "settings", "timeline"];

/**
 * Sub-pages without their own dock entry: the dock highlights the parent, the header shows the name.
 * Timeline: reading material across all areas, not a place to work – reached from the overview
 * ("View all"), ⌘K and #timeline.
 */
export const SUBVIEWS: Partial<Record<View, { parent: View; label: string }>> = {
  timeline: { parent: "overview", label: "Timeline" },
};

/** Which dock entry a page belongs to. */
export const dockView = (v: View): View => SUBVIEWS[v]?.parent ?? v;

/** Module a page needs. Pages without an entry are always there. */
const VIEW_MODULE: Partial<Record<View, ModuleId>> = {
  services: "docker",
  backups: "backup",
};

/** Is this page available with the installed modules? */
export const viewEnabled = (v: View): boolean => {
  const m = VIEW_MODULE[v];
  return !m || has(m);
};

export interface ViewDef {
  id: View;
  label: string;
  icon: LucideIcon;
  areas?: Area[];
}

/**
 * Dock: Overview | where you act (Services, Backups) and Security (mostly reading) | Settings.
 * `areas` drives the problem dot in the dock: the overview carries system problems (updates, disk),
 * Services those from Docker, stacks and sites.
 */
const ALL_DOCK: ViewDef[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid, areas: ["system"] },
  { id: "services", label: "Services", icon: Boxes, areas: ["docker", "stacks", "sites"] },
  { id: "backups", label: "Backups", icon: DatabaseBackup, areas: ["backups"] },
  { id: "security", label: "Security", icon: ShieldCheck, areas: ["security"] },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
];

/** Dock entries for the installed modules. */
export const dockViews = (): ViewDef[] => ALL_DOCK.filter((v) => viewEnabled(v.id));

/** Label of any page (dock entry or sub-page). */
export const viewLabel = (v: View): string => ALL_DOCK.find((d) => d.id === v)?.label ?? SUBVIEWS[v]?.label ?? v;

const AREA_VIEW: Record<Area, View> = {
  system: "overview",
  docker: "services",
  stacks: "services",
  sites: "services",
  backups: "backups",
  security: "security",
};

/** Page for a problem area; areas of disabled pages land on the overview. */
export const viewOfArea = (a: Area): View => {
  const v = AREA_VIEW[a] ?? "overview";
  return viewEnabled(v) ? v : "overview";
};

type ProblemLink = { area: Area; target?: string };

/** Settings row of a problem's `target` ("settings/<row>"), if that row exists here. */
const problemSetting = (p: ProblemLink) => (p.target?.startsWith("settings/") ? settingOfRow(p.target.slice(9)) : null);

/** Where "View" leads for a problem: the settings row in `target` that fixes it, else the page of its area. */
export const viewOfProblem = (p: ProblemLink): View => (problemSetting(p) ? "settings" : viewOfArea(p.area));

/** Go to a problem: the page of its area, or straight into the settings dialog that fixes it. */
export function followProblem(go: (v: View) => void, p: ProblemLink) {
  const row = problemSetting(p);
  go(row ? "settings" : viewOfArea(p.area));
  if (row) openSetting(row);
}

/** A view id from a string (backend link, hash), or null if unknown or its module is off. */
export function asView(s: string | null | undefined): View | null {
  if (!s) return null;
  return (ALL_VIEWS as readonly string[]).includes(s) && viewEnabled(s as View) ? (s as View) : null;
}

const read = (): View => {
  const h = location.hash.replace(/^#/, "");
  const v = asView(h);
  // Unknown hash, or a page whose module is off: back to the overview (and clean up the address).
  if (!v && h) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return v ?? "overview";
};

interface Nav {
  view: View;
  go: (v: View) => void;
  /** The overview is polled app-wide: health for the dock, freshness for the header. */
  overview: Overview | null;
  overviewError: string | null;
  overviewAt: number | null;
}

const Ctx = createContext<Nav | null>(null);

export function NavProvider({
  children,
  overview,
  overviewError,
  overviewAt,
}: {
  children: ReactNode;
  overview: Overview | null;
  overviewError: string | null;
  overviewAt: number | null;
}) {
  const cfg = useConfig();
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const on = () => setView(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // Config changed (e.g. arrived late): leave a page that no longer exists.
  useEffect(() => setView(read()), [cfg]);
  const go = useCallback((v: View) => {
    if (!viewEnabled(v)) v = "overview";
    const hash = v === "overview" ? "" : `#${v}`;
    if (location.hash !== hash) history.pushState(null, "", `${location.pathname}${location.search}${hash}`);
    setView(v);
    scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);
  const value = useMemo(() => ({ view, go, overview, overviewError, overviewAt }), [view, go, overview, overviewError, overviewAt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error("useNav outside of <NavProvider>");
  return n;
}
