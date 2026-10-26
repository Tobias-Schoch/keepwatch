import { useEffect, useLayoutEffect, useRef } from "react";
import { LOCALE } from "../../../format";
import { prefersReduced, Spring, type SpringConfig } from "../../motion";
import "./tiles.css";

/**
 * Counter (after React Bits): digits roll to their value like an odometer.
 * Every place is a 0–9 wheel on its own spring; on first appearance the ones
 * spin all the way round once, the tens only up to their value. A digit is
 * STEP em tall; a mask fades softly at the top and bottom.
 */

const STEP = 1.1;
/** Calmer than the default spring: the spin should be seen, not heard. */
const ROLL: SpringConfig = { stiffness: 80, damping: 18 };

function placesOf(value: number): number[] {
  const len = String(Math.max(0, Math.floor(Math.abs(value)))).length;
  return Array.from({ length: len }, (_, i) => 10 ** (len - i - 1));
}

function Digit({ place, value, delay }: { place: number; value: number; delay: number }) {
  const wheel = useRef<HTMLSpanElement>(null);
  const spring = useRef<Spring | null>(null);
  const target = Math.floor(value / place);

  useLayoutEffect(() => {
    const paint = (latest: number) => {
      const node = wheel.current;
      if (!node) return;
      const at = ((latest % 10) + 10) % 10;
      for (let i = 0; i < 10; i++) {
        let offset = (10 + i - at) % 10;
        if (offset > 5) offset -= 10;
        const el = node.children[i] as HTMLElement;
        // 2D instead of translate3d (and no will-change in tiles.css): resting digits are not their own layers.
        el.style.transform = `translateY(${(offset * STEP).toFixed(4)}em)`;
        // Keep only the nearest neighbors visible — otherwise distant digits flash
        // at the mask edge during a fast spin.
        el.style.opacity = Math.abs(offset) > 1.2 ? "0" : "1";
      }
    };
    spring.current = new Spring(0, ROLL, paint);
    paint(0);
    return () => spring.current?.stop();
  }, []);

  useEffect(() => {
    const sp = spring.current;
    if (!sp) return;
    if (prefersReduced()) {
      sp.jump(target);
      return;
    }
    // Delay only the first time (staggered entrance of the tiles).
    const first = sp.value === 0 && sp.target === 0;
    if (!first || delay <= 0) {
      sp.set(target);
      return;
    }
    const t = setTimeout(() => sp.set(target), delay);
    return () => clearTimeout(t);
  }, [target, delay]);

  return (
    <span className="o-counter-d">
      <span ref={wheel} className="o-counter-wheel">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="o-counter-n">
            {i}
          </span>
        ))}
      </span>
      <span className="o-counter-sizer">0</span>
    </span>
  );
}

export function Counter({ value, delay = 0, className }: { value: number; delay?: number; className?: string }) {
  const places = placesOf(value);
  return (
    <span className={className ? `o-num o-counter ${className}` : "o-num o-counter"} aria-label={value.toLocaleString(LOCALE)} role="img">
      <span className="o-counter-row" aria-hidden>
        {value < 0 && <span className="o-counter-sign">−</span>}
        {places.map((p, i) => (
          <Digit key={p} place={p} value={Math.abs(value)} delay={delay + i * 70} />
        ))}
      </span>
    </span>
  );
}
