/**
 * DotField — after React Bits (reactbits.dev, src/ts-default), no dependencies.
 *
 * Obsidian: the original draws every dot each frame (well over 10,000 circles
 * on Retina) as one Canvas 2D path — that practically froze the page while the
 * mouse moved. Here the dots live once as a buffer on the GPU and the vertex
 * shader computes the evasion; per frame only cursor, strength and glow go over
 * as uniforms.
 *
 * Second stage: the field sits still on one large canvas. When the cursor moves,
 * only a small canvas around it (side length 2 × cursorRadius) redraws the
 * evading patch and covers the still field there — outside the radius no dot
 * moves, so the edges match pixel-perfectly. Instead of the whole window (~7.7
 * million pixels on Retina) only this patch is redrawn and composited per frame;
 * the blur layers above are only recomputed there.
 *
 * Unchanged: grid, gradient along the diagonal, the bulge around the cursor that
 * only appears on movement and fades again, glow under the cursor. Dropped
 * (unused in Obsidian): repel mode (bulgeOnly=false), sparkle and waveAmplitude.
 * A smoothly trailing cursor replaces the per-dot easing.
 */

import { memo, useEffect, useRef } from 'react';

import './bg.css';

interface DotFieldProps {
  dotRadius?: number;
  dotSpacing?: number;
  cursorRadius?: number;
  bulgeOnly?: boolean;
  bulgeStrength?: number;
  glowRadius?: number;
  gradientFrom?: string;
  gradientTo?: string;
  glowColor?: string;
}

const VERT = `
attribute vec2 aPos;
uniform vec2 uSize;
uniform vec2 uOrigin;
uniform vec2 uView;
uniform vec2 uMouse;
uniform float uEng;
uniform float uCursor;
uniform float uBulge;
uniform float uPoint;
uniform vec4 uFrom;
uniform vec4 uTo;
varying vec4 vCol;
varying float vPoint;
void main(){
  vec2 p = aPos;
  vec2 d = uMouse - aPos;
  float dist = length(d);
  if (uEng > 0.01 && dist < uCursor && dist > 0.0001) {
    float t = 1.0 - dist / uCursor;
    p -= d / dist * (t * t * uBulge * uEng);
  }
  float g = clamp(dot(p, uSize) / dot(uSize, uSize), 0.0, 1.0);
  vCol = mix(uFrom, uTo, g);
  gl_Position = vec4((p - uOrigin) / uView * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  gl_PointSize = uPoint;
  vPoint = uPoint;
}
`;

const FRAG = `
precision mediump float;
varying vec4 vCol;
varying float vPoint;
void main(){
  float r = length(gl_PointCoord - 0.5) * vPoint;
  float a = clamp(vPoint * 0.5 - r + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(vCol.rgb * vCol.a * a, vCol.a * a);
}
`;

/** Any CSS color → [r, g, b, a] in 0…1. */
function rgba(color: string): [number, number, number, number] {
  // Read rgb()/rgba() directly: going through a pixel lost color steps at low alpha.
  const m = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [1, 1, 1, 0.3];
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('DotField:', gl.getShaderInfoLog(s));
  return s;
}

