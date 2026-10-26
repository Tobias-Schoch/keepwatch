/** Rough validation and arithmetic for IP addresses and CIDR ranges (IPv4 exact, IPv6 rough). */

const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const V6 = /^[0-9a-f:]+$/i;

export function parseEntry(raw: string): { ip: string; prefix: number | null; v6: boolean } | null {
  const s = raw.trim();
  if (!s) return null;
  const [ip, p, extra] = s.split("/");
  if (extra !== undefined) return null;
  const v4 = V4.test(ip);
  const v6 = !v4 && V6.test(ip) && ip.includes(":") && (ip.match(/::/g)?.length ?? 0) <= 1;
  if (!v4 && !v6) return null;
  if (p === undefined) return { ip, prefix: null, v6 };
  if (!/^\d{1,3}$/.test(p)) return null;
  const n = Number(p);
  if (n < 0 || n > (v6 ? 128 : 32)) return null;
  return { ip, prefix: n, v6 };
}

export const isValidEntry = (raw: string) => parseEntry(raw) !== null;

/** Number of addresses in an entry (IPv6 from /64 on capped at Number.MAX_SAFE_INTEGER). */
export function addressCount(raw: string): number {
  const e = parseEntry(raw);
  if (!e || e.prefix === null) return 1;
  const bits = (e.v6 ? 128 : 32) - e.prefix;
  return bits >= 53 ? Number.MAX_SAFE_INTEGER : 2 ** bits;
}

const v4num = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** Is `ip` (a single IPv4) inside the entry? IPv6 only on exact match. */
export function covers(entry: string, ip: string): boolean {
  const e = parseEntry(entry);
  if (!e) return false;
  if (e.v6 || !V4.test(ip)) return e.ip.toLowerCase() === ip.toLowerCase() && (e.prefix === null || e.prefix === 128);
  if (e.prefix === null) return e.ip === ip;
  if (e.prefix === 0) return true;
  const mask = 2 ** 32 - 2 ** (32 - e.prefix);
  const a = v4num(e.ip);
  const b = v4num(ip);
  return Math.floor(a / 2 ** (32 - e.prefix)) === Math.floor(b / 2 ** (32 - e.prefix)) && mask > 0;
}

/** Normalizes notation so "1.2.3.4/32" and "1.2.3.4" count as equal. */
export function normalize(raw: string): string {
  const e = parseEntry(raw);
  if (!e) return raw.trim();
  if (e.prefix === null || e.prefix === (e.v6 ? 128 : 32)) return e.ip.toLowerCase();
  return `${e.ip.toLowerCase()}/${e.prefix}`;
}

/** iCloud Private Relay egress (Cloudflare 104.28.x, Akamai 172.224–239.x): shared by many Apple users. */
export const isPrivateRelay = (v: string) => /^104\.28\./.test(v) || /^172\.(22[4-9]|23\d)\./.test(v);
