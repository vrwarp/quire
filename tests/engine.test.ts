import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import {
  OneEuroFilter,
  StylusKinematicPredictor,
  buildStrokeOutline,
  computeBBox,
  densifyStrokePoints,
  hitTestStroke,
  isScribbleEraseGesture,
  partialEraseStroke,
  recognizeShape,
  strokeInLasso,
} from '../src/engine/inkMath';
import { filterCoalescedReplayPoints, unpackPointerSamples } from '../src/engine/inputRouter';
import {
  DEFAULT_SETTINGS,
  createId,
  createNewNote,
  getFolderDepth,
  searchNotes,
} from '../src/engine/storage';
import { mergeNoteVersions } from '../src/engine/syncEngine';
import { exportNoteToQuireBundle, exportNoteToVectorPdf } from '../src/engine/exportEngine';
import { ProMotionGovernor } from '../src/engine/promotion';
import type { Folder, NoteDocument, StrokePoint, VectorStroke } from '../src/types';

function makePt(x: number, y: number, dtMs = 0, pressure = 0.6): StrokePoint {
  return { x, y, pressure, altitude: Math.PI / 2, azimuth: 0, dtMs };
}

describe('Quire Ink Math & Recognition Engine (FR-INK-01..05)', () => {
  it('smooths high-frequency jitter with OneEuroFilter while tracking motion', () => {
    const filter = new OneEuroFilter(1.4, 0.04);
    const out1 = filter.filter(100, 0);
    const out2 = filter.filter(102, 4);
    const out3 = filter.filter(99, 8);
    expect(out1).toBe(100);
    expect(Math.abs(out2 - 100)).toBeLessThan(2);
    expect(Math.abs(out3 - 100)).toBeLessThan(2);
  });

  it('builds closed variable-width vector ribbon outlines', () => {
    const pts = [makePt(10, 10, 0, 0.2), makePt(40, 20, 8, 0.8), makePt(80, 15, 16, 0.5)];
    const { left, right } = buildStrokeOutline(pts, 4, false);
    expect(left.length).toBeGreaterThanOrEqual(pts.length);
    expect(left.length).toBe(right.length);
  });

  it('snaps rough straight lines, rectangles, and circles (Hold-to-Snap FR-INK-05)', () => {
    // Straight line with small hand wobble
    const linePts = Array.from({ length: 12 }, (_, i) =>
      makePt(20 + i * 15, 50 + (i % 2 === 0 ? 1.5 : -1.5), i * 10)
    );
    const lineRes = recognizeShape(linePts);
    expect(lineRes?.kind).toBe('line');

    // Closed rectangle
    const rectPts = [
      makePt(10, 10, 0),
      makePt(60, 11, 10),
      makePt(110, 10, 20),
      makePt(111, 60, 30),
      makePt(110, 110, 40),
      makePt(60, 109, 50),
      makePt(10, 110, 60),
      makePt(9, 60, 70),
      makePt(11, 12, 80),
    ];
    const rectRes = recognizeShape(rectPts);
    expect(rectRes?.kind).toBe('rectangle');

    // Closed circle
    const circlePts = Array.from({ length: 36 }, (_, i) => {
      const a = (i / 35) * Math.PI * 2;
      return makePt(200 + Math.cos(a) * 50, 200 + Math.sin(a) * 50, i * 10);
    });
    const circleRes = recognizeShape(circlePts);
    expect(circleRes?.kind).toBe('ellipse');
  });

  it('splits a vector stroke cleanly into 2 child strokes with analytical partial eraser (FR-INK-03)', () => {
    const pts = Array.from({ length: 21 }, (_, i) => makePt(i * 10, 50, i * 8));
    const stroke: VectorStroke = {
      id: 'str_orig',
      pageId: 'pg_1',
      tool: 'pen',
      color: '#18181b',
      width: 3,
      points: pts,
      bbox: computeBBox(pts, 3),
    };
    expect(hitTestStroke(stroke, 100, 50, 12)).toBe(true);

    let seq = 0;
    const split = partialEraseStroke(stroke, 100, 50, 18, () => `str_child_${++seq}`);
    expect(split).not.toBeNull();
    expect(split!.length).toBe(2);
    expect(split![0].points[split![0].points.length - 1].x).toBeLessThan(85);
    expect(split![1].points[0].x).toBeGreaterThan(115);
  });

  it('selects strokes inside a freeform Lasso polygon (FR-INK-04)', () => {
    const insideStroke: VectorStroke = {
      id: 'str_in',
      pageId: 'pg_1',
      tool: 'pen',
      color: '#18181b',
      width: 3,
      points: [makePt(50, 50), makePt(70, 70), makePt(90, 50)],
      bbox: computeBBox([makePt(50, 50), makePt(90, 70)]),
    };
    const outsideStroke: VectorStroke = {
      ...insideStroke,
      id: 'str_out',
      points: [makePt(300, 300), makePt(320, 320)],
    };
    const poly = [
      { x: 20, y: 20 },
      { x: 140, y: 20 },
      { x: 140, y: 140 },
      { x: 20, y: 140 },
    ];
    expect(strokeInLasso(insideStroke, poly)).toBe(true);
    expect(strokeInLasso(outsideStroke, poly)).toBe(false);
  });

  it('detects rapid scribble-scratch gesture for quick erase', () => {
    const scribble: StrokePoint[] = [];
    for (let i = 0; i < 24; i++) {
      const x = i % 4 < 2 ? 100 + (i % 2) * 40 : 140 - (i % 2) * 40;
      scribble.push(makePt(x, 100 + i * 1.2, i * 12));
    }
    expect(isScribbleEraseGesture(scribble)).toBe(true);
  });
});

