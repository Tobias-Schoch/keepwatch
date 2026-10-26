/**
 * Fuzzy search without a package: every word of the input must match – as a
 * substring of the title (best at a word start), as scattered letters in the
 * title ("sha" → "Shop api") or in the hint/keywords.
 */
export interface Match {
  score: number;
  /** Positions in the title to highlight. */
  hl: number[];
}

const BOUNDARY = /[\s\-_.:/·(@[]/;

function walk(tok: string, s: string, preferStarts: boolean): number[] | null {
  const idx: number[] = [];
  let from = 0;
  for (const ch of tok) {
    const first = s.indexOf(ch, from);
    if (first < 0) return null;
    let i = first;
    if (preferStarts)
      for (let k = first; k < Math.min(s.length, first + 16); k++)
        if (s[k] === ch && (k === 0 || BOUNDARY.test(s[k - 1]))) {
          i = k;
          break;
        }
    idx.push(i);
    from = i + 1;
  }
  return idx;
}

function subsequence(tok: string, s: string): { idx: number[]; gaps: number } | null {
  const idx = walk(tok, s, true) ?? walk(tok, s, false);
  if (!idx) return null;
  const gaps = idx[idx.length - 1] - idx[0] + 1 - idx.length;
  if (gaps > tok.length * 4 + 6) return null;
  return { idx, gaps };
}

export function fuzzy(query: string, title: string, extra = ""): Match | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, hl: [] };
  const t = title.toLowerCase();
  const x = extra.toLowerCase();
  let score = 0;
  const hl = new Set<number>();
  for (const tok of tokens) {
    const i = t.indexOf(tok);
    if (i >= 0) {
      const start = i === 0 || BOUNDARY.test(t[i - 1]) || (title[i] >= "A" && title[i] <= "Z");
      score += 100 + (i === 0 ? 60 : start ? 40 : 0) + tok.length * 3 - Math.min(i, 40) * 0.5;
      for (let k = 0; k < tok.length; k++) hl.add(i + k);
      continue;
    }
    const sub = tok.length > 1 ? subsequence(tok, t) : null;
    if (sub) {
      score += 50 - sub.gaps * 2;
      sub.idx.forEach((k) => hl.add(k));
      continue;
    }
    const j = x.indexOf(tok);
    if (j >= 0) {
      score += 30 + (j === 0 || BOUNDARY.test(x[j - 1]) ? 10 : 0);
      continue;
    }
    return null;
  }
  return { score, hl: [...hl].sort((a, b) => a - b) };
}

/** A complete IPv4 or (roughly) IPv6 – then the palette shows the IP card. */
export function asIp(q: string): string | null {
  const s = q.trim();
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s)) return s;
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(":") && (s.match(/:/g)?.length ?? 0) >= 2 && (s.match(/::/g)?.length ?? 0) <= 1) return s.toLowerCase();
  return null;
}
