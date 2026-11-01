import DotField from "./rb/bg/DotField";
import FaultyTerminal from "./rb/bg/FaultyTerminal";
import Waves from "./rb/bg/Waves";
import { useDesign, useMode } from "./theme";

/**
 * Light behind the app, one React Bits background per design:
 *   Graphite – Dot Field, a dot grid that moves out of the cursor's way; in light mode Waves
 *   Phosphor – Faulty Terminal, a flickering glyph wall under a CRT (scanlines, vignette)
 *   Paper    – Waves, ink lines the cursor drags through
 */
export function LightRays() {
  const design = useDesign();
  const mode = useMode();
  if (design === "phosphor")
    return (
      <div className="o-backdrop o-rb-app" aria-hidden>
        <FaultyTerminal cell={[10, 16]} resolution={0.75} tint={[0.36, 1, 0.52]} brightness={0.62} curvature={0.14} flicker={0.1} />
        <div className="o-rb-veil" />
        <div className="ph-crt" />
      </div>
    );
  if (design === "paper" || (design === "graphit" && mode === "light"))
    return (
      <div className="o-backdrop o-rb-app" aria-hidden>
        <Waves xGap={12} yGap={34} waveAmpX={36} waveAmpY={18} />
        <div className="o-rb-veil" />
        <div className="o-grain" />
      </div>
    );
  return (
    <div className="o-backdrop o-rb-app" aria-hidden>
      <DotField
        dotRadius={2}
        dotSpacing={16}
        cursorRadius={420}
        bulgeOnly
        bulgeStrength={60}
        glowRadius={200}
        gradientFrom="rgba(255, 255, 255, 0.4)"
        gradientTo="rgba(170, 170, 170, 0.14)"
        glowColor="#262626"
      />
      <div className="o-rb-veil" />
      <div className="o-grain" />
    </div>
  );
}
