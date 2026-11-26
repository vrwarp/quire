/// <reference lib="webworker" />
import type { PaperTheme, StrokePoint, VectorStroke } from '../types';
import { drawVectorStroke } from '../engine/canvasRenderer';

/**
 * 120 Hz Dedicated InkRenderWorker (Single-Surface Desynchronized 2D OffscreenCanvas).
 *
 * Built directly on the proven single-canvas 2D OffscreenCanvas architecture (zero secondary
 * OffscreenCanvas `drawImage` -> `copyNativeImage()` readbacks, zero WebGL2 `surfaceBufferToImageBuffer`
 * IPC stalls, and zero microtask deferral), enhanced with:
 * - Delta point streaming (`wet-start` / `wet-append`) so `postMessage` payload is O(1).
 * - Tight dirty-rect `clearRect` (`lastDirtyRect`) instead of clearing the entire viewport.
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
      seq: number;
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
      seq: number;
      offsetX: number;
      offsetY: number;
      zoom: number;
      newPoints: StrokePoint[];
      predicted: StrokePoint[];
    }
  | {
      type: 'wet-trim';
      seq: number;
      offsetX: number;
      offsetY: number;
      zoom: number;
    }
  | {
      type: 'wet-replace';
      seq: number;
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
  | { type: 'clear'; seq?: number };

interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let dpr = 1;
let cssWidth = 1;
let cssHeight = 1;

// Active Wet Stroke State
let activeSeq = 0;
let wetTool: 'pen' | 'highlighter' = 'pen';
let wetColor = '#18181b';
let wetWidth = 2.8;
let wetPaperTheme: PaperTheme = 'cream';
let wetPoints: StrokePoint[] = [];
let wetMinX = Infinity;
let wetMinY = Infinity;
let wetMaxX = -Infinity;
let wetMaxY = -Infinity;
let lastDirtyRect: DirtyRect | null = null;
let fullSurfaceDirty = false;

const presentTimestamps: number[] = [];

function recordPresent(startAt: number) {
  const now = performance.now();
  presentTimestamps.push(now);
  while (presentTimestamps.length > 0 && now - presentTimestamps[0] > 1000) {
    presentTimestamps.shift();
  }
  const latencyMs = Math.max(0.1, now - startAt);
  if (presentTimestamps.length % 12 === 1) {
    self.postMessage({
      type: 'telemetry',
      fps: presentTimestamps.length,
      renderMs: Number(latencyMs.toFixed(2)),
    });
  }
}

function resizeBackingStore(w: number, h: number, nextDpr: number) {
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
  lastDirtyRect = null;
  fullSurfaceDirty = false;
}

function clearPreviousDirty() {
  if (!ctx || !canvas) return;
  if (fullSurfaceDirty) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fullSurfaceDirty = false;
    lastDirtyRect = null;
    return;
  }
  if (lastDirtyRect) {
    ctx.clearRect(lastDirtyRect.x, lastDirtyRect.y, lastDirtyRect.w, lastDirtyRect.h);
    lastDirtyRect = null;
  }
}

function expandWetBounds(pt: StrokePoint) {
  if (pt.x < wetMinX) wetMinX = pt.x;
  if (pt.y < wetMinY) wetMinY = pt.y;
  if (pt.x > wetMaxX) wetMaxX = pt.x;
  if (pt.y > wetMaxY) wetMaxY = pt.y;
}

function computeDirtyRect(
  predicted: StrokePoint[],
  offsetX: number,
  offsetY: number,
  zoom: number
): DirtyRect | null {
  if (!canvas || wetPoints.length === 0) return null;
  let minX = wetMinX;
  let minY = wetMinY;
  let maxX = wetMaxX;
  let maxY = wetMaxY;
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const padPx = Math.ceil((wetWidth * zoom + 8) * dpr);
  const x0 = Math.max(0, Math.floor((offsetX + minX * zoom) * dpr) - padPx);
  const y0 = Math.max(0, Math.floor((offsetY + minY * zoom) * dpr) - padPx);
  const x1 = Math.min(canvas.width, Math.ceil((offsetX + maxX * zoom) * dpr) + padPx);
  const y1 = Math.min(canvas.height, Math.ceil((offsetY + maxY * zoom) * dpr) + padPx);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function renderWetFrame(
  offsetX: number,
  offsetY: number,
  zoom: number,
  predicted: StrokePoint[],
  snapBadge?: string
) {
  if (!ctx || !canvas || wetPoints.length === 0) return;
  const t0 = performance.now();

  clearPreviousDirty();

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(offsetX, offsetY);
  ctx.scale(zoom, zoom);

  const combinedPoints =
    predicted.length > 0 ? [...wetPoints, ...predicted] : wetPoints;

  drawVectorStroke(
    ctx,
    {
      tool: wetTool,
      color: wetColor,
      width: wetWidth,
      points: combinedPoints,
    },
    wetPaperTheme
  );

  if (snapBadge) {
    const tip = wetPoints[wetPoints.length - 1];
    ctx.fillStyle = 'rgba(200, 90, 50, 0.92)';
    ctx.beginPath();
    ctx.roundRect(tip.x + 10, tip.y - 24, 108, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(snapBadge, tip.x + 18, tip.y - 9);
    fullSurfaceDirty = true;
  } else {
    lastDirtyRect = computeDirtyRect(predicted, offsetX, offsetY, zoom);
  }

  ctx.restore();
  recordPresent(t0);
}

self.onmessage = (event: MessageEvent<InkWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    canvas = msg.canvas;
    ctx = canvas.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings);
    resizeBackingStore(msg.width, msg.height, msg.dpr);
    self.postMessage({ type: 'ready', backend: '2d-offscreen' });
    return;
  }

  if (msg.type === 'resize') {
    resizeBackingStore(msg.width, msg.height, msg.dpr);
    return;
  }

  if (!ctx || !canvas) return;

  if (msg.type === 'clear') {
    // Ignore delayed post-commit clear if a newer wet stroke has already started
    if (msg.seq !== undefined && msg.seq !== activeSeq) return;
    clearPreviousDirty();
    wetPoints = [];
    wetMinX = Infinity;
    wetMinY = Infinity;
    wetMaxX = -Infinity;
    wetMaxY = -Infinity;
    return;
  }

  if (msg.type === 'wet-start') {
    activeSeq = msg.seq;
    clearPreviousDirty();
    wetTool = msg.tool;
    wetColor = msg.color;
    wetWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetPoints = [msg.point];
    wetMinX = msg.point.x;
    wetMinY = msg.point.y;
    wetMaxX = msg.point.x;
    wetMaxY = msg.point.y;
    renderWetFrame(msg.offsetX, msg.offsetY, msg.zoom, []);
    return;
  }

  if (msg.type === 'wet-append') {
    if (msg.seq !== activeSeq || wetPoints.length === 0) return;
    for (let i = 0; i < msg.newPoints.length; i++) {
      const p = msg.newPoints[i];
      wetPoints.push(p);
      expandWetBounds(p);
    }
    renderWetFrame(msg.offsetX, msg.offsetY, msg.zoom, msg.predicted);
    return;
  }

  if (msg.type === 'wet-trim') {
    if (msg.seq !== activeSeq || wetPoints.length === 0) return;
    renderWetFrame(msg.offsetX, msg.offsetY, msg.zoom, []);
    return;
  }

  if (msg.type === 'wet-replace') {
    if (msg.seq !== activeSeq) return;
    wetTool = msg.tool;
    wetColor = msg.color;
    wetWidth = msg.width;
    wetPaperTheme = msg.paperTheme;
    wetPoints = msg.points.slice();
    wetMinX = Infinity;
    wetMinY = Infinity;
    wetMaxX = -Infinity;
    wetMaxY = -Infinity;
    for (let i = 0; i < wetPoints.length; i++) {
      expandWetBounds(wetPoints[i]);
    }
    renderWetFrame(msg.offsetX, msg.offsetY, msg.zoom, [], msg.snapBadge);
    return;
  }

  if (msg.type === 'lasso-overlay') {
    const t0 = performance.now();
    clearPreviousDirty();
    fullSurfaceDirty = true;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(msg.offsetX, msg.offsetY);
    ctx.scale(msg.zoom, msg.zoom);

    if (msg.liftedStrokes.length > 0) {
      ctx.save();
      ctx.translate(msg.centerX + msg.dx, msg.centerY + msg.dy);
      ctx.scale(msg.scale, msg.scale);
      ctx.translate(-msg.centerX, -msg.centerY);
      for (const stroke of msg.liftedStrokes) {
        drawVectorStroke(ctx, stroke, msg.paperTheme);
      }
      ctx.restore();
    }

    if (msg.polygon.length >= 2) {
      ctx.save();
      ctx.translate(msg.dx, msg.dy);
      ctx.strokeStyle = '#c85a32';
      ctx.fillStyle = 'rgba(200, 90, 50, 0.08)';
      ctx.lineWidth = 1.5 / Math.max(0.5, msg.zoom);
      ctx.setLineDash([5 / Math.max(0.5, msg.zoom), 4 / Math.max(0.5, msg.zoom)]);
      ctx.beginPath();
      ctx.moveTo(msg.polygon[0].x, msg.polygon[0].y);
      for (let i = 1; i < msg.polygon.length; i++) {
        ctx.lineTo(msg.polygon[i].x, msg.polygon[i].y);
      }
      if (msg.liftedStrokes.length > 0) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    recordPresent(t0);
    return;
  }

  if (msg.type === 'replay-frame') {
    const t0 = performance.now();
    clearPreviousDirty();
    fullSurfaceDirty = true;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(msg.offsetX, msg.offsetY);
    ctx.scale(msg.zoom, msg.zoom);

    for (const item of msg.activeStrokes) {
      drawVectorStroke(ctx, item.stroke, msg.paperTheme, {
        maxDtMs: item.elapsedDtMs,
        glowColor: 'rgba(200, 90, 50, 0.55)',
      });
    }

    ctx.restore();
    recordPresent(t0);
  }
};
