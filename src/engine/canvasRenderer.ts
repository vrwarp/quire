import type { PaperTheme, StrokePoint, VectorStroke } from '../types';
import { buildStrokeOutline } from './inkMath';

/**
 * Resolves semantic ink colors for Dark Paper mode (CUJ 2):
 * Default near-black ink inverts cleanly to crisp off-white on dark paper,
 * while colored inks and highlighters retain their hue.
 */
export function resolveStrokeColor(
  color: string,
  paperTheme: PaperTheme,
  tool: 'pen' | 'highlighter'
): string {
  if (tool === 'highlighter') return color;
  const normalized = color.toLowerCase();
  if (paperTheme === 'dark') {
    if (normalized === '#18181b' || normalized === '#111827' || normalized === '#000000' || normalized === '#1e2430') {
      return '#f2efe9';
    }
  } else {
    if (normalized === '#f2efe9' || normalized === '#ffffff' || normalized === '#f3f4f6') {
      return '#18181b';
    }
  }
  return color;
}

/**
 * Draws a single vector stroke onto a 2D canvas context (main thread or OffscreenCanvas).
 * Uses variable-width ribbon outline for pressure-sensitive Pen strokes, and uniform-alpha
 * round-cap strokes for Highlighter.
 */
export function drawVectorStroke(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  stroke: {
    tool: 'pen' | 'highlighter';
    color: string;
    width: number;
    points: StrokePoint[];
  },
  paperTheme: PaperTheme,
  options?: {
    opacityMultiplier?: number;
    maxDtMs?: number;
    glowColor?: string;
  }
): void {
  let pts = stroke.points;
  if (options?.maxDtMs !== undefined) {
    pts = pts.filter((p) => p.dtMs <= options.maxDtMs!);
  }
  if (pts.length === 0) return;

  const resolvedColor = resolveStrokeColor(stroke.color, paperTheme, stroke.tool);
  const opacity = options?.opacityMultiplier ?? 1;

  ctx.save();
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.34 * opacity;
    ctx.strokeStyle = resolvedColor;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.globalAlpha = opacity;
  if (options?.glowColor) {
    ctx.shadowColor = options.glowColor;
    ctx.shadowBlur = 8;
  }
  ctx.fillStyle = resolvedColor;

  if (pts.length === 1) {
    const r = Math.max(0.75, stroke.width * 0.45);
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const { left, right } = buildStrokeOutline(pts, stroke.width, false);
  if (left.length === 0) {
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < left.length; i++) {
    ctx.lineTo(left[i].x, left[i].y);
  }
  for (let i = right.length - 1; i >= 0; i--) {
    ctx.lineTo(right[i].x, right[i].y);
  }
  ctx.closePath();
  ctx.fill();

  // Smooth round endcaps
  const startR = Math.max(0.5, Math.hypot(left[0].x - right[0].x, left[0].y - right[0].y) * 0.5);
  const endIdx = left.length - 1;
  const endR = Math.max(
    0.5,
    Math.hypot(left[endIdx].x - right[endIdx].x, left[endIdx].y - right[endIdx].y) * 0.5
  );
  ctx.beginPath();
  ctx.arc(pts[0].x, pts[0].y, startR, 0, Math.PI * 2);
  ctx.arc(pts[pts.length - 1].x, pts[pts.length - 1].y, endR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

let sharedHighlighterScratch: HTMLCanvasElement | null = null;

function getHighlighterScratch(pxW: number, pxH: number): HTMLCanvasElement {
  if (!sharedHighlighterScratch) {
    sharedHighlighterScratch = document.createElement('canvas');
  }
  if (sharedHighlighterScratch.width !== pxW || sharedHighlighterScratch.height !== pxH) {
    sharedHighlighterScratch.width = pxW;
    sharedHighlighterScratch.height = pxH;
  }
  return sharedHighlighterScratch;
}

/**
 * Renders a page's dry Highlighter layer with single-layer non-darkening semantics (FR-INK-02):
 * Each color group is rendered at full alpha into a shared scratch buffer and composited once,
 * so overlapping passes never darken or muddy underlying dark ink / PDF text.
 */
export function renderDryHighlighterLayer(
  canvas: HTMLCanvasElement,
  strokes: VectorStroke[],
  widthPt: number,
  heightPt: number,
  scale: number,
  paperTheme: PaperTheme,
  hiddenIds?: Set<string>
): void {
  const pxW = Math.max(1, Math.round(widthPt * scale));
  const pxH = Math.max(1, Math.round(heightPt * scale));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, pxW, pxH);

  const highlighters = strokes.filter(
    (s) => s.tool === 'highlighter' && (!hiddenIds || hiddenIds.size === 0 || !hiddenIds.has(s.id))
  );
  if (highlighters.length === 0) return;

  // Group by color so repeated passes of the same highlighter color stay single-layer flat alpha
  const byColor = new Map<string, VectorStroke[]>();
  for (const s of highlighters) {
    const list = byColor.get(s.color) ?? [];
    list.push(s);
    byColor.set(s.color, list);
  }

  const scratch = getHighlighterScratch(pxW, pxH);
  const sctx = scratch.getContext('2d');
  if (!sctx) return;

  for (const [color, group] of byColor.entries()) {
    sctx.clearRect(0, 0, pxW, pxH);
    sctx.save();
    sctx.scale(scale, scale);
    sctx.strokeStyle = color;
    sctx.lineCap = 'butt';
    sctx.lineJoin = 'round';
    for (const stroke of group) {
      if (stroke.points.length === 0) continue;
      sctx.lineWidth = stroke.width;
      sctx.beginPath();
      sctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        sctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      sctx.stroke();
    }
    sctx.restore();

    ctx.save();
    ctx.globalAlpha = paperTheme === 'dark' ? 0.28 : 0.36;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
}

/**
 * Appends a single newly committed Pen stroke onto an initialized Dry Pen layer in O(1) time,
 * avoiding O(N) full-page clearing and Barry-Goldman Catmull-Rom re-tessellation on every pen lift.
 */
export function appendDryPenStroke(
  canvas: HTMLCanvasElement,
  stroke: VectorStroke,
  widthPt: number,
  heightPt: number,
  scale: number,
  paperTheme: PaperTheme
): boolean {
  if (stroke.tool !== 'pen') return false;
  const pxW = Math.max(1, Math.round(widthPt * scale));
  const pxH = Math.max(1, Math.round(heightPt * scale));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    return false;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.save();
  ctx.scale(scale, scale);
  drawVectorStroke(ctx, stroke, paperTheme);
  ctx.restore();
  return true;
}

/**
 * Renders a page's dry Pen layer with optional audio replay ghosting.
 */
export function renderDryPenLayer(
  canvas: HTMLCanvasElement,
  strokes: VectorStroke[],
  widthPt: number,
  heightPt: number,
  scale: number,
  paperTheme: PaperTheme,
  options?: {
    hiddenIds?: Set<string>;
    replaySessionId?: string | null;
    replayTimeMs?: number;
  }
): void {
  const pxW = Math.max(1, Math.round(widthPt * scale));
  const pxH = Math.max(1, Math.round(heightPt * scale));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, pxW, pxH);

  ctx.save();
  ctx.scale(scale, scale);
  for (const stroke of strokes) {
    if (stroke.tool !== 'pen') continue;
    if (options?.hiddenIds?.has(stroke.id)) continue;

    if (
      options?.replaySessionId &&
      stroke.audioSessionId === options.replaySessionId &&
      stroke.startAudioMs !== undefined
    ) {
      const t = options.replayTimeMs ?? 0;
      if (t < stroke.startAudioMs) {
        drawVectorStroke(ctx, stroke, paperTheme, { opacityMultiplier: 0.22 });
      } else if (stroke.endAudioMs !== undefined && t <= stroke.endAudioMs) {
        // Ghost full stroke; active progress is animated at 120 FPS on the Wet OffscreenCanvas
        drawVectorStroke(ctx, stroke, paperTheme, { opacityMultiplier: 0.22 });
      } else {
        drawVectorStroke(ctx, stroke, paperTheme, { opacityMultiplier: 1 });
      }
    } else {
      drawVectorStroke(ctx, stroke, paperTheme);
    }
  }
  ctx.restore();
}
