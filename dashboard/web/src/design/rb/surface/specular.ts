/**
 * Specular Button (after React Bits) without WebGL: a highlight travels along a
 * button's edge to the point closest to the cursor, with a weaker reflection
 * glowing opposite. Instead of a canvas per button, one shared rAF loop only
 * writes CSS variables; drawing happens in surface.css.
 *
 *   --sx/--sy  highlight on the edge (px from left/top)
 *   --bx/--by  counter-reflection
 *   --ex/--ey  pool of light inside, just behind the highlight
 *   --sl       brightness 0…1
 */

import { setVar } from "./glow";

const PROXIMITY = 250;

interface Item {
  el: HTMLElement;
  idle: number;
  spot: number;
  level: number;
  press: number;
  ready: boolean;
  g?: Geo;
}

type Geo = { w: number; h: number; hx: number; hy: number; r: number };

const items = new Map<HTMLElement, Item>();
const pointer = { x: 0, y: 0, known: false };
let raf = 0;
let last = 0;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const wrap = (v: number) => v - Math.floor(v);

/** Position 0…1 along the edge of a rounded rectangle (y pointing up). */
function loopPosition(x: number, y: number, hx: number, hy: number, r: number) {
  const ix = hx - r;
  const iy = hy - r;
  const arc = (Math.PI / 2) * r;
  const quarter = ix + iy + arc;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const qx = ax - ix;
  const qy = ay - iy;
  let s;
  if (qx > 0 && qy > 0) s = iy + Math.atan2(qy, qx) * r;
  else if (qx > qy) s = Math.min(ay, iy);
  else s = iy + arc + ix - Math.min(ax, ix);
  if (x < 0) s = y >= 0 ? 2 * quarter - s : 2 * quarter + s;
  else if (y < 0) s = 4 * quarter - s;
  return wrap(s / Math.max(4 * quarter, 0.0001));
}

function rimPoint(position: number, hx: number, hy: number, r: number): [number, number] {
  const ix = hx - r;
  const iy = hy - r;
  const arc = (Math.PI / 2) * r;
  const quarter = ix + iy + arc;
  let s = wrap(position) * 4 * quarter;
  let sx = 1;
  let sy = 1;
  if (s > 3 * quarter) {
    s = 4 * quarter - s;
    sy = -1;
  } else if (s > 2 * quarter) {
    s -= 2 * quarter;
    sx = -1;
    sy = -1;
  } else if (s > quarter) {
    s = 2 * quarter - s;
    sx = -1;
  }
  let x = ix - (s - iy - arc);
  let y = hy;
  if (s <= iy) {
    x = hx;
    y = s;
  } else if (s <= iy + arc) {
    const a = (s - iy) / Math.max(r, 0.0001);
    x = ix + Math.cos(a) * r;
    y = iy + Math.sin(a) * r;
  }
  return [x * sx, y * sy];
}

/** Dimensions; the radius is only re-read on resize. */
function geometry(it: Item): Geo {
  const w = Math.max(1, it.el.offsetWidth);
  const h = Math.max(1, it.el.offsetHeight);
  if (it.g && it.g.w === w && it.g.h === h) return it.g;
  const r = Math.min(parseFloat(getComputedStyle(it.el).borderTopLeftRadius) || 0, w / 2, h / 2);
  return (it.g = { w, h, hx: w / 2, hy: h / 2, r });
}

/** Resting position: top left in the corner, like light from above at an angle. */
function restSpot(g: Geo) {
  const inset = g.r * (1 - Math.SQRT1_2);
  return loopPosition(inset - g.hx, g.hy - inset, g.hx, g.hy, g.r);
}

function aim(el: HTMLElement, g: Geo) {
  if (!pointer.known || (el as HTMLButtonElement).disabled) return null;
  const rect = el.getBoundingClientRect();
  const scale = rect.width / g.w || 1;
  const x = (pointer.x - rect.left - rect.width / 2) / scale;
  const y = (rect.top + rect.height / 2 - pointer.y) / scale;
  const distance = Math.hypot(Math.max(Math.abs(x) - g.hx, 0), Math.max(Math.abs(y) - g.hy, 0));
  const t = clamp(1 - distance / PROXIMITY, 0, 1);
  const near = t * t * (3 - 2 * t);
  const nearest = loopPosition(x, y, g.hx, g.hy, g.r);
  if (distance > 0) return { spot: nearest, near };
  // Inside the button: the light only swings gently instead of jumping to the nearest edge.
  const depth = clamp(Math.min(g.hx - Math.abs(x), g.hy - Math.abs(y)) / (g.hy * 0.8), 0, 1);
  const sway = restSpot(g) - (x / g.hx) * 0.06 - (y / g.hy) * 0.02;
  const offset = sway - nearest - Math.round(sway - nearest);
  return { spot: wrap(nearest + offset * depth * depth * (3 - 2 * depth)), near };
}

