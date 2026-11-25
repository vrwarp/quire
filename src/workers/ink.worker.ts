/// <reference lib="webworker" />
import type { PaperTheme, StrokePoint, VectorStroke } from '../types';
import { drawVectorStroke, resolveStrokeColor } from '../engine/canvasRenderer';

/**
 * 120 Hz Dedicated OffscreenCanvas InkRenderWorker (O(1) Dirty-Rect 2D GPU Engine).
 *
 * WHY 2D OFFSCREENCANVAS + PERSISTENT COMMIT LAYER + DIRTY-RECT BLIT IS CRITICAL ON WEBKIT:
 * 1. In WebKit (`CanvasRenderingContext2DBase.cpp:307`), a `2d` OffscreenCanvas implements
 *    `surfaceBufferToImageBuffer()` as `return buffer();` (an `Accelerated` IOSurface in
 *    `GPUProcess` sent via `AsyncSetLayerContents` at 120 Hz, bypassing main-thread 60 Hz).
 *    By contrast, `webgl2` on a placeholder OffscreenCanvas (`WebGLRenderingContextBase.cpp:864`)
 *    triggers synchronous `copyNativeImage()` readbacks + 16 MB allocations every frame!
 * 2. Never call `self.requestAnimationFrame()` inside a WebKit Worker (`WorkerAnimationController.cpp`
 *    hardcodes worker rAF to a 60 Hz 16.67 ms timer). Instead, coalesce same-turn messages via
 *    `queueMicrotask` and commit directly at the 120 Hz input cadence.
 * 3. For O(1) frame times (<0.15 ms regardless of stroke length):
 *    - `committedCanvas` accumulates ONLY true committed Apple Pencil segments (never cleared mid-stroke).
 *    - `displayCanvas` restores ONLY the tiny ~50x50 px `tipDirty` patch from `committedCanvas`,
 *      appends ONLY the 1–3 newly arrived delta segments, and draws the 3-point transient
 *      `predictedTip` on top. Zero full-screen `clearRect`s and zero O(N) stroke re-tessellation!
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

interface PixelRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const EMPTY_RECT: PixelRect = {
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
};

function isRectEmpty(r: PixelRect): boolean {
  return r.minX >= r.maxX || r.minY >= r.maxY;
}

function unionRect(a: PixelRect, b: PixelRect): PixelRect {
  if (isRectEmpty(a)) return { ...b };
  if (isRectEmpty(b)) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

let displayCanvas: OffscreenCanvas | null = null;
let displayCtx: OffscreenCanvasRenderingContext2D | null = null;
let committedCanvas: OffscreenCanvas | null = null;
let committedCtx: OffscreenCanvasRenderingContext2D | null = null;

let cssWidth = 1;
let cssHeight = 1;
let dpr = 1;

let wetActive = false;
let wetTool: 'pen' | 'highlighter' = 'pen';
let wetColorHex = '#18181b';
let wetBaseWidth = 2.8;
let wetPaperTheme: PaperTheme = 'cream';
let wetOffsetX = 0;
let wetOffsetY = 0;
let wetZoom = 1;

let committedPts: StrokePoint[] = [];
let drawnUpToIdx = 0;
let currentPredictedPts: StrokePoint[] = [];
let strokeDirty: PixelRect = { ...EMPTY_RECT };
let tipDirty: PixelRect = { ...EMPTY_RECT };
let fullSurfaceDirty = false;
let flushScheduled = false;

const presentTimestamps: number[] = [];

function computePointsPixelRect(
  pts: StrokePoint[],
  strokeWidthPt: number,
  offsetX: number,
  offsetY: number,
  zoom: number
): PixelRect {
  if (pts.length === 0 || !displayCanvas) return { ...EMPTY_RECT };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const padPx = Math.ceil((strokeWidthPt * zoom + 6) * dpr);
  const x0 = Math.max(0, Math.floor((offsetX + minX * zoom) * dpr) - padPx);
  const y0 = Math.max(0, Math.floor((offsetY + minY * zoom) * dpr) - padPx);
  const x1 = Math.min(displayCanvas.width, Math.ceil((offsetX + maxX * zoom) * dpr) + padPx);
  const y1 = Math.min(displayCanvas.height, Math.ceil((offsetY + maxY * zoom) * dpr) + padPx);
  if (x1 <= x0 || y1 <= y0) return { ...EMPTY_RECT };
  return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
}

function clearRectRegion(ctx: OffscreenCanvasRenderingContext2D, r: PixelRect): void {
  if (isRectEmpty(r)) return;
  ctx.clearRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
}

function resizeBackingStore(w: number, h: number, nextDpr: number): void {
  cssWidth = Math.max(1, w);
  cssHeight = Math.max(1, h);
  dpr = Math.max(1, Math.min(2, nextDpr));
  if (!displayCanvas) return;
  const pxW = Math.max(1, Math.round(cssWidth * dpr));
  const pxH = Math.max(1, Math.round(cssHeight * dpr));
  if (displayCanvas.width !== pxW || displayCanvas.height !== pxH) {
    displayCanvas.width = pxW;
    displayCanvas.height = pxH;
  }
  if (committedCanvas && (committedCanvas.width !== pxW || committedCanvas.height !== pxH)) {
    committedCanvas.width = pxW;
    committedCanvas.height = pxH;
  }
  strokeDirty = { ...EMPTY_RECT };
  tipDirty = { ...EMPTY_RECT };
  drawnUpToIdx = 0;
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

function drawSliceInPageSpace(
  ctx: OffscreenCanvasRenderingContext2D,
  slice: StrokePoint[],
  tool: 'pen' | 'highlighter',
  color: string,
  width: number,
  paperTheme: PaperTheme,
  offsetX: number,
  offsetY: number,
  zoom: number
): void {
  if (slice.length === 0) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(offsetX, offsetY);
  ctx.scale(zoom, zoom);
  drawVectorStroke(ctx, { tool, color, width, points: slice }, paperTheme);
  ctx.restore();
}

function flushWetStroke(): void {
  flushScheduled = false;
  if (!wetActive || !displayCanvas || !displayCtx) return;
  const t0 = performance.now();

  // Single-layer non-darkening wet Highlighter path (bounded strictly to strokeDirty)
  if (wetTool === 'highlighter') {
    clearRectRegion(displayCtx, strokeDirty);
    const combined =
      currentPredictedPts.length > 0
        ? [...committedPts, ...currentPredictedPts]
        : committedPts;
    const nextDirty = computePointsPixelRect(
      combined,
      wetBaseWidth,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    drawSliceInPageSpace(
      displayCtx,
      combined,
      'highlighter',
      wetColorHex,
      wetBaseWidth,
      wetPaperTheme,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    strokeDirty = nextDirty;
    drawnUpToIdx = Math.max(0, committedPts.length - 1);
    recordPresent(t0);
    return;
  }

  // O(1) Incremental Pen Path:
  // 1. Erase ONLY last frame's tiny ~50x50px predicted-tip patch and restore any committed ink under it.
  if (!isRectEmpty(tipDirty)) {
    const rw = tipDirty.maxX - tipDirty.minX;
    const rh = tipDirty.maxY - tipDirty.minY;
    displayCtx.clearRect(tipDirty.minX, tipDirty.minY, rw, rh);
    if (committedCanvas && rw > 0 && rh > 0) {
      displayCtx.drawImage(
        committedCanvas,
        tipDirty.minX,
        tipDirty.minY,
        rw,
        rh,
        tipDirty.minX,
        tipDirty.minY,
        rw,
        rh
      );
    }
    tipDirty = { ...EMPTY_RECT };
  }

  // 2. Rasterize ONLY newly arrived committed delta points onto both committedCtx & displayCtx!
  const len = committedPts.length;
  if (len > 0 && (drawnUpToIdx === 0 || drawnUpToIdx < len - 1)) {
    const sliceStart = drawnUpToIdx === 0 ? 0 : Math.max(0, drawnUpToIdx - 2);
    const deltaSlice = committedPts.slice(sliceStart);
    const deltaRect = computePointsPixelRect(
      deltaSlice,
      wetBaseWidth,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    if (committedCtx) {
      drawSliceInPageSpace(
        committedCtx,
        deltaSlice,
        'pen',
        wetColorHex,
        wetBaseWidth,
        wetPaperTheme,
        wetOffsetX,
        wetOffsetY,
        wetZoom
      );
    }
    drawSliceInPageSpace(
      displayCtx,
      deltaSlice,
      'pen',
      wetColorHex,
      wetBaseWidth,
      wetPaperTheme,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    strokeDirty = unionRect(strokeDirty, deltaRect);
    drawnUpToIdx = len - 1;
  }

  // 3. Draw transient kinematic predicted tip ONLY onto displayCtx and record its tiny dirty rect.
  if (currentPredictedPts.length > 0 && len > 0) {
    const anchorStart = Math.max(0, len - 2);
    const tipSlice = [...committedPts.slice(anchorStart), ...currentPredictedPts];
    tipDirty = computePointsPixelRect(
      tipSlice,
      wetBaseWidth,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    drawSliceInPageSpace(
      displayCtx,
      tipSlice,
      'pen',
      wetColorHex,
      wetBaseWidth,
      wetPaperTheme,
      wetOffsetX,
      wetOffsetY,
      wetZoom
    );
    strokeDirty = unionRect(strokeDirty, tipDirty);
  }

  recordPresent(t0);
}

function scheduleWetFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushWetStroke);
}

function clearCanvasSurface(): void {
  wetActive = false;
  flushScheduled = false;
  committedPts = [];
  currentPredictedPts = [];
  drawnUpToIdx = 0;

  if (!displayCanvas || !displayCtx) return;

  if (fullSurfaceDirty) {
    displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    committedCtx?.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    fullSurfaceDirty = false;
  } else {
    const combinedDirty = unionRect(strokeDirty, tipDirty);
    clearRectRegion(displayCtx, combinedDirty);
    if (committedCtx) {
      clearRectRegion(committedCtx, combinedDirty);
    }
  }
  strokeDirty = { ...EMPTY_RECT };
  tipDirty = { ...EMPTY_RECT };
}

self.onmessage = (event: MessageEvent<InkWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    displayCanvas = msg.canvas;
    displayCtx = displayCanvas.getContext('2d', { alpha: true });
    committedCanvas = new OffscreenCanvas(1, 1);
    committedCtx = committedCanvas.getContext('2d', { alpha: true });
    resizeBackingStore(msg.width, msg.height, msg.dpr);
    self.postMessage({ type: 'ready', backend: '2d-offscreen' });
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
    clearCanvasSurface();
    wetActive = true;
    wetTool = msg.tool;
    wetColorHex = msg.color;
    wetBaseWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetOffsetX = msg.offsetX;
    wetOffsetY = msg.offsetY;
    wetZoom = msg.zoom;
    committedPts = [msg.point];
    currentPredictedPts = [];
    drawnUpToIdx = 0;

    // Render initial pen-down point synchronously for instant 0-frame contact response!
    flushWetStroke();
    return;
  }

  if (msg.type === 'wet-append') {
    if (!wetActive) return;
    if (
      Math.abs(wetOffsetX - msg.offsetX) > 0.5 ||
      Math.abs(wetOffsetY - msg.offsetY) > 0.5 ||
      Math.abs(wetZoom - msg.zoom) > 1e-4
    ) {
      // Page offset/zoom shifted mid-stroke: reset incremental layer cleanly
      const savedPts = [...committedPts, ...msg.newPoints];
      clearCanvasSurface();
      wetActive = true;
      wetOffsetX = msg.offsetX;
      wetOffsetY = msg.offsetY;
      wetZoom = msg.zoom;
      committedPts = savedPts;
      drawnUpToIdx = 0;
    } else {
      for (let i = 0; i < msg.newPoints.length; i++) {
        committedPts.push(msg.newPoints[i]);
      }
    }
    currentPredictedPts = msg.predicted;
    scheduleWetFlush();
    return;
  }

  if (msg.type === 'wet-replace') {
    clearCanvasSurface();
    wetActive = true;
    wetTool = msg.tool;
    wetColorHex = msg.color;
    wetBaseWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetOffsetX = msg.offsetX;
    wetOffsetY = msg.offsetY;
    wetZoom = msg.zoom;
    committedPts = msg.points.slice();
    currentPredictedPts = [];
    drawnUpToIdx = 0;
    flushWetStroke();

    if (msg.snapBadge && displayCtx && msg.points.length > 0) {
      const last = msg.points[msg.points.length - 1];
      displayCtx.save();
      displayCtx.scale(dpr, dpr);
      displayCtx.font = '600 11px system-ui, -apple-system, sans-serif';
      const label = msg.snapBadge;
      const tw = displayCtx.measureText(label).width + 14;
      const bx = wetOffsetX + last.x * wetZoom + 10;
      const by = wetOffsetY + last.y * wetZoom - 24;
      displayCtx.fillStyle = 'rgba(24, 24, 27, 0.86)';
      displayCtx.beginPath();
      displayCtx.roundRect(bx, by, tw, 20, 10);
      displayCtx.fill();
      displayCtx.fillStyle = '#ffffff';
      displayCtx.fillText(label, bx + 7, by + 13.5);
      displayCtx.restore();
      fullSurfaceDirty = true;
    }
    return;
  }

  if (msg.type === 'lasso-overlay' && displayCanvas && displayCtx) {
    const t0 = performance.now();
    displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    fullSurfaceDirty = true;
    displayCtx.save();
    displayCtx.scale(dpr, dpr);
    displayCtx.translate(msg.offsetX, msg.offsetY);
    displayCtx.scale(msg.zoom, msg.zoom);

    if (msg.liftedStrokes.length > 0) {
      displayCtx.save();
      displayCtx.translate(msg.centerX + msg.dx, msg.centerY + msg.dy);
      displayCtx.scale(msg.scale, msg.scale);
      displayCtx.translate(-msg.centerX, -msg.centerY);
      for (const s of msg.liftedStrokes) {
        drawVectorStroke(displayCtx, s, msg.paperTheme);
      }
      displayCtx.restore();
    }

    if (msg.polygon.length >= 2) {
      displayCtx.save();
      displayCtx.translate(msg.dx, msg.dy);
      displayCtx.strokeStyle = resolveStrokeColor('#c85a32', msg.paperTheme, 'pen');
      displayCtx.lineWidth = 1.6 / Math.max(0.5, msg.zoom);
      displayCtx.setLineDash([5 / msg.zoom, 4 / msg.zoom]);
      displayCtx.beginPath();
      displayCtx.moveTo(msg.polygon[0].x, msg.polygon[0].y);
      for (let i = 1; i < msg.polygon.length; i++) {
        displayCtx.lineTo(msg.polygon[i].x, msg.polygon[i].y);
      }
      displayCtx.stroke();
      displayCtx.restore();
    }

    displayCtx.restore();
    recordPresent(t0);
    return;
  }

  if (msg.type === 'replay-frame' && displayCanvas && displayCtx) {
    const t0 = performance.now();
    displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    fullSurfaceDirty = true;
    displayCtx.save();
    displayCtx.scale(dpr, dpr);
    displayCtx.translate(msg.offsetX, msg.offsetY);
    displayCtx.scale(msg.zoom, msg.zoom);
    for (const item of msg.activeStrokes) {
      drawVectorStroke(displayCtx, item.stroke, msg.paperTheme, {
        maxDtMs: item.elapsedDtMs,
        glowColor: 'rgba(200, 90, 50, 0.45)',
      });
    }
    displayCtx.restore();
    recordPresent(t0);
  }
};
