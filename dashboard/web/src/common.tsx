import { ArrowDown, ArrowUp, ChevronDown, RefreshCw, WifiOff } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { reloadIfIdle, useNewBuild } from "./api";
import { Particles, Reveal } from "./design/fx";
import { FoldText } from "./design/rb/type/FoldText";
import { Button, Callout, cx, Pill, type Tone } from "./design/ui";
import { ago, countryName, LOCALE } from "./format";
import type { Country as CountryT } from "./types";

/**
 * Page header: folded headline and one line below it (ideally chips).
 * `big` only for the overview – there the title is the answer of the day.
 * Sub-pages get a small header (≈ 36 px), so the content starts early.
 */
export function PageHero({ title, shine, lead, aside, big }: { title: string; shine?: number; lead?: ReactNode; aside?: ReactNode; big?: boolean }) {
  return (
    <section className={cx("o-hero is-sm", !big && "d-hero-sub")}>
      <div className="min-w-0">
        <FoldText as="h1" text={title} key={title} className="o-display" delay={80} stagger={36} shineFrom={shine ?? title.split(" ").length - 1} />
        {lead && (
          <div className="o-lead o-reveal" style={{ animationDelay: "300ms" }}>
            {lead}
          </div>
        )}
      </div>
      {aside && (
        <div className="o-reveal shrink-0" style={{ animationDelay: "360ms" }}>
          {aside}
        </div>
      )}
    </section>
  );
}

/** Bento tile (glass, particles on hover, edge light). */
export function Tile({
  label,
  className,
  children,
  delay = 0,
  seed = 1,
  onClick,
  title,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
  delay?: number;
  seed?: number;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <Particles seed={seed} />
      <div className="o-tile-label">{label}</div>
      {children}
    </>
  );
  return (
    <Reveal delay={delay} className={cx("o-tile", className)}>
      {onClick ? (
        <button type="button" className="o-tile-in is-action" data-light onClick={onClick} title={title}>
          {body}
        </button>
      ) : (
        <div className="o-tile-in" data-light title={title}>
          {body}
        </div>
      )}
    </Reveal>
  );
}

