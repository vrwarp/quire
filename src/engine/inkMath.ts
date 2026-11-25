import type { BBox, ShapeKind, StrokePoint, VectorStroke } from '../types';

/**
 * Adaptive 1€ Low-Pass Filter for stylus coordinates.
 * Eliminates slow-speed digitizer jitter while keeping near-zero lag during fast strokes.
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.4, beta = 0.04, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / Math.max(dtSec, 1e-4));
  }

  filter(x: number, timestampMs: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampMs;
      return x;
    }
    const dtSec = Math.max((timestampMs - this.tPrev) / 1000, 1 / 480);
    const dx = (x - this.xPrev) / dtSec;
    const aD = this.alpha(this.dCutoff, dtSec);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dtSec);
    const xHat = a * x + (1 - a) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = timestampMs;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

export function computeBBox(points: StrokePoint[], pad = 4): BBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Computes pressure-modulated half-width for a stroke point.
 */
export function strokeHalfWidth(baseWidth: number, pressure: number, isHighlighter: boolean): number {
  if (isHighlighter) return baseWidth * 0.5;
  const clamped = Math.max(0.15, Math.min(1.0, pressure || 0.5));
  return baseWidth * (0.38 + 0.62 * Math.pow(clamped, 0.85)) * 0.5;
}

/**
 * Centripetal Catmull-Rom interpolation producing smooth sub-points for variable-width ribbons
 * and vector PDF cubic Bézier outlines.
 */
export function densifyStrokePoints(points: StrokePoint[], subdivisions = 3): StrokePoint[] {
  if (points.length < 3) return points;
  const out: StrokePoint[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = segLen < 2 ? 1 : Math.min(subdivisions, Math.ceil(segLen / 3));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({
        x,
        y,
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
        altitude: p1.altitude + (p2.altitude - p1.altitude) * t,
        azimuth: p1.azimuth + (p2.azimuth - p1.azimuth) * t,
        dtMs: Math.round(p1.dtMs + (p2.dtMs - p1.dtMs) * t),
      });
    }
  }
  return out;
}

/**
 * Builds a closed polygon outline (left edge forward + right edge backward) for a variable-width
 * stroke ribbon. Used for both GPU triangle-strip tessellation and crisp vector PDF export.
 */
export function buildStrokeOutline(
  rawPoints: StrokePoint[],
  baseWidth: number,
  isHighlighter: boolean
): { left: Array<{ x: number; y: number }>; right: Array<{ x: number; y: number }> } {
  const pts = densifyStrokePoints(rawPoints, 3);
  if (pts.length === 0) return { left: [], right: [] };
  if (pts.length === 1) {
    const r = strokeHalfWidth(baseWidth, pts[0].pressure, isHighlighter);
    const left: Array<{ x: number; y: number }> = [];
    const right: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI;
      left.push({ x: pts[0].x + Math.cos(a) * r, y: pts[0].y + Math.sin(a) * r });
      right.push({ x: pts[0].x + Math.cos(a + Math.PI) * r, y: pts[0].y + Math.sin(a + Math.PI) * r });
    }
    return { left, right };
  }

  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    const hw = strokeHalfWidth(baseWidth, pts[i].pressure, isHighlighter);
    left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
    right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
  }
  return { left, right };
}

/**
 * Hold-to-Snap Geometric Shape Recognizer (FR-INK-05).
 * Detects straight lines, arrows, rectangles, ellipses/circles, and triangles.
 */
