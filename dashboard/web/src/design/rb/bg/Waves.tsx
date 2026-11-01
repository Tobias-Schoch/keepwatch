/**
 * Waves — after React Bits (reactbits.dev, Backgrounds), no dependencies.
 *
 * Vertical ink lines, bent by Perlin noise that drifts slowly; the cursor drags the lines
 * along like a hand through tall grass and they spring back. Unchanged from the original:
 * the noise, the cursor spring (tension, friction, maxCursorMove) and the smoothed cursor
 * speed that decides how far the lines get pushed.
 *
 * Paper: all lines go into a single path and one stroke per frame (the original strokes
 * each line on its own); the color comes from the design (--o-wave). At most `fps`
 * frames per second, paused while the tab is hidden, a still frame with reduced motion.
 */

import { memo, useEffect, useRef } from "react";
import { prefersReduced } from "../../motion";
import "./bg.css";

interface WavesProps {
  /** Stroke color; empty = --o-wave of the design. */
  lineColor?: string;
  lineWidth?: number;
  waveSpeedX?: number;
  waveSpeedY?: number;
  waveAmpX?: number;
  waveAmpY?: number;
  xGap?: number;
  yGap?: number;
  friction?: number;
  tension?: number;
  maxCursorMove?: number;
  fps?: number;
  className?: string;
}

/* Perlin noise (2D), as in the original. */
class Grad {
  constructor(public x: number, public y: number) {}
  dot2(x: number, y: number) {
    return this.x * x + this.y * y;
  }
}
class Noise {
  private grad3 = [new Grad(1, 1), new Grad(-1, 1), new Grad(1, -1), new Grad(-1, -1), new Grad(1, 0), new Grad(-1, 0), new Grad(0, 1), new Grad(0, -1)];
  private p = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180];
  private perm = new Array<number>(512);
  private gradP = new Array<Grad>(512);
  constructor(seed = 0) {
    if (seed > 0 && seed < 1) seed *= 65536;
    seed = Math.floor(seed);
    if (seed < 256) seed |= seed << 8;
    for (let i = 0; i < 256; i++) {
      const v = i & 1 ? this.p[i] ^ (seed & 255) : this.p[i] ^ ((seed >> 8) & 255);
      this.perm[i] = this.perm[i + 256] = v;
      this.gradP[i] = this.gradP[i + 256] = this.grad3[v % 8];
    }
  }
  private fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  private lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;
  perlin2(x: number, y: number) {
    let X = Math.floor(x);
    let Y = Math.floor(y);
    x -= X;
    y -= Y;
    X &= 255;
    Y &= 255;
    const n00 = this.gradP[X + this.perm[Y]].dot2(x, y);
    const n01 = this.gradP[X + this.perm[Y + 1]].dot2(x, y - 1);
    const n10 = this.gradP[X + 1 + this.perm[Y]].dot2(x - 1, y);
    const n11 = this.gradP[X + 1 + this.perm[Y + 1]].dot2(x - 1, y - 1);
    const u = this.fade(x);
    return this.lerp(this.lerp(n00, n10, u), this.lerp(n01, n11, u), this.fade(y));
  }
}

interface Point {
  x: number;
  y: number;
  wave: { x: number; y: number };
  cursor: { x: number; y: number; vx: number; vy: number };
}