const DotField = memo(({
  dotRadius = 1.5,
  dotSpacing = 14,
  cursorRadius = 500,
  bulgeOnly = true,
  bulgeStrength = 67,
  glowRadius = 160,
  gradientFrom = 'rgba(168, 85, 247, 0.35)',
  gradientTo = 'rgba(180, 151, 207, 0.25)',
  glowColor = '#120F17',
}: DotFieldProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const local = localRef.current;
    const glowEl = glowRef.current;
    if (!canvas || !local) return;

    // Background color under the field: the small canvas uses it to cover the still field.
    let bg: [number, number, number] = [0, 0, 0];
    for (let el: HTMLElement | null = canvas.parentElement; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      const v = rgba(c);
      if (v[3] > 0.99) {
        bg = [v[0], v[1], v[2]];
        break;
      }
    }

    /** A canvas with its own WebGL context and the same program. */
    function renderer(cv: HTMLCanvasElement, opaque: boolean) {
      const gl = cv.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: 'low-power' });
      if (!gl) return null;
      const prog = gl.createProgram()!;
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.warn('DotField:', gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (opaque) gl.clearColor(bg[0], bg[1], bg[2], 1);
      else gl.clearColor(0, 0, 0, 0);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      const u = (n: string) => gl.getUniformLocation(prog, n);
      const loc = { size: u('uSize'), origin: u('uOrigin'), view: u('uView'), mouse: u('uMouse'), eng: u('uEng'), point: u('uPoint') };
      gl.uniform1f(u('uCursor'), cursorRadius);
      gl.uniform1f(u('uBulge'), bulgeOnly ? bulgeStrength : 0);
      gl.uniform4fv(u('uFrom'), rgba(gradientFrom));
      gl.uniform4fv(u('uTo'), rgba(gradientTo));
      let count = 0;
      return {
        /** Size the canvas to w × h CSS px and upload the dots. */
        setup(pos: Float32Array, n: number, fw: number, fh: number, w: number, h: number, dpr: number) {
          cv.width = Math.max(1, Math.round(w * dpr));
          cv.height = Math.max(1, Math.round(h * dpr));
          gl.viewport(0, 0, cv.width, cv.height);
          gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
          count = n;
          gl.uniform2f(loc.size, fw, fh);
          gl.uniform2f(loc.view, w, h);
          // Diameter in the original: dotRadius (the circle has radius dotRadius / 2).
          gl.uniform1f(loc.point, dotRadius * dpr);
        },
        draw(ox: number, oy: number, mx: number, my: number, eng: number) {
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.uniform2f(loc.origin, ox, oy);
          gl.uniform2f(loc.mouse, mx, my);
          gl.uniform1f(loc.eng, eng);
          gl.drawArrays(gl.POINTS, 0, count);
        },
        dispose() {
          gl.deleteBuffer(buf);
          gl.deleteProgram(prog);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
        },
      };
    }

    const field = renderer(canvas, false);
    const near = renderer(local, true);
    if (!field || !near) return;

    // Side length of the small canvas: evasion radius plus a dot and some air.
    const half = Math.ceil(cursorRadius + dotRadius + 4);
    const side = half * 2;
    let w = 0;
    let h = 0;
    let ratio = 1;

    function build() {
      const rect = canvas!.parentElement!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ratio = dpr;
      const step = dotRadius + dotSpacing;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      const pos = new Float32Array(rows * cols * 2);
      let i = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          pos[i++] = padX + col * step + step / 2;
          pos[i++] = padY + row * step + step / 2;
        }
      }
      field!.setup(pos, rows * cols, w, h, w, h, dpr);
      near!.setup(pos, rows * cols, w, h, side, side, dpr);
      field!.draw(0, 0, -9999, -9999, 0);
    }

    // Cursor relative to the canvas (the field is fixed behind the page).
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const m = { x: -9999, y: -9999, sx: -9999, sy: -9999, px: -9999, py: -9999, speed: 0 };
    let eng = 0;
    let glow = 0;
    let raf = 0;
    let last = 0;
    let shown = false;
    let lastT = '';

    /** Draw and show the small canvas around the (smoothed) cursor — or hide it. */
    function drawNear() {
      if (eng <= 0) {
        if (shown) {
          local!.style.visibility = 'hidden';
          shown = false;
        }
        return;
      }
      // Rounded to whole device pixels: so the dots on both canvases line up pixel-perfectly.
      const ox = Math.round((m.sx - half) * ratio) / ratio;
      const oy = Math.round((m.sy - half) * ratio) / ratio;
      near!.draw(ox, oy, m.sx, m.sy, eng);
      const t = `translate3d(${ox}px, ${oy}px, 0)`;
      if (t !== lastT) {
        local!.style.transform = t;
        lastT = t;
      }
      if (!shown) {
        local!.style.visibility = 'visible';
        shown = true;
      }
    }

    // Only compute while something moves, and at most 60 times per second
    // (the decay rates are per frame).
    function tick(now: number) {
      raf = 0;
      if (now - last < 1000 / 60 - 2) {
        raf = requestAnimationFrame(tick);
        return;
      }
      last = now;

      const dx = m.x - m.px;
      const dy = m.y - m.py;
      m.px = m.x;
      m.py = m.y;
      m.speed += (Math.sqrt(dx * dx + dy * dy) - m.speed) * 0.5;
      if (m.speed < 0.001) m.speed = 0;

      eng += (Math.min(m.speed / 5, 1) - eng) * 0.06;
      if (eng < 0.001) eng = 0;
      glow += (eng - glow) * 0.08;
      if (glow < 0.001) glow = 0;

      const jump = m.sx < -9000;
      m.sx = jump ? m.x : m.sx + (m.x - m.sx) * 0.2;
      m.sy = jump ? m.y : m.sy + (m.y - m.sy) * 0.2;

      if (glowEl) {
        glowEl.style.transform = `translate3d(${m.sx}px, ${m.sy}px, 0)`;
        glowEl.style.opacity = glow.toFixed(3);
      }

      drawNear();
      if (m.speed > 0 || eng > 0 || glow > 0) raf = requestAnimationFrame(tick);
    }

    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
    }

    function onMouseMove(e: MouseEvent) {
      if (reduce) return;
      const r = canvas!.getBoundingClientRect();
      m.x = e.clientX - r.left;
      m.y = e.clientY - r.top;
      if (m.px < -9000) {
        m.px = m.x;
        m.py = m.y;
      }
      wake();
    }

    let resizeTimer: ReturnType<typeof setTimeout>;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        build();
        drawNear();
      }, 100);
    }

    function onVisibility() {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (eng > 0 || glow > 0) {
        wake();
      }
    }

    local.style.visibility = 'hidden';
    build();
    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('visibilitychange', onVisibility);
      field.dispose();
      near.dispose();
    };
  }, [dotRadius, dotSpacing, cursorRadius, bulgeOnly, bulgeStrength, gradientFrom, gradientTo]);

  return (
    <div className="dot-field-container">
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <canvas
        ref={localRef}
        className="dot-field-near"
        style={{ position: 'absolute', left: 0, top: 0, width: 2 * Math.ceil(cursorRadius + dotRadius + 4), height: 2 * Math.ceil(cursorRadius + dotRadius + 4) }}
      />
      <div
        ref={glowRef}
        className="dot-field-glow"
        style={{
          width: glowRadius * 2,
          height: glowRadius * 2,
          margin: -glowRadius,
          background: `radial-gradient(closest-side, ${glowColor}, transparent)`,
        }}
      />
    </div>
  );
});

DotField.displayName = 'DotField';

export default DotField;
