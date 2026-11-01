/**
 * FaultyTerminal — after React Bits (reactbits.dev, Backgrounds), without ogl.
 *
 * A wall of tiny glyphs on a CRT: a slow noise field decides which cells glow and how
 * bright, every cell flips its glyph now and then, the whole tube flickers a little and
 * bends at the edges. Around the cursor the field brightens and the glyphs churn.
 *
 * Phosphor: the original renders at full resolution every frame. Here the canvas runs at
 * a fraction of the CSS size (`resolution`, the pixels are upscaled crisp – that is the
 * look anyway) and at most `fps` frames per second; the glyphs are bit patterns from a
 * hash, no texture. Paused while the tab is hidden; with reduced motion one still frame.
 * Dropped: page-load dither, chromatic aberration (three times the work for a hint of
 * color fringe). Scanlines and vignette are CSS on top (.ph-crt).
 */

import { memo, useEffect, useRef } from "react";
import { prefersReduced } from "../../motion";
import "./bg.css";

interface FaultyTerminalProps {
  /** Glyph cell in CSS pixels (width, height). */
  cell?: [number, number];
  /** Canvas pixels per CSS pixel. */
  resolution?: number;
  fps?: number;
  /** Phosphor color as r, g, b (0…1). */
  tint?: [number, number, number];
  brightness?: number;
  /** 0 = flat glass, 0.2 = clearly bent tube. */
  curvature?: number;
  flicker?: number;
  mouseStrength?: number;
  className?: string;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCell;
uniform float uTime;
uniform vec3 uTint;
uniform float uBright;
uniform float uCurve;
uniform float uFlicker;
uniform vec3 uMouse; // xy in canvas pixels from the top left, z = strength 0…1
uniform float uIntro;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
uint uhash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 32768);
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

void main() {
  // Tube: bend the coordinates towards the edges.
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + uCurve * dot(c.yx, c.yx) * 0.5;
  if (abs(c.x) > 1.0 || abs(c.y) > 1.0) { outColor = vec4(0.0); return; }
  vec2 p = (c * 0.5 + 0.5) * uRes;
  p.y = uRes.y - p.y;

  vec2 cell = floor(p / uCell);
  vec2 local = fract(p / uCell);

  // Field: slow, drifting – which regions of the wall glow.
  float t = uTime;
  vec2 q = cell * vec2(0.055, 0.075);
  float field = fbm(q + vec2(t * 0.045, -t * 0.03) + fbm(q * 0.6 - t * 0.02) * 1.6);
  field = smoothstep(0.38, 0.82, field);

  // Cursor: brighter, faster churn.
  float md = length((p - uMouse.xy) / uRes.y);
  float near = uMouse.z * exp(-md * md * 18.0);
  field = clamp(field + near * 0.9, 0.0, 1.0);

  // Intro: the wall powers up from the middle.
  field *= smoothstep(0.0, 0.25, uIntro * 1.4 - length(c) * 0.55);

  // Glyph: 3 × 5 dots out of a hash; the cell flips at its own pace.
  float rate = 0.4 + hash(cell + 7.0) * 2.2 + near * 9.0;
  float tick = floor(t * rate + hash(cell) * 10.0);
  uint bits = uhash(cell * 1.31 + tick);
  vec2 g = (local - vec2(0.18, 0.14)) / vec2(0.64, 0.72);
  float on = 0.0;
  if (g.x >= 0.0 && g.x < 1.0 && g.y >= 0.0 && g.y < 1.0) {
    uint idx = uint(floor(g.x * 3.0)) + uint(floor(g.y * 5.0)) * 3u;
    on = float((bits >> idx) & 1u);
  }
  // Some cells stay dark entirely – reads more like text than noise.
  float blank = step(0.32 + field * 0.4, hash(cell * 0.73 + floor(t * 0.15 + hash(cell.yx))));
  float lum = on * (1.0 - blank) * (0.08 + field * 0.92);

  // Whole tube: flicker and a slow rolling bar.
  float flick = 1.0 - uFlicker * (0.5 + 0.5 * sin(t * 61.0)) * hash(vec2(floor(t * 24.0), 3.0));
  float band = fract(uv.y * 0.6 - t * 0.05) - 0.5;
  float roll = 1.0 + 0.14 * exp(-band * band * 180.0);

  float glow = lum * uBright * flick * roll;
  outColor = vec4(uTint * glow, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("FaultyTerminal:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function FaultyTerminal({
  cell = [11, 17],
  resolution = 0.75,
  fps = 30,
  tint = [0.42, 1, 0.58],
  brightness = 1,
  curvature = 0.16,
  flicker = 0.12,
  mouseStrength = 1,
  className,
}: FaultyTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const opts = useRef({ cell, resolution, fps, tint, brightness, curvature, flicker, mouseStrength });
  opts.current = { cell, resolution, fps, tint, brightness, curvature, flicker, mouseStrength };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "faulty-terminal-canvas";
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) {
      host.dataset.nogl = "";
      return;
    }
    host.appendChild(canvas);

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    if (!vs || !fs) {
      host.dataset.nogl = "";
      canvas.remove();
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const U = {
      res: u("uRes"), cell: u("uCell"), time: u("uTime"), tint: u("uTint"), bright: u("uBright"),
      curve: u("uCurve"), flicker: u("uFlicker"), mouse: u("uMouse"), intro: u("uIntro"),
    };

    let scale = 1;
    const fit = () => {
      const o = opts.current;
      scale = Math.max(0.25, o.resolution);
      const w = Math.max(1, Math.round(host.clientWidth * scale));
      const h = Math.max(1, Math.round(host.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    // Cursor: trails a little, strength rises with movement and fades when still.
    const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, s: 0, ts: 0 };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = host.getBoundingClientRect();
      mouse.tx = e.clientX - r.left;
      mouse.ty = e.clientY - r.top;
      if (mouse.x < -9e3) {
        mouse.x = mouse.tx;
        mouse.y = mouse.ty;
      }
      mouse.ts = 1;
      wake();
    };
    const onLeave = () => (mouse.ts = 0);

    const reduced = prefersReduced();
    const start = performance.now();
    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      const o = opts.current;
      if (!reduced && now - last < 1000 / o.fps - 2) {
        raf = requestAnimationFrame(frame);
        return;
      }
      last = now;
      fit();
      const t = reduced ? 42 : (now - start) / 1000;
      mouse.x += (mouse.tx - mouse.x) * 0.18;
      mouse.y += (mouse.ty - mouse.y) * 0.18;
      mouse.s += (mouse.ts * o.mouseStrength - mouse.s) * 0.08;
      mouse.ts *= 0.985;
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform2f(U.cell, o.cell[0] * scale, o.cell[1] * scale);
      gl.uniform1f(U.time, t);
      gl.uniform3f(U.tint, o.tint[0], o.tint[1], o.tint[2]);
      gl.uniform1f(U.bright, o.brightness);
      gl.uniform1f(U.curve, o.curvature);
      gl.uniform1f(U.flicker, reduced ? 0 : o.flicker);
      gl.uniform3f(U.mouse, mouse.x * scale, mouse.y * scale, reduced ? 0 : mouse.s);
      gl.uniform1f(U.intro, reduced ? 1 : Math.min(1, (now - start) / 1600));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduced && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const onVis = () => (document.hidden ? (cancelAnimationFrame(raf), (raf = 0)) : wake());
    const ro = new ResizeObserver(() => wake());
    ro.observe(host);

    addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVis);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    };
  }, []);

  return <div ref={hostRef} className={className ? `faulty-terminal ${className}` : "faulty-terminal"} />;
}

export default memo(FaultyTerminal);
