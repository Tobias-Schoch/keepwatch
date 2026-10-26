/**
 * Numbers, sizes and times. English, 24-hour clock. Times are shown in the
 * server's local timezone (KW_LOCAL_TZ from /api/config), falling back to the
 * browser's own timezone.
 */

export const LOCALE = "en";

let tz: string | undefined;

/** Called by config.tsx once /api/config is loaded. Invalid zones fall back to the browser's. */
export function setTimeZone(zone: string | undefined) {
  try {
    if (zone) new Intl.DateTimeFormat(LOCALE, { timeZone: zone });
    tz = zone || undefined;
  } catch {
    tz = undefined;
  }
}

/** The timezone all times are shown in (IANA name). */
export const timeZone = () => tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Formats a Unix time (seconds) in the server's timezone, 24-hour clock. */
export function fmtDate(unix: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(unix * 1000).toLocaleString(LOCALE, { timeZone: tz, hourCycle: "h23", ...opts });
}

/** Calendar day of a Unix time in the server's timezone: "2026-10-26". */
export function dayKey(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Hour (0–23) right now in the server's timezone. */
export function hourNow(): number {
  return Number(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" })) % 24;
}

const nfCache = new Map<number, Intl.NumberFormat>();
const nf = (digits: number) => {
  let f = nfCache.get(digits);
  if (!f) nfCache.set(digits, (f = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: digits })));
  return f;
};

export const num = (n: number, digits = 0) => nf(digits).format(n);

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf(i === 0 ? 0 : v >= 100 ? 0 : digits).format(v)} ${units[i]}`;
}

/** Rate in bytes/s → "1.2 MB/s". */
export const rate = (bps: number | null | undefined) => (bps === null || bps === undefined ? "—" : `${bytes(bps)}/s`);

export const pct = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? "—" : `${num(n, digits)}%`);

export const nowSec = () => Math.floor(Date.now() / 1000);

/** "8 days 1 hr", "3 hr 12 min", "45 s" */
export function duration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const days = `${d} ${d === 1 ? "day" : "days"}`;
  if (d > 0) return h && d < 7 ? `${days} ${h} hr` : days;
  if (h > 0) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m > 0) return `${m} min`;
  return `${sec} s`;
}

/** "5 min ago", "in 3 hr", "8 days ago" */
export function ago(unix: number | null | undefined, now = nowSec()): string {
  if (!unix) return "—";
  const d = now - unix;
  if (Math.abs(d) < 45) return d >= 0 ? "just now" : "in a moment";
  const short = (s: number) => (s >= 86400 ? duration(Math.floor(s / 86400) * 86400) : duration(s));
  return d >= 0 ? `${short(d)} ago` : `in ${short(-d)}`;
}

/** "Oct 26, 2026, 14:30" */
export function dateTime(unix: number | null | undefined): string {
  if (!unix) return "—";
  return fmtDate(unix, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "today 14:30", "yesterday 09:12", "Oct 24, 14:30" */
export function shortDateTime(unix: number | null | undefined): string {
  if (!unix) return "—";
  const time = clock(unix);
  const day = dayKey(unix);
  const n = nowSec();
  if (day === dayKey(n)) return `today ${time}`;
  if (day === dayKey(n - 86400)) return `yesterday ${time}`;
  return `${fmtDate(unix, { month: "short", day: "numeric" })}, ${time}`;
}

/** "14:30" */
export const clock = (unix: number) => fmtDate(unix, { hour: "2-digit", minute: "2-digit" });
/** "14:30:05" */
export const clockSec = (unix: number) => fmtDate(unix, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** `plural(3, "ban", "bans")` → "3 bans" */
export const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** "Monday, October 26" */
export function todayLong(): string {
  return fmtDate(nowSec(), { weekday: "long", day: "numeric", month: "long" });
}

export function greeting(): string {
  const h = hourNow();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback without the Clipboard API (e.g. http://localhost in some browsers).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Short duration: "45 s", "5 min", "3 hr", "8 d" */
export function span(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr`;
  return `${Math.floor(sec / 86400)} d`;
}

/** "5 min ago", "13 d ago" – a single unit, so nothing gets cut off. */
export function agoShort(unix: number | null | undefined, now = nowSec()): string {
  if (!unix) return "—";
  const d = now - unix;
  if (Math.abs(d) < 45) return d >= 0 ? "just now" : "in a moment";
  return d >= 0 ? `${span(d)} ago` : `in ${span(-d)}`;
}

/** End of a sentence: adds a period only if the text doesn't end with one already. */
export const period = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** "2026-02-01" → "Feb 1, 2026" (already a calendar day of the server). */
export const dayDate = (day: string | null | undefined) =>
  day ? new Date(day + "T12:00:00Z").toLocaleDateString(LOCALE, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : null;

/** "HH:MM" → minutes since midnight. */
export const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

let regionNames: Intl.DisplayNames | null | undefined;
/** Short English country name ("United Kingdom" instead of the long form from DB-IP). */
export function countryName(cc: string | null, fallback: string): string {
  if (!cc) return fallback;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames([LOCALE], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(cc) ?? fallback;
  } catch {
    return fallback;
  }
}
