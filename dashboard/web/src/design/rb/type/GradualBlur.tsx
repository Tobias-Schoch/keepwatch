import type { CSSProperties } from "react";
import "./type.css";

/**
 * GradualBlur (after React Bits): several stacked layers with backdrop-filter,
 * each visible only in a narrow band (mask) and blurrier towards the edge. The
 * content dissolves softly into the edge instead of being cut off hard. Fixed
 * to the window edge.
 *
 * Performance: every layer is its own blur pass plus a mask layer, and they sit
 * fixed over the page — in every frame where something moves underneath, the
 * GPU recomputes them all (especially expensive in WebKit). Layers below
 * `minBlur` (≈ 1.5 px, barely visible) are dropped; the first remaining layer
 * fades in one band earlier instead. That turns 6 + 6 layers into 4 + 4.
 */
const ease = (p: number) => p * p;

export function GradualBlur({
  position,
  height,
  strength = 1.6,
  layers = 6,
  minBlur = 2,
  className,
}: {
  position: "top" | "bottom";
  /** CSS height, e.g. "112px". */
  height: string;
  /** Strength at the outermost edge in rem ≈ strength. */
  strength?: number;
  layers?: number;
  /** Layers with less blur (px) are skipped. */
  minBlur?: number;
  className?: string;
}) {
  const dir = position === "top" ? "to top" : "to bottom";
  const step = 100 / layers;
  const r = (n: number) => Math.round(n * 10) / 10;
  // exponential as in the original, plus ease-in: sharp for a long way inside, strong only at the edge
  const blurs = Array.from({ length: layers }, (_, k) => Math.pow(2, ease((k + 1) / layers) * 4) * 0.0625 * strength);
  let first = blurs.findIndex((b) => b * 16 >= minBlur);
  if (first < 0) first = layers - 1;
  const divs = blurs.slice(first).map((blur, j) => {
    const i = first + j + 1;
    // The first remaining layer starts one band earlier (taking over the skipped ones).
    const lead = j === 0 && first > 0 ? step : 0;
    const p1 = r(Math.max(0, step * i - step - lead));
    const p2 = r(Math.max(0, step * i - lead));
    const p3 = r(step * i + step);
    const p4 = r(step * i + step * 2);
    let g = `transparent ${p1}%, #000 ${p2}%`;
    if (p3 <= 100) g += `, #000 ${p3}%`;
    if (p4 <= 100) g += `, transparent ${p4}%`;
    const mask = `linear-gradient(${dir}, ${g})`;
    const style: CSSProperties = {
      maskImage: mask,
      WebkitMaskImage: mask,
      backdropFilter: `blur(${blur.toFixed(3)}rem)`,
      WebkitBackdropFilter: `blur(${blur.toFixed(3)}rem)`,
    };
    return <div key={i} style={style} />;
  });
  return (
    <div className={`o-gblur ${className ?? ""}`} data-pos={position} style={{ height }} aria-hidden>
      {divs}
      <i className="o-gblur-tint" />
    </div>
  );
}
