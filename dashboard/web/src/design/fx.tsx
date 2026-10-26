import {
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { LOCALE } from "../format";
import { easeOutExpo, prefersReduced, Spring, SPRING } from "./motion";
import { applyGlow, dimGlow, planGlow, setVar, type GlowPlan } from "./rb/surface/glow";
import { useSweep } from "./rb/type/sweep";
import "./rb/surface/surface.css";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------------------------------------------------------------------------
 * Edge light: a light follows the cursor. Every surface with [data-light] gets
 * --gx/--gy (cursor relative to the surface) and --gi (0…1, proximity). From
 * that the CSS draws the spotlight inside; Border Glow handles the edge glow
 * (rb/surface/glow.ts: --ga angle, --ge edge proximity).
 *
 * At most once per frame: first measure all surfaces, then write all of them
 * (alternating reads and writes forced several style recalculations per frame),
 * and only write values that changed. The variables are registered as
 * non-inherited in surface.css — a change only recomputes the surface itself,
 * not its whole content.
 * ------------------------------------------------------------------------- */
const REACH = 220;

export function useEdgeLight() {
  useEffect(() => {
    let x = -9999;
    let y = -9999;
    let raf = 0;
    let lit = new Set<HTMLElement>();
    const paint = () => {
      raf = 0;
      const away = x < -9000;
      if (away && !lit.size) return;
      // 1) Read only.
      const hits: { el: HTMLElement; r: DOMRect; i: number; kx: number; ky: number; glow: GlowPlan }[] = [];
      if (!away)
        document.querySelectorAll<HTMLElement>("[data-light]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.bottom < -REACH || r.top > innerHeight + REACH) return;
          const dx = Math.max(r.left - x, 0, x - r.right);
          const dy = Math.max(r.top - y, 0, y - r.bottom);
          const d = Math.hypot(dx, dy);
          if (d > REACH) return;
          const i = 1 - d / REACH;
          // Stretched surfaces (dock glass, tilted cards): convert the cursor into their own coordinates.
          const kx = el.offsetWidth && r.width ? el.offsetWidth / r.width : 1;
          const ky = el.offsetHeight && r.height ? el.offsetHeight / r.height : 1;
          hits.push({ el, r, i, kx, ky, glow: planGlow(el, r, x, y, d) });
        });
      // 2) Write only.
      const now = new Set<HTMLElement>();
      for (const { el, r, i, kx, ky, glow } of hits) {
        setVar(el, "--gx", `${((x - r.left) * kx).toFixed(1)}px`);
        setVar(el, "--gy", `${((y - r.top) * ky).toFixed(1)}px`);
        setVar(el, "--gi", (i * i).toFixed(3));
        applyGlow(glow);
        now.add(el);
      }
      for (const el of lit)
        if (!now.has(el)) {
          setVar(el, "--gi", "0");
          dimGlow(el);
        }
      lit = now;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      x = e.clientX;
      y = e.clientY;
      schedule();
    };
    const leave = () => {
      x = y = -9999;
      schedule();
    };
    // On scroll, only follow up if the cursor is inside the window at all.
    const scroll = () => {
      if (x > -9000 || lit.size) schedule();
    };
    addEventListener("pointermove", move, { passive: true });
    addEventListener("scroll", scroll, { passive: true, capture: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", move);
      removeEventListener("scroll", scroll, { capture: true });
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
}

/* ---------------------------------------------------------------------------
 * CountUp: a number counts calmly up to its value (tabular digits, no jumping).
 * ------------------------------------------------------------------------- */
export function CountUp({ value, duration = 1100, delay = 0, className }: { value: number; duration?: number; delay?: number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const from = shown.current ?? 0;
    const to = value;
    if (prefersReduced() || from === to) {
      shown.current = to;
      node.textContent = to.toLocaleString(LOCALE);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + (shown.current === null ? delay : 0);
    const step = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / duration));
      const v = Math.round(from + (to - from) * easeOutExpo(p));
      node.textContent = v.toLocaleString(LOCALE);
      shown.current = v;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    node.textContent = from.toLocaleString(LOCALE);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, delay]);
  return (
    <span className={cx("o-num", className)} aria-label={String(value)}>
      <span ref={el} aria-hidden>
        {value.toLocaleString(LOCALE)}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * BlurText: words emerge from the blur one after another.
 * ------------------------------------------------------------------------- */
export function BlurText({
  text,
  as = "span",
  className,
  delay = 0,
  stagger = 70,
  shineFrom,
}: {
  text: string;
  as?: "h1" | "h2" | "p" | "span" | "div";
  className?: string;
  delay?: number;
  stagger?: number;
  /** From this word index on, the silver shimmer runs across the words. */
  shineFrom?: number;
}) {
  const root = useRef<HTMLElement>(null);
  // Shimmer as a single pass every 7 s (previously an infinite CSS animation from 1.4 s).
  useSweep(root, shineFrom !== undefined, 1400, [text]);
  const words = text.split(/(\s+)/);
  let n = 0;
  return createElement(
    as,
    { ref: root, className: cx("o-blurtext", className), "aria-label": text },
    words.map((w, i) => {
      if (/^\s+$/.test(w)) return w;
      const idx = n++;
      return (
        <span
          key={i}
          aria-hidden
          className={cx("o-blur-word", shineFrom !== undefined && idx >= shineFrom && "o-shiny")}
          style={{ animationDelay: `${delay + idx * stagger}ms` }}
        >
          {w}
        </span>
      );
    }),
  );
}

export function Shiny({ children, className }: { children: ReactNode; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  useSweep(el, true, 1400);
  return (
    <span ref={el} className={cx("o-shiny", className)}>
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Decrypt: characters scramble briefly and lock in from left to right.
 * ------------------------------------------------------------------------- */
const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function Decrypt({ text, className, duration = 900 }: { text: string; className?: string; duration?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (prefersReduced()) {
      node.textContent = text;
      return;
    }
    let raf = 0;
    let lastSwap = 0;
    const t0 = performance.now();
    const chars = [...text];
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      if (now - lastSwap > 40 || p === 1) {
        lastSwap = now;
        const fixed = Math.floor(easeOutExpo(p) * chars.length);
        node.textContent = chars
          .map((ch, i) => (i < fixed || !/[A-Z0-9]/i.test(ch) ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
          .join("");
      }
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      node.textContent = text;
    };
  }, [text, duration]);
  return (
    <span className={className} aria-label={text}>
      <span ref={el} aria-hidden>
        {text}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Tilt: the surface tilts slightly towards the cursor, lifts, and a sheen follows.
 * ------------------------------------------------------------------------- */
type TiltProps = HTMLAttributes<HTMLDivElement> & {
  max?: number;
  lift?: number;
  glare?: boolean;
  children: ReactNode;
};

export function Tilt({ max = 4, lift = 3, glare = true, className, children, style, ...rest }: TiltProps) {
  const el = useRef<HTMLDivElement>(null);
  const state = useRef({ rx: 0, ry: 0, z: 0 });
  const springs = useMemo(() => {
    const write = () => {
      const node = el.current;
      if (!node) return;
      const s = state.current;
      // No transform at all while resting: otherwise every card would stay its own 3D layer.
      if (Math.abs(s.rx) < 0.001 && Math.abs(s.ry) < 0.001 && Math.abs(s.z) < 0.001) {
        node.style.transform = "";
        return;
      }
      node.style.transform = `perspective(1000px) translate3d(0, ${(-s.z).toFixed(2)}px, 0) rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`;
    };
    return {
      rx: new Spring(0, SPRING.lift, (v) => ((state.current.rx = v), write())),
      ry: new Spring(0, SPRING.lift, (v) => ((state.current.ry = v), write())),
      z: new Spring(0, SPRING.lift, (v) => ((state.current.z = v), write())),
    };
  }, []);
  useEffect(() => () => Object.values(springs).forEach((s) => s.stop()), [springs]);
  const reduced = prefersReduced();
  return (
    <div
      ref={el}
      {...rest}
      style={style}
      className={cx("o-tilt", className)}
      onPointerMove={(e) => {
        rest.onPointerMove?.(e);
        if (e.pointerType === "touch" || reduced) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        springs.rx.set((0.5 - py) * max * 2);
        springs.ry.set((px - 0.5) * max * 2);
        springs.z.set(lift);
        e.currentTarget.style.setProperty("--tx", `${(px * 100).toFixed(1)}%`);
        e.currentTarget.style.setProperty("--ty", `${(py * 100).toFixed(1)}%`);
      }}
      onPointerLeave={(e) => {
        rest.onPointerLeave?.(e);
        springs.rx.set(0);
        springs.ry.set(0);
        springs.z.set(0);
      }}
    >
      {children}
      {glare && <span className="o-glare" aria-hidden />}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Reveal: a single, short entrance on appearing.
 * ------------------------------------------------------------------------- */
export function Reveal({
  children,
  delay = 0,
  className,
  style,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  as?: "div" | "section" | "li";
}) {
  return createElement(as, { className: cx("o-reveal", className), style: { ...style, animationDelay: `${delay}ms` } }, children);
}

/* ---------------------------------------------------------------------------
 * Particles: a few fine points of light drifting in a tile on hover.
 * ------------------------------------------------------------------------- */
export function Particles({ count = 9, seed = 1 }: { count?: number; seed?: number }) {
  const dots = useMemo(() => {
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    return Array.from({ length: count }, () => ({
      left: `${8 + rnd() * 84}%`,
      top: `${10 + rnd() * 80}%`,
      dur: `${3.2 + rnd() * 3}s`,
      delay: `${-rnd() * 4}s`,
      dx: `${(rnd() - 0.5) * 40}px`,
      dy: `${-12 - rnd() * 34}px`,
      size: rnd() > 0.7 ? 3 : 2,
    }));
  }, [count, seed]);
  return (
    <span className="o-particles" aria-hidden>
      {dots.map((d, i) => (
        <i
          key={i}
          style={
            {
              left: d.left,
              top: d.top,
              width: d.size,
              height: d.size,
              animationDuration: d.dur,
              animationDelay: d.delay,
              "--dx": d.dx,
              "--dy": d.dy,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