function Waves({
  lineColor = "",
  lineWidth = 1,
  waveSpeedX = 0.0125,
  waveSpeedY = 0.005,
  waveAmpX = 32,
  waveAmpY = 16,
  xGap = 12,
  yGap = 34,
  friction = 0.925,
  tension = 0.005,
  maxCursorMove = 110,
  fps = 50,
  className,
}: WavesProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const opts = useRef({ lineColor, lineWidth, waveSpeedX, waveSpeedY, waveAmpX, waveAmpY, xGap, yGap, friction, tension, maxCursorMove, fps });
  opts.current = { lineColor, lineWidth, waveSpeedX, waveSpeedY, waveAmpX, waveAmpY, xGap, yGap, friction, tension, maxCursorMove, fps };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "waves-canvas";
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const noise = new Noise(Math.random());
    let lines: Point[][] = [];
    let w = 0;
    let h = 0;
    let dpr = 1;
    let color = "";
    const mouse = { x: -10, y: 0, lx: 0, ly: 0, sx: 0, sy: 0, v: 0, vs: 0, a: 0, set: false };

    const build = () => {
      const o = opts.current;
      const r = host.getBoundingClientRect();
      w = r.width;
      h = r.height;
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      lines = [];
      const oWidth = w + 200;
      const oHeight = h + 30;
      const totalLines = Math.ceil(oWidth / o.xGap);
      const totalPoints = Math.ceil(oHeight / o.yGap);
      const xStart = (w - o.xGap * totalLines) / 2;
      const yStart = (h - o.yGap * totalPoints) / 2;
      for (let i = 0; i <= totalLines; i++) {
        const pts: Point[] = [];
        for (let j = 0; j <= totalPoints; j++)
          pts.push({ x: xStart + o.xGap * i, y: yStart + o.yGap * j, wave: { x: 0, y: 0 }, cursor: { x: 0, y: 0, vx: 0, vy: 0 } });
        lines.push(pts);
      }
      color = o.lineColor || getComputedStyle(host).getPropertyValue("--o-wave").trim() || "rgba(0, 0, 0, 0.12)";
    };

    const move = (time: number) => {
      const o = opts.current;
      for (const pts of lines)
        for (const p of pts) {
          const m = noise.perlin2((p.x + time * o.waveSpeedX) * 0.002, (p.y + time * o.waveSpeedY) * 0.0015) * 12;
          p.wave.x = Math.cos(m) * o.waveAmpX;
          p.wave.y = Math.sin(m) * o.waveAmpY;
          const dx = p.x - mouse.sx;
          const dy = p.y - mouse.sy;
          const d = Math.hypot(dx, dy);
          const l = Math.max(175, mouse.vs);
          if (d < l) {
            const s = 1 - d / l;
            const f = Math.cos(d * 0.001) * s;
            p.cursor.vx += Math.cos(mouse.a) * f * l * mouse.vs * 0.00065;
            p.cursor.vy += Math.sin(mouse.a) * f * l * mouse.vs * 0.00065;
          }
          p.cursor.vx += (0 - p.cursor.x) * o.tension;
          p.cursor.vy += (0 - p.cursor.y) * o.tension;
          p.cursor.vx *= o.friction;
          p.cursor.vy *= o.friction;
          p.cursor.x = Math.min(o.maxCursorMove, Math.max(-o.maxCursorMove, p.cursor.x + p.cursor.vx * 2));
          p.cursor.y = Math.min(o.maxCursorMove, Math.max(-o.maxCursorMove, p.cursor.y + p.cursor.vy * 2));
        }
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = opts.current.lineWidth;
      for (const pts of lines) {
        const first = pts[0];
        ctx.moveTo(first.x + first.wave.x, first.y + first.wave.y);
        pts.forEach((p, i) => {
          const isLast = i === pts.length - 1;
          ctx.lineTo(p.x + p.wave.x + (isLast ? 0 : p.cursor.x), p.y + p.wave.y + (isLast ? 0 : p.cursor.y));
        });
      }
      ctx.stroke();
    };

    const reduced = prefersReduced();
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = 0;
      if (now(t)) {
        // Smoothed cursor and its speed, as in the original.
        mouse.sx += (mouse.x - mouse.sx) * 0.1;
        mouse.sy += (mouse.y - mouse.sy) * 0.1;
        const dx = mouse.x - mouse.lx;
        const dy = mouse.y - mouse.ly;
        mouse.v = Math.hypot(dx, dy);
        mouse.vs += (mouse.v - mouse.vs) * 0.1;
        mouse.vs = Math.min(100, mouse.vs);
        mouse.lx = mouse.x;
        mouse.ly = mouse.y;
        mouse.a = Math.atan2(dy, dx);
        move(reduced ? 12000 : t);
        draw();
      }
      if (!reduced && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const now = (t: number) => {
      if (reduced) return true;
      if (t - last < 1000 / opts.current.fps - 2) return false;
      last = t;
      return true;
    };
    const wake = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || reduced) return;
      const r = host.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      if (!mouse.set) {
        mouse.sx = mouse.lx = mouse.x;
        mouse.sy = mouse.ly = mouse.y;
        mouse.set = true;
      }
    };
    const onVis = () => (document.hidden ? (cancelAnimationFrame(raf), (raf = 0)) : wake());
    const ro = new ResizeObserver(() => {
      build();
      wake();
    });
    ro.observe(host);
    build();
    addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      canvas.remove();
    };
  }, []);

  return <div ref={hostRef} className={className ? `waves ${className}` : "waves"} />;
}

export default memo(Waves);
