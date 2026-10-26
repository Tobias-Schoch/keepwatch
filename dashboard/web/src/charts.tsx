import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clock, fmtDate, num } from "./format";

/**
 * Hand-drawn SVG charts in the Obsidian material: one axis, fine grid, 2 px lines,
 * gradient fill, emphasized end point, crosshair + tooltip on hover. The width is
 * measured (no stretched viewBox) so text stays crisp.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Round upper bound for the y axis (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v: number): number {
  if (!isFinite(v) || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** Like niceMax, but in steps of 1024 (KB, MB, …) so the axis shows round byte values. */
export function niceBytes(v: number): number {
  let unit = 1;
  while (v / unit >= 1024) unit *= 1024;
  return niceMax(v / unit) * unit;
}

export interface Series {
  label: string;
  values: number[];
  color: string;
}

const PAD = { l: 52, r: 10, t: 12, b: 24 };

function timeTicks(t0: number, t1: number, count: number): number[] {
  if (t1 <= t0) return [t0];
  const span = t1 - t0;
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const step = steps.find((s) => span / s <= count) ?? 86400;
  const first = Math.ceil(t0 / step) * step;
  const out: number[] = [];
  for (let x = first; x <= t1; x += step) out.push(x);
  return out;
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const left = Math.max(70, Math.min(w - 70, x));
  return (
    <div className="d-tip" style={{ left }}>
      {children}
    </div>
  );
}

