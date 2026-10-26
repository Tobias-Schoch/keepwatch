import { History } from "lucide-react";
import { prefersReduced } from "./design/motion";
import { has, type ModuleId } from "./config";
import { asView, type View } from "./nav";
import { registerPalette } from "./palette/registry";
import { openSetting, settingByText, settingOfRow } from "./pages/settingsOpen";

/* Timeline "What happened?" – types, labels, jumping to the right place (API.md, timeline.py). */

export type TlKind = "services" | "backup" | "system" | "security" | "dashboard";
export type TlLevel = "info" | "warn" | "crit";

/**
 * Where a click leads: a page, and there an element with this text to find and flash –
 * or, with `setting`, a settings row to open (row ids as in problem targets "settings/<row>").
 */
export interface TlLink {
  /** A page id (see nav.tsx); unknown ids and pages of disabled modules are ignored. */
  view: View | string;
  setting?: string;
  sel?: string;
  text?: string;
  exact?: boolean;
  up?: string;
}

export interface TlEvent {
  id: number;
  t: number;
  tEnd: number | null;
  kind: TlKind;
  title: string;
  detail: string | null;
  level: TlLevel;
  service: string | null;
  serviceTitle: string | null;
  /** docker, portainer, backup, probe, apt, boot, cert, deploy, f2b, ssh, port22, audit, updates, image, … */
  source: string;
  /** Bundled entries (bans per hour, logins per hour). */
  count: number;
  /** Backfilled from existing logs on first start. */
  backfill: boolean;
  link: TlLink | null;
}

export interface Timeline {
  events: TlEvent[];
  more: boolean;
  services: { id: string; title: string; count: number }[];
  counts: Partial<Record<TlKind, { total: number; problems: number }>>;
  range: { from: number; to: number };
  oldest: number | null;
  keepDays: number;
  backfilledAt: number | null;
  backfilling: boolean;
}

export interface TimelineRecent {
  since: number;
  events: TlEvent[];
  total: number;
  problems: number;
  backfilling: boolean;
}

/** `module`: the filter only shows when that module is installed. */
export const KINDS: { id: TlKind; label: string; module?: ModuleId }[] = [
  { id: "services", label: "Services", module: "docker" },
  { id: "backup", label: "Backups", module: "backup" },
  { id: "system", label: "System" },
  { id: "security", label: "Security" },
  { id: "dashboard", label: "Dashboard" },
];

/** Kind filters for the installed modules. */
export const visibleKinds = () => KINDS.filter((k) => !k.module || has(k.module));

export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<TlKind, string>;

export const isProblem = (e: TlEvent) => e.level !== "info";

/** Switch to the page, find the spot, scroll to it and flash it briefly (like the command palette). */
export function followLink(go: (v: View) => void, link: TlLink) {
  const view = asView(link.view);
  if (!view) return; // unknown page or its module is off
  go(view);
  // Settings are rows with a dialog: open the matching dialog directly.
  const setting = view === "settings" ? settingOfRow(link.setting) ?? (link.text ? settingByText(link.text) : null) : null;
  if (setting) return openSetting(setting);
  if (!link.sel || !link.text) return;
  const want = link.text.trim().toLowerCase();
  // Security shows its sections as fact rows (.s-fact-label) rather than panel headings.
  const sel = view === "security" ? `${link.sel}, .s-fact-label` : link.sel;
  let tries = 0;
  const look = () => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const el = els.find((e) => {
      const s = (e.textContent ?? "").trim().toLowerCase();
      return link.exact ? s === want : s.includes(want);
    });
    if (!el) {
      if (++tries < 60) setTimeout(look, 100);
      return;
    }
    const target = (link.up && el.closest<HTMLElement>(link.up)) || el.closest<HTMLElement>(".s-fact") || el;
    target.scrollIntoView({ block: "center", behavior: prefersReduced() ? "auto" : "smooth" });
    target.classList.remove("d-flash");
    void target.offsetWidth;
    target.classList.add("d-flash");
    setTimeout(() => target.classList.remove("d-flash"), 2000);
  };
  setTimeout(look, 80);
}

/* ⌘K: "Open timeline" */
registerPalette(() => [
  {
    id: "view:timeline",
    group: "pages",
    title: "Open timeline",
    hint: "What happened?",
    keywords: "timeline history events log activity what happened last night yesterday reboot backup updates",
    icon: History,
    rank: 2,
    run: (ctx) => ctx.go("timeline"),
  },
]);