describe('Library Search & 5-Level Nested Folders (FR-ORG-02, FR-ORG-04)', () => {
  it('searches 500 notes across titles, folders, tags, and typed text in <300ms', () => {
    const folders: Folder[] = [
      { id: 'f1', name: 'Organic Chemistry', parentId: null, color: '#c85a32', createdAt: 1 },
    ];
    const notes: NoteDocument[] = Array.from({ length: 500 }, (_, i) => {
      const n = createNewNote(DEFAULT_SETTINGS, i === 250 ? 'f1' : null, `Lecture Note ${i}`);
      if (i === 400) {
        n.tags = ['exam-2'];
        const pid = n.pages[0].pageId;
        n.textBoxesByPage[pid] = [
          {
            id: 'tb1',
            pageId: pid,
            x: 20,
            y: 20,
            width: 200,
            height: 40,
            plainText: 'Thermodynamics entropy derivation',
            fontFamily: 'sans',
            fontSize: 15,
            color: '#18181b',
            bold: false,
            italic: false,
            underline: false,
            listMode: 'none',
          },
        ];
      }
      return n;
    });

    const t0 = performance.now();
    const byText = searchNotes(notes, folders, 'entropy');
    const byFolder = searchNotes(notes, folders, 'organic');
    const byTag = searchNotes(notes, folders, 'exam-2');
    const elapsed = performance.now() - t0;

    expect(byText.length).toBe(1);
    expect(byFolder.length).toBe(1);
    expect(byTag.length).toBe(1);
    expect(elapsed).toBeLessThan(300);
  });

  it('enforces accurate folder nesting depth up to 5 levels', () => {
    const folders: Folder[] = [
      { id: 'f1', name: 'L1', parentId: null, color: '#000', createdAt: 1 },
      { id: 'f2', name: 'L2', parentId: 'f1', color: '#000', createdAt: 1 },
      { id: 'f3', name: 'L3', parentId: 'f2', color: '#000', createdAt: 1 },
      { id: 'f4', name: 'L4', parentId: 'f3', color: '#000', createdAt: 1 },
      { id: 'f5', name: 'L5', parentId: 'f4', color: '#000', createdAt: 1 },
    ];
    expect(getFolderDepth('f1', folders)).toBe(1);
    expect(getFolderDepth('f5', folders)).toBe(5);
  });
});

