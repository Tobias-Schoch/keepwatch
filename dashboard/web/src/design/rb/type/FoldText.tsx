import { createElement, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { cx } from "../../ui";
import { useSweep } from "./sweep";
import "./type.css";

/**
 * FoldText (after React Bits): every letter folds forward out of the depth at
 * its top edge, with a short crease shadow. No GSAP — plain CSS animation,
 * delayed per letter.
 *
 * Colored as before: words carry the headline's metal gradient (o-blur-word,
 * so the variants can recolor it). From `shineFrom` on, the silver shimmer runs
 * — as ONE continuous streak of light across the whole word, even though every
 * letter is its own element: each letter knows its offset from the start of
 * the word (--fx) and the word width (--fw) and shifts the shared gradient
 * accordingly.
 *
 * Performance: the shimmer runs as a single pass every 7 s (useSweep) instead
 * of an infinite animation. Once all letters have settled, the line gets
 * data-folded: perspective, backface hiding and crease shadow are dropped —
 * they kept every letter as its own compositing layer.
 */
export function FoldText({
  text,
  as = "span",
  className,
  delay = 0,
  stagger = 38,
  duration = 720,
  shineFrom,
}: {
  text: string;
  as?: "h1" | "h2" | "p" | "span" | "div";
  className?: string;
  /** ms until the first letter. */
  delay?: number;
  /** ms between two letters. */
  stagger?: number;
  /** ms per letter. */
  duration?: number;
  /** The shimmer runs from this word index on. */
  shineFrom?: number;
}) {
  const root = useRef<HTMLElement>(null);

  // Measure letter offsets within the word (only for shimmering words).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || shineFrom === undefined) return;
    const measure = () => {
      el.querySelectorAll<HTMLElement>(".o-fold-word.is-shine").forEach((word) => {
        const w = word.offsetWidth;
        word.style.setProperty("--fw", `${w}px`);
        word.querySelectorAll<HTMLElement>(".o-fold-piece").forEach((p) => {
          p.style.setProperty("--fx", `${p.offsetLeft}px`);
        });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [text, shineFrom]);

  // Shimmer: first pass 1.6 s after appearing, then every 7 s.
  useSweep(root, shineFrom !== undefined, 1600, [text]);

  // After unfolding: remove the 3D helpers (see above).
  const letters = text.replace(/\s+/g, "").length;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.removeAttribute("data-folded");
    const t = window.setTimeout(() => el.setAttribute("data-folded", ""), delay + Math.max(0, letters - 1) * stagger + duration + 80);
    return () => clearTimeout(t);
  }, [text, letters, delay, stagger, duration]);

  const parts = text.split(/(\s+)/);
  let w = 0;
  let c = 0;
  const words = parts.map((part, i) => {
    if (!part) return null;
    if (/^\s+$/.test(part)) return " ";
    const wi = w++;
    const shine = shineFrom !== undefined && wi >= shineFrom;
    return (
      <span key={i} className={cx("o-fold-word", shine && "is-shine")}>
        {Array.from(part).map((ch, j) => {
          const ci = c++;
          return (
            <span key={j} className="o-fold-seg">
              <span
                className={cx("o-fold-piece", shine ? "is-shine" : "o-blur-word")}
                style={{ "--d": `${delay + ci * stagger}ms`, "--dur": `${duration}ms` } as CSSProperties}
              >
                {ch}
              </span>
            </span>
          );
        })}
      </span>
    );
  });

  return createElement(
    as,
    { ref: root, className: cx("o-fold", className) },
    <span className="o-fold-sr">{text}</span>,
    <span aria-hidden>{words}</span>,
  );
}
