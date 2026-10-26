import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { api, usePoll } from "../api";
import { Chips, Loading, PageHero, Section, Stale } from "../common";
import { Button, Callout, cx, Pill, Segmented } from "../design/ui";
import { clock, dateTime, dayKey, fmtDate, nowSec, num, plural } from "../format";
import { useConfig } from "../config";
import { useNav } from "../nav";
import { followLink, isProblem, KIND_LABEL, visibleKinds, type Timeline, type TimelineRecent, type TlEvent, type TlKind } from "../timeline";
import "./timeline.css";

/* ---------- One row ------------------------------------------------------------------------ */

/** Day headings use the server's timezone (KW_LOCAL_TZ), like the backend's day boundaries. */
function dayLabel(t: number): { head: string; sub: string } {
  const k = dayKey(t);
  const n = nowSec();
  const long = fmtDate(t, { weekday: "long", day: "numeric", month: "long" });
  if (k === dayKey(n)) return { head: "Today", sub: long };
  if (k === dayKey(n - 86400)) return { head: "Yesterday", sub: long };
  const [wd, ...rest] = long.split(", ");
  return { head: wd, sub: rest.join(", ") };
}

/** "04:02", "yesterday 03:00", "Oct 24 14:30" – for the overview, which has no day headings. */
function when(t: number): string {
  const k = dayKey(t);
  const n = nowSec();
  if (k === dayKey(n)) return clock(t);
  if (k === dayKey(n - 86400)) return `yesterday ${clock(t)}`;
  return `${fmtDate(t, { day: "numeric", month: "short" })} ${clock(t)}`;
}

export function TimelineRow({ e, relative }: { e: TlEvent; relative?: boolean }) {
  const { go } = useNav();
  const tone = e.level === "crit" ? "rose" : e.level === "warn" ? "sand" : undefined;
  const span = e.tEnd && e.tEnd - e.t >= 120 && e.count > 1 ? `${clock(e.t)}–${clock(e.tEnd)}` : null;
  const detail = [span, e.detail].filter(Boolean).join(" · ");
  const body = (
    <>
      <time className="d-tl-time o-num" dateTime={new Date(e.t * 1000).toISOString()} title={dateTime(e.t) + (e.backfill ? " · backfilled from existing logs" : "")}>
        {relative ? when(e.t) : clock(e.t)}
      </time>
      <i className="d-tl-dot" aria-hidden />
      <span className="d-tl-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
      <span className="d-tl-main" title={detail ? `${e.title}\n${detail}` : undefined}>
        <span className="d-tl-title">{e.title}</span>
        {detail && <span className="d-tl-detail">{detail}</span>}
      </span>
      {e.link ? <ArrowRight className="d-tl-go" aria-hidden /> : <span />}
    </>
  );
  return (
    <li className="d-tl-item" data-tone={tone}>
      {e.link ? (
        <button type="button" className="d-tl-row is-link" onClick={() => followLink(go, e.link!)}>
          {body}
        </button>
      ) : (
        <div className="d-tl-row">{body}</div>
      )}
    </li>
  );
}

/* ---------- Bundles: many similar entries of one day (bans, logins) ------------------------------ */

type Bundle = { id: string; items: TlEvent[] };
type Entry = { e: TlEvent } | { b: Bundle };

/** From this many unremarkable entries of the same source in a day, they are bundled. */
const BUNDLE_MIN = 3;

/** Similar = same source and same title except for numbers and commit hashes. Bans (f2b) all count together. */
const shape = (e: TlEvent) => (e.source === "f2b" ? "f2b" : `${e.source}|${e.title.replace(/\b[0-9a-f]{7,40}\b/g, "#").replace(/\d+/g, "#")}`);

