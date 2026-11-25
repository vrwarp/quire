import type { StrokePoint } from '../types';

/**
 * 240 Hz Apple Pencil & Gesture Arbitrator.
 *
 * - Extracts full 240 Hz coalesced stylus samples (`getCoalescedEvents()`) and UIKit
 *   trajectory predictions (`getPredictedEvents()`), plus `pressure`, `altitudeAngle`,
 *   and `azimuthAngle` (Safari 18.2+ / iPadOS 18.2+).
 * - De-quantizes WebKit's 1ms Spectre-rounded `timeStamp` across coalesced 240 Hz sub-samples
 *   so velocity/acceleration derivatives remain smooth at 4.167 ms sub-frame intervals.
 * - Enforces left- & right-handed palm rejection during active pen contact plus a 250 ms
 *   cooldown guard window so wrist touches never trigger accidental taps or pan jumps.
 */

import { pointToSegmentDistSq } from './inkMath';

export interface UnpackedStylusBatch {
  coalesced: Array<{ point: StrokePoint; exactTimeMs: number }>;
  predicted: StrokePoint[];
  maxRawTimeStamp: number;
}

/**
 * Strips overlapping historical `coalescedTouchesForTouch` windows concatenated by WebKit's
 * `EventDispatcher::touchEvent` (`EventDispatcher.cpp:255`), which otherwise jump backward
 * onto an already-recorded curve segment and create a straight-chord "double line" lens.
 */
export function filterCoalescedReplayPoints<T extends { point: StrokePoint }>(
  candidates: T[],
  committedPoints: StrokePoint[]
): T[] {
  if (candidates.length === 0 || committedPoints.length < 4) {
    return candidates;
  }

  const out: T[] = [];
  let prev = committedPoints[committedPoints.length - 1];
  const prev2 = committedPoints[committedPoints.length - 2];
  let dirX = prev.x - prev2.x;
  let dirY = prev.y - prev2.y;
  let dirLen = Math.hypot(dirX, dirY);
  if (dirLen > 1e-4) {
    dirX /= dirLen;
    dirY /= dirLen;
  }

  const recentStart = Math.max(0, committedPoints.length - 120);
  let skippingReplay = false;

  const isOnCommittedWake = (x: number, y: number, endExclusive: number): boolean => {
    for (let i = recentStart; i < endExclusive - 1; i++) {
      const a = committedPoints[i];
      const b = committedPoints[i + 1];
      if (pointToSegmentDistSq(x, y, a.x, a.y, b.x, b.y) <= 25.0) {
        // Within 5.0 pt of the already-recorded stroke ribbon
        return true;
      }
    }
    return false;
  };

  for (let idx = 0; idx < candidates.length; idx++) {
    const item = candidates[idx];
    const p = item.point;
    const stepX = p.x - prev.x;
    const stepY = p.y - prev.y;
    const stepDist = Math.hypot(stepX, stepY);

    if (skippingReplay) {
      if (stepDist < 0.15) {
        continue;
      }
      const forwardProj = stepX * dirX + stepY * dirY;
      // Stay in skippingReplay while re-tracing the already-committed wake behind `prev`;
      // resume immediately once a sample advances forward past the tip!
      if (forwardProj > 0.2 && !isOnCommittedWake(p.x, p.y, committedPoints.length)) {
        skippingReplay = false;
      } else if (isOnCommittedWake(p.x, p.y, committedPoints.length)) {
        continue;
      } else {
        skippingReplay = false;
      }
    } else if (stepDist > 10.0 && dirLen > 1e-4) {
      const dot = (stepX / stepDist) * dirX + (stepY / stepDist) * dirY;
      // Abrupt >10 pt backward jump directly onto our own recent wake = WebKit coalesced overlap!
      if (dot < -0.35 && isOnCommittedWake(p.x, p.y, committedPoints.length - 1)) {
        skippingReplay = true;
        continue;
      }
    }

    out.push(item);
    if (stepDist > 0.25) {
      dirX = stepX / stepDist;
      dirY = stepY / stepDist;
      dirLen = 1;
    }
    prev = p;
  }

  return out;
}

export class PalmRejectionGuard {
  private penActive = false;
  private lastPenUpAt = -Infinity;
  private readonly guardWindowMs: number;

  constructor(guardWindowMs = 250) {
    this.guardWindowMs = guardWindowMs;
  }

  notePenDown(): void {
    this.penActive = true;
  }

  notePenUp(): void {
    this.penActive = false;
    this.lastPenUpAt = performance.now();
  }

  shouldRejectTouch(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    if (this.penActive) return true;
    return performance.now() - this.lastPenUpAt < this.guardWindowMs;
  }
}

