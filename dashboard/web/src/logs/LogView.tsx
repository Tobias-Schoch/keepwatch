import { ChevronDown, ChevronUp, Download, Maximize2, Pause, Play, Search } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cx, IconButton, Segmented } from "../design/ui";
import { useHas } from "../config";
import { dayKey, nowSec, num, plural } from "../format";
import { availableRanges, download, fileSlug, isoLocal, lineTime, LIMIT, localZone, RANGES, shortNames, type LevelFilter, type RangeId } from "./api";
import { useLogsTarget } from "./open";
import { MAX_ROWS, useLiveLogs, type Row } from "./useLiveLogs";
import { ArchiveNote } from "../logarchive/ArchiveNote";
import "./logs.css";

/**
 * Live logs of one or more containers (a service = all of them interleaved).
 * Follows live (only new lines every 2 s), pauses when you scroll up and
 * resumes once you're back at the bottom. Search highlights and jumps
 * (↵ / ⇧↵), error lines are tinted red, times are in the server's timezone.
 */
export function LogView({ containers, title, compact, onExpand }: { containers: string[]; title: string; compact?: boolean; onExpand?: () => void }) {
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [range, setRange] = useState<RangeId>("3600");
  const [live, setLive] = useState(true);
  const [pausedBy, setPausedBy] = useState<"user" | "scroll" | null>(null);
  const [q, setQ] = useState("");
  const [onlyHits, setOnlyHits] = useState(false);
  const [hit, setHit] = useState(-1);

  const archiveOn = useHas("log-archive");
  // When the big window covers this (small) view, only the big one reads.
  const sheet = useLogsTarget();
  const suspended = !!compact && sheet !== null;
  const windowSec = RANGES.find((r) => r.id === range)!.sec;
  const { rows, loading, error, errors, capped, at } = useLiveLogs({ containers, windowSec, level, running: live && !suspended });

  const labels = useMemo(() => shortNames(containers), [containers]);
  const multi = containers.length > 1;
  const labelWidth = Math.min(16, Math.max(3, ...Object.values(labels).map((l) => l.length)));
  const needle = q.trim().toLowerCase();

  const base = useMemo(() => (sel ? rows.filter((r) => r.gap || sel.has(r.c)) : rows), [rows, sel]);
  const shown = useMemo(() => (needle && onlyHits ? base.filter((r) => !r.gap && r.text.toLowerCase().includes(needle)) : base), [base, needle, onlyHits]);
  const matches = useMemo(() => (needle ? shown.reduce<number[]>((a, r, i) => (!r.gap && r.text.toLowerCase().includes(needle) ? (a.push(i), a) : a), []) : []), [shown, needle]);
  const counts = useMemo(() => {
    let e = 0;
    let w = 0;
    for (const r of base) {
      if (r.level === "error") e++;
      else if (r.level === "warn") w++;
    }
    return { e, w };
  }, [base]);

  /* ---- Scrolling: stick to the bottom, scrolling up = pause ------------------------------------ */
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const last = shown.length ? shown[shown.length - 1].id : 0;

  const toBottom = useCallback(() => {
    const el = box.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [last, shown.length, toBottom]);

  const resume = useCallback(() => {
    setLive(true);
    setPausedBy(null);
    toBottom();
  }, [toBottom]);

  const pause = useCallback((by: "user" | "scroll") => {
    setLive(false);
    setPausedBy(by);
  }, []);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    const up = el.scrollTop < lastTop.current - 2;
    lastTop.current = el.scrollTop;
    if (atBottom) {
      stick.current = true;
      if (pausedBy === "scroll") resume();
    } else if (up) {
      stick.current = false;
      if (live) pause("scroll");
    }
  };

  /* ---- Jumping: search hits and errors ---------------------------------------------------------- */
  const jumpTo = useCallback(
    (id: number) => {
      const el = box.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!el) return;
      stick.current = false;
      if (live) pause("scroll");
      el.scrollIntoView({ block: "center" });
      lastTop.current = box.current?.scrollTop ?? 0;
    },
    [live, pause],
  );

  useEffect(() => setHit(-1), [needle, onlyHits]);

  const step = (dir: 1 | -1) => {
    if (!matches.length) return;
    const n = hit < 0 ? (dir === 1 ? 0 : matches.length - 1) : (hit + dir + matches.length) % matches.length;
    setHit(n);
    jumpTo(shown[matches[n]].id);
  };

  const levelJump = useRef<Record<string, number>>({});
  const nextOf = (lv: "error" | "warn") => {
    const list = shown.filter((r) => r.level === lv);
    if (!list.length) return;
    const prev = levelJump.current[lv] ?? list.length;
    const i = (prev - 1 + list.length) % list.length; // backwards from the newest
    levelJump.current[lv] = i;
    jumpTo(list[i].id);
  };

  /* ---- Download --------------------------------------------------------------------------------- */
  const save = () => {
    const text = shown
      .filter((r) => !r.gap)
      .map((r) => `${isoLocal(r.t)} ${multi ? `[${r.c}] ` : ""}${r.stream === "stderr" ? "! " : ""}${r.text}`)
      .join("\n");
    const stamp = isoLocal(nowSec()).slice(0, 16).replace(/[-:]/g, "").replace(" ", "-");
    download(`${fileSlug(title)}-${stamp}.log`, `${text}\n`);
  };

  const toggle = (c: string) => {
    setSel((cur) => {
      const next = new Set(cur ?? []);
      if (!cur) next.add(c);
      else if (next.has(c)) next.delete(c);
      else next.add(c);
      return next.size === 0 || next.size === containers.length ? null : next;
    });
  };

  const rangeInfo = RANGES.find((r) => r.id === range)!;
  const today = dayKey(nowSec());
  const curHit = hit >= 0 && matches[hit] !== undefined ? shown[matches[hit]].id : -1;
  const status = suspended ? "suspended" : live ? "live" : pausedBy === "scroll" ? "scroll" : "paused";

  let empty: ReactNode = null;
  if (!shown.length) {
    if (loading) empty = "Loading logs …";
    else if (error) empty = error;
    else if (needle && onlyHits) empty = `No line contains “${q.trim()}”.`;
    else empty = level === "problems" ? `No errors or warnings ${rangeInfo.since}.` : `No output ${rangeInfo.since}.`;
  }

  return (
    <div className={cx("d-lv", compact && "is-compact")}>
      <div className="d-lv-row">
        <span className="d-lv-live" data-state={status} role="status" aria-live="polite">
          <i aria-hidden />
          {status === "live" ? "live" : status === "scroll" ? "paused – you’re reading further up" : status === "suspended" ? "reading in the big window" : "paused"}
        </span>
        <span className="flex-1" />
        {onExpand && (
          <Button size="sm" variant="ghost" onClick={onExpand} title="Open in the big window">
            <Maximize2 className="h-3.5 w-3.5" /> Expand
          </Button>
        )}
        <Button size="sm" variant={live ? "secondary" : "primary"} onClick={() => (live ? pause("user") : resume())} disabled={suspended}>
          {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {live ? "Pause" : "Resume live"}
        </Button>
        <Button size="sm" variant="ghost" onClick={save} disabled={!shown.length} title={`${plural(shown.filter((r) => !r.gap).length, "line", "lines")} as .log`}>
          <Download className="h-3.5 w-3.5" /> Download
        </Button>
      </div>

      <div className="d-lv-row">
        {multi && (
          <div className="d-lv-chips" role="group" aria-label="Container">
            <button type="button" className={cx("o-chip", !sel && "is-on")} aria-pressed={!sel} onClick={() => setSel(null)}>
              {containers.length === 2 ? "both containers" : `all ${containers.length} containers`}
            </button>
            {containers.map((c) => (
              <button key={c} type="button" className={cx("o-chip", sel?.has(c) && "is-on")} aria-pressed={!!sel?.has(c)} onClick={() => toggle(c)} title={c}>
                {labels[c]}
              </button>
            ))}
          </div>
        )}
        <Segmented
          size="sm"
          ariaLabel="Which lines"
          value={level}
          onChange={setLevel}
          options={[
            { id: "all", label: "All" },
            { id: "problems", label: "Errors & warnings" },
          ]}
        />
        <Segmented size="sm" ariaLabel="Time range" value={range} onChange={setRange} options={availableRanges().map((r) => ({ id: r.id, label: r.label }))} />
      </div>

      <div className="d-lv-row">
        <label className="o-search d-lv-search">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Search logs"
            aria-label="Search logs (↵ next match, ⇧↵ previous)"
            spellCheck={false}
          />
          {needle && (
            <span className="d-lv-hits" aria-live="polite">
              {matches.length ? `${hit >= 0 ? hit + 1 : "–"} / ${num(matches.length)}` : "0 matches"}
            </span>
          )}
          {needle && (
            <>
              <IconButton size="sm" label="Previous match (⇧↵)" onClick={() => step(-1)} disabled={!matches.length}>
                <ChevronUp className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton size="sm" label="Next match (↵)" onClick={() => step(1)} disabled={!matches.length}>
                <ChevronDown className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )}
        </label>
        {needle && (
          <button type="button" className={cx("o-chip", onlyHits && "is-on")} aria-pressed={onlyHits} onClick={() => setOnlyHits((v) => !v)}>
            Matches only
          </button>
        )}
        <button type="button" className="d-lv-count" data-tone="rose" disabled={!counts.e} onClick={() => nextOf("error")} title="Jump to the next error">
          {plural(counts.e, "error", "errors")}
        </button>
        <button type="button" className="d-lv-count" data-tone="sand" disabled={!counts.w} onClick={() => nextOf("warn")} title="Jump to the next warning">
          {plural(counts.w, "warning", "warnings")}
        </button>
        <span className="d-lv-dim">{capped.length || rows.length >= MAX_ROWS ? "in the loaded lines" : rangeInfo.since}</span>
      </div>

      {/* Log archive (logarchive/): source, removed containers, search the whole range */}
      {archiveOn && <ArchiveNote containers={containers} title={title} windowSec={windowSec} level={level} q={q.trim()} onRange={setRange} />}

      <div ref={box} className={cx("d-lv-box", compact && "is-short")} style={{ ["--lv-cw" as string]: `${labelWidth}ch` }} onScroll={onScroll} role="log" aria-label={`Log output of ${title}`} aria-live="off" tabIndex={0}>
        {empty ? (
          <div className="d-lv-empty">{empty}</div>
        ) : (
          shown.map((r) => <Line key={r.id} r={r} label={multi ? labels[r.c] ?? r.c : undefined} needle={needle} hit={r.id === curHit} today={today} />)
        )}
      </div>

      <div className="d-lv-foot">
        <span>
          {plural(shown.filter((r) => !r.gap).length, "line", "lines")}
          {live && !suspended ? " · following live (every 2 s)" : ""}
          {error && shown.length ? <span className="o-text-rose"> · {error}</span> : null}
          {at && !live ? ` · as of ${lineTime(Math.floor(at / 1000), today)}` : ""}
        </span>
        <span className="flex-1" />
        <span>Times in {localZone()}</span>
      </div>
      {(capped.length > 0 || Object.keys(errors).length > 0) && (
        <div className="d-lv-notes">
          {capped.length > 0 && (
            <p>
              {level === "problems"
                ? `Searched the last 10,000 lines per container ${rangeInfo.since}`
                : `At most ${num(LIMIT)} lines per container ${rangeInfo.since}`}{" "}
              – older ones are missing for {capped.map((c) => labels[c] ?? c).join(", ")}.
            </p>
          )}
          {Object.entries(errors).map(([c, m]) => (
            <p key={c} className="o-text-rose">
              {labels[c] ?? c}: {m}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function mark(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const low = text.toLowerCase();
  let i = low.indexOf(needle);
  if (i < 0) return text;
  const out: ReactNode[] = [];
  let from = 0;
  while (i >= 0) {
    out.push(text.slice(from, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    from = i + needle.length;
    i = low.indexOf(needle, from);
  }
  out.push(text.slice(from));
  return out;
}

const Line = memo(function Line({ r, label, needle, hit, today }: { r: Row; label?: string; needle: string; hit: boolean; today: string }) {
  return (
    <div className={cx("d-ll", r.level === "error" && "is-err", r.level === "warn" && "is-warn", r.gap && "is-gap", r.sep && "is-sep", hit && "is-hit")} data-id={r.id} data-sep={r.sep}>
      <time dateTime={new Date(r.t * 1000).toISOString()}>{lineTime(r.t, today)}</time>
      {label !== undefined && (
        <span className="d-ll-c" title={r.c}>
          {r.gap ? "" : label}
        </span>
      )}
      <span className="d-ll-m">{mark(r.text, needle)}</span>
    </div>
  );
});