/** Collapse unremarkable similar entries of a day into one row, at the position of the newest. Problems stay single. */
function bundle(items: TlEvent[]): Entry[] {
  const by = new Map<string, TlEvent[]>();
  for (const e of items) if (!isProblem(e)) by.set(shape(e), [...(by.get(shape(e)) ?? []), e]);
  const out: Entry[] = [];
  const done = new Set<string>();
  for (const e of items) {
    const k = shape(e);
    const group = !isProblem(e) ? by.get(k) : undefined;
    if (!group || group.length < BUNDLE_MIN) out.push({ e });
    else if (!done.has(k)) {
      done.add(k);
      out.push({ b: { id: `${k}:${e.id}`, items: group } });
    }
  }
  return bursts(out);
}

/** Bursts: consecutive entries of the same source at most 15 min apart (e.g. many containers during a deploy). */
function bursts(list: Entry[]): Entry[] {
  const res: Entry[] = [];
  let run: TlEvent[] = [];
  const flush = () => {
    if (run.length >= BUNDLE_MIN) res.push({ b: { id: `burst:${run[0].id}`, items: run } });
    else run.forEach((e) => res.push({ e }));
    run = [];
  };
  for (const x of list) {
    const e = "e" in x && !isProblem(x.e) ? x.e : null;
    const prev = run[run.length - 1];
    if (e && prev && prev.source === e.source && prev.t - e.t <= 900) run.push(e);
    else {
      flush();
      if (e) run.push(e);
      else res.push(x);
    }
  }
  flush();
  return res;
}

/** "57 bans · SSH, port 22 (closed)", "SSH login: root from the tailnet (213×)", "6× Shop deployed", else "Title and 3 more". */
function bundleTitle(items: TlEvent[]): string {
  const lead = items.map((e) => /^(\d+) (\S+) · (.+)$/.exec(e.title));
  if (lead.every(Boolean)) {
    const sum = lead.reduce((n, m) => n + Number(m![1]), 0);
    const word = lead.reduce((a, m) => (Number(m![1]) > Number(a![1]) ? m : a))![2];
    const what = [...new Set(lead.map((m) => m![3]))];
    return `${num(sum)} ${word} · ${what.join(", ")}`;
  }
  const times = items.map((e) => /^(.*?)\s*\((\d+)×\)$/.exec(e.title));
  if (times.every(Boolean)) return `${times[0]![1]} (${num(times.reduce((n, m) => n + Number(m![2]), 0))}×)`;
  if (new Set(items.map((e) => e.title)).size === 1) return `${items.length}× ${items[0].title}`;
  // Same shape, different numbers/hashes: name the fixed part.
  if (new Set(items.map(shape)).size === 1) {
    const fixed = items[0].title.replace(/\b[0-9a-f]{7,40}\b/g, "").replace(/[\s·:,–-]+$/, "").trim();
    return `${items.length}× ${fixed || items[0].title}`;
  }
  return `${items[0].title} and ${items.length - 1} more`;
}

function BundleRow({ b }: { b: Bundle }) {
  const [open, setOpen] = useState(false);
  const first = b.items[0];
  const last = b.items[b.items.length - 1];
  return (
    <li className="d-tl-item is-bundle">
      <button type="button" className="d-tl-row is-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <time className="d-tl-time o-num" title={`${dateTime(last.t)} – ${dateTime(first.tEnd ?? first.t)}`}>
          {clock(first.t)}
        </time>
        <i className="d-tl-dot" aria-hidden />
        <span className="d-tl-kind">{KIND_LABEL[first.kind] ?? first.kind}</span>
        <span className="d-tl-main">
          <span className="d-tl-title">{bundleTitle(b.items)}</span>
          <span className="d-tl-detail">
            {[...new Set([clock(last.t), clock(first.tEnd ?? first.t)])].join("–")} · {b.items.length} entries
          </span>
        </span>
        <ChevronDown className={cx("d-tl-go is-fold o-chev", open && "is-open")} aria-hidden />
      </button>
      {open && (
        <ol className="d-tl-list is-sub">
          {b.items.map((e) => (
            <TimelineRow key={e.id} e={e} />
          ))}
        </ol>
      )}
    </li>
  );
}

