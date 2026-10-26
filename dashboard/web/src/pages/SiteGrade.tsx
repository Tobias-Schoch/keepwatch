import { AlertTriangle, ChevronDown, Lock, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, Callout, Confirm, CopyButton, cx, DialogHead, Overlay, Pill, type ConfirmCopy, type Tone } from "../design/ui";
import { has } from "../config";
import { agoShort, LOCALE, plural, shortDateTime } from "../format";
import { useNav } from "../nav";
import { useAction, useToast } from "../messages";
import { openSetting } from "./settingsOpen";
import {
  ALERT_BELOW,
  CATEGORY_LABEL,
  GRADE_MIN,
  GRADES,
  gradeFor,
  lowScore,
  pts,
  STATUS_LABEL,
  statusTone,
  useSiteGrades,
  type FixAction,
  type GradeCategory,
  type GradeCheck,
  type SiteGrade,
  type SiteGrades,
} from "../sitegrade";
import "./sitegrade.css";

/**
 * Security grade per site: a score of 0–100 from six categories, grade A–F from that (server/sitegrade.py, API.md).
 * "Security 84" next to every site (GradeScore); a click opens the detail with a bar per category and the
 * deductions (sorted by points, each with "How to fix"). The page is wrapped in <SiteGradeProvider>; GradeScore
 * takes data and "open" from the context, the provider renders the detail itself.
 *
 * Gating: checks from the Trivy scan (via = "scan") only with image-scan; fixes that point to Portainer only with portainer.
 */

interface Ctx {
  data: SiteGrades | null;
  open: (id: number, domain: string) => void;
}

const GradeCtx = createContext<Ctx | null>(null);

export function SiteGradeProvider({ children }: { children: ReactNode }) {
  const p = useSiteGrades(true);
  const [sel, setSel] = useState<{ id: number; domain: string } | null>(null);
  const value = useMemo<Ctx>(() => ({ data: p.data, open: (id, domain) => setSel({ id, domain }) }), [p.data]);
  return (
    <GradeCtx.Provider value={value}>
      {children}
      {sel && <GradeDetail id={sel.id} domain={sel.domain} data={p.data} refresh={p.refresh} onClose={() => setSel(null)} />}
    </GradeCtx.Provider>
  );
}

/** Grades and "open detail" from the provider (e.g. for hints in a service header). */
export const useGrades = () => useContext(GradeCtx);

const VIA_LABEL = { public: "from outside", app: "app directly", lock: "block page only" } as const;

function catTone(c: GradeCategory): Tone {
  if (c.skipped) return "neutral";
  if (c.points >= c.max) return "ok";
  return c.points / c.max >= 0.6 ? "sand" : "rose";
}

/** Checks of installed modules only; fixes that need Portainer are dropped without it. */
const visibleChecks = (g: SiteGrade): GradeCheck[] =>
  (g.checks ?? [])
    .filter((c) => c.via !== "scan" || has("image-scan"))
    .map((c) => (c.fix && !has("portainer") && /portainer/i.test(c.fix.where) ? { ...c, fix: null } : c));

const deductions = (g: SiteGrade) => visibleChecks(g).filter((c) => c.deduction > 0).sort((a, b) => b.deduction - a.deduction || a.title.localeCompare(b.title, LOCALE));

function chipTitle(g: SiteGrade | null, checking: boolean) {
  if (!g) return checking ? "Checking…" : "Security: not checked yet";
  if (g.error) return `Security: ${g.error}`;
  return `Security ${g.score}/100${g.via ? ` · checked ${VIA_LABEL[g.via]}` : ""} – details`;
}

/* ---------- score next to the site ---------------------------------------------------------------- */

/** Colour of the security score: green from the alert threshold (80), yellow from 70, red below. */
export function securityTone(score: number | null | undefined, alertBelow = ALERT_BELOW): Tone {
  if (score == null) return "neutral";
  return score >= alertBelow ? "ok" : score >= 70 ? "sand" : "rose";
}

/** "Security 84" next to a site (header and site row); a click opens categories, deductions and "How to fix". */
export function GradeScore({ id, domain }: { id: number; domain: string }) {
  const ctx = useContext(GradeCtx);
  if (!ctx?.data) return null;
  const g = gradeFor(ctx.data, id, domain);
  const checking = !!ctx.data.checking?.includes(domain);
  const tone = g?.score != null ? securityTone(g.score, ctx.data.alertBelow) : g?.error ? "sand" : "neutral";
  const title = chipTitle(g, checking);
  return (
    <button
      type="button"
      className={cx("sg-score-btn", checking && "is-checking")}
      data-tone={tone}
      onClick={() => ctx.open(id, domain)}
      title={title}
      aria-label={`${domain}: ${title}`}
    >
      Security {g?.score ?? (g?.error ? "?" : "–")}
    </button>
  );
}

