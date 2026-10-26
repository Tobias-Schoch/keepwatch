import DotField from "./rb/bg/DotField";

/**
 * Light behind the app (graphite): Dot Field (React Bits) – a dot grid that
 * moves out of the cursor's way.
 */
export function LightRays() {
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
