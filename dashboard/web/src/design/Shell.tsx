import { Moon, RefreshCw, Search, Sun } from "lucide-react";
import { useState, type ReactNode } from "react";
import { MOCK, refreshAll, useOnline } from "../api";
import { Since } from "../common";
import { useConfig } from "../config";
import { useNav, viewLabel } from "../nav";
import { openPalette, PALETTE_KEY } from "../palette/Palette";
import { Dock } from "./Dock";
import { GradualBlur } from "./rb/type/GradualBlur";
import { PaperShell } from "./shells/PaperShell";
import { PhosphorShell } from "./shells/PhosphorShell";
import { setMode, useDesign, useMode } from "./theme";
import { cx, IconButton, Kbd, Pill } from "./ui";

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="o-mark" aria-hidden>
      <defs>
        <linearGradient id="o-mark-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--o-mark-1)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--o-mark-2)" }} />
          <stop offset="1" style={{ stopColor: "var(--o-mark-3)" }} />
        </linearGradient>
        <linearGradient id="o-mark-b" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--o-mark-4)" }} />
          <stop offset="1" style={{ stopColor: "var(--o-mark-5)" }} />
        </linearGradient>
      </defs>
      <path d="M12 1.5 21 8l-9 14.5L3 8z" fill="url(#o-mark-a)" />
      <path d="M12 1.5 21 8l-9 3.2z" fill="url(#o-mark-b)" opacity="0.9" />
      <path d="M12 11.2 21 8l-9 14.5z" fill="#14141a" opacity="0.55" />
    </svg>
  );
}

/** What every navigation shows: where you are, the host, whether the server answers. */
export function useShell() {
  const { view, go, overview, overviewAt } = useNav();
  const online = useOnline();
  const { hostname } = useConfig();
  const [spin, setSpin] = useState(false);
  return {
    view,
    go,
    overview,
    overviewAt,
    online,
    host: overview?.host.hostname ?? hostname,
    crumb: view === "overview" ? null : viewLabel(view),
    spin,
    refresh: () => {
      setSpin(true);
      refreshAll();
      setTimeout(() => setSpin(false), 700);
    },
  };
}

/** Server state: green while it answers, "offline" when not, "sample data" in mock mode. */
export function ServerState({ className }: { className?: string }) {
  const { online, overviewAt } = useShell();
  return (
    <span
      className={cx("o-server", className)}
      data-ok={online === null ? "unknown" : online ? "1" : "0"}
      title={online === false ? "The server is not responding" : online ? "Time of the last response" : "Connecting…"}
    >
      <i />
      <span className="o-server-host">{online === false ? "offline" : MOCK ? "sample data" : <Since at={overviewAt} />}</span>
    </span>
  );
}

/**
 * The frame around every page. Each design brings its own navigation:
 * Graphite a header and a floating dock, Phosphor a terminal sidebar with a status line,
 * Paper a newspaper masthead with section tabs.
 */
export function Shell({ children }: { children: ReactNode }) {
  const design = useDesign();
  if (design === "phosphor") return <PhosphorShell>{children}</PhosphorShell>;
  if (design === "paper") return <PaperShell>{children}</PaperShell>;
  return <GraphiteShell>{children}</GraphiteShell>;
}

function GraphiteShell({ children }: { children: ReactNode }) {
  const { view, go, overview, host, crumb, spin, refresh } = useShell();

  return (
    <>
      <GradualBlur position="top" height="104px" strength={1.3} />
      <header className="o-top">
        <div className="o-top-in">
          <button type="button" className="o-brand" onClick={() => go("overview")} aria-label="Go to overview">
            <Mark />
            <span className="o-brand-name">Keepwatch</span>
            <span className="o-brand-tag" title={overview?.host.ip}>{host}</span>
          </button>
          {crumb && (
            <span className="o-crumb" aria-hidden>
              <i>/</i>
              <span className="truncate">{crumb}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="o-searchpill d-search-btn" onClick={openPalette} aria-label={`Search (${PALETTE_KEY})`} aria-keyshortcuts="Meta+K Control+K">
              <Search className="h-4 w-4" aria-hidden />
              <span className="o-searchpill-text">Search</span>
              <Kbd>{PALETTE_KEY}</Kbd>
            </button>
            {MOCK && (
              <Pill tone="sand" title="Sample data – nothing here comes from a server">
                Mock
              </Pill>
            )}
            <ServerState />
            <ModeToggle />
            <IconButton label="Refresh" onClick={refresh}>
              <RefreshCw className={cx("h-4 w-4", spin && "o-spin")} />
            </IconButton>
          </div>
        </div>
      </header>

      <main className="o-stage">
        <div key={view} className="o-page-in">
          {children}
        </div>
      </main>
      <GradualBlur position="bottom" height="132px" strength={1.4} />
      <Dock />
    </>
  );
}

/** Light / dark for Graphite: the icon shows where the click leads. */
function ModeToggle() {
  const mode = useMode();
  const next = mode === "light" ? "dark" : "light";
  return (
    <IconButton label={`Switch to ${next} mode`} onClick={() => setMode(next)}>
      {next === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </IconButton>
  );
}
