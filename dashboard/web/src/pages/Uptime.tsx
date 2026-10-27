import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { AreaChart } from "../charts";
import { Callout, cx, Pill, Segmented } from "../design/ui";
import { clock, dateTime, duration, fmtDate, LOCALE, num } from "../format";
import { dayTone, fmtUptime, useUptime, type UptimeDay, type UptimeDetail, type UptimeSite } from "../uptime";
import "./uptime.css";

/**
 * Uptime in the site row (Services): a 90-day bar, one tick per day, plus the
 * uptime of the last 30 days. Expanded: response time (24 h / 7 days) and
 * outages. Data: /api/uptime (one request for all rows).
 */

const pct = (v: number) => `${fmtUptime(v)}%`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

function dayText(d: UptimeDay): string {
  if (d.total === 0) return "no checks";
  const share = (100 * d.ok) / d.total;
  return d.downSec > 0 ? `${pct(share)} · ${duration(d.downSec)} down` : `${pct(share)} · no downtime`;
}

export function useSiteUptime(domain: string): UptimeSite | null | undefined {
  const { data } = useUptime();
  if (!data) return undefined;
  return (data.sites ?? []).find((s) => s.domain === domain) ?? null;
}

/** Bar + percentage below the domain name; click expands the details. */
export function UptimeStrip({ domain, open, onToggle }: { domain: string; open: boolean; onToggle: () => void }) {
  const u = useSiteUptime(domain);
  const [hover, setHover] = useState<number | null>(null);
  if (u === undefined) return <span className="up-strip is-loading" aria-hidden />;
  if (u === null || u.uptime30 === null) {
    return (
      <button type="button" className="up-strip-btn" onClick={onToggle} aria-expanded={open}>
        <span className="up-nodata">no checks yet</span>
      </button>
    );
  }
  const h = hover !== null ? u.days[hover] : null;
  return (
    <button type="button" className={cx("up-strip-btn", open && "is-open")} onClick={onToggle} aria-expanded={open} aria-label={`Uptime ${domain}: ${pct(u.uptime30)} over 30 days – ${open ? "collapse" : "expand"} history`}>
      <span className="up-strip" onPointerLeave={() => setHover(null)}>
        {u.days.map((d, i) => (
          <i key={d.day} data-tone={dayTone(d)} onPointerEnter={() => setHover(i)} />
        ))}
        {h && (
          <span className="up-tip" style={{ left: `${(hover! / u.days.length) * 100}%` }}>
            <b>{dayLabel(h.day)}</b> {dayText(h)}
          </span>
        )}
      </span>
      {u.down ? (
        <span className="up-pct is-down" title={u.downReason ?? undefined}>
          Down for {duration(Date.now() / 1000 - (u.downSince ?? Date.now() / 1000))}
        </span>
      ) : (
        <span className={cx("up-pct", u.uptime30 < 99 && "is-warn")} title="Uptime over the last 30 days">
          {pct(u.uptime30)}
        </span>
      )}
      <ChevronDown className={cx("up-chev h-3.5 w-3.5", open && "is-open")} />
    </button>
  );
}

const fmtDayTime = (t: number) => fmtDate(t, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Expanded: response time curve and outages. */
export function UptimeDetailPanel({ domain }: { domain: string }) {
  const u = useSiteUptime(domain);
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [d, setD] = useState<UptimeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<UptimeDetail>(`/api/uptime/site?domain=${encodeURIComponent(domain)}&range=${range}`)
        .then((x) => alive && (setD(x), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [domain, range]);

  const chart = useMemo(() => {
    if (!d || d.points.length < 2) return null;
    // Fill gaps (no checks, only failures) with the last value so the curve doesn't drop to 0.
    let last = d.points.find((p) => p.ms !== null)?.ms ?? 0;
    const t: number[] = [];
    const ms: number[] = [];
    for (const p of d.points) {
      last = p.ms ?? last;
      t.push(p.t);
      ms.push(last);
    }
    const n = d.points.reduce((a, p) => a + p.n, 0);
    const fails = d.points.reduce((a, p) => a + p.fails, 0);
    const vals = d.points.filter((p) => p.ms !== null).map((p) => p.ms!);
    return { t, ms, share: n ? (100 * (n - fails)) / n : null, avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  }, [d]);

  return (
    <div className="up-detail">
      <div className="up-detail-head">
        <Segmented<"24h" | "7d">
          size="sm"
          ariaLabel="Range"
          value={range}
          onChange={setRange}
          options={[
            { id: "24h", label: "24 h" },
            { id: "7d", label: "7 days" },
          ]}
        />
        {chart?.share !== null && chart?.share !== undefined && <Pill tone={chart.share >= 99.9 ? "ok" : chart.share >= 99 ? "sand" : "rose"}>{pct(chart.share)} up</Pill>}
        {chart?.avg !== null && chart?.avg !== undefined && <Pill tone="neutral">⌀ {num(chart.avg)} ms</Pill>}
        {u && (
          <span className="o-hint ml-auto">
            Every minute · expects <span className="d-mono">{u.expect}</span>
          </span>
        )}
      </div>
      {u?.down && (
        <Callout tone="rose" className="mb-3" title={`Not responding as expected since ${dateTime(u.downSince)}`}>
          {u.downReason}
        </Callout>
      )}
      {error ? (
        <Callout tone="rose" title="Couldn't load history">
          {error}
        </Callout>
      ) : !d ? (
        <div className="up-empty">Loading…</div>
      ) : !chart ? (
        <div className="up-empty">No data yet – the dashboard checks this site every minute from now on.</div>
      ) : (
        <AreaChart
          t={chart.t}
          height={150}
          series={[{ label: "Response time", values: chart.ms, color: "var(--o-accent)" }]}
          format={(v) => `${num(v)} ms`}
          timeFormat={range === "24h" ? clock : fmtDayTime}
        />
      )}
      {d && (chart || d.outages.length > 0) && (
        <div className="up-outages">
          <div className="o-micro">Outages · 90 days</div>
          {d.outages.length === 0 ? (
            <p className="o-hint !mt-1">None – every check got the expected response.</p>
          ) : (
            <table className="d-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {d.outages.map((o) => (
                  <tr key={o.start}>
                    <td className="whitespace-nowrap">{dateTime(o.start)}</td>
                    <td className="whitespace-nowrap">{o.end ? duration(o.durationSec) : <Pill tone="rose">ongoing, {duration(o.durationSec)}</Pill>}</td>
                    <td className="w-full">
                      {o.reason}
                      {o.lastReason && <span className="o-mute"> · last: {o.lastReason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
