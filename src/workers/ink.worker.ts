/// <reference lib="webworker" />
import type { PaperTheme, StrokePoint, VectorStroke } from '../types';
import { drawVectorStroke, resolveStrokeColor } from '../engine/canvasRenderer';
import { strokeHalfWidth } from '../engine/inkMath';

/**
 * 120 Hz Dedicated OffscreenCanvas InkRenderWorker (WebGL2 Zero-Copy IOSurface Engine).
 *
 * WHY WEBGL2 + INCREMENTAL VBO + MICROTASK COALESCING IS CRITICAL ON iPAD PRO SAFARI:
 * 1. In WebKit (`PlaceholderRenderingContext.cpp` / `GraphicsLayerCARemote.mm`), a `2d`
 *    OffscreenCanvas invokes `tryCopyToLayer()` -> `buffer.clone()`, copying ~16 MB of
 *    Retina pixels on every commit. A `webgl2` OffscreenCanvas renders on the Apple M-series
 *    GPU in `GPUProcess` and hands a 32-byte `IOSurface` `MachSendRight` zero-copy to `UIProcess`!
 * 2. Never call `self.requestAnimationFrame()` inside a WebKit Worker (`WorkerAnimationController.cpp`
 *    hardcodes worker rAF to a 60 Hz 16.67 ms timer). Instead, coalesce same-turn `MessagePort`
 *    packets via `queueMicrotask` and draw immediately so swapchain queue depth stays at 0!
 * 3. `wet-append` streams ONLY newly arrived 240 Hz delta points + 3 kinematic-predicted tip
 *    points, uploading <1 KB per frame via `gl.bufferSubData` (O(1) regardless of stroke length).
 */