export function recognizeShape(points: StrokePoint[]): {
  kind: ShapeKind;
  snappedPoints: StrokePoint[];
} | null {
  if (points.length < 4) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const bbox = computeBBox(points, 0);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const diag = Math.hypot(w, h);
  if (diag < 18) return null;

  const avgPressure = points.reduce((s, p) => s + p.pressure, 0) / points.length;
  const endDt = last.dtMs;
  const mkPt = (x: number, y: number, idx: number, total: number): StrokePoint => ({
    x,
    y,
    pressure: avgPressure,
    altitude: first.altitude,
    azimuth: first.azimuth,
    dtMs: Math.round((idx / Math.max(1, total - 1)) * endDt),
  });

  // 1. Check straight line: max perpendicular deviation from segment(first, last)
  const chordLen = Math.hypot(last.x - first.x, last.y - first.y);
  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  let maxLineDev = 0;
  for (const p of points) {
    const d = Math.sqrt(pointToSegmentDistSq(p.x, p.y, first.x, first.y, last.x, last.y));
    if (d > maxLineDev) maxLineDev = d;
  }

  if (chordLen > diag * 0.78 && maxLineDev < Math.max(8, diag * 0.08) && totalLen < chordLen * 1.25) {
    // Check if an arrow head was drawn at the end (small backtracking hook)
    const snapped: StrokePoint[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      snapped.push(mkPt(first.x + (last.x - first.x) * t, first.y + (last.y - first.y) * t, i, steps + 1));
    }
    return { kind: 'line', snappedPoints: snapped };
  }

  // 2. Closed shape check
  const closureDist = Math.hypot(last.x - first.x, last.y - first.y);
  if (closureDist > diag * 0.35) {
    // Open stroke that isn't a straight line — check if it's an arrow (straight shaft + small head)
    const simplified = douglasPeucker(points, diag * 0.06);
    if (simplified.length === 3 || simplified.length === 4) {
      const shaftEnd = simplified[1];
      const shaftLen = Math.hypot(shaftEnd.x - first.x, shaftEnd.y - first.y);
      const headLen = Math.hypot(last.x - shaftEnd.x, last.y - shaftEnd.y);
      if (shaftLen > diag * 0.65 && headLen > 8 && headLen < shaftLen * 0.45) {
        const angle = Math.atan2(shaftEnd.y - first.y, shaftEnd.x - first.x);
        const headSize = Math.min(22, shaftLen * 0.18);
        const wing1 = {
          x: shaftEnd.x - headSize * Math.cos(angle - Math.PI / 6),
          y: shaftEnd.y - headSize * Math.sin(angle - Math.PI / 6),
        };
        const wing2 = {
          x: shaftEnd.x - headSize * Math.cos(angle + Math.PI / 6),
          y: shaftEnd.y - headSize * Math.sin(angle + Math.PI / 6),
        };
        const verts = [first, shaftEnd, wing1, shaftEnd, wing2];
        return {
          kind: 'arrow',
          snappedPoints: verts.map((v, i) => mkPt(v.x, v.y, i, verts.length)),
        };
      }
    }
    return null;
  }

  // 3. Test Ellipse / Circle fit
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const rx = Math.max(w / 2, 1);
  const ry = Math.max(h / 2, 1);
  let ellipseErrSum = 0;
  for (const p of points) {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    ellipseErrSum += Math.abs(Math.hypot(nx, ny) - 1);
  }
  const ellipseErr = ellipseErrSum / points.length;

  // 4. Test Polygon corners via Douglas-Peucker
  const poly = douglasPeucker(points, Math.max(8, diag * 0.075));
  // Remove closing duplicate if close to start
  const corners =
    poly.length > 2 && Math.hypot(poly[poly.length - 1].x - poly[0].x, poly[poly.length - 1].y - poly[0].y) < diag * 0.22
      ? poly.slice(0, -1)
      : poly;

  if (corners.length === 3 && ellipseErr > 0.14) {
    const closed = [...corners, corners[0]];
    return {
      kind: 'triangle',
      snappedPoints: interpolatePolyline(closed, 4, mkPt),
    };
  }

  if (corners.length === 4 && ellipseErr > 0.12) {
    // Snap to clean axis-aligned rectangle if close to upright, else preserve 4 corners
    const rectPts = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.minY },
    ];
    return {
      kind: 'rectangle',
      snappedPoints: interpolatePolyline(rectPts, 4, mkPt),
    };
  }

  if (ellipseErr < 0.22) {
    // Snap near-circular ellipses to perfect circle
    const isCircle = Math.abs(rx - ry) / Math.max(rx, ry) < 0.16;
    const finalRx = isCircle ? (rx + ry) / 2 : rx;
    const finalRy = isCircle ? (rx + ry) / 2 : ry;
    const segs = 48;
    const snapped: StrokePoint[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      snapped.push(mkPt(cx + Math.cos(a) * finalRx, cy + Math.sin(a) * finalRy, i, segs + 1));
    }
    return { kind: 'ellipse', snappedPoints: snapped };
  }

  return null;
}

