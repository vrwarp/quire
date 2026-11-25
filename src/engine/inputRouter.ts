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

export interface UnpackedStylusBatch {
  coalesced: Array<{ point: StrokePoint; exactTimeMs: number }>;
  predicted: StrokePoint[];
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
  lastBatchPerf: number
): UnpackedStylusBatch {
  const rawCoalesced =
    typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const coalescedList = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced : [e];

  const rawPredicted =
    typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];

  const nowPerf = e.timeStamp || performance.now();
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

  const coalesced = coalescedList.map((pe, idx) => {
    // Spread 240 Hz coalesced sub-samples smoothly across the frame interval when WebKit
    // rounds or duplicates pe.timeStamp across coalesced events.
    const interpolatedTime = nowPerf - spanMs * ((count - 1 - idx) / count);
    const exactTimeMs = hasDistinctSubframeTimestamps ? pe.timeStamp : interpolatedTime;
    return {
      point: mapPoint(pe, exactTimeMs),
      exactTimeMs,
    };
  });

  const predicted = rawPredicted.slice(0, 3).map((pe, idx) => {
    const predTime = nowPerf + (idx + 1) * 4.167;
    return mapPoint(pe, predTime);
  });

  return { coalesced, predicted };
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
