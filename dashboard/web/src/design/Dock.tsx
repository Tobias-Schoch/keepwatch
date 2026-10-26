import { useEffect, useLayoutEffect, useRef } from "react";
import { useConfig } from "../config";
import { dockView, dockViews, useNav } from "../nav";
import { prefersReduced, Spring, SPRING } from "./motion";
import { cx } from "./ui";

/**
 * Navigation as a floating glass dock: icons grow towards the cursor, the label
 * appears above, a dot below marks where you are. A colored dot in the top
 * right shows problems in that area. Only pages of installed modules appear.
 *
 * Performance: the glass (background, blur, shadow, edge light) sits on its own
 * layer (.o-dock-bg) with a fixed resting width. When the dock widens while
 * magnifying, a ResizeObserver stretches that layer with scaleX — it is not
 * repainted every frame, only moved and stretched.
 */

const BASE = 44;
const MAX = 66;
const REACH = 150;

export function Dock() {
  const { view, go, overview } = useNav();
  const health = overview?.health ?? [];
  useConfig(); // re-render when the modules are known
  const views = dockViews();

  const els = useRef(new Map<string, HTMLButtonElement>());
  /** Last written size per icon (for the resting width of the glass). */
  const sizes = useRef(new Map<string, number>());
  const dockRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLSpanElement>(null);
  const springs = useRef(new Map<string, Spring>());
  const refs = useRef(new Map<string, (el: HTMLButtonElement | null) => void>());
  const refFor = (key: string) => {
    let fn = refs.current.get(key);
    if (!fn) {
      fn = (el) => {
        if (!el) {
          els.current.delete(key);
          springs.current.get(key)?.stop();
          springs.current.delete(key);
          sizes.current.delete(key);
          return;
        }
        els.current.set(key, el);
        if (!springs.current.has(key))
          springs.current.set(
            key,
            new Spring(BASE, SPRING.snappy, (v) => {
              els.current.get(key)?.style.setProperty("--s", `${v.toFixed(2)}px`);
              sizes.current.set(key, +v.toFixed(2));
            }),
          );
      };
      refs.current.set(key, fn);
    }
    return fn;
  };
  useEffect(() => () => springs.current.forEach((s) => s.stop()), []);

  // Stretch the glass: width = resting width × k. The resting width is the current width
  // minus how much the icons are currently larger than BASE.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const glass = glassRef.current;
    if (!dock || !glass) return;
    let rest = 0;
    let lastT = "";
    const fit = (w: number) => {
      let grow = 0;
      sizes.current.forEach((v) => (grow += v - BASE));
      const base = w - grow;
      if (base > 0 && Math.abs(base - rest) > 0.5) {
        rest = base;
        glass.style.width = `${rest.toFixed(2)}px`;
      }
      const k = rest > 0 ? w / rest : 1;
      const t = Math.abs(k - 1) < 1e-4 ? "" : `scaleX(${k.toFixed(5)})`;
      if (t !== lastT) {
        glass.style.transform = t;
        lastT = t;
      }
    };
    fit(dock.offsetWidth);
    const ro = new ResizeObserver(([e]) => fit(e.borderBoxSize?.[0]?.inlineSize ?? dock.offsetWidth));
    ro.observe(dock);
    return () => ro.disconnect();
  }, []);

  const magnify = (x: number | null) => {
    const allow = x !== null && !prefersReduced() && matchMedia("(hover: hover) and (min-width: 720px)").matches;
    els.current.forEach((el, key) => {
      const sp = springs.current.get(key);
      if (!sp) return;
      if (!allow) return sp.set(BASE);
      const r = el.getBoundingClientRect();
      const d = Math.abs(x! - (r.left + r.width / 2));
      const k = d > REACH ? 0 : Math.cos((d / REACH) * (Math.PI / 2));
      sp.set(BASE + (MAX - BASE) * k * k);
    });
  };

  return (
    <nav className="o-dock-wrap" aria-label="Navigation">
      <div ref={dockRef} className="o-dock" onPointerMove={(e) => e.pointerType !== "touch" && magnify(e.clientX)} onPointerLeave={() => magnify(null)}>
        <span ref={glassRef} className="o-dock-bg" data-light aria-hidden />
        {views.map((v, i) => {
          const probs = v.areas ? health.filter((h) => v.areas!.includes(h.area)) : [];
          const alert = probs.some((p) => p.level === "crit") ? "rose" : probs.length ? "sand" : undefined;
          const Icon = v.icon;
          return (
            <span key={v.id} className="contents">
              {(i === 1 || v.id === "settings") && <span className="o-dock-sep" aria-hidden />}
              <button
                ref={refFor(v.id)}
                type="button"
                className={cx("o-dock-item", dockView(view) === v.id && "is-active")}
                aria-label={probs.length ? `${v.label} – ${probs.length} ${probs.length === 1 ? "issue" : "issues"}` : v.label}
                aria-current={dockView(view) === v.id ? "page" : undefined}
                onClick={() => go(v.id)}
              >
                <span className="o-dock-face">
                  <Icon className="o-dock-icon" strokeWidth={1.6} />
                </span>
                {alert && <i className="o-dock-alert" data-tone={alert} />}
                <span className="o-dock-label" aria-hidden>
                  {v.label}
                </span>
                <i className="o-dock-dot" aria-hidden />
              </button>
            </span>
          );
        })}
      </div>
    </nav>
  );
}