export type InkWorkerMessage =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'resize';
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'wet-start';
      tool: 'pen' | 'highlighter';
      color: string;
      width: number;
      paperTheme: PaperTheme;
      offsetX: number;
      offsetY: number;
      zoom: number;
      point: StrokePoint;
    }
  | {
      type: 'wet-append';
      offsetX: number;
      offsetY: number;
      zoom: number;
      newPoints: StrokePoint[];
      predicted: StrokePoint[];
    }
  | {
      type: 'wet-replace';
      tool: 'pen' | 'highlighter';
      color: string;
      width: number;
      paperTheme: PaperTheme;
      offsetX: number;
      offsetY: number;
      zoom: number;
      points: StrokePoint[];
      snapBadge?: string;
    }
  | {
      type: 'lasso-overlay';
      offsetX: number;
      offsetY: number;
      zoom: number;
      paperTheme: PaperTheme;
      polygon: Array<{ x: number; y: number }>;
      liftedStrokes: VectorStroke[];
      dx: number;
      dy: number;
      scale: number;
      centerX: number;
      centerY: number;
    }
  | {
      type: 'replay-frame';
      offsetX: number;
      offsetY: number;
      zoom: number;
      paperTheme: PaperTheme;
      activeStrokes: Array<{ stroke: VectorStroke; elapsedDtMs: number }>;
    }
  | { type: 'clear' };

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform float u_zoom;
void main() {
  vec2 screenPx = u_offset + a_pos * u_zoom;
  vec2 clip = (screenPx / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color.rgb * u_color.a, u_color.a);
}
`;

const MAX_FLOATS = 524_288; // 262k vertices (~2 MB pre-allocated VBO)
const CAP_SEGMENTS = 8;

const UNIT_CIRCLE: Array<{ c: number; s: number }> = Array.from(
  { length: CAP_SEGMENTS + 1 },
  (_, i) => {
    const a = (i / CAP_SEGMENTS) * Math.PI * 2;
    return { c: Math.cos(a), s: Math.sin(a) };
  }
);

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;

let program: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let vbo: WebGLBuffer | null = null;
let uResLoc: WebGLUniformLocation | null = null;
let uOffLoc: WebGLUniformLocation | null = null;
let uZoomLoc: WebGLUniformLocation | null = null;
let uColLoc: WebGLUniformLocation | null = null;

let cssWidth = 1;
let cssHeight = 1;
let dpr = 1;

// Incremental Wet Stroke State
const vertexSlab = new Float32Array(MAX_FLOATS);
const predictedSlab = new Float32Array(4096);
let committedFloats = 0;
let uploadedFloats = 0;
let predictedFloats = 0;

let wetActive = false;
let wetTool: 'pen' | 'highlighter' = 'pen';
let wetBaseWidth = 2.8;
let wetColorHex = '#18181b';
let wetPaperTheme: PaperTheme = 'cream';
let wetRgba: [number, number, number, number] = [0.1, 0.1, 0.1, 1.0];
let wetOffsetX = 0;
let wetOffsetY = 0;
let wetZoom = 1;
let committedPts: StrokePoint[] = [];
let currentPredictedPts: StrokePoint[] = [];
let flushScheduled = false;

const presentTimestamps: number[] = [];

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const n = parseInt(full, 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function computeWetRgba(
  color: string,
  paperTheme: PaperTheme,
  tool: 'pen' | 'highlighter'
): [number, number, number, number] {
  const resolved = resolveStrokeColor(color, paperTheme, tool);
  const [r, g, b] = parseHexRgb(resolved);
  const alpha = tool === 'highlighter' ? (paperTheme === 'dark' ? 0.28 : 0.36) : 1.0;
  return [r, g, b, alpha];
}

function emitDisk(
  target: Float32Array,
  cursor: number,
  cx: number,
  cy: number,
  radius: number
): number {
  if (cursor + CAP_SEGMENTS * 6 >= target.length) return cursor;
  for (let i = 0; i < CAP_SEGMENTS; i++) {
    const u0 = UNIT_CIRCLE[i];
    const u1 = UNIT_CIRCLE[i + 1];
    target[cursor++] = cx;
    target[cursor++] = cy;
    target[cursor++] = cx + u0.c * radius;
    target[cursor++] = cy + u0.s * radius;
    target[cursor++] = cx + u1.c * radius;
    target[cursor++] = cy + u1.s * radius;
  }
  return cursor;
}

function emitCapsule(
  target: Float32Array,
  cursor: number,
  ax: number,
  ay: number,
  ra: number,
  bx: number,
  by: number,
  rb: number
): number {
  if (cursor + 12 + CAP_SEGMENTS * 6 >= target.length) return cursor;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) {
    return emitDisk(target, cursor, bx, by, rb);
  }
  const nx = -dy / len;
  const ny = dx / len;

  const axL = ax + nx * ra;
  const ayL = ay + ny * ra;
  const axR = ax - nx * ra;
  const ayR = ay - ny * ra;
  const bxL = bx + nx * rb;
  const byL = by + ny * rb;
  const bxR = bx - nx * rb;
  const byR = by - ny * rb;

  // Triangle 1
  target[cursor++] = axL;
  target[cursor++] = ayL;
  target[cursor++] = axR;
  target[cursor++] = ayR;
  target[cursor++] = bxL;
  target[cursor++] = byL;

  // Triangle 2
  target[cursor++] = axR;
  target[cursor++] = ayR;
  target[cursor++] = bxR;
  target[cursor++] = byR;
  target[cursor++] = bxL;
  target[cursor++] = byL;

  // Round join / endcap disk at B
  return emitDisk(target, cursor, bx, by, rb);
}

/**
 * Appends smooth Catmull-Rom subdivided capsules for a newly arrived committed point `pNew`.
 */
function appendCommittedPoint(pNew: StrokePoint): void {
  const isHl = wetTool === 'highlighter';
  const rNew = Math.max(0.45, strokeHalfWidth(wetBaseWidth, pNew.pressure, isHl));
  const n = committedPts.length;

  if (n === 0) {
    committedPts.push(pNew);
    committedFloats = emitDisk(vertexSlab, committedFloats, pNew.x, pNew.y, rNew);
    return;
  }

  const pPrev = committedPts[n - 1];
  const rPrev = Math.max(0.45, strokeHalfWidth(wetBaseWidth, pPrev.pressure, isHl));
  const segDist = Math.hypot(pNew.x - pPrev.x, pNew.y - pPrev.y);

  // Subdivide fast movements via local Catmull-Rom so curves stay silky without lag
  if (n >= 2 && segDist > 3.2) {
    const p0 = committedPts[Math.max(0, n - 3)];
    const p1 = committedPts[n - 2];
    const p2 = pPrev;
    const p3 = pNew;
    // Smoothly subdivide p2 -> p3 using tangent continuity from p1
    const steps = Math.min(4, Math.ceil(segDist / 2.5));
    let lastX = p2.x;
    let lastY = p2.y;
    let lastR = rPrev;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom with virtual p4 extrapolated along (p3 - p2)
      const p4x = p3.x + (p3.x - p2.x);
      const p4y = p3.y + (p3.y - p2.y);
      void p0;
      const x =
        0.5 *
        (2 * p2.x +
          (-p1.x + p3.x) * t +
          (2 * p1.x - 5 * p2.x + 4 * p3.x - p4x) * t2 +
          (-p1.x + 3 * p2.x - 3 * p3.x + p4x) * t3);
      const y =
        0.5 *
        (2 * p2.y +
          (-p1.y + p3.y) * t +
          (2 * p1.y - 5 * p2.y + 4 * p3.y - p4y) * t2 +
          (-p1.y + 3 * p2.y - 3 * p3.y + p4y) * t3);
      const r = rPrev + (rNew - rPrev) * t;
      committedFloats = emitCapsule(vertexSlab, committedFloats, lastX, lastY, lastR, x, y, r);
      lastX = x;
      lastY = y;
      lastR = r;
    }
  } else {
    committedFloats = emitCapsule(
      vertexSlab,
      committedFloats,
      pPrev.x,
      pPrev.y,
      rPrev,
      pNew.x,
      pNew.y,
      rNew
    );
  }

  committedPts.push(pNew);
}

function buildPredictedTip(predicted: StrokePoint[]): void {
  predictedFloats = 0;
  if (predicted.length === 0 || committedPts.length === 0) return;
  const isHl = wetTool === 'highlighter';
  let prev = committedPts[committedPts.length - 1];
  let prevR = Math.max(0.45, strokeHalfWidth(wetBaseWidth, prev.pressure, isHl));

  for (let i = 0; i < predicted.length; i++) {
    const cur = predicted[i];
    const curR = Math.max(0.35, strokeHalfWidth(wetBaseWidth, cur.pressure, isHl));
    predictedFloats = emitCapsule(
      predictedSlab,
      predictedFloats,
      prev.x,
      prev.y,
      prevR,
      cur.x,
      cur.y,
      curR
    );
    prev = cur;
    prevR = curR;
  }
}

function compileShader(context: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = context.createShader(type);
  if (!sh) return null;
  context.shaderSource(sh, src);
  context.compileShader(sh);
  if (!context.getShaderParameter(sh, context.COMPILE_STATUS)) {
    context.deleteShader(sh);
    return null;
  }
  return sh;
}

function initWebGL2(offscreen: OffscreenCanvas): boolean {
  const context = offscreen.getContext('webgl2', {
    alpha: true,
    antialias: true,
    desynchronized: true,
    powerPreference: 'high-performance',
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;

  if (!context) return false;

  const vs = compileShader(context, context.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(context, context.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return false;

  const prog = context.createProgram();
  if (!prog) return false;
  context.attachShader(prog, vs);
  context.attachShader(prog, fs);
  context.linkProgram(prog);
  if (!context.getProgramParameter(prog, context.LINK_STATUS)) return false;

  gl = context;
  program = prog;
  uResLoc = context.getUniformLocation(prog, 'u_resolution');
  uOffLoc = context.getUniformLocation(prog, 'u_offset');
  uZoomLoc = context.getUniformLocation(prog, 'u_zoom');
  uColLoc = context.getUniformLocation(prog, 'u_color');

  vao = context.createVertexArray();
  vbo = context.createBuffer();
  context.bindVertexArray(vao);
  context.bindBuffer(context.ARRAY_BUFFER, vbo);
  context.bufferData(context.ARRAY_BUFFER, vertexSlab.byteLength, context.DYNAMIC_DRAW);

  const posLoc = context.getAttribLocation(prog, 'a_pos');
  context.enableVertexAttribArray(posLoc);
  context.vertexAttribPointer(posLoc, 2, context.FLOAT, false, 0, 0);

  return true;
}

function resizeBackingStore(w: number, h: number, nextDpr: number): void {
  cssWidth = Math.max(1, w);
  cssHeight = Math.max(1, h);
  dpr = Math.max(1, nextDpr);
  if (!canvas) return;
  const pxW = Math.max(1, Math.round(cssWidth * dpr));
  const pxH = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
}

function recordPresent(startAt: number): void {
  const now = performance.now();
  presentTimestamps.push(now);
  while (presentTimestamps.length > 0 && now - presentTimestamps[0] > 1000) {
    presentTimestamps.shift();
  }
  const latencyMs = Math.max(0.05, now - startAt);
  if (presentTimestamps.length % 12 === 1) {
    self.postMessage({
      type: 'telemetry',
      fps: presentTimestamps.length,
      renderMs: Number(latencyMs.toFixed(2)),
    });
  }
}

function flushWetStroke(): void {
  flushScheduled = false;
  if (!wetActive || !canvas) return;
  const t0 = performance.now();

  if (gl && program && vao && vbo) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    // Upload ONLY newly committed delta vertices (O(1) per pointermove!)
    if (committedFloats > uploadedFloats) {
      const deltaView = vertexSlab.subarray(uploadedFloats, committedFloats);
      gl.bufferSubData(gl.ARRAY_BUFFER, uploadedFloats * 4, deltaView);
      uploadedFloats = committedFloats;
    }

    // Upload transient predicted tip vertices right after committedFloats
    buildPredictedTip(currentPredictedPts);
    const totalFloats = Math.min(MAX_FLOATS, committedFloats + predictedFloats);
    if (predictedFloats > 0 && committedFloats + predictedFloats <= MAX_FLOATS) {
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        committedFloats * 4,
        predictedSlab.subarray(0, predictedFloats)
      );
    }

    gl.uniform2f(uResLoc, cssWidth, cssHeight);
    gl.uniform2f(uOffLoc, wetOffsetX, wetOffsetY);
    gl.uniform1f(uZoomLoc, wetZoom);
    gl.uniform4f(uColLoc, wetRgba[0], wetRgba[1], wetRgba[2], wetRgba[3]);

    if (wetTool === 'highlighter') {
      // Single-layer non-darkening wet highlighter: MAX blending keeps flat alpha across self-overlaps!
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }

    const vertexCount = Math.floor(totalFloats / 2);
    if (vertexCount > 0) {
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    }
    gl.flush();
    recordPresent(t0);
    return;
  }

  if (ctx2d) {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.save();
    ctx2d.scale(dpr, dpr);
    ctx2d.translate(wetOffsetX, wetOffsetY);
    ctx2d.scale(wetZoom, wetZoom);
    const combined =
      currentPredictedPts.length > 0
        ? [...committedPts, ...currentPredictedPts]
        : committedPts;
    drawVectorStroke(
      ctx2d,
      { tool: wetTool, color: wetColorHex, width: wetBaseWidth, points: combined },
      wetPaperTheme
    );
    ctx2d.restore();
    recordPresent(t0);
  }
}

function scheduleWetFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushWetStroke);
}

function clearCanvasSurface(): void {
  wetActive = false;
  committedPts = [];
  currentPredictedPts = [];
  committedFloats = 0;
  uploadedFloats = 0;
  predictedFloats = 0;
  if (!canvas) return;
  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.flush();
  } else if (ctx2d) {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/**
 * Draws transient multi-stroke scenes (Lasso drag & 120 FPS Audio Replay) using WebGL2 capsules
 * or 2D fallback.
 */
function drawTransientStrokes(
  strokes: Array<{ stroke: VectorStroke; maxDtMs?: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
  paperTheme: PaperTheme,
  transform?: { dx: number; dy: number; scale: number; cx: number; cy: number }
): void {
  if (!canvas) return;
  const t0 = performance.now();

  if (gl && program && vao && vbo) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.uniform2f(uResLoc, cssWidth, cssHeight);
    gl.uniform2f(uOffLoc, offsetX, offsetY);
    gl.uniform1f(uZoomLoc, zoom);

    for (const item of strokes) {
      const s = item.stroke;
      const pts =
        item.maxDtMs !== undefined ? s.points.filter((p) => p.dtMs <= item.maxDtMs!) : s.points;
      if (pts.length === 0) continue;

      const isHl = s.tool === 'highlighter';
      const scale = transform?.scale ?? 1;
      let cursor = 0;

      const tx = (p: StrokePoint) =>
        transform ? transform.cx + (p.x - transform.cx) * scale + transform.dx : p.x;
      const ty = (p: StrokePoint) =>
        transform ? transform.cy + (p.y - transform.cy) * scale + transform.dy : p.y;

      const r0 = Math.max(0.45, strokeHalfWidth(s.width * scale, pts[0].pressure, isHl));
      cursor = emitDisk(vertexSlab, cursor, tx(pts[0]), ty(pts[0]), r0);

      for (let i = 1; i < pts.length; i++) {
        const ra = Math.max(0.45, strokeHalfWidth(s.width * scale, pts[i - 1].pressure, isHl));
        const rb = Math.max(0.45, strokeHalfWidth(s.width * scale, pts[i].pressure, isHl));
        cursor = emitCapsule(
          vertexSlab,
          cursor,
          tx(pts[i - 1]),
          ty(pts[i - 1]),
          ra,
          tx(pts[i]),
          ty(pts[i]),
          rb
        );
      }

      if (cursor === 0) continue;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexSlab.subarray(0, cursor));
      const rgba = computeWetRgba(s.color, paperTheme, s.tool);
      gl.uniform4f(uColLoc, rgba[0], rgba[1], rgba[2], rgba[3]);

      if (isHl) {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLES, 0, Math.floor(cursor / 2));
    }
    gl.flush();
    uploadedFloats = 0;
    recordPresent(t0);
    return;
  }

  if (ctx2d) {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.save();
    ctx2d.scale(dpr, dpr);
    ctx2d.translate(offsetX, offsetY);
    ctx2d.scale(zoom, zoom);
    if (transform) {
      ctx2d.translate(transform.cx + transform.dx, transform.cy + transform.dy);
      ctx2d.scale(transform.scale, transform.scale);
      ctx2d.translate(-transform.cx, -transform.cy);
    }
    for (const item of strokes) {
      drawVectorStroke(ctx2d, item.stroke, paperTheme, { maxDtMs: item.maxDtMs });
    }
    ctx2d.restore();
    recordPresent(t0);
  }
}

self.onmessage = (event: MessageEvent<InkWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    canvas = msg.canvas;
    const ok = initWebGL2(canvas);
    if (!ok) {
      ctx2d = canvas.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings);
    }
    resizeBackingStore(msg.width, msg.height, msg.dpr);
    self.postMessage({ type: 'ready', backend: ok ? 'webgl2' : '2d-offscreen' });
    return;
  }

  if (msg.type === 'resize') {
    resizeBackingStore(msg.width, msg.height, msg.dpr);
    return;
  }

  if (msg.type === 'clear') {
    clearCanvasSurface();
    return;
  }

  if (msg.type === 'wet-start') {
    wetActive = true;
    wetTool = msg.tool;
    wetColorHex = msg.color;
    wetBaseWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetRgba = computeWetRgba(msg.color, msg.paperTheme, msg.tool);
    wetOffsetX = msg.offsetX;
    wetOffsetY = msg.offsetY;
    wetZoom = msg.zoom;
    committedPts = [];
    currentPredictedPts = [];
    committedFloats = 0;
    uploadedFloats = 0;
    predictedFloats = 0;

    appendCommittedPoint(msg.point);
    // Flush initial touch point synchronously for instant 0-frame pen-down dot!
    flushWetStroke();
    return;
  }

  if (msg.type === 'wet-append') {
    if (!wetActive) return;
    wetOffsetX = msg.offsetX;
    wetOffsetY = msg.offsetY;
    wetZoom = msg.zoom;
    for (let i = 0; i < msg.newPoints.length; i++) {
      appendCommittedPoint(msg.newPoints[i]);
    }
    currentPredictedPts = msg.predicted;
    scheduleWetFlush();
    return;
  }

  if (msg.type === 'wet-replace') {
    wetActive = true;
    wetTool = msg.tool;
    wetColorHex = msg.color;
    wetBaseWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetRgba = computeWetRgba(msg.color, msg.paperTheme, msg.tool);
    wetOffsetX = msg.offsetX;
    wetOffsetY = msg.offsetY;
    wetZoom = msg.zoom;
    committedPts = [];
    currentPredictedPts = [];
    committedFloats = 0;
    uploadedFloats = 0;
    predictedFloats = 0;
    for (let i = 0; i < msg.points.length; i++) {
      appendCommittedPoint(msg.points[i]);
    }
    flushWetStroke();
    return;
  }

  if (msg.type === 'lasso-overlay') {
    const items = msg.liftedStrokes.map((stroke) => ({ stroke }));
    // Also render dashed marquee as thin segments if polygon exists
    if (msg.polygon.length >= 2) {
      const marqueePts: StrokePoint[] = msg.polygon.map((p, idx) => ({
        x: p.x,
        y: p.y,
        pressure: 0.5,
        altitude: 1.5,
        azimuth: 0,
        dtMs: idx,
      }));
      items.push({
        stroke: {
          id: '__marquee__',
          pageId: '',
          tool: 'pen',
          color: '#c85a32',
          width: 1.5 / Math.max(0.5, msg.zoom),
          points: marqueePts,
          bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        },
      });
    }
    drawTransientStrokes(items, msg.offsetX, msg.offsetY, msg.zoom, msg.paperTheme, {
      dx: msg.dx,
      dy: msg.dy,
      scale: msg.scale,
      cx: msg.centerX,
      cy: msg.centerY,
    });
    return;
  }

  if (msg.type === 'replay-frame') {
    drawTransientStrokes(
      msg.activeStrokes.map((a) => ({ stroke: a.stroke, maxDtMs: a.elapsedDtMs })),
      msg.offsetX,
      msg.offsetY,
      msg.zoom,
      msg.paperTheme
    );
  }
};
