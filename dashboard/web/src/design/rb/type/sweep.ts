import { useEffect, type DependencyList, type RefObject } from "react";
import { prefersReduced } from "../../motion";

/**
 * Silver shimmer as a single pass instead of an infinite animation.
 *
 * The shimmer used to be a CSS animation "7 s, infinite" of which only the
 * first 45% (3.15 s) moved anything. The browser still recomputed style and
 * paint for every letter in every frame — also during the 3.85 s of rest and
 * when the headline was scrolled away. Now a timer sets `data-sweep` every 7 s,
 * CSS plays one pass (SWEEP_MS), then it rests. Same rhythm, same motion; a pass
 * is only skipped when the surface is not visible (tab hidden, scrolled away).
 */
export const SWEEP_MS = 3150;
export const SWEEP_EVERY = 7000;

export function useSweep(ref: RefObject<HTMLElement>, on: boolean, firstDelay: number, deps: DependencyList = []) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on || prefersReduced()) return;
    let t = 0;
    const seen = () => {
      if (document.hidden) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    };
    const run = () => {
      if (!seen()) {
        t = window.setTimeout(run, SWEEP_EVERY);
        return;
      }
      el.setAttribute("data-sweep", "");
      t = window.setTimeout(() => {
        el.removeAttribute("data-sweep");
        t = window.setTimeout(run, SWEEP_EVERY - SWEEP_MS - 40);
      }, SWEEP_MS + 40);
    };
    t = window.setTimeout(run, firstDelay);
    return () => {
      clearTimeout(t);
      el.removeAttribute("data-sweep");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, firstDelay, ...deps]);
}
