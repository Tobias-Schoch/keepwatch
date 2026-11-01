import { useEffect, useState, type ReactNode } from "react";
import { MOCK } from "../../api";
import { useConfig } from "../../config";
import { clockSec, duration, num, nowSec } from "../../format";
import { dockView, dockViews, useNav, viewProblems } from "../../nav";
import { openPalette, PALETTE_KEY } from "../../palette/Palette";
import { layersOpen } from "../layer";
import { ServerState, useShell } from "../Shell";
import { DESIGNS, setDesign, useDesign } from "../theme";
import { cx } from "../ui";

/**
 * Phosphor: the dashboard as a terminal. A fixed sidebar instead of the dock – sections with
 * hotkeys (1…n, "/" searches), live system meters as ASCII bars – and a status line at the
 * bottom like tmux or vim. Below 900 px the sidebar folds into a bar at the top.
 */
export function PhosphorShell({ children }: { children: ReactNode }) {
  const { view, go, overview, host, spin, refresh } = useShell();
  useConfig(); // re-render when the modules are known
  const views = dockViews();
  const health = overview?.health ?? [];

  // Hotkeys: digits jump to a section, "/" opens the search – never while typing or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || layersOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "/") {
        e.preventDefault();
        openPalette();
        return;
      }
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < views.length) {
        e.preventDefault();
        go(views[i].id);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [views, go]);

  const now = overview?.now;
  const mem = now ? (now.mem.used / Math.max(1, now.mem.total)) * 100 : null;
  const root = now?.disks.find((d) => d.mount === "/") ?? now?.disks[0];
  const disk = root ? (root.used / Math.max(1, root.total)) * 100 : null;

  return (
    <>
      <aside className="ph-side">
        <button type="button" className="ph-brand" onClick={() => go("overview")} aria-label="Go to overview">
          <span className="ph-logo" aria-hidden>
            ▚▞ KEEPWATCH
          </span>
          <span className="ph-host">
            root@<b>{host || "server"}</b>
          </span>
        </button>

        <button type="button" className="ph-cmd" onClick={openPalette} aria-label={`Search (${PALETTE_KEY})`} aria-keyshortcuts="/ Meta+K Control+K">
          <span className="ph-prompt" aria-hidden>
            $
          </span>
          <span className="ph-cmd-text">search</span>
          <span className="ph-caret" aria-hidden />
          <kbd className="ph-key">/</kbd>
        </button>

        <nav className="ph-nav" aria-label="Navigation">
          <div className="ph-head" aria-hidden>
            ── sections ──
          </div>
          {views.map((v, i) => {
            const { probs, alert } = viewProblems(v, health);
            const on = dockView(view) === v.id;
            return (
              <button
                key={v.id}
                type="button"
                className={cx("ph-item", on && "is-on")}
                aria-current={on ? "page" : undefined}
                aria-keyshortcuts={String(i + 1)}
                aria-label={probs.length ? `${v.label} – ${probs.length} ${probs.length === 1 ? "issue" : "issues"}` : v.label}
                onClick={() => go(v.id)}
              >
                <kbd className="ph-key">{i + 1}</kbd>
                <span className="ph-item-label">{v.label}</span>
                {alert && (
                  <span className="ph-alert" data-tone={alert} aria-hidden>
                    !{probs.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {now && overview && (
          <div className="ph-sys" aria-label="System">
            <div className="ph-head" aria-hidden>
              ── system ──
            </div>
            <Meter label="cpu" value={now.cpu} />
            {mem !== null && <Meter label="mem" value={mem} />}
            {disk !== null && <Meter label="disk" value={disk} />}
            <div className="ph-row">
              <span>load</span>
              <b>{now.load.map((l) => num(l, 2)).join(" ")}</b>
            </div>
            <div className="ph-row">
              <span>up</span>
              <b>{duration(overview.host.uptimeSec)}</b>
            </div>
          </div>
        )}

        <div className="ph-side-foot">
          <ServerState />
          <button type="button" className="ph-link" onClick={refresh} aria-label="Refresh">
            [{spin ? "…" : "r"}] refresh
          </button>
        </div>
      </aside>

      <main className="o-stage ph-stage">
        <div key={view} className="o-page-in">
          {children}
        </div>
      </main>

      <StatusLine issues={health.length} />
    </>
  );
}

/** A meter as text: [█████░░░░░]  52%. Tone follows the value. */
function Meter({ label, value }: { label: string; value: number }) {
  const n = Math.max(0, Math.min(12, Math.round((value / 100) * 12)));
  const tone = value >= 90 ? "rose" : value >= 75 ? "sand" : undefined;
  return (
    <div className="ph-row" data-tone={tone}>
      <span>{label}</span>
      <b className="ph-bar" aria-label={`${Math.round(value)} %`}>
        <i aria-hidden>{"█".repeat(n)}</i>
        <span aria-hidden>{"░".repeat(12 - n)}</span>
        {String(Math.round(value)).padStart(3, " ")}%
      </b>
    </div>
  );
}

/** Bottom line: mode, path, issues, design, clock. */
function StatusLine({ issues }: { issues: number }) {
  const { view } = useNav();
  const design = useDesign();
  const [t, setT] = useState(nowSec);
  useEffect(() => {
    const id = setInterval(() => setT(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);
  const next = DESIGNS[(DESIGNS.findIndex((d) => d.id === design) + 1) % DESIGNS.length];
  return (
    <footer className="ph-status">
      <span className="ph-st-mode" data-mock={MOCK || undefined}>
        {MOCK ? "MOCK" : "LIVE"}
      </span>
      <span className="ph-st-path">~/{view === "overview" ? "" : view}</span>
      <span className="ph-st-fill" />
      {issues > 0 && (
        <span className="ph-st-issues" data-tone="sand">
          {issues} {issues === 1 ? "issue" : "issues"}
        </span>
      )}
      <button type="button" className="ph-st-design" onClick={() => setDesign(next.id)} title={`Switch to ${next.name}`}>
        design:{design}
      </button>
      <span className="ph-st-clock o-num">{clockSec(t)}</span>
    </footer>
  );
}