function write(it: Item, g: Geo) {
  const [rx, ry] = rimPoint(it.spot, g.hx, g.hy, g.r);
  const [bx, by] = rimPoint(it.spot + 0.5, g.hx, g.hy, g.r);
  const len = Math.hypot(rx, ry) || 1;
  const pull = 1 - Math.min(0.35 * g.hy, len) / len;
  const el = it.el;
  setVar(el, "--sx", `${(g.hx + rx).toFixed(1)}px`);
  setVar(el, "--sy", `${(g.hy - ry).toFixed(1)}px`);
  setVar(el, "--bx", `${(g.hx + bx).toFixed(1)}px`);
  setVar(el, "--by", `${(g.hy - by).toFixed(1)}px`);
  setVar(el, "--ex", `${(g.hx + rx * pull).toFixed(1)}px`);
  setVar(el, "--ey", `${(g.hy - ry * pull).toFixed(1)}px`);
  setVar(el, "--sl", clamp(it.level + it.press * 0.8, 0, 1.6).toFixed(3));
}

function frame(now: number) {
  raf = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  let busy = false;
  // Measure all buttons first, then write all: alternating reads and
  // writes forced a new style and layout pass per button.
  const plan: { it: Item; g: Geo; target: ReturnType<typeof aim> }[] = [];
  for (const it of items.values()) {
    if (!it.el.isConnected) continue;
    const g = geometry(it);
    plan.push({ it, g, target: aim(it.el, g) });
  }
  for (const { it, g, target } of plan) {
    const disabled = (it.el as HTMLButtonElement).disabled;
    if (!it.ready) {
      it.spot = restSpot(g);
      it.level = disabled ? 0 : it.idle;
      it.ready = true;
    }
    const steering = !!target && target.near > 0;
    let diff = (steering ? target!.spot : restSpot(g)) - it.spot;
    diff -= Math.round(diff);
    it.spot = wrap(it.spot + diff * (1 - Math.exp(-dt * 8)));
    const level = disabled ? 0 : it.idle + (1 - it.idle) * (target ? target.near : 0);
    it.level += (level - it.level) * (1 - Math.exp(-dt * 7));
    it.press *= Math.exp(-dt * 5);
    write(it, g);
    if (Math.abs(diff) > 0.0002 || Math.abs(level - it.level) > 0.002 || it.press > 0.002) busy = true;
  }
  if (busy) raf = requestAnimationFrame(frame);
  else last = 0;
}

function wake() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function onMove(e: PointerEvent) {
  if (e.pointerType === "touch") return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.known = true;
  wake();
}
function onLeave() {
  pointer.known = false;
  wake();
}
function onDown(e: PointerEvent) {
  const it = items.get(e.currentTarget as HTMLElement);
  if (!it || (it.el as HTMLButtonElement).disabled) return;
  it.press = 1;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.known = true;
  wake();
}

let listening = false;
function listen(on: boolean) {
  if (on === listening) return;
  listening = on;
  const m = on ? addEventListener : removeEventListener;
  m("pointermove", onMove as EventListener, { passive: true } as AddEventListenerOptions);
  m("resize", wake);
  m("scroll", wake, { passive: true, capture: true } as AddEventListenerOptions);
  if (on) document.documentElement.addEventListener("pointerleave", onLeave);
  else document.documentElement.removeEventListener("pointerleave", onLeave);
}

/** Registers a button; returns the unregister function. `idle` = base brightness without cursor. */
export function registerSpecular(el: HTMLElement, idle: number): () => void {
  const it: Item = { el, idle, spot: 0, level: 0, press: 0, ready: false };
  items.set(el, it);
  el.addEventListener("pointerdown", onDown);
  listen(true);
  wake();
  return () => {
    el.removeEventListener("pointerdown", onDown);
    items.delete(el);
    if (!items.size) {
      listen(false);
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }
  };
}

/** Update once after state changes (e.g. disabled). */
export const nudgeSpecular = wake;
