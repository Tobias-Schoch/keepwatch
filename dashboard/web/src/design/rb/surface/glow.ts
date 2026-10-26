/**
 * Border Glow (after React Bits) for every surface with [data-light]: the closer
 * the cursor gets to an edge, the brighter a light cone pointing from the center
 * to the cursor — colored edge (::after of the surface, see surface.css) plus a
 * glow inwards and outwards (.o-bglow).
 *
 * The glow span is only created when a surface lights up for the first time.
 * If the surface clips (overflow ≠ visible, e.g. tiles with an orbit), it hangs
 * on the parent element and is laid over the surface there.
 *
 * Performance: split into planGlow (reads only) and applyGlow (writes only).
 * Code handling many surfaces in one frame reads all first, then writes all —
 * otherwise every read after a write forces a new style and layout pass.
 * setVar only writes what actually changed.
 */

/** Reach outside the surface within which the edge still glows (px). */
export const GLOW_OUT = 64;
const PAD = 40;

interface Glow {
  span: HTMLSpanElement;
  outer: boolean;
}
const glows = new WeakMap<HTMLElement, Glow>();

/** Last written values per element — equal values trigger no style recalc. */
const written = new WeakMap<HTMLElement, Record<string, string>>();
export function setVar(el: HTMLElement, key: string, value: string) {
  let w = written.get(el);
  if (!w) written.set(el, (w = {}));
  if (w[key] === value) return;
  w[key] = value;
  if (key.startsWith("--")) el.style.setProperty(key, value);
  else el.style[key as "left"] = value;
}

function make(el: HTMLElement): Glow {
  const cs = getComputedStyle(el);
  const clipped = cs.overflowX !== "visible" || cs.overflowY !== "visible";
  const host = clipped && el.parentElement ? el.parentElement : el;
  if (host !== el && getComputedStyle(host).position === "static") host.style.position = "relative";
  const span = document.createElement("span");
  span.className = "o-bglow";
  span.setAttribute("aria-hidden", "true");
  span.style.setProperty("--br", cs.borderRadius);
  host.appendChild(span);
  const g = { span, outer: host !== el };
  glows.set(el, g);
  return g;
}

export interface GlowPlan {
  el: HTMLElement;
  ang: string;
  ge: number;
  /** Position of the surface within its parent (only for a glow hung outside). */
  box: [number, number, number, number] | null;
}

/**
 * Computes angle and edge proximity — reads only. `ge` 0…1: inside, the ratio
 * to the nearest edge (0 center, 1 edge); outside, a falloff over GLOW_OUT.
 */
export function planGlow(el: HTMLElement, r: DOMRect, x: number, y: number, outside: number): GlowPlan {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  let ge: number;
  if (outside > 0) {
    const t = Math.max(0, 1 - outside / GLOW_OUT);
    ge = t * t;
  } else {
    ge = Math.min(1, Math.max(Math.abs(dx) / (r.width / 2 || 1), Math.abs(dy) / (r.height / 2 || 1)));
  }
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  const g = glows.get(el);
  const box: GlowPlan["box"] = g && g.outer && g.span.isConnected ? [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight] : null;
  return { el, ang: `${deg.toFixed(1)}deg`, ge, box };
}

/** Writes a planned glow — writes only (except when first created). */
export function applyGlow(p: GlowPlan) {
  const { el, ang } = p;
  const ge = p.ge.toFixed(3);
  setVar(el, "--ga", ang);
  setVar(el, "--ge", ge);

  let g = glows.get(el);
  let box = p.box;
  if ((!g || !g.span.isConnected) && p.ge > 0.28) {
    g = make(el);
    // Once on creation: read the position right away so the glow is not a frame late.
    if (g.outer) box = [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight];
  }
  if (!g || !g.span.isConnected) return;
  const s = g.span;
  setVar(s, "--ga", ang);
  setVar(s, "--ge", ge);
  if (g.outer && box) {
    setVar(s, "left", `${box[0] - PAD}px`);
    setVar(s, "top", `${box[1] - PAD}px`);
    setVar(s, "width", `${box[2] + PAD * 2}px`);
    setVar(s, "height", `${box[3] + PAD * 2}px`);
  }
}

/** Both steps at once (for single calls outside a loop). */
export function paintGlow(el: HTMLElement, r: DOMRect, x: number, y: number, outside: number) {
  applyGlow(planGlow(el, r, x, y, outside));
}

/** Surface is out of reach: hide everything (the span stays for later). */
export function dimGlow(el: HTMLElement) {
  setVar(el, "--ge", "0");
  const g = glows.get(el);
  if (g) setVar(g.span, "--ge", "0");
}
