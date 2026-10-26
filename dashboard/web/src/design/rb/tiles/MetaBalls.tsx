import { useEffect, useRef } from "react";
import { prefersReduced } from "../../motion";
import "./tiles.css";

/**
 * MetaBalls (after React Bits, without ogl): viscous drops of light that
 * attract, merge and stretch when pulled. One drop follows the cursor while it
 * is over the tile, otherwise it drifts along by itself.
 *
 * Drawn not as a fill but like black glass: a hint of fill, a bright outline
 * and fine contour lines around it. Colors come from the active Obsidian
 * variant (--o-accent, --o-hi).
 */

const MAX = 14;
const SLOTS = MAX + 1;
const VISIBLE = 0.877;

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uScale;
uniform vec4 uBalls[${SLOTS}];
uniform vec4 uShapes[${SLOTS}];
uniform int uCount;
uniform float uGamma;
uniform float uThreshold;
uniform vec3 uColor;
uniform vec3 uCursorColor;
uniform float uLine;
uniform float uSpacing;
uniform float uRings;
uniform float uFade;
out vec4 outColor;

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * uScale;
  float field = 0.0;
  float tint = 0.0;
  float mass = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < ${SLOTS}; i++) {
    if (i >= uCount) break;
    vec4 ball = uBalls[i];
    vec4 shape = uShapes[i];
    vec2 d = p - ball.xy;
    vec2 q = vec2(shape.x * d.x + shape.y * d.y, shape.y * d.x + shape.z * d.y);
    float qq = max(dot(q, q), ball.z * 1e-4 + 1e-12);
    float v = ball.z / qq;
    float w = pow(v, uGamma);
    field += w;
    float weight = w / (1.0 + w / uThreshold);
    mass += weight;
    tint += weight * ball.w;
    grad -= 2.0 * uGamma * w / qq * vec2(shape.x * q.x + shape.y * q.y, shape.y * q.x + shape.z * q.y);
  }
  float slope = max(length(grad) * uScale, 1e-8);
  float c = mass > 0.0 ? clamp(tint / mass, 0.0, 1.0) : 0.0;
  vec3 color = mix(uColor, uCursorColor, c);

  // Fill: just a hint, the shape lives from its outline and contour lines
  float solid = field > 3.0 * uThreshold ? 1.0 : clamp((field - uThreshold) / slope + 0.5, 0.0, 1.0);
  float fill = solid * 0.075;

  // Outline
  float rim = field > 3.0 * uThreshold ? 0.0 : clamp(0.5 * uLine + 0.5 - abs((field - uThreshold) / slope), 0.0, 1.0);

  // Contour lines outwards
  float rho = pow(max(field / uThreshold, 1e-6), -0.5 / uGamma);
  float rate = rho * slope / (2.0 * uGamma * max(field, 1e-8));
  float u = (rho - 1.0) / uSpacing;
  float ring = floor(u + 0.5);
  float gap = (u - ring) * uSpacing / max(rate, 1e-8);
  float rings = clamp(0.5 * uLine * 0.8 + 0.5 - abs(gap), 0.0, 1.0);
  rings *= ring < 0.5 || ring > uRings + 0.5 ? 0.0 : 1.0 - ring / (uRings + 1.0);
  if (ring > 0.5) rings *= smoothstep(uLine * 6.0, uLine * 12.0, uSpacing / max(rate, 1e-8));

  // Halo around the cursor drop
  float halo = solid < 0.5 ? exp(-max(rho - 1.0, 0.0) * 2.2) * 0.10 * c : 0.0;

  float a = clamp(fill + rim * 0.85 + rings * 0.32 + halo, 0.0, 1.0) * uFade;
  outColor = vec4(color * a, a);
}
`;

const fract = (x: number) => x - Math.floor(x);
const hash31 = (p: number) => {
  const r = [p * 0.1031, p * 0.103, p * 0.0973].map(fract);
  const dot = r[0] * (r[1] + 33.33) + r[1] * (r[2] + 33.33) + r[2] * (r[0] + 33.33);
  return r.map((v) => fract(v + dot));
};
const hash33 = (v: number[]) => {
  const p = [v[0] * 0.1031, v[1] * 0.103, v[2] * 0.0973].map(fract);
  const dot = p[0] * (p[1] + 33.33) + p[1] * (p[0] + 33.33) + p[2] * (p[2] + 33.33);
  const q = p.map((x) => fract(x + dot));
  return [fract((q[0] + q[1]) * q[2]), fract((q[0] + q[0]) * q[1]), fract((q[1] + q[0]) * q[0])];
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInOut = (t: number) => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
function toRgb(color: string, fallback: [number, number, number]): [number, number, number] {
  let hex = color.trim().replace("#", "");
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

interface Body {
  vx: number;
  vy: number;
  a: number;
  b: number;
  va: number;
  vb: number;
}

function createBall(index: number) {
  const h1 = hash31(index + 1);
  const h2 = hash33(h1);
  return {
    start: h1[0] * Math.PI * 2,
    rate: 0.1 * Math.PI + h1[1] * 0.3 * Math.PI,
    rise: 0.55 + h1[2] * 0.7,
    sway: h2[0] * Math.PI * 2,
    radius: 0.55 + h2[2] * 1.35,
    delay: 0.1 + fract(h1[2] * 7.31 + h2[1] * 3.17) * 0.55,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: 0,
    fy: 0,
    ax: 0,
    ay: 0,
    avx: 0,
    avy: 0,
    a: 0,
    b: 0,
    va: 0,
    vb: 0,
  };
}
type Ball = ReturnType<typeof createBall>;

// Fixed setting for the hero tile: calm, viscous, a little sticky.
const S = {
  speed: 0.22,
  size: 26,
  count: 9,
  clump: 0.95,
  cursor: 2.4,
  goo: 0.6,
  sticky: 0.55,
  stretch: 0.55,
  wobble: 0.45,
  line: 1.1,
  rings: 3,
  smooth: 0.08,
  /** Center of the swarm as a fraction of half the width/height (top right). */
  biasX: 0.5,
  biasY: 0.38,
  /** Drift range as a fraction of half the width/height. */
  rangeX: 0.38,
  rangeY: 0.42,
};

export function MetaBalls() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = host.current;
    if (!box) return;
    // A fresh canvas per run (StrictMode: a lost context would come back otherwise).
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) {
      canvas.remove();
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn("Obsidian-MetaBalls-Shader:", gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "position");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("Obsidian-MetaBalls-Shader:", gl.getProgramInfoLog(prog));
      canvas.remove();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const loc = {
      res: U("uResolution"),
      scale: U("uScale"),
      balls: U("uBalls"),
      shapes: U("uShapes"),
      count: U("uCount"),
      gamma: U("uGamma"),
      threshold: U("uThreshold"),
      color: U("uColor"),
      cursorColor: U("uCursorColor"),
      line: U("uLine"),
      spacing: U("uSpacing"),
      rings: U("uRings"),
      fade: U("uFade"),
    };

    const css = getComputedStyle(document.documentElement);
    const color = toRgb(css.getPropertyValue("--o-accent"), [0.64, 0.64, 1]);
    const cursorColor = toRgb(css.getPropertyValue("--o-hi"), [1, 1, 1]);

    const ballData = new Float32Array(SLOTS * 4);
    const shapeData = new Float32Array(SLOTS * 4);
    const balls = Array.from({ length: S.count }, (_, i) => createBall(i));
    const idle = createBall(MAX + 7);
    const cursor = { x: 0, y: 0, vx: 0, vy: 0, a: 0, b: 0, va: 0, vb: 0, ready: false };
    const pointer = { x: 0, y: 0, inside: false };
    const reduced = prefersReduced();
    const view = { w: 1, h: 1, ratio: 1 };
    let phase = reduced ? 3 : 0;
    let clock = 0;
    const introAt = reduced ? -1 : 0;
    let visible = true;
    let raf = 0;
    let last = 0;

    const goo = clamp(S.goo, 0, 1);
    const gamma = goo < 0.5 ? 1 + (0.5 - goo) * 1.2 : 1 - (goo - 0.5) * 0.5;
    const threshold = Math.pow(1.3, gamma);
    const reach = Math.pow(2, 0.5 / gamma);

    const resize = () => {
      const r = box.getBoundingClientRect();
      const ratio = Math.min(1.5, devicePixelRatio || 1);
      view.w = Math.max(1, r.width);
      view.h = Math.max(1, r.height);
      view.ratio = ratio;
      canvas.width = Math.max(1, Math.round(view.w * ratio));
      canvas.height = Math.max(1, Math.round(view.h * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const toWorld = (cx: number, cy: number) => {
      const r = box.getBoundingClientRect();
      const k = S.size / Math.max(1, r.height);
      return {
        x: (cx - r.left - r.width / 2) * k,
        y: (r.top + r.height / 2 - cy) * k,
        inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom,
      };
    };
    const presence = () => {
      if (introAt < 0) return { size: 1, time: Infinity };
      const t = clock - introAt;
      return { size: easeOut(t / 0.9), time: t };
    };
    const release = (ball: Ball, look: { time: number }) => (look.time === Infinity ? 1 : easeInOut((look.time - ball.delay) / 1.6));
    const anchor = (ball: Ball, spread: number): [number, number] => {
      const hw = (S.size * view.w) / view.h / 2;
      const hh = S.size / 2;
      const x = hw * S.biasX + Math.sin(phase * ball.rise * 0.9 + ball.start) * hw * S.rangeX * S.clump * spread;
      const y = hh * S.biasY + Math.sin(phase * ball.rate * 1.3 + ball.sway) * hh * S.rangeY * S.clump * spread;
      return [x, y];
    };
    const deform = (body: Body, h: number) => {
      const speed = Math.hypot(body.vx, body.vy);
      const amount = 0.6 * S.stretch * Math.tanh(speed / 14);
      let ta = 0;
      let tb = 0;
      if (speed > 1e-4) {
        ta = (amount * (body.vx * body.vx - body.vy * body.vy)) / (speed * speed);
        tb = (amount * 2 * body.vx * body.vy) / (speed * speed);
      }
      const omega = 13;
      const zeta = 0.85 - 0.68 * S.wobble;
      body.va += (omega * omega * (ta - body.a) - 2 * zeta * omega * body.va) * h;
      body.vb += (omega * omega * (tb - body.b) - 2 * zeta * omega * body.vb) * h;
      body.a += body.va * h;
      body.b += body.vb * h;
    };
    const step = (h: number, look: { size: number; time: number }) => {
      const pull = 36 * S.sticky;
      const cr = S.cursor * VISIBLE * look.size;
      phase += h * S.speed;
      for (const ball of balls) {
        const [x, y] = anchor(ball, release(ball, look));
        ball.avx = clamp((x - ball.ax) / h, -40, 40);
        ball.avy = clamp((y - ball.ay) / h, -40, 40);
        ball.ax = x;
        ball.ay = y;
        ball.fx = 20 * (x - ball.x) - 5.4 * (ball.vx - ball.avx);
        ball.fy = 20 * (y - ball.y) - 5.4 * (ball.vy - ball.avy);
      }
      for (let i = 0; i < balls.length; i++) {
        const p = balls[i];
        const rp = p.radius * VISIBLE * look.size;
        for (let j = i + 1; j < balls.length; j++) {
          const q = balls[j];
          const rq = q.radius * VISIBLE * look.size;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.hypot(dx, dy) || 1e-4;
          const far = (rp + rq) * reach;
          if (d >= far) continue;
          const core = (rp + rq) * 0.62;
          let force;
          if (d < core) force = -60 * (core - d);
          else {
            const t = (d - core) / (far - core);
            force = pull * Math.min(rp, rq) * smoothstep(0, 0.6, t) * (1 - smoothstep(0.82, 1, t));
          }
          const nx = dx / d;
          const ny = dy / d;
          const mp = rp * rp + 0.05;
          const mq = rq * rq + 0.05;
          p.fx += (nx * force) / mp;
          p.fy += (ny * force) / mp;
          q.fx -= (nx * force) / mq;
          q.fy -= (ny * force) / mq;
        }
        const dx = cursor.x - p.x;
        const dy = cursor.y - p.y;
        const d = Math.hypot(dx, dy) || 1e-4;
        const far = (rp + cr) * reach;
        if (d < far) {
          const core = (rp + cr) * 0.62;
          let force;
          if (d < core) force = -140 * (core - d);
          else {
            const t = (d - core) / (far - core);
            force = pull * 0.6 * rp * smoothstep(0, 0.6, t) * (1 - smoothstep(0.82, 1, t));
          }
          p.fx += ((dx / d) * force) / (rp * rp + 0.05);
          p.fy += ((dy / d) * force) / (rp * rp + 0.05);
        }
      }
      for (const ball of balls) {
        ball.vx += ball.fx * h;
        ball.vy += ball.fy * h;
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;
        deform(ball, h);
        if (!Number.isFinite(ball.x + ball.y + ball.vx + ball.vy + ball.a + ball.b + ball.va + ball.vb)) {
          Object.assign(ball, { x: ball.ax, y: ball.ay, vx: 0, vy: 0, a: 0, b: 0, va: 0, vb: 0 });
        }
      }
    };
    const moveCursor = (dt: number, look: { time: number }) => {
      let tx: number;
      let ty: number;
      if (pointer.inside) {
        tx = pointer.x;
        ty = pointer.y;
      } else {
        const out = look.time === Infinity ? 1 : easeInOut((look.time - 0.75) / 1.3);
        [tx, ty] = anchor(idle, out);
      }
      if (!cursor.ready) {
        cursor.x = tx;
        cursor.y = ty;
        cursor.ready = true;
      }
      const follow = 1 - Math.pow(1 - S.smooth, dt * 60);
      const nx = cursor.x + (tx - cursor.x) * follow;
      const ny = cursor.y + (ty - cursor.y) * follow;
      const blend = 1 - Math.exp(-dt / 0.05);
      cursor.vx += ((nx - cursor.x) / Math.max(dt, 1e-4) - cursor.vx) * blend;
      cursor.vy += ((ny - cursor.y) / Math.max(dt, 1e-4) - cursor.vy) * blend;
      cursor.x = nx;
      cursor.y = ny;
    };
    const shapeOf = (body: Body, out: Float32Array, o: number) => {
      const m = Math.hypot(body.a, body.b);
      const c = Math.cosh(m);
      const k = m > 1e-6 ? Math.sinh(m) / m : 1;
      out[o] = c - k * body.a;
      out[o + 1] = -k * body.b;
      out[o + 2] = c + k * body.a;
      out[o + 3] = 0;
    };
    const draw = () => {
      const look = presence();
      const n = balls.length;
      for (let i = 0; i < n; i++) {
        const b = balls[i];
        const r = b.radius * look.size;
        ballData[i * 4] = b.x;
        ballData[i * 4 + 1] = b.y;
        ballData[i * 4 + 2] = r * r;
        ballData[i * 4 + 3] = 0;
        shapeOf(b, shapeData, i * 4);
      }
      const cr = S.cursor * look.size;
      ballData[n * 4] = cursor.x;
      ballData[n * 4 + 1] = cursor.y;
      ballData[n * 4 + 2] = cr * cr;
      ballData[n * 4 + 3] = 1;
      shapeOf(cursor, shapeData, n * 4);
      gl.uniform2f(loc.res, canvas.width, canvas.height);
      gl.uniform1f(loc.scale, S.size / canvas.height);
      gl.uniform4fv(loc.balls, ballData);
      gl.uniform4fv(loc.shapes, shapeData);
      gl.uniform1i(loc.count, n + 1);
      gl.uniform1f(loc.gamma, gamma);
      gl.uniform1f(loc.threshold, threshold);
      gl.uniform3fv(loc.color, color);
      gl.uniform3fv(loc.cursorColor, cursorColor);
      gl.uniform1f(loc.line, S.line * view.ratio);
      gl.uniform1f(loc.spacing, 0.3);
      gl.uniform1f(loc.rings, S.rings);
      gl.uniform1f(loc.fade, 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const frame = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      if (dt > 1e-4) {
        clock += dt;
        const look = presence();
        moveCursor(dt, look);
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        for (let i = 0; i < steps; i++) step(dt / steps, look);
        deform(cursor, dt);
      }
      draw();
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf || !visible || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const p = toWorld(e.clientX, e.clientY);
      pointer.x = p.x;
      pointer.y = p.y;
      pointer.inside = p.inside;
      if (reduced) {
        // Without motion: only follow the cursor when it moves.
        clock += 1 / 60;
        moveCursor(1 / 60, presence());
        for (let i = 0; i < 4; i++) step(1 / 240, presence());
        draw();
      }
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());

    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw();
    });
    ro.observe(box);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
    });
    io.observe(box);
    addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVis);

    resize();
    if (reduced) {
      // Let it settle once, then stay still.
      for (let i = 0; i < 240; i++) step(1 / 120, presence());
      cursor.x = anchor(idle, 1)[0];
      cursor.y = anchor(idle, 1)[1];
      draw();
    } else start();
    const fadeIn = requestAnimationFrame(() => box.classList.add("is-on"));

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(fadeIn);
      ro.disconnect();
      io.disconnect();
      removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      box.classList.remove("is-on");
    };
  }, []);

  return <div ref={host} className="o-metaballs" aria-hidden />;
}
