/**
 * Short, precise springs. One shared rAF loop drives all springs and sleeps
 * as soon as nothing is moving.
 */

export const prefersReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
}

export const SPRING = {
  /** Short and firm — indicators, dock. */
  snappy: { stiffness: 420, damping: 36 },
  /** Calm — numbers, large surfaces. */
  calm: { stiffness: 140, damping: 24 },
  /** With a hint of overshoot — lift/tilt. */
  lift: { stiffness: 260, damping: 20 },
} satisfies Record<string, SpringConfig>;

const active = new Set<Spring>();
let raf = 0;
let last = 0;

function tick(now: number) {
  const dt = Math.min(1 / 30, (now - last) / 1000 || 1 / 60);
  last = now;
  for (const s of active) s.step(dt);
  raf = active.size ? requestAnimationFrame(tick) : 0;
}

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  constructor(
    value: number,
    private config: SpringConfig,
    private onUpdate: (v: number) => void,
  ) {
    this.value = value;
    this.target = value;
  }
  set(target: number) {
    this.target = target;
    if (prefersReduced()) {
      this.jump(target);
      return;
    }
    if (!active.has(this)) {
      active.add(this);
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
  }
  jump(v: number) {
    this.value = this.target = v;
    this.velocity = 0;
    active.delete(this);
    this.onUpdate(v);
  }
  step(dt: number) {
    const { stiffness, damping, mass = 1 } = this.config;
    const steps = 4;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const force = -stiffness * (this.value - this.target) - damping * this.velocity;
      this.velocity += (force / mass) * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.velocity) < 0.001 && Math.abs(this.value - this.target) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      active.delete(this);
    }
    this.onUpdate(this.value);
  }
  stop() {
    active.delete(this);
  }
}

/** Ease-out for one-off counters. */
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
