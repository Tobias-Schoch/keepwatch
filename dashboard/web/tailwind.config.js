export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter Variable", "system-ui", "-apple-system", "sans-serif"],
        mono: [
          "ui-monospace",
          "SF Mono",
          "JetBrains Mono",
          "Menlo",
          "monospace",
        ],
      },
      backdropBlur: {
        "3xl": "64px",
      },
      colors: {
        glass: "rgba(255,255,255,0.04)",
        canvas: "#08080a",
        panel: "#0e0e11",
        raised: "#141418",
        line: "rgba(255,255,255,0.07)",
        brand: {
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
        },
      },
      boxShadow: {
        // Original-Design (designs/classic)
        glass: "0 4px 24px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
        "glass-lg": "0 20px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)",
        "glow-indigo":
          "0 0 0 1px rgba(99,102,241,0.15), 0 4px 24px rgba(99,102,241,0.30), 0 0 60px rgba(99,102,241,0.12)",
        "glow-sm-indigo": "0 4px 14px rgba(99,102,241,0.25)",
        pop: "0 24px 80px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)",
        sheet: "-24px 0 80px -12px rgba(0,0,0,0.8)",
        "brand-ring": "0 0 0 1px rgba(99,102,241,0.5), 0 0 0 4px rgba(99,102,241,0.15)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px) scale(0.985)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "sheet-in": {
          from: { opacity: "0.4", transform: "translateX(32px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "bar-in": {
          from: { opacity: "0", transform: "translate(-50%, 16px)" },
          to: { opacity: "1", transform: "translate(-50%, 0)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateY(12px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        progress: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(250%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "rise-in": "rise-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1)",
        "sheet-in": "sheet-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1)",
        "bar-in": "bar-in 240ms cubic-bezier(0.2, 0.9, 0.3, 1)",
        "toast-in": "toast-in 240ms cubic-bezier(0.2, 0.9, 0.3, 1)",
        progress: "progress 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