function interpolatePolyline(
  verts: Array<{ x: number; y: number }>,
  stepsPerEdge: number,
  mkPt: (x: number, y: number, idx: number, total: number) => StrokePoint
): StrokePoint[] {
  const out: StrokePoint[] = [];
  const total = (verts.length - 1) * stepsPerEdge + 1;
  let idx = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i];
    const b = verts[i + 1];
    for (let s = 0; s < stepsPerEdge; s++) {
      const t = s / stepsPerEdge;
      out.push(mkPt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, idx++, total));
    }
  }
  const last = verts[verts.length - 1];
  out.push(mkPt(last.x, last.y, idx, total));
  return out;
}

export function douglasPeucker(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.sqrt(pointToSegmentDistSq(points[i].x, points[i].y, first.x, first.y, last.x, last.y));
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/**
 * Hit-tests a stroke against a circular probe (eraser or audio tap-to-seek).
 */
export function hitTestStroke(stroke: VectorStroke, x: number, y: number, radius: number): boolean {
  const r = radius + stroke.width * 0.5;
  if (
    x < stroke.bbox.minX - r ||
    x > stroke.bbox.maxX + r ||
    y < stroke.bbox.minY - r ||
    y > stroke.bbox.maxY + r
  ) {
    return false;
  }
  const rSq = r * r;
  const pts = stroke.points;
  if (pts.length === 1) {
    const dx = x - pts[0].x;
    const dy = y - pts[0].y;
    return dx * dx + dy * dy <= rSq;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (pointToSegmentDistSq(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= rSq) {
      return true;
    }
  }
  return false;
}

/**
 * Analytical Precision / Partial Vector Eraser (FR-INK-03).
 * Splits a vector stroke wherever points fall inside the eraser circle, returning 0, 1, or N
 * clean vector child strokes (never using bitmap masks, preserving vector PDF export).
 */
export function partialEraseStroke(
  stroke: VectorStroke,
  cx: number,
  cy: number,
  radius: number,
  makeId: () => string
): VectorStroke[] | null {
  if (!hitTestStroke(stroke, cx, cy, radius)) return null;
  const rSq = (radius + stroke.width * 0.35) ** 2;
  const chunks: StrokePoint[][] = [];
  let current: StrokePoint[] = [];

  for (const pt of stroke.points) {
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    if (dx * dx + dy * dy <= rSq) {
      if (current.length >= 2) {
        chunks.push(current);
      }
      current = [];
    } else {
      current.push(pt);
    }
  }
  if (current.length >= 2) {
    chunks.push(current);
  }

  return chunks.map((pts) => ({
    ...stroke,
    id: makeId(),
    points: pts,
    bbox: computeBBox(pts, stroke.width),
  }));
}

/**
 * Point-in-polygon ray casting for freeform Lasso selection (FR-INK-04).
 */
export function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function strokeInLasso(stroke: VectorStroke, polygon: Array<{ x: number; y: number }>): boolean {
  if (polygon.length < 3) return false;
  let hits = 0;
  const step = Math.max(1, Math.floor(stroke.points.length / 12));
  let checked = 0;
  for (let i = 0; i < stroke.points.length; i += step) {
    checked++;
    if (pointInPolygon(stroke.points[i].x, stroke.points[i].y, polygon)) {
      hits++;
    }
  }
  return checked > 0 && hits / checked >= 0.45;
}

/**
 * Detects a rapid 3-oscillation scribble-scratch gesture (optional quick erase replacement for
 * Apple Pencil double-tap on WebKit).
 */
export function isScribbleEraseGesture(points: StrokePoint[]): boolean {
  if (points.length < 14) return false;
  let directionChanges = 0;
  let lastSign = 0;
  let totalDist = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalDist += Math.hypot(dx, dy);
    if (Math.abs(dx) > 3) {
      const sign = Math.sign(dx);
      if (lastSign !== 0 && sign !== lastSign) {
        directionChanges++;
      }
      lastSign = sign;
    }
  }
  const bbox = computeBBox(points, 0);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  return directionChanges >= 4 && w > 18 && w < 220 && h < 90 && totalDist > w * 2.8;
}

/**
 * Fractional indexing helper for O(1) page insertion & reordering without re-indexing strokes.
 */
export function generateOrderKey(prev?: string | null, next?: string | null): string {
  const a = prev ? parseFloat(prev) : 0;
  const b = next ? parseFloat(next) : a + 1000;
  return String((a + b) / 2);
}

/**
 * 2nd-Order Curvature-Damped Kinematic Stylus Predictor.
 *
 * Compensates for the ~12–16 ms WebProcess -> GPUProcess -> UIProcess presentation pipeline
 * AND works around WebKit Bug 284852 (WKTouchEventsGestureRecognizer.mm:372), where iPadOS
 * drops `getPredictedEvents()` whenever a resting palm occupies `touchIndex == 0`.
 *
 * Strictly transient: predicted points are rendered only at the live wet-ink tip and
 * replaced on the very next frame by true 240 Hz Apple Pencil samples.
 */
export class StylusKinematicPredictor {
  private history: Array<{ x: number; y: number; pressure: number; tMs: number }> = [];
  private vx = 0;
  private vy = 0;
  private ax = 0;
  private ay = 0;

  reset(): void {
    this.history.length = 0;
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;
  }

  pushSample(pt: StrokePoint, tMs: number): void {
    const n = this.history.length;
    if (n > 0) {
      const prev = this.history[n - 1];
      const dt = Math.max(2.5, tMs - prev.tMs);
      const instVx = (pt.x - prev.x) / dt;
      const instVy = (pt.y - prev.y) / dt;

      if (n === 1) {
        this.vx = instVx;
        this.vy = instVy;
      } else {
        const nextVx = 0.62 * instVx + 0.38 * this.vx;
        const nextVy = 0.62 * instVy + 0.38 * this.vy;
        const instAx = (nextVx - this.vx) / dt;
        const instAy = (nextVy - this.vy) / dt;
        this.ax = 0.45 * instAx + 0.55 * this.ax;
        this.ay = 0.45 * instAy + 0.55 * this.ay;
        this.vx = nextVx;
        this.vy = nextVy;
      }
    }

    this.history.push({ x: pt.x, y: pt.y, pressure: pt.pressure, tMs });
    if (this.history.length > 6) {
      this.history.shift();
    }
  }

  predict(
    lastPoint: StrokePoint,
    nativePredicted: StrokePoint[],
    lookaheadMs: number
  ): StrokePoint[] {
    if (lookaheadMs <= 0 || this.history.length < 2) {
      return nativePredicted;
    }

    const speed = Math.hypot(this.vx, this.vy); // pt / ms (e.g. 0.5 = 500 pt/s)
    if (speed < 0.035) {
      // Near-stationary (<35 pt/s): avoid micro-jitter while holding to snap shapes
      return [];
    }

    // Curvature attenuation so sharp corners/hooks never overshoot
    const cross = Math.abs(this.vx * this.ay - this.vy * this.ax);
    const curvature = cross / Math.max(speed * speed * speed, 1e-4);
    const turnDamping = Math.max(0.28, Math.min(1.0, 1 / (1 + 140 * curvature * speed)));

    const horizonMs = lookaheadMs * turnDamping;
    const accelWeight = 0.32 * turnDamping;
    const maxLeadPt = Math.min(34, speed * horizonMs * 1.25 + 2);

    const steps = 3;
    const out: StrokePoint[] = [];

    for (let i = 1; i <= steps; i++) {
      const frac = i / steps;
      const dt = horizonMs * frac;
      let dx = this.vx * dt + 0.5 * this.ax * accelWeight * dt * dt;
      let dy = this.vy * dt + 0.5 * this.ay * accelWeight * dt * dt;

      const dist = Math.hypot(dx, dy);
      const stepCap = maxLeadPt * frac;
      if (dist > stepCap && dist > 1e-5) {
        dx = (dx / dist) * stepCap;
        dy = (dy / dist) * stepCap;
      }

      let px = lastPoint.x + dx;
      let py = lastPoint.y + dy;

      // Blend with UIKit's native predictedTouches when available (e.g. first ~8ms step)
      if (i <= nativePredicted.length) {
        const np = nativePredicted[i - 1];
        px = 0.45 * np.x + 0.55 * px;
        py = 0.45 * np.y + 0.55 * py;
      }

      // Gently taper tip pressure slightly on final predicted sub-point for natural nib feel
      const tipPressure = Math.max(0.15, lastPoint.pressure * (1 - 0.08 * frac));

      out.push({
        x: px,
        y: py,
        pressure: tipPressure,
        altitude: lastPoint.altitude,
        azimuth: lastPoint.azimuth,
        dtMs: lastPoint.dtMs + Math.round(dt),
      });
    }

    return out;
  }
}