export function AreaChart({
  t,
  series,
  height = 180,
  yMax,
  nice = niceMax,
  format,
  timeFormat = clock,
  empty = "No data yet – the backend collects from the moment it starts.",
}: {
  t: number[];
  series: Series[];
  height?: number;
  yMax?: number;
  nice?: (v: number) => number;
  format: (v: number) => string;
  timeFormat?: (t: number) => string;
  empty?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");
  const n = t.length;
  const H = height - (series.length > 1 ? 26 : 0);

  const geo = useMemo(() => {
    if (n < 2 || w < 40) return null;
    const max = yMax ?? nice(Math.max(...series.flatMap((s) => s.values), 0) * 1.08);
    const iw = w - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const t0 = t[0];
    const t1 = t[n - 1];
    const x = (ti: number) => PAD.l + ((ti - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => PAD.t + ih - (Math.max(0, Math.min(max, v)) / max) * ih;
    const paths = series.map((s) => {
      let d = "";
      s.values.forEach((v, i) => (d += `${i ? "L" : "M"}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`));
      const area = `${d}L${x(t[n - 1]).toFixed(1)},${PAD.t + ih}L${x(t0).toFixed(1)},${PAD.t + ih}Z`;
      return { d, area };
    });
    return { max, iw, ih, x, y, paths, ticks: timeTicks(t0, t1, Math.max(2, Math.floor(iw / 90))) };
  }, [n, w, t, series, H, yMax, nice]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t0 = t[0];
    const t1 = t[n - 1];
    const ti = t0 + ((px - PAD.l) / geo.iw) * (t1 - t0);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(t[i] - ti);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div className="d-chart" ref={ref} style={{ height }}>
      {series.length > 1 && (
        <div className="d-legend mb-2">
          {series.map((s) => (
            <span key={s.label}>
              <i className="d-key" style={{ background: s.color }} />
              {s.label}
              <b>{s.values.length ? format(s.values[s.values.length - 1]) : "—"}</b>
            </span>
          ))}
        </div>
      )}
      {!geo ? (
        <div className="d-empty">{n < 2 ? empty : ""}</div>
      ) : (
        <svg height={H} viewBox={`0 0 ${w} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(", ")}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={series.length > 1 ? 0.16 : 0.26} />
                <stop offset="1" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {[0.5, 1].map((f) => (
            <g key={f}>
              <line className="d-grid-line" x1={PAD.l} x2={w - PAD.r} y1={geo.y(geo.max * f)} y2={geo.y(geo.max * f)} />
              <text className="d-axis" x={PAD.l - 8} y={geo.y(geo.max * f) + 3.5} textAnchor="end">
                {format(geo.max * f)}
              </text>
            </g>
          ))}
          <line className="d-base-line" x1={PAD.l} x2={w - PAD.r} y1={PAD.t + geo.ih} y2={PAD.t + geo.ih} />
          <text className="d-axis" x={PAD.l - 8} y={PAD.t + geo.ih + 3.5} textAnchor="end">
            {format(0)}
          </text>
          {geo.ticks.map((tk) => (
            <text key={tk} className="d-axis" x={geo.x(tk)} y={H - 6} textAnchor="middle">
              {timeFormat(tk)}
            </text>
          ))}
          {geo.paths.map((p, i) => (
            <path key={`a${i}`} d={p.area} fill={`url(#${uid}-g${i})`} />
          ))}
          {geo.paths.map((p, i) => (
            <path key={`l${i}`} d={p.d} className="d-line" stroke={series[i].color} />
          ))}
          {hover === null &&
            series.map((s, i) => {
              const v = s.values[n - 1];
              return (
                <g key={`e${i}`}>
                  <circle cx={geo.x(t[n - 1])} cy={geo.y(v)} r="8" fill={s.color} opacity="0.18" className="d-end" />
                  <circle cx={geo.x(t[n - 1])} cy={geo.y(v)} r="4" fill={s.color} className="d-dot" />
                </g>
              );
            })}
          {hover !== null && (
            <g>
              <line className="d-cross" x1={geo.x(t[hover])} x2={geo.x(t[hover])} y1={PAD.t} y2={PAD.t + geo.ih} />
              {series.map((s, i) => (
                <circle key={i} cx={geo.x(t[hover])} cy={geo.y(s.values[hover])} r="4" fill={s.color} className="d-dot" />
              ))}
            </g>
          )}
          {/* large hit area */}
          <rect x={PAD.l} y={0} width={geo.iw} height={H} fill="transparent" />
        </svg>
      )}
      {geo && hover !== null && (
        <Tip x={geo.x(t[hover])} w={w}>
          <div className="d-tip-time">{timeFormat(t[hover])}</div>
          {series.map((s) => (
            <div key={s.label} className="d-tip-row">
              <i className="d-key" style={{ background: s.color }} />
              {s.label}
              <b>{format(s.values[hover])}</b>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

/**
 * Hourly bars (24 h) with an optional marker strip below (e.g. bans).
 * The strip has no axis of its own – it only shows *when* something happened;
 * the count is in the tooltip.
 */
export function HourBars({
  t,
  values,
  label,
  strip,
  part,
  height = 190,
  format = (v: number) => num(v),
  unit = "hour",
}: {
  t: number[];
  values: number[];
  label: string;
  /** Marker strip below the bars; parts breaks the value down in the tooltip (e.g. bans by kind). */
  strip?: { label: string; values: number[]; parts?: { label: string; values: number[] }[] };
  /** Share of each bar, from the bottom in red (e.g. attempts from addresses banned today). */
  part?: { label: string; values: number[] };
  height?: number;
  format?: (v: number) => string;
  /** Hourly bars (time of day) or daily bars (date). */
  unit?: "hour" | "day";
}) {
  const axis = (tk: number) => (unit === "day" ? fmtDate(tk, { day: "numeric", month: "short" }) : clock(tk));
  const tipTime = (tk: number) =>
    unit === "day" ? fmtDate(tk, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : `${clock(tk)} – ${clock(tk + 3600)}`;
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const stripH = strip ? 22 : 0;
  const geo = useMemo(() => {
    if (!n || w < 40) return null;
    const max = niceMax(Math.max(...values, 0) * 1.05);
    const iw = w - PAD.l - PAD.r;
    const ih = height - PAD.t - PAD.b - stripH;
    const slot = iw / n;
    const bw = Math.max(2, slot - 2);
    const y = (v: number) => PAD.t + ih - (v / max) * ih;
    return { max, iw, ih, slot, bw, y };
  }, [n, w, values, height, stripH]);

  const bar = (i: number) => {
    if (!geo) return "";
    const x = PAD.l + i * geo.slot + 1;
    const top = geo.y(values[i]);
    const base = PAD.t + geo.ih;
    const h = base - top;
    if (h <= 0.5) return "";
    const r = Math.min(4, geo.bw / 2, h);
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + geo.bw - r}Q${x + geo.bw},${top} ${x + geo.bw},${top + r}V${base}Z`;
  };

  const partRect = (i: number) => {
    if (!geo || !part) return null;
    const v = Math.min(part.values[i] ?? 0, values[i]);
    const base = PAD.t + geo.ih;
    const h = base - geo.y(v);
    if (h <= 0.5) return null;
    return { x: PAD.l + i * geo.slot + 1, y: base - h, h };
  };

  return (
    <div className="d-chart" ref={ref} style={{ height }}>
      {geo && (
        <svg
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.floor((e.clientX - r.left - PAD.l) / geo.slot);
            setHover(i >= 0 && i < n ? i : null);
          }}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={label}
        >
          {[0.5, 1].map((f) => (
            <g key={f}>
              <line className="d-grid-line" x1={PAD.l} x2={w - PAD.r} y1={geo.y(geo.max * f)} y2={geo.y(geo.max * f)} />
              <text className="d-axis" x={PAD.l - 8} y={geo.y(geo.max * f) + 3.5} textAnchor="end">
                {format(geo.max * f)}
              </text>
            </g>
          ))}
          {values.map((_, i) => (
            <path key={i} d={bar(i)} className={`d-bar-rect ${hover === i ? "is-hot" : hover !== null ? "is-dim" : ""}`} />
          ))}
          {part &&
            values.map((_, i) => {
              const r = partRect(i);
              return r ? (
                <rect key={`p${i}`} x={r.x} y={r.y} width={geo.bw} height={r.h} rx={Math.min(2, geo.bw / 2)}
                  className={`d-bar-part ${hover === i ? "is-hot" : hover !== null ? "is-dim" : ""}`} />
              ) : null;
            })}
          <line className="d-base-line" x1={PAD.l} x2={w - PAD.r} y1={PAD.t + geo.ih} y2={PAD.t + geo.ih} />
          {strip && (
            <g>
              <text className="d-strip-label" x={PAD.l - 8} y={PAD.t + geo.ih + 15} textAnchor="end">
                {strip.label}
              </text>
              {strip.values.map((v, i) =>
                v > 0 ? (
                  <rect key={i} className="d-strip-mark" x={PAD.l + i * geo.slot + geo.slot / 2 - 3} y={PAD.t + geo.ih + 8} width="6" height="8" rx="2" opacity={Math.min(1, 0.45 + v * 0.18)} />
                ) : null,
              )}
            </g>
          )}
          {t.map((tk, i) =>
            i % Math.max(1, Math.ceil(n / Math.max(2, Math.floor(geo.iw / 70)))) === 0 ? (
              <text key={tk} className="d-axis" x={PAD.l + i * geo.slot + geo.slot / 2} y={height - 6} textAnchor="middle">
                {axis(tk)}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {geo && hover !== null && (
        <Tip x={PAD.l + hover * geo.slot + geo.slot / 2} w={w}>
          <div className="d-tip-time">{tipTime(t[hover])}</div>
          <div className="d-tip-row">
            <i className="d-key" style={{ background: "var(--d-mono)" }} />
            {label}
            <b>{format(values[hover])}</b>
          </div>
          {part && (
            <div className="d-tip-row">
              <i className="d-key" style={{ background: "var(--o-rose)" }} />
              {part.label}
              <b>
                {format(part.values[hover] ?? 0)}
                {values[hover] > 0 ? ` · ${Math.round(((part.values[hover] ?? 0) / values[hover]) * 100)}%` : ""}
              </b>
            </div>
          )}
          {strip && (
            <div className="d-tip-row">
              <i className="d-key" style={{ background: "var(--o-rose)" }} />
              {strip.label}
              <b>{strip.values[hover] ?? 0}</b>
            </div>
          )}
          {strip?.parts && (strip.values[hover] ?? 0) > 0 && (
            <div className="d-tip-sub">
              {strip.parts
                .filter((p) => (p.values[hover] ?? 0) > 0)
                .map((p) => `${p.values[hover]} ${p.label}`)
                .join(" · ")}
            </div>
          )}
        </Tip>
      )}
    </div>
  );
}

/** Small trend line for tiles (no axes). */
export function Spark({ values, color = "var(--d-mono)", max }: { values: number[]; color?: string; max?: number }) {
  const uid = useId().replace(/:/g, "");
  if (values.length < 2) return <svg className="d-spark" aria-hidden />;
  const m = max ?? Math.max(...values, 0.0001);
  const w = 100;
  const h = 30;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (Math.min(v, m) / m) * (h - 3) - 1.5] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  return (
    <svg className="d-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`${uid}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${w},${h}L0,${h}Z`} fill={`url(#${uid}-s)`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
