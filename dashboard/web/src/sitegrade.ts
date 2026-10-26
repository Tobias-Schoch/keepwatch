/** Security grade per site – types and polling (backend: server/sitegrade.py, API.md). Module proxy. */
import { useEffect, useRef } from "react";
import { usePoll, type Poll } from "./api";
import { has } from "./config";
import type { Tone } from "./design/ui";
import { useToast } from "./messages";

export type Grade = "A" | "B" | "C" | "D" | "E" | "F";
export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type CategoryId = "transport" | "header" | "cookies" | "leak" | "access" | "software";
/** How a check was seen: from outside, directly at the app (behind an allow-list) or from the Trivy scan. */
export type CheckVia = "public" | "app" | "scan";
/** public = like any visitor · app = behind an allow-list, app directly in the Docker network · lock = only the block page. */
export type SiteVia = "public" | "app" | "lock";
/** What the dashboard can switch itself (via the Proxy Manager API, turning on only). */
export type FixAction = "hsts" | "force-ssl";

export interface GradeFix {
  /** Where to change it ("Proxy Manager → Proxy Hosts → … → SSL", "next.config.js … – repo …"). */
  where: string;
  text: string;
  snippet: string | null;
  action: FixAction | null;
}

export interface GradeCheck {
  id: string;
  category: CategoryId;
  title: string;
  status: CheckStatus;
  weight: number;
  deduction: number;
  summary: string;
  detail: string;
  fix: GradeFix | null;
  via?: CheckVia;
}

export interface GradeCategory {
  id: CategoryId;
  title: string;
  max: number;
  points: number;
  problems: number;
  /** Nothing in it was visible (block page only, no scan) – full points without evidence. */
  skipped: boolean;
}

export interface SiteGrade {
  schema?: number;
  id: number | null;
  domain: string;
  checkedAt: number;
  grade: Grade | null;
  /** 0–100 after caps; the grade follows from this alone. */
  score: number | null;
  /** 0–100 before caps. */
  raw?: number | null;
  via?: SiteVia;
  /** Behind an allow-list (403 for everyone else). */
  limited: boolean;
  limitedNote: string | null;
  status: number | null;
  /** Response of the app itself (only with via = app). */
  appStatus?: number | null;
  url: string | null;
  loginUrl: string | null;
  admin?: { path: string; status: number }[];
  caps: { grade: Grade; max?: number; reason: string }[];
  categories?: GradeCategory[];
  checks: GradeCheck[];
  error: string | null;
  durationMs?: number | null;
  checking?: boolean;
}

export interface SiteGrades {
  checkedAt: number | null;
  /** Domains being checked right now. */
  checking: string[];
  error: string | null;
  every: number;
  /** Proxy Manager login saved – then the dashboard can turn on HSTS / force HTTPS. */
  npmWrite: boolean;
  schema?: number;
  /** Below this the score shows in a service header (80). */
  alertBelow?: number;
  grades?: { grade: Grade; min: number }[];
  categories?: { id: CategoryId; title: string; max: number; checks: { id: string; title: string; weight: number }[] }[];
  sites: SiteGrade[];
}

export const GRADES: Grade[] = ["A", "B", "C", "D", "E", "F"];
export const ALERT_BELOW = 80;
/** Fixed thresholds (as in sitegrade.py): A from 90, B from 80, C from 70, D from 60, E from 50, else F. */
export const GRADE_MIN: Record<Grade, number> = { A: 90, B: 80, C: 70, D: 60, E: 50, F: 0 };
export const CATEGORY_LABEL: Record<CategoryId, string> = {
  transport: "Transport",
  header: "Headers",
  cookies: "Cookies & session",
  leak: "Information leaks",
  access: "Access protection",
  software: "Software",
};

/** A green, B neutral, C sand, D–F rose. */
export function gradeTone(g: Grade | null | undefined): Tone {
  if (!g) return "neutral";
  if (g === "A") return "ok";
  if (g === "B") return "neutral";
  if (g === "C") return "sand";
  return "rose";
}

export const statusTone = (s: CheckStatus): Tone => (s === "ok" ? "ok" : s === "warn" ? "sand" : s === "fail" ? "rose" : "neutral");
export const STATUS_LABEL: Record<CheckStatus, string> = { ok: "ok", warn: "warning", fail: "failed", skip: "not visible" };

/** Worse than B (C–F). */
export const belowB = (g: Grade | null | undefined) => !!g && GRADES.indexOf(g) > 1;

/** Score below the threshold for the service header hint (default 80, i.e. C and worse). */
export const lowScore = (g: Pick<SiteGrade, "score"> | null | undefined, below = ALERT_BELOW) => g?.score != null && g.score < below;

/** "84" or "84/100". */
export const scoreText = (g: Pick<SiteGrade, "grade" | "score">, full = false) => `${g.score ?? "–"}${full ? "/100" : ""}`;

/** Points with one decimal ("12.5"). */
export const pts = (n: number) => String(Math.round(n * 10) / 10);

/** Grade of a site: by proxy host id, else by domain. */
export function gradeFor(d: SiteGrades | null, id: number, domain: string): SiteGrade | null {
  if (!d) return null;
  const sites = d.sites ?? [];
  return sites.find((s) => s.id === id) ?? sites.find((s) => s.domain === domain) ?? null;
}

/** Polls /api/sitegrade: every 60 s, every 2 s during a check. Reports when a check finishes (`toasts`). Nothing without proxy. */
export function useSiteGrades(toasts = false): Poll<SiteGrades> {
  const every = useRef(60_000);
  const p = usePoll<SiteGrades>(has("proxy") ? "/api/sitegrade" : null, every.current);
  const toast = useToast();
  const was = useRef<number | null>(null);
  every.current = p.data?.checking?.length ? 2_000 : 60_000;
  useEffect(() => {
    if (!p.data) return;
    const n = p.data.checking?.length ?? 0;
    if (toasts && was.current && !n) {
      const low = (p.data.sites ?? []).filter((s) => lowScore(s, p.data?.alertBelow)).length;
      toast(low ? `Security scores updated – ${low} below ${p.data.alertBelow ?? ALERT_BELOW} points.` : "Security scores updated.", low ? "warn" : "success");
    }
    was.current = n;
  }, [p.data, toast, toasts]);
  return p;
}
