import { ArrowUp, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MOCK } from "../../api";
import { useConfig } from "../../config";
import { num, plural, todayLong } from "../../format";
import { dockView, dockViews, viewProblems } from "../../nav";
import { openPalette, PALETTE_KEY } from "../../palette/Palette";
import { ServerState, useShell } from "../Shell";
import { cx, IconButton, Kbd } from "../ui";

/**
 * Paper: the dashboard as a broadsheet. A masthead with the date line and the host as the
 * edition; below it the sections as tabs that stick to the top once the masthead has
 * scrolled away (the name then moves into the tab bar). No dock, no glass.
 */
export function PaperShell({ children }: { children: ReactNode }) {
  const { view, go, overview, host, spin, refresh } = useShell();
  useConfig(); // re-render when the modules are known
  const views = dockViews();
  const health = overview?.health ?? [];
  const mast = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = mast.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const crit = health.filter((h) => h.level === "crit").length;
  const days = overview ? Math.floor(overview.host.uptimeSec / 86400) : null;

  return (
    <>
      <header ref={mast} className="pp-mast">
        <div className="pp-wrap">
          <div className="pp-dateline">
            <span>{todayLong()}</span>
            <span className="pp-dateline-mid">
              {host || "Server"} edition{MOCK && <em> · sample data</em>}
            </span>
            <span>{days !== null ? `No. ${num(days + 1)} since boot` : " "}</span>
          </div>
          <button type="button" className="pp-title" onClick={() => go("overview")} aria-label="Go to overview">
            Keepwatch
          </button>
          <div className="pp-subline">
            {health.length === 0 ? (
              <span>All quiet on the server.</span>
            ) : (
              <span>
                {plural(health.length, "matter", "matters")} on the desk{crit > 0 && <b> · {crit} urgent</b>}
              </span>
            )}
            {overview && (
              <span className="pp-subline-facts">
                Load {num(overview.now.load[0], 2)} · {overview.host.os}
              </span>
            )}
          </div>
        </div>
      </header>

      <nav className={cx("pp-nav", stuck && "is-stuck")} aria-label="Navigation">
        <div className="pp-wrap pp-nav-in">
          <button type="button" className="pp-nav-brand" onClick={() => go("overview")} tabIndex={stuck ? 0 : -1} aria-hidden={!stuck}>
            Keepwatch
          </button>
          <div className="pp-tabs">
            {views.map((v, i) => {
              const { probs, alert } = viewProblems(v, health);
              const on = dockView(view) === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  className={cx("pp-tab", on && "is-on")}
                  aria-current={on ? "page" : undefined}
                  aria-label={probs.length ? `${v.label} – ${probs.length} ${probs.length === 1 ? "issue" : "issues"}` : v.label}
                  onClick={() => go(v.id)}
                >
                  <span className="pp-tab-no" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{v.label}</span>
                  {alert && <i className="pp-tab-alert" data-tone={alert} aria-hidden />}
                </button>
              );
            })}
          </div>
          <div className="pp-nav-tools">
            <button type="button" className="pp-search" onClick={openPalette} aria-label={`Search (${PALETTE_KEY})`} aria-keyshortcuts="Meta+K Control+K">
              <Search className="h-4 w-4" aria-hidden />
              <span className="pp-search-text">Search</span>
              <Kbd>{PALETTE_KEY}</Kbd>
            </button>
            <ServerState />
            <IconButton label="Refresh" onClick={refresh}>
              <RefreshCw className={cx("h-4 w-4", spin && "o-spin")} />
            </IconButton>
          </div>
        </div>
      </nav>

      <main className="o-stage pp-stage">
        <div key={view} className="o-page-in">
          {children}
        </div>
      </main>

      <footer className="pp-foot">
        <div className="pp-wrap pp-foot-in">
          <span>Keepwatch · printed on {host || "your server"}</span>
          <button type="button" className="pp-foot-top" onClick={() => scrollTo({ top: 0, behavior: "smooth" })}>
            Back to top <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </footer>
    </>
  );
}