/**
 * "Security 77/100" in the header of a service: 100 minus the deductions of all its sites together, not the average
 * (three sites at 95 each → 85). A click opens the weakest site. Nothing without sites or without grades (no proxy).
 */
export function ServiceScore({ sites }: { sites: { id: number; domain: string }[] }) {
  const ctx = useContext(GradeCtx);
  if (!ctx?.data || !sites.length) return null;
  const d = ctx.data;
  const list = sites.map((s) => ({ ...s, g: gradeFor(d, s.id, s.domain) }));
  const scored = list.filter((x): x is typeof x & { g: SiteGrade & { score: number } } => x.g?.score != null).sort((a, b) => a.g.score - b.g.score);
  const checking = list.some((x) => d.checking?.includes(x.domain));
  const score = scored.length ? Math.max(0, Math.round(100 - scored.reduce((n, x) => n + (100 - x.g.score), 0))) : null;
  const open = scored[0] ?? list[0];
  const title = [
    ...list.map((x) => `${x.domain}: ${x.g?.score != null ? `${x.g.score}/100` : (x.g?.error ?? (d.checking?.includes(x.domain) ? "checking…" : "not checked yet"))}`),
    ...(list.length > 1 ? ["Deductions of all sites added up"] : []),
  ].join("\n");
  return (
    <button
      type="button"
      className={cx("sg-score-btn", checking && "is-checking")}
      data-tone={securityTone(score, d.alertBelow)}
      onClick={() => ctx.open(open.id, open.domain)}
      title={`${title}\nClick: ${open.domain} – details`}
      aria-label={`Security ${score ?? "not rated"} of 100 – details for ${open.domain}`}
    >
      Security {score ?? "–"}/100
    </button>
  );
}

/** "2 sites below 80" for a page header. Nothing while all have at least 80. */
export function GradeSummaryChip({ domains }: { domains?: string[] }) {
  const ctx = useContext(GradeCtx);
  const d = ctx?.data;
  if (!d) return null;
  const below = d.alertBelow ?? ALERT_BELOW;
  const list = (d.sites ?? []).filter((s) => (!domains || domains.includes(s.domain)) && lowScore(s, below));
  if (!list.length) return null;
  const rose = list.some((s) => s.grade && "DEF".includes(s.grade));
  const worst = [...list].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
  return (
    <button type="button" className="d-chip-btn" onClick={() => worst.id !== null && ctx.open(worst.id, worst.domain)} title={list.map((s) => `${s.domain}: ${s.score}/100`).join("\n")}>
      <Pill tone={rose ? "rose" : "sand"}>
        <ShieldCheck className="h-3 w-3" /> {plural(list.length, "site", "sites")} below {below}
      </Pill>
    </button>
  );
}

/* ---------- bar per category --------------------------------------------------------------------- */

