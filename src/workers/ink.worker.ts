/// <reference lib="webworker" />
import type { PaperTheme, StrokePoint, VectorStroke } from '../types';
import { drawVectorStroke } from '../engine/canvasRenderer';

/**
 * 120 Hz Dedicated InkRenderWorker (OffscreenCanvas).
 *
 * CRITICAL WEBKIT INVARIANT:
 * Never gate rendering on `self.requestAnimationFrame()` inside a Worker!
 * In WebKit (WorkerAnimationController.cpp), worker rAF is backed by a hardcoded
 * 16.67 ms (60 Hz) timer. Instead, we render immediately inside incoming message tasks
 * so `OffscreenCanvas::scheduleCommitToPlaceholderCanvas()` dispatches `AsyncSetLayerContents`
 * (zero-copy IOSurface MachSendRight) straight to the iPadOS UIProcess at 120 Hz.
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
      type: 'wet-stroke';
      tool: 'pen' | 'highlighter';
      color: string;
      width: number;
      paperTheme: PaperTheme;
      offsetX: number;
      offsetY: number;
      zoom: number;
      points: StrokePoint[];
      predicted: StrokePoint[];
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

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let dpr = 1;
let cssWidth = 1;
let cssHeight = 1;

// Lightweight rolling frame rate telemetry
const presentTimestamps: number[] = [];

function recordPresent(startAt: number) {
  const now = performance.now();
  presentTimestamps.push(now);
  while (presentTimestamps.length > 0 && now - presentTimestamps[0] > 1000) {
    presentTimestamps.shift();
  }
  const latencyMs = Math.max(0.2, now - startAt);
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
}

self.onmessage = (event: MessageEvent<InkWorkerMessage>) => {
  const msg = event.data;
  const t0 = performance.now();

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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  if (msg.type === 'wet-stroke') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(msg.offsetX, msg.offsetY);
    ctx.scale(msg.zoom, msg.zoom);

    const combinedPoints =
      msg.predicted.length > 0 ? [...msg.points, ...msg.predicted] : msg.points;

    drawVectorStroke(
      ctx,
      {
        tool: msg.tool,
        color: msg.color,
        width: msg.width,
        points: combinedPoints,
      },
      msg.paperTheme
    );

    if (msg.snapBadge && msg.points.length > 0) {
      const tip = msg.points[msg.points.length - 1];
      ctx.fillStyle = 'rgba(200, 90, 50, 0.92)';
      ctx.beginPath();
      ctx.roundRect(tip.x + 10, tip.y - 24, 92, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(msg.snapBadge, tip.x + 18, tip.y - 9);
    }

    ctx.restore();
    recordPresent(t0);
    return;
  }

  if (msg.type === 'lasso-overlay') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(msg.offsetX, msg.offsetY);
    ctx.scale(msg.zoom, msg.zoom);

    // Draw lifted strokes at 120 FPS during drag/scale
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

    // Draw dashed lasso marquee
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