export function Section({ title, sub, aside, children, id, className }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section className={cx("o-section", className)} id={id}>
      <div className="o-section-row">
        <div className="min-w-0">
          <h2 className="o-h1">{title}</h2>
          {sub && <p className="o-sub">{sub}</p>}
        </div>
        {aside && <div className="o-toolbar">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function StateDot({ tone, live, title }: { tone: Tone; live?: boolean; title?: string }) {
  // key = tone: when the state changes, the element is recreated and pulses briefly again.
  return <i key={tone} className={cx("d-dot-state", live && "is-live")} data-tone={tone} title={title} aria-hidden={!title} />;
}

/** Fill level with tone: calm below 70%, sand from 70%, rose from 90%. */
export function Meter({ share, tone, thin }: { share: number; tone?: Tone; thin?: boolean }) {
  const s = Math.max(0, Math.min(1, share));
  const t = tone ?? (s >= 0.9 ? "rose" : s >= 0.7 ? "sand" : "neutral");
  return (
    <span className={cx("d-bar", thin && "is-thin")} aria-hidden>
      <i data-tone={t === "neutral" ? undefined : t} style={{ width: `${(s * 100).toFixed(1)}%` } as CSSProperties} />
    </span>
  );
}

/** First loading state, or the error while there is no data yet. */
export function Loading<T>({ data, error, children }: { data: T | null; error: string | null; children: (d: T) => ReactNode }) {
  if (data) return <>{children(data)}</>;
  if (error)
    return (
      <Callout tone="rose" icon={WifiOff} title="No data">
        {error}
      </Callout>
    );
  return (
    <div className="o-empty" aria-busy>
      <span className="o-spin inline-block h-5 w-5 rounded-full border-2 border-white/10 border-t-white/70" />
      Loading…
    </div>
  );
}

/** Shown when the last poll failed but older data is still on screen. */
export function Stale({ error, at }: { error: string | null; at: number | null }) {
  if (!error || !at) return null;
  return (
    <span className="d-stale" title={error}>
      <WifiOff className="h-3.5 w-3.5" /> As of {ago(Math.floor(at / 1000))}
    </span>
  );
}

/** Row of chips below a page title. */
export function Chips({ children }: { children: ReactNode }) {
  return <div className="d-chipline">{children}</div>;
}

/** Disclosure button (chevron + text), e.g. "39 bans". */
export function FoldToggle({ open, onToggle, children, className }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={cx("d-fold", className)} onClick={onToggle} aria-expanded={open}>
      <ChevronDown className={cx("o-chev h-4 w-4", open && "is-open")} />
      {children}
    </button>
  );
}

/**
 * Country of an IP as text: code and short English name, no flag.
 * Tailnet green, internal neutral, unknown faint.
 */
export function Country({ c, short }: { c: CountryT | null | undefined; short?: boolean }) {
  if (!c) return null;
  if (c.name === "Tailnet") return <Pill tone="ok">Tailnet</Pill>;
  if (!c.cc) {
    const unknown = c.name === "?" || c.name === "unknown";
    return <span className={cx("d-country", unknown ? "is-faint" : "is-mute")}>{unknown ? "unknown" : c.name}</span>;
  }
  const name = countryName(c.cc, c.name);
  return (
    <span className="d-country" title={short ? name : undefined}>
      <b>{c.cc}</b>
      {!short && <span>{name}</span>}
    </span>
  );
}

/** "5 s ago" – ticks every 5 s (as often as the overview arrives); only this element re-renders. */
export function Since({ at }: { at: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!at) return <>connecting…</>;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <>{s < 60 ? `${s} s ago` : ago(Math.floor(at / 1000))}</>;
}

/**
 * New version deployed (X-Dashboard-Build changed): reloads by itself as soon as
 * no dialog is open, nothing is being typed and no action is running.
 * Until then a small note with a button at the bottom.
 */
export function UpdateHint() {
  const fresh = useNewBuild();
  useEffect(() => {
    if (!fresh) return;
    if (reloadIfIdle()) return;
    const t = setInterval(() => void reloadIfIdle(), 1000);
    return () => clearInterval(t);
  }, [fresh]);
  if (!fresh) return null;
  return (
    <div className="d-update" role="status">
      <span>New version available</span>
      <Button size="sm" variant="primary" onClick={() => location.reload()}>
        <RefreshCw className="h-3.5 w-3.5" /> Reload
      </Button>
    </div>
  );
}

/* ---------- Sortable tables ------------------------------------------------------------------ */

export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

/**
 * Sort state of a table, remembered per table in the browser (localStorage, may be missing).
 * First click on a new column: numbers and times descending, text ascending (`firstDir`).
 */
export function useSort<K extends string>(id: string, initial: SortState<K>, keys: readonly K[]) {
  const storeKey = `dash.sort.${id}`;
  const [sort, setSort] = useState<SortState<K>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storeKey) ?? "null") as SortState<K> | null;
      if (v && keys.includes(v.key) && (v.dir === "asc" || v.dir === "desc")) return v;
    } catch {
      /* no storage – default */
    }
    return initial;
  });
  const toggle = useCallback(
    (key: K, firstDir: "asc" | "desc") =>
      setSort((cur) => {
        const next: SortState<K> = cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir };
        try {
          localStorage.setItem(storeKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      }),
    [storeKey],
  );
  return [sort, toggle] as const;
}

/** Sort comparison: numbers numerically, text by locale, empty values always last. */
export function compare(a: string | number | null | undefined, b: string | number | null | undefined, dir: "asc" | "desc"): number {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const r = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), LOCALE, { numeric: true });
  return dir === "asc" ? r : -r;
}

/** Pads IPv4 so it sorts correctly as text (IPv6 stays as is). */
export const ipKey = (ip: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split(".").map((o) => o.padStart(3, "0")).join(".") : `~${ip}`);

/** Column header that sorts on click (arrow shows direction). */
export function SortTh<K extends string>({
  k,
  sort,
  onSort,
  children,
  right,
  first = "desc",
  className,
}: {
  k: K;
  sort: SortState<K>;
  onSort: (k: K, firstDir: "asc" | "desc") => void;
  children: ReactNode;
  right?: boolean;
  first?: "asc" | "desc";
  className?: string;
}) {
  const on = sort.key === k;
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cx(right && "is-right", className)} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={cx("d-sort", on && "is-on")} onClick={() => onSort(k, first)}>
        {right && on && <Icon className="h-3 w-3" />}
        {children}
        {!right && on && <Icon className="h-3 w-3" />}
      </button>
    </th>
  );
}