/* ---------- Overview: "Since yesterday" ------------------------------------------------------ */

export function TimelineRecentSection() {
  const { go } = useNav();
  const r = usePoll<TimelineRecent>("/api/timeline/recent", 60_000);
  const d = r.data;
  if (r.error && !d) return null; // the overview stays quiet when the timeline is missing
  return (
    <Section
      title="Since yesterday"
      sub={
        d
          ? d.total === 0
            ? d.backfilling
              ? "Building the timeline from existing logs …"
              : "Nothing has happened yet."
            : d.total > d.events.length
              ? `The ${d.events.length} most important of ${plural(d.total, "event", "events")}${d.problems ? ` · ${plural(d.problems, "problem", "problems")}` : ""}.`
              : `${plural(d.total, "event", "events")}${d.problems ? ` · ${plural(d.problems, "problem", "problems")}` : ""}.`
          : undefined
      }
      aside={
        <Button size="sm" variant="secondary" onClick={() => go("timeline")}>
          View all
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      }
    >
      {d && d.events.length > 0 && (
        <ol className="d-tl-list is-compact">
          {d.events.map((e) => (
            <TimelineRow key={e.id} e={e} relative />
          ))}
        </ol>
      )}
    </Section>
  );
}

/* ---------- Page #timeline ------------------------------------------------------------------- */

type Range = "24h" | "7d" | "30d" | "120d";
const RANGE_SEC: Record<Range, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "120d": 120 * 86400 };
type KindFilter = TlKind | "all";

