import DotField from "./rb/bg/DotField";
import Waves from "./rb/bg/Waves";
import { useMode } from "./theme";

/**
 * Light behind the app, one React Bits background per mode:
 *   dark  – Dot Field, a dot grid that moves out of the cursor's way
 *   light – Waves, ink lines on paper the cursor drags through
 */
export function LightRays() {
  const mode = useMode();
  if (mode === "light")
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