function Bars({ cats }: { cats: GradeCategory[] }) {
  return (
    <ul className="sg-bars">
      {cats.map((c) => (
        <li
          key={c.id}
          className="sg-bar"
          data-tone={catTone(c)}
          title={`${CATEGORY_LABEL[c.id] ?? c.title}: ${pts(c.points)} of ${c.max}${c.skipped ? " (not visible, no deduction)" : c.problems ? ` · ${plural(c.problems, "deduction", "deductions")}` : ""}`}
        >
          <span className="sg-bar-label">{CATEGORY_LABEL[c.id] ?? c.title}</span>
          <span className="sg-bar-track" aria-hidden>
            <span className="sg-bar-fill" style={{ width: `${Math.max(0, Math.min(100, (c.points / c.max) * 100))}%` }} />
          </span>
          <span className="sg-bar-n">
            {pts(c.points)}
            <span className="sg-bar-max">/{c.max}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Detail ------------------------------------------------------------------------------ */

function fixCopy(action: FixAction, domain: string): ConfirmCopy {
  if (action === "hsts")
    return {
      title: `Turn on HSTS for ${domain}?`,
      description:
        "The Proxy Manager then sends Strict-Transport-Security (2 years, preload) and forces HTTPS. Browsers that have seen the site once will only open it encrypted from then on – there is no going back until it expires.",
      note: "The Proxy Manager rewrites the host's config, checks it with nginx -t and reloads nginx – no downtime. Turning it off is only possible in the Proxy Manager itself.",
      confirmLabel: "Turn on HSTS",
      tone: "accent",
    };
  return {
    title: `Force HTTPS for ${domain}?`,
    description: "Every request over http:// is then redirected to https:// with a 301.",
    note: "The Proxy Manager rewrites the host's config, checks it with nginx -t and reloads nginx – no downtime.",
    confirmLabel: "Force HTTPS",
    tone: "accent",
  };
}

const ACTION_LABEL: Record<FixAction, string> = { hsts: "Turn on HSTS", "force-ssl": "Force HTTPS" };

interface FixProps {
  c: GradeCheck;
  g: SiteGrade;
  npmWrite: boolean;
  busy: boolean;
  onAction: (a: FixAction) => void;
}

function Fix({ c, g, npmWrite }: Pick<FixProps, "c" | "g" | "npmWrite">) {
  const { go } = useNav();
  const f = c.fix;
  if (!f) return null;
  return (
    <div className="sg-fix">
      <div className="sg-fix-head">
        <Wrench className="h-3.5 w-3.5" /> How to fix
      </div>
      <div className="sg-fix-where">{f.where}</div>
      <p className="sg-fix-text">{f.text}</p>
      {f.snippet && (
        <div className="sg-snippet">
          <pre>{f.snippet}</pre>
          <CopyButton text={f.snippet} label="Copy" />
        </div>
      )}
      {f.action && g.id !== null && !npmWrite && (
        <p className="sg-fix-text">
          The dashboard can switch this for you once a login is saved under{" "}
          <button
            type="button"
            className="sg-link"
            onClick={() => {
              go("settings");
              openSetting("npm");
            }}
          >
            Settings → Proxy Manager login
          </button>
          .
        </p>
      )}
    </div>
  );
}

/** One deduction: header row with points (and the button when the dashboard can do it itself), expanded details + "How to fix". */
function Deduction({ c, g, npmWrite, busy, onAction, initiallyOpen }: FixProps & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const act = c.fix?.action && g.id !== null && npmWrite ? c.fix.action : null;
  return (
    <li className={cx("sg-check", `is-${c.status}`)}>
      <div className="sg-check-row">
        <button type="button" className="sg-check-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="sg-ded" data-tone={statusTone(c.status)}>
            −{pts(c.deduction)}
          </span>
          <span className="sg-check-main">
            <span className="sg-check-title">
              {c.title}
              <span className="sg-check-cat">{CATEGORY_LABEL[c.category] ?? ""}</span>
              {c.via === "app" && <span className="sg-check-cat">app directly</span>}
            </span>
            <span className="sg-check-sum">{c.summary}</span>
          </span>
          <ChevronDown className={cx("o-chev h-4 w-4 shrink-0 text-[var(--o-faint)]", open && "is-open")} />
        </button>
        {act && (
          <Button size="sm" variant="primary" className="sg-act" disabled={busy} onClick={() => onAction(act)}>
            <ShieldCheck className="h-3.5 w-3.5" /> {ACTION_LABEL[act]}
          </Button>
        )}
      </div>
      {open && (
        <div className="sg-check-body">
          {c.detail && <p className="sg-detail">{c.detail}</p>}
          <Fix c={c} g={g} npmWrite={npmWrite} />
        </div>
      )}
    </li>
  );
}

/** Passed and not visible checks – one row per check, collapsed. */
function Passed({ list }: { list: GradeCheck[] }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const skipped = list.filter((c) => c.status === "skip").length;
  return (
    <section>
      <button type="button" className="sg-passed-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown className={cx("o-chev h-3.5 w-3.5", open && "is-open")} />
        {plural(list.length - skipped, "check", "checks")} without deduction{skipped ? ` · ${skipped} not visible` : ""}
      </button>
      {open && (
        <ul className="sg-passed">
          {list.map((c) => (
            <li key={c.id} title={c.detail || undefined}>
              <span className="sg-status" data-tone={statusTone(c.status)}>
                {c.status === "skip" ? STATUS_LABEL.skip : "ok"}
              </span>
              <span className="sg-check-title">{c.title}</span>
              <span className="sg-check-sum">{c.summary}</span>
              <span className="sg-passed-w" title="Weight">
                {c.weight}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const capMax = (c: SiteGrade["caps"][number]) => c.max ?? GRADE_MIN[GRADES[GRADES.indexOf(c.grade) - 1] ?? "A"] - 1;

function GradeDetail({ id, domain, data, refresh, onClose }: { id: number; domain: string; data: SiteGrades | null; refresh: () => Promise<void>; onClose: () => void }) {
  const g = gradeFor(data, id, domain);
  const checking = !!data?.checking?.includes(domain);
  const anyChecking = !!data?.checking?.length;
  const { busy, run } = useAction();
  const toast = useToast();
  const [ask, setAsk] = useState<FixAction | null>(null);

  const check = (all: boolean) =>
    void run(all ? "check-all" : "check", async () => {
      await api.post("/api/sitegrade/check", all ? {} : { id });
    }).then(() => refresh());

  const fix = (a: FixAction) =>
    void run("fix", async () => {
      const r = await api.post<{ ok: boolean; message: string }>("/api/sitegrade/fix", { id, fix: a });
      toast(r.message);
    }).then(() => refresh());

  const tone = securityTone(g?.score, data?.alertBelow);
  const ded = g ? deductions(g) : [];
  const passed = g ? visibleChecks(g).filter((c) => c.deduction <= 0) : [];
  const via = g?.via ?? (g?.limited ? "lock" : "public");

  return (
    <Overlay onClose={onClose} label={`Security ${domain}`} size="lg" align="top">
      <DialogHead
        icon={ShieldCheck}
        title={
          <span className="inline-flex items-center gap-3">
            <span className={cx("sg-big", via === "lock" && "is-limited")} data-tone={g?.score != null ? tone : "neutral"}>
              {g?.score ?? "–"}
              <span className="sg-score-max">/100</span>
            </span>
            <span className="min-w-0">{domain}</span>
          </span>
        }
        sub={
          g?.grade ? (
            <>
              checked {VIA_LABEL[via]} · <span title={shortDateTime(g.checkedAt)}>{agoShort(g.checkedAt)}</span>
              {g.raw != null && g.raw !== g.score && <> · {g.raw} before caps</>}
            </>
          ) : g?.error ? (
            "Check without result"
          ) : (
            "Not checked yet"
          )
        }
        aside={
          <Button size="sm" variant="secondary" disabled={!!busy || checking} onClick={() => check(false)}>
            <RefreshCw className={cx("h-3.5 w-3.5", (checking || busy === "check") && "o-spin")} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        }
      />
      <div className="o-dialog-body sg-body">
        {via === "app" && (
          <p className="sg-note">
            <Lock className="h-3.5 w-3.5 shrink-0" /> Behind an allow-list. Headers, cookies and error page come straight from the app (Docker network, GET only), encryption and HSTS from outside.
          </p>
        )}
        {g?.grade && !g.categories?.length && <p className="sg-note">Older result without categories – the server recalculates it on the next run.</p>}
        {via === "lock" && !!g?.categories?.length && (
          <Callout tone="neutral" icon={Lock} title="Only the block page was checked">
            The container wasn't reachable directly. What only the app sets (CSP, cookies, …) is not deducted.
          </Callout>
        )}
        {g?.error && (
          <Callout tone="sand" title="The site couldn't be checked">
            {g.error}
          </Callout>
        )}
        {g && g.caps.length > 0 && (
          <Callout tone={g.caps.some((c) => "DEF".includes(c.grade)) ? "rose" : "sand"} icon={AlertTriangle} title="Caps">
            {g.caps.map((c) => `at most ${capMax(c)}: ${c.reason}`).join(" · ")}
          </Callout>
        )}
        {!g && !checking && <p className="sg-empty">No grade for this site yet. "Check now" gets one in a few seconds.</p>}
        {!g && checking && <p className="sg-empty">Checking…</p>}
        {g?.categories && g.categories.length > 0 && <Bars cats={g.categories} />}
        {g && ded.length > 0 && (
          <section>
            <h3 className="sg-group-title">Deductions · −{pts(ded.reduce((n, c) => n + c.deduction, 0))}</h3>
            <ul className="sg-list">
              {ded.map((c, i) => (
                <Deduction key={c.id} c={c} g={g} npmWrite={!!data?.npmWrite} busy={!!busy} onAction={setAsk} initiallyOpen={i === 0} />
              ))}
            </ul>
          </section>
        )}
        {g?.grade && !ded.length && <p className="sg-empty">No deductions.</p>}
        {g && <Passed list={passed} />}
        <p className="sg-schema">Score = 100 − deductions: a failure costs the check's full weight, a warning half of it.</p>
      </div>
      <div className="o-dialog-foot">
        <span className="o-mute mr-auto text-[12.5px]">{data?.checkedAt ? `All sites last checked ${agoShort(data.checkedAt)}` : "No full run yet"}</span>
        <Button variant="ghost" disabled={!!busy || anyChecking} onClick={() => check(true)}>
          <RefreshCw className={cx("h-4 w-4", (busy === "check-all" || (anyChecking && !checking)) && "o-spin")} />
          Check all sites
        </Button>
      </div>
      {ask && <Confirm icon={ShieldCheck} copy={fixCopy(ask, domain)} onClose={() => setAsk(null)} onConfirm={() => fix(ask)} />}
    </Overlay>
  );
}