export function unpackPointerSamples(
  e: PointerEvent,
  toPageCoords: (clientX: number, clientY: number) => { x: number; y: number },
  strokeStartPerf: number,
  lastBatchPerf: number,
  lastRawTimeStamp = 0,
  committedPoints: StrokePoint[] = []
): UnpackedStylusBatch {
  const rawCoalesced =
    typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const rawList = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced : [e];

  // 1. Filter out non-monotonic or stale historical coalesced events from previous batches
  const monotonicList: PointerEvent[] = [];
  let maxSeenRawTs = lastRawTimeStamp;
  for (let i = 0; i < rawList.length; i++) {
    const pe = rawList[i];
    const ts = pe.timeStamp || 0;
    if (ts > 0) {
      // Strictly older than previous batch or older than an earlier sub-event in this batch -> stale replay!
      if (lastRawTimeStamp > 0 && ts < lastRawTimeStamp - 0.05) {
        continue;
      }
      if (ts < maxSeenRawTs - 0.05) {
        continue;
      }
      if (ts > maxSeenRawTs) {
        maxSeenRawTs = ts;
      }
    }
    monotonicList.push(pe);
  }
  const coalescedList = monotonicList.length > 0 ? monotonicList : [e];

  const rawPredicted =
    typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];

  const nowPerf = e.timeStamp || performance.now();
  if (nowPerf > maxSeenRawTs) maxSeenRawTs = nowPerf;
  const spanMs = Math.max(4.0, Math.min(24.0, nowPerf - lastBatchPerf));
  const count = coalescedList.length;

  const mapPoint = (pe: PointerEvent, exactTimeMs: number): StrokePoint => {
    const pt = toPageCoords(pe.clientX, pe.clientY);
    const anyPe = pe as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    return {
      x: pt.x,
      y: pt.y,
      pressure: pe.pointerType === 'pen' ? pe.pressure || 0.5 : 0.5,
      altitude: anyPe.altitudeAngle ?? Math.PI / 2,
      azimuth: anyPe.azimuthAngle ?? 0,
      dtMs: Math.max(0, Math.round(exactTimeMs - strokeStartPerf)),
    };
  };

  const hasDistinctSubframeTimestamps =
    count === 1
      ? Boolean(coalescedList[0].timeStamp && coalescedList[0].timeStamp > lastBatchPerf)
      : coalescedList.every((pe, idx) => {
          if (!pe.timeStamp) return false;
          const prevT = idx === 0 ? lastBatchPerf : coalescedList[idx - 1].timeStamp;
          return pe.timeStamp - prevT > 1.5;
        });

  const mappedCoalesced = coalescedList.map((pe, idx) => {
    const interpolatedTime = nowPerf - spanMs * ((count - 1 - idx) / count);
    const exactTimeMs = hasDistinctSubframeTimestamps ? pe.timeStamp : interpolatedTime;
    return {
      point: mapPoint(pe, exactTimeMs),
      exactTimeMs,
    };
  });

  const coalesced = filterCoalescedReplayPoints(mappedCoalesced, committedPoints);

  const predicted = rawPredicted.slice(0, 3).map((pe, idx) => {
    const predTime = nowPerf + (idx + 1) * 4.167;
    return mapPoint(pe, predTime);
  });

  return { coalesced, predicted, maxRawTimeStamp: maxSeenRawTs };
}

/**
 * Multi-finger tap recognizer for 2-finger Undo and 3-finger Redo (CUJ 2).
 */
export function attachMultiFingerUndoRedo(
  target: HTMLElement,
  handlers: { onUndo: () => void; onRedo: () => void }
): () => void {
  let maxTouches = 0;
  let startAt = 0;
  let movedTooFar = false;
  const startPositions = new Map<number, { x: number; y: number }>();

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      startAt = performance.now();
      movedTooFar = false;
      maxTouches = 1;
      startPositions.clear();
    }
    maxTouches = Math.max(maxTouches, e.touches.length);
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      startPositions.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const origin = startPositions.get(t.identifier);
      if (origin && Math.hypot(t.clientX - origin.x, t.clientY - origin.y) > 14) {
        movedTooFar = true;
      }
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length !== 0) return;
    const elapsed = performance.now() - startAt;
    if (!movedTooFar && elapsed < 260) {
      if (maxTouches === 2) handlers.onUndo();
      else if (maxTouches === 3) handlers.onRedo();
    }
    maxTouches = 0;
    startPositions.clear();
  };

  target.addEventListener('touchstart', onTouchStart, { passive: true });
  target.addEventListener('touchmove', onTouchMove, { passive: true });
  target.addEventListener('touchend', onTouchEnd, { passive: true });

  return () => {
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('touchend', onTouchEnd);
  };
}