describe('Non-Destructive Delta Sync & Vector Export (FR-SYN-01..03)', () => {
  it('preserves concurrent offline edits on the same page as a Conflict Copy (CUJ 6)', () => {
    const base = createNewNote(DEFAULT_SETTINGS, null, 'Physics Midterm');
    const pid = base.pages[0].pageId;

    const local: NoteDocument = {
      ...structuredClone(base),
      hlc: { ts: 1000, counter: 1, deviceId: 'dev_ipad' },
      strokesByPage: {
        [pid]: [
          {
            id: 'str_local',
            pageId: pid,
            tool: 'pen',
            color: '#18181b',
            width: 3,
            points: [makePt(10, 10), makePt(50, 50)],
            bbox: computeBBox([makePt(10, 10), makePt(50, 50)]),
          },
        ],
      },
    };
    const remote: NoteDocument = {
      ...structuredClone(base),
      hlc: { ts: 1005, counter: 1, deviceId: 'dev_mac' },
      strokesByPage: {
        [pid]: [
          {
            id: 'str_remote',
            pageId: pid,
            tool: 'pen',
            color: '#1d4ed8',
            width: 3,
            points: [makePt(80, 80), makePt(120, 120)],
            bbox: computeBBox([makePt(80, 80), makePt(120, 120)]),
          },
        ],
      },
    };

    const { merged, conflictCopy } = mergeNoteVersions(local, remote);
    expect(merged.strokesByPage[pid].some((s) => s.id === 'str_local')).toBe(true);
    expect(conflictCopy).not.toBeNull();
    expect(conflictCopy!.title).toContain('Conflict Copy');
    expect(conflictCopy!.strokesByPage[pid].some((s) => s.id === 'str_remote')).toBe(true);
  });

  it('exports valid Vector PDF with ink, multiply highlighter, and typed text (FR-SYN-03)', async () => {
    const note = createNewNote(DEFAULT_SETTINGS, null, 'Vector Export Test');
    const pid = note.pages[0].pageId;
    note.strokesByPage[pid] = [
      {
        id: createId('str'),
        pageId: pid,
        tool: 'highlighter',
        color: '#facc15',
        width: 18,
        points: [makePt(50, 100), makePt(250, 100)],
        bbox: computeBBox([makePt(50, 100), makePt(250, 100)]),
      },
      {
        id: createId('str'),
        pageId: pid,
        tool: 'pen',
        color: '#18181b',
        width: 3,
        points: [makePt(50, 100), makePt(150, 120), makePt(250, 100)],
        bbox: computeBBox([makePt(50, 100), makePt(250, 120)]),
      },
    ];
    note.textBoxesByPage[pid] = [
      {
        id: 'tb_export',
        pageId: pid,
        x: 60,
        y: 200,
        width: 240,
        height: 40,
        plainText: 'E = mc^2',
        fontFamily: 'sans',
        fontSize: 16,
        color: '#18181b',
        bold: true,
        italic: false,
        underline: false,
        listMode: 'none',
      },
    ];

    const pdfBytes = await exportNoteToVectorPdf(note, { includeBackground: true });
    expect(pdfBytes.byteLength).toBeGreaterThan(800);
    const parsed = await PDFDocument.load(pdfBytes);
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getTitle()).toBe('Vector Export Test');

    // Also verify lossless .quire archive bundle
    const bundleBytes = await exportNoteToQuireBundle(note);
    const entries = unzipSync(bundleBytes);
    expect(entries['manifest.json']).toBeDefined();
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.note.title).toBe('Vector Export Test');
    expect(manifest.note.strokesByPage[pid].length).toBe(2);
  });
});

describe('ProMotion 120 Hz Governor (WebKit Bypass Primitives)', () => {
  it('mounts rate-mark and display-pacer on wake() and parks cleanly', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const gov = new ProMotionGovernor(host, { holdMs: 500 });

    expect(host.querySelector('.quire-scroll-keep')).not.toBeNull();
    expect(gov.isActive).toBe(false);

    gov.wake();
    expect(gov.isActive).toBe(true);
    expect(host.querySelector('.quire-rate-mark')).not.toBeNull();
    expect(host.querySelector('.quire-display-pacer')).not.toBeNull();

    gov.park();
    expect(gov.isActive).toBe(false);
    expect(host.querySelector('.quire-rate-mark')).toBeNull();
    expect(host.querySelector('.quire-display-pacer')).toBeNull();

    gov.dispose();
    host.remove();
  });
});