const PREFS_KEY = "dash:timeline";
function loadPrefs(): { range: Range; kind: KindFilter; service: string; problems: boolean } {
  const def = { range: "7d" as Range, kind: "all" as KindFilter, service: "", problems: false };
  try {
    return { ...def, ...JSON.parse(sessionStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return def;
  }
}

export function TimelinePage() {
  const { go } = useNav();
  useConfig(); // re-render when the modules are known
  const kinds = visibleKinds();
  const [prefs, setPrefs] = useState(loadPrefs);
  const { range, service, problems } = prefs;
  // A remembered kind whose module is off (or an old value) counts as "all".
  const kind: KindFilter = prefs.kind !== "all" && kinds.some((k) => k.id === prefs.kind) ? prefs.kind : "all";
  const set = (p: Partial<typeof prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        sessionStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* no storage – fine */
      }
      return next;
    });

  // "from" rounded to 5 minutes so the address (and with it the request) doesn't change on every render.
  const from = Math.floor(Date.now() / 300_000) * 300 - RANGE_SEC[range];
  const qs = new URLSearchParams({ from: String(from), limit: "300" });
  if (kind !== "all") qs.set("kind", kind);
  if (service) qs.set("service", service);
  if (problems) qs.set("problems", "1");
  const path = `/api/timeline?${qs}`;
  const tl = usePoll<Timeline>(path, 30_000);

  // "Load older": more pages below the first, reset whenever a filter changes.
  const [older, setOlder] = useState<{ events: TlEvent[]; more: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => setOlder(null), [path]);
  const loadOlder = async (last: number) => {
    setLoading(true);
    try {
      const q = new URLSearchParams(qs);
      q.set("before", String(last));
      const r = await api.get<Timeline>(`/api/timeline?${q}`);
      setOlder((o) => ({ events: [...(o?.events ?? []), ...r.events], more: r.more }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="o-wrap d-page">
      <Loading data={tl.data} error={tl.error}>
        {(d) => {
          const events = [...d.events, ...(older?.events ?? [])];
          const more = older ? older.more : d.more;
          const total = Object.values(d.counts).reduce((s, c) => s + (c?.total ?? 0), 0);
          const probs = Object.values(d.counts).reduce((s, c) => s + (c?.problems ?? 0), 0);
          const days: { key: string; t: number; items: TlEvent[] }[] = [];
          for (const e of events) {
            const k = dayKey(e.t);
            if (days.length && days[days.length - 1].key === k) days[days.length - 1].items.push(e);
            else days.push({ key: k, t: e.t, items: [e] });
          }
          const serviceKnown = !service || d.services.some((s) => s.id === service);
          return (
            <>
              <PageHero
                title="What happened?"
                lead={
                  <Chips>
                    <Pill tone="neutral">{plural(total, "event", "events")}</Pill>
                    <Button size="sm" variant="ghost" onClick={() => go("overview")}>
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Overview
                    </Button>
                  </Chips>
                }
                aside={<Stale error={tl.error} at={tl.at} />}
              />

              <div className="d-tl-filters" role="group" aria-label="Filters">
                <Segmented<Range>
                  ariaLabel="Time range"
                  size="sm"
                  value={range}
                  onChange={(v) => set({ range: v })}
                  options={[
                    { id: "24h", label: "24 hr" },
                    { id: "7d", label: "7 days" },
                    { id: "30d", label: "30 days" },
                    { id: "120d", label: "120 days" },
                  ]}
                />
                <Segmented<KindFilter>
                  ariaLabel="Kind"
                  size="sm"
                  value={kind}
                  onChange={(v) => set({ kind: v })}
                  options={[
                    { id: "all", label: "All" },
                    ...kinds.map((k) => ({ id: k.id, label: k.label, dot: (d.counts[k.id]?.problems ?? 0) > 0, title: d.counts[k.id] ? `${plural(d.counts[k.id]!.total, "event", "events")}` : "none" })),
                  ]}
                />
                <select className="o-input d-tl-select" aria-label="Service" value={serviceKnown ? service : ""} onChange={(e) => set({ service: e.target.value })}>
                  <option value="">All services</option>
                  {d.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} ({num(s.count)})
                    </option>
                  ))}
                </select>
                <button type="button" className={cx("o-chip d-tl-chip", problems && "is-on")} aria-pressed={problems} onClick={() => set({ problems: !problems })}>
                  Problems only
                  {probs > 0 && <span className="d-tl-chipcount">{num(probs)}</span>}
                </button>
              </div>

              {d.backfilling && (
                <Callout tone="neutral" className="mb-6" title="Backfilling from existing logs – takes about a minute." />
              )}

              {days.length === 0 ? (
                <div className="o-empty">{problems ? "No problems in this time range." : "Nothing happened in this time range."}</div>
              ) : (
                days.map((day) => {
                  const l = dayLabel(day.t);
                  const p = day.items.filter(isProblem).length;
                  return (
                    <section key={day.key} className="d-tl-day">
                      <h2 className="d-tl-dayhead">
                        <span className="d-tl-dayname">{l.head}</span>
                        <span className="d-tl-daydate">{l.sub}</span>
                        <span className="d-tl-daycount">
                          {plural(day.items.length, "event", "events")}
                          {p > 0 && <span className="d-tl-dayprob"> · {plural(p, "problem", "problems")}</span>}
                        </span>
                      </h2>
                      <ol className="d-tl-list">
                        {bundle(day.items).map((x) => ("b" in x ? <BundleRow key={x.b.id} b={x.b} /> : <TimelineRow key={x.e.id} e={x.e} />))}
                      </ol>
                    </section>
                  );
                })
              )}

              <div className="d-tl-foot">
                {more && (
                  <Button size="sm" variant="secondary" disabled={loading} onClick={() => void loadOlder(events[events.length - 1].t)}>
                    {loading ? "Loading …" : "Load older"}
                  </Button>
                )}
                <p className="o-sub" title={d.backfilledAt ? `Everything before ${dateTime(d.backfilledAt)} was backfilled from existing logs and may have gaps.` : undefined}>
                  Kept for {d.keepDays} days{d.oldest ? ` · oldest entry ${fmtDate(d.oldest, { day: "numeric", month: "short", year: "numeric" })}` : ""}
                </p>
              </div>
            </>
          );
        }}
      </Loading>
    </div>
  );
}