describe('Apple Pencil Low-Latency Pipeline (Kinematic Predictor & 240 Hz De-Quantizer)', () => {
  it('synthesizes transient 16ms lookahead points even when WebKit Bug 284852 drops nativePredicted', () => {
    const predictor = new StylusKinematicPredictor();
    // Simulate steady 240 Hz stroke moving +4 pt every 4.167 ms (~960 pt/s)
    const p0 = makePt(100, 200, 0, 0.65);
    const p1 = makePt(104, 200, 4, 0.65);
    const p2 = makePt(108, 200, 8, 0.65);
    predictor.pushSample(p0, 1000.0);
    predictor.pushSample(p1, 1004.167);
    predictor.pushSample(p2, 1008.333);

    const tip = predictor.predict(p2, [], 16);
    expect(tip.length).toBe(3);
    expect(tip[0].x).toBeGreaterThan(p2.x);
    expect(tip[2].x).toBeGreaterThan(tip[0].x);
    expect(tip[2].x - p2.x).toBeGreaterThan(10);
    expect(tip[2].x - p2.x).toBeLessThanOrEqual(34);
  });

  it('attenuates lookahead on sharp high-curvature turns and suppresses jitter when stationary', () => {
    const straight = new StylusKinematicPredictor();
    straight.pushSample(makePt(0, 0, 0), 0);
    straight.pushSample(makePt(6, 0, 4), 4);
    const lastStraight = makePt(12, 0, 8);
    straight.pushSample(lastStraight, 8);
    const straightLead = Math.hypot(
      straight.predict(lastStraight, [], 16)[2].x - lastStraight.x,
      straight.predict(lastStraight, [], 16)[2].y - lastStraight.y
    );

    const corner = new StylusKinematicPredictor();
    corner.pushSample(makePt(0, 0, 0), 0);
    corner.pushSample(makePt(6, 0, 4), 4);
    const lastCorner = makePt(6, 6, 8);
    corner.pushSample(lastCorner, 8);
    const cornerTip = corner.predict(lastCorner, [], 16);
    const cornerLead = Math.hypot(
      cornerTip[2].x - lastCorner.x,
      cornerTip[2].y - lastCorner.y
    );
    expect(cornerLead).toBeLessThan(straightLead);

    // Near-stationary hold (<35 pt/s) returns empty prediction so Hold-to-Snap never wobbles
    const stationary = new StylusKinematicPredictor();
    stationary.pushSample(makePt(50, 50, 0), 0);
    stationary.pushSample(makePt(50.05, 50.02, 20), 20);
    expect(stationary.predict(makePt(50.05, 50.02, 20), [], 16)).toEqual([]);
  });

  it('de-quantizes duplicate 1ms-rounded WebKit coalesced timestamps across 240 Hz sub-samples', () => {
    const sub0 = {
      clientX: 100,
      clientY: 200,
      pointerType: 'pen',
      pressure: 0.6,
      timeStamp: 1008,
    } as unknown as PointerEvent;
    const sub1 = {
      clientX: 104,
      clientY: 200,
      pointerType: 'pen',
      pressure: 0.7,
      timeStamp: 1008,
    } as unknown as PointerEvent;
    const batchEvent = {
      clientX: 104,
      clientY: 200,
      pointerType: 'pen',
      pressure: 0.7,
      timeStamp: 1008,
      getCoalescedEvents: () => [sub0, sub1],
      getPredictedEvents: () => [],
    } as unknown as PointerEvent;

    const unpacked = unpackPointerSamples(
      batchEvent,
      (cx, cy) => ({ x: cx, y: cy }),
      1000,
      1000
    );
    expect(unpacked.coalesced.length).toBe(2);
    expect(unpacked.coalesced[0].exactTimeMs).toBeCloseTo(1004, 2);
    expect(unpacked.coalesced[1].exactTimeMs).toBeCloseTo(1008, 2);
  });

  it('strips overlapping WebKit coalescedTouchesForTouch replay windows (no double-line chord) while preserving real loops', () => {
    // Smooth curve from top-right to bottom-left
    const curve: StrokePoint[] = Array.from({ length: 40 }, (_, i) => {
      const u = i / 39;
      return makePt(460 - 270 * Math.sin(u * 1.35), 80 + 480 * u, i * 4);
    });

    const alreadyCommitted = curve.slice(0, 29); // indices 0..28
    // Simulate WebKit EventDispatcher.cpp:255 concatenating overlapping [15..28] + [29..36]
    const overlappingBatch = [...curve.slice(15, 29), ...curve.slice(29, 37)].map((point, idx) => ({
      point,
      exactTimeMs: 200 + idx * 4,
    }));

    const cleaned = filterCoalescedReplayPoints(overlappingBatch, alreadyCommitted);
    expect(cleaned.map((c) => c.point)).toEqual(curve.slice(29, 37));

    // Verify intentional figure-8 / loop crossing smoothly at 240 Hz is NOT stripped
    const loopPts: StrokePoint[] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return makePt(200 + Math.sin(a) * 40, 200 + Math.sin(2 * a) * 30, i * 4);
    });
    const loopCommitted = loopPts.slice(0, 24);
    const loopNext = loopPts.slice(24).map((point, idx) => ({ point, exactTimeMs: 100 + idx * 4 }));
    expect(filterCoalescedReplayPoints(loopNext, loopCommitted).length).toBe(loopNext.length);
  });

  it('produces zero overshoot horns across extreme 60x segment-length transitions via Centripetal Catmull-Rom', () => {
    const pts: StrokePoint[] = [];
    for (let i = 0; i < 10; i++) pts.push(makePt(400 - i * 3.5, 100 + i * 2));
    // 60x jump followed immediately by 3.5pt dense points (previously caused a 12pt overshoot horn!)
    for (let i = 0; i < 10; i++) pts.push(makePt(210 - i * 2, 290 + i * 3.5));

    const dense = densifyStrokePoints(pts, 3);
    for (let i = 1; i < dense.length; i++) {
      // Strictly monotonic x decreasing & y increasing — zero backward horn or loop!
      expect(dense[i].x).toBeLessThanOrEqual(dense[i - 1].x + 1e-4);
      expect(dense[i].y).toBeGreaterThanOrEqual(dense[i - 1].y - 1e-4);
    }
  });
});


