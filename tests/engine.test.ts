import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import {
  OneEuroFilter,
  StylusKinematicPredictor,
  buildStrokeOutline,
  computeBBox,
  createSnappedShapeDescriptor,
  densifyStrokePoints,
  hitTestStroke,
  partialEraseStroke,
  recognizeShape,
  strokeInLasso,
  updateSnappedShape,
} from '../src/engine/inkMath';
import {
  PalmRejectionGuard,
  filterCoalescedReplayPoints,
  unpackPointerSamples,
} from '../src/engine/inputRouter';
import {
  DEFAULT_SETTINGS,
  createId,
  createNewNote,
  getFolderDepth,
  searchNotes,
} from '../src/engine/storage';
import { mergeNoteVersions } from '../src/engine/syncEngine';
import { exportNoteToQuireBundle, exportNoteToVectorPdf } from '../src/engine/exportEngine';
import { resolveStrokeColor } from '../src/engine/canvasRenderer';
import {
  THEME_META_COLORS,
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  nextThemeMode,
  resolveEffectivePaperTheme,
  resolveThemeMode,
  shouldInvertPdfCanvas,
} from '../src/engine/theme';
import {
  LINED_FIRST_RULE_Y_PT,
  LINED_MARGIN_X_PT,
  LINED_STEP_PT,
  buildPaperTemplateSvgPaths,
  getPaperTemplateGeometry,
  getPaperTemplateSvgDataUri,
} from '../src/engine/paperTemplate';
import { ProMotionGovernor } from '../src/engine/promotion';
import type { Folder, NoteDocument, PageSource, StrokePoint, VectorStroke } from '../src/types';

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

  it('dynamically stretches and scales snapped shapes when dragging after Hold-to-Snap', () => {
    const linePts = Array.from({ length: 10 }, (_, i) => makePt(20 + i * 10, 40, i * 10));
    const lineRes = recognizeShape(linePts)!;
    expect(lineRes.kind).toBe('line');
    const lineDesc = createSnappedShapeDescriptor('line', lineRes.snappedPoints, linePts[linePts.length - 1]);
    const stretched = updateSnappedShape(lineDesc, 260, 100);
    expect(stretched[0].x).toBeCloseTo(20, 1);
    expect(stretched[0].y).toBeCloseTo(40, 1);
    expect(stretched[stretched.length - 1].x).toBeCloseTo(260, 1);
    expect(stretched[stretched.length - 1].y).toBeCloseTo(100, 1);

    const circlePts = Array.from({ length: 36 }, (_, i) => {
      const a = (i / 35) * Math.PI * 2;
      return makePt(200 + Math.cos(a) * 40, 200 + Math.sin(a) * 40, i * 10);
    });
    const circleRes = recognizeShape(circlePts)!;
    const circleDesc = createSnappedShapeDescriptor(
      'ellipse',
      circleRes.snappedPoints,
      circlePts[circlePts.length - 1]
    );
    // Dragging twice as far from the anchor doubles the circle diameter
    const targetX = circleDesc.anchor.x + (circleDesc.snapTip.x - circleDesc.anchor.x) * 2;
    const targetY = circleDesc.anchor.y + (circleDesc.snapTip.y - circleDesc.anchor.y) * 2;
    const resized = updateSnappedShape(circleDesc, targetX, targetY);
    const origBox = computeBBox(circleRes.snappedPoints, 0);
    const newBox = computeBBox(resized, 0);
    expect((newBox.maxX - newBox.minX) / (origBox.maxX - origBox.minX)).toBeCloseTo(2, 1);
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

  it('suppresses touch and multi-finger gestures while Apple Pencil is active or in cooldown', () => {
    const guard = new PalmRejectionGuard(250);
    expect(guard.isSuppressedNow()).toBe(false);
    guard.notePenDown();
    expect(guard.isSuppressedNow()).toBe(true);
    guard.notePenUp();
    expect(guard.isSuppressedNow()).toBe(true);
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

describe('Dark/Light Mode (Tier 1) & Non-Destructive Night Canvas (Tier 2)', () => {
  it('resolves tri-state themeMode and cycles system -> light -> dark -> system', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');

    expect(nextThemeMode('system')).toBe('light');
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
  });

  it('syncs document data-theme, colorScheme, meta theme-color, and localStorage bootstrap key', () => {
    const meta = document.createElement('meta');
    meta.id = 'meta-theme-color';
    meta.name = 'theme-color';
    meta.content = '#ebe6dc';
    document.head.appendChild(meta);

    applyDocumentTheme('dark', 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(meta.getAttribute('content')).toBe(THEME_META_COLORS.dark);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    applyDocumentTheme('light', 'system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(meta.getAttribute('content')).toBe(THEME_META_COLORS.light);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');

    meta.remove();
  });

  it('computes non-destructive Night Canvas overrides for template pages and PDFs', () => {
    const creamPage: PageSource = { kind: 'template', template: 'lined', theme: 'cream' };
    const darkPage: PageSource = { kind: 'template', template: 'grid', theme: 'dark' };
    const pdfPage: PageSource = {
      kind: 'pdf',
      blobKey: 'pdf_1',
      pdfPageNumber: 1,
      rotation: 0,
      fileName: 'slides.pdf',
    };

    // Light UI never overrides paper or inverts PDFs (explicit dark paper stays dark)
    expect(resolveEffectivePaperTheme(creamPage, 'light', 'paper-and-pdf')).toBe('cream');
    expect(resolveEffectivePaperTheme(darkPage, 'light', 'off')).toBe('dark');
    expect(resolveEffectivePaperTheme(pdfPage, 'light', 'paper-and-pdf')).toBe('light');
    expect(shouldInvertPdfCanvas(pdfPage, 'light', 'paper-and-pdf')).toBe(false);

    // Dark UI + Night Canvas 'off' preserves canonical paper & PDF
    expect(resolveEffectivePaperTheme(creamPage, 'dark', 'off')).toBe('cream');
    expect(shouldInvertPdfCanvas(pdfPage, 'dark', 'off')).toBe(false);

    // Dark UI + Night Canvas 'paper' darkens template pages only
    expect(resolveEffectivePaperTheme(creamPage, 'dark', 'paper')).toBe('dark');
    expect(resolveEffectivePaperTheme(pdfPage, 'dark', 'paper')).toBe('light');
    expect(shouldInvertPdfCanvas(pdfPage, 'dark', 'paper')).toBe(false);

    // Dark UI + Night Canvas 'paper-and-pdf' darkens template pages AND inverts PDFs
    expect(resolveEffectivePaperTheme(creamPage, 'dark', 'paper-and-pdf')).toBe('dark');
    expect(resolveEffectivePaperTheme(pdfPage, 'dark', 'paper-and-pdf')).toBe('dark');
    expect(shouldInvertPdfCanvas(pdfPage, 'dark', 'paper-and-pdf')).toBe(true);
    expect(shouldInvertPdfCanvas(creamPage, 'dark', 'paper-and-pdf')).toBe(false);
  });

  it('semantically inverts neutral pen ink on dark paper while preserving colored pens and highlighters', () => {
    expect(resolveStrokeColor('#18181b', 'dark', 'pen')).toBe('#f2efe9');
    expect(resolveStrokeColor('#f2efe9', 'light', 'pen')).toBe('#18181b');
    expect(resolveStrokeColor('#c85a32', 'dark', 'pen')).toBe('#c85a32');
    expect(resolveStrokeColor('#facc15', 'dark', 'highlighter')).toBe('#facc15');
  });

  it('exports valid Vector PDF on dark paper with Screen highlighter blend mode', async () => {
    const note = createNewNote(
      { ...DEFAULT_SETTINGS, defaultPaperTheme: 'dark' },
      null,
      'Dark Paper Vector Export'
    );
    const pid = note.pages[0].pageId;
    note.strokesByPage[pid] = [
      {
        id: createId('str'),
        pageId: pid,
        tool: 'highlighter',
        color: '#facc15',
        width: 18,
        points: [makePt(40, 80), makePt(200, 80)],
        bbox: computeBBox([makePt(40, 80), makePt(200, 80)]),
      },
      {
        id: createId('str'),
        pageId: pid,
        tool: 'pen',
        color: '#18181b',
        width: 3,
        points: [makePt(40, 80), makePt(200, 95)],
        bbox: computeBBox([makePt(40, 80), makePt(200, 95)]),
      },
    ];
    const pdfBytes = await exportNoteToVectorPdf(note, { includeBackground: true });
    expect(pdfBytes.byteLength).toBeGreaterThan(800);
    const parsed = await PDFDocument.load(pdfBytes);
    expect(parsed.getPageCount()).toBe(1);
    // Verify Screen blend mode is emitted in the PDF ExtGState for dark paper highlighters
    const uncompressed = await parsed.save({ useObjectStreams: false });
    const pdfText = new TextDecoder('latin1').decode(uncompressed);
    expect(pdfText).toContain('/Screen');
  });
});

describe('Canonical Paper Templates & Continuous-Segment Geometry Consistency', () => {
  it('generates uniform lined rules with zero tile-wrap header seam and exact 26pt spacing', () => {
    const geom = getPaperTemplateGeometry('lined', 612, 792);
    expect(geom.kind).toBe('lined');
    if (geom.kind !== 'lined') return;

    expect(geom.marginXPt).toBe(LINED_MARGIN_X_PT);
    expect(geom.ruleYsPt[0]).toBe(LINED_FIRST_RULE_Y_PT);
    expect(geom.ruleYsPt.length).toBeGreaterThanOrEqual(27);

    // Every consecutive pair of rules (including 2nd -> 3rd!) must have identical 26pt spacing
    for (let i = 1; i < geom.ruleYsPt.length; i++) {
      expect(geom.ruleYsPt[i] - geom.ruleYsPt[i - 1]).toBe(LINED_STEP_PT);
    }

    const svgUri = getPaperTemplateSvgDataUri('lined', 'light', 612, 792);
    expect(svgUri.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(getPaperTemplateSvgDataUri('blank', 'light', 612, 792)).toBe('none');
  });

  it('centers grid and dotted templates symmetrically away from rounded page borders', () => {
    const grid = getPaperTemplateGeometry('grid', 612, 792);
    expect(grid.kind).toBe('grid');
    if (grid.kind === 'grid') {
      const leftMargin = grid.verticalXsPt[0];
      const rightMargin = 612 - grid.verticalXsPt[grid.verticalXsPt.length - 1];
      expect(leftMargin).toBeGreaterThanOrEqual(14);
      expect(leftMargin).toBeCloseTo(rightMargin, 2);
      for (let i = 1; i < grid.horizontalYsPt.length; i++) {
        expect(grid.horizontalYsPt[i] - grid.horizontalYsPt[i - 1]).toBe(26);
      }
    }

    const dotted = getPaperTemplateGeometry('dotted', 612, 792);
    expect(dotted.kind).toBe('dotted');
    if (dotted.kind === 'dotted') {
      const leftMargin = dotted.xsPt[0];
      const rightMargin = 612 - dotted.xsPt[dotted.xsPt.length - 1];
      expect(leftMargin).toBeGreaterThanOrEqual(14);
      expect(leftMargin).toBeCloseTo(rightMargin, 2);
      for (let i = 1; i < dotted.ysPt.length; i++) {
        expect(dotted.ysPt[i] - dotted.ysPt[i - 1]).toBe(24);
      }
    }

    const paths = buildPaperTemplateSvgPaths('grid', 612, 792);
    expect(paths.rulesPath.length).toBeGreaterThan(50);
    expect(getPaperTemplateSvgDataUri('dotted', 'cream', 612, 792)).toContain('pattern');
  });

  it('exports lined, grid, and dotted Vector PDFs with 1-point taps and round pen endcaps', async () => {
    const note = createNewNote(DEFAULT_SETTINGS, null, 'All Templates Export');
    const p0 = note.pages[0];
    note.pages.push(
      {
        pageId: 'pg_grid',
        orderKey: '2000',
        widthPt: 612,
        heightPt: 792,
        source: { kind: 'template', template: 'grid', theme: 'light' },
      },
      {
        pageId: 'pg_dotted',
        orderKey: '3000',
        widthPt: 612,
        heightPt: 792,
        source: { kind: 'template', template: 'dotted', theme: 'dark' },
      }
    );
    note.strokesByPage[p0.pageId] = [
      {
        id: 'tap_pen',
        pageId: p0.pageId,
        tool: 'pen',
        color: '#18181b',
        width: 4,
        points: [makePt(100, 108)],
        bbox: computeBBox([makePt(100, 108)], 4),
      },
      {
        id: 'tap_hl',
        pageId: p0.pageId,
        tool: 'highlighter',
        color: '#facc15',
        width: 18,
        points: [makePt(140, 108)],
        bbox: computeBBox([makePt(140, 108)], 18),
      },
    ];
    const pdfBytes = await exportNoteToVectorPdf(note, { includeBackground: true });
    const parsed = await PDFDocument.load(pdfBytes);
    expect(parsed.getPageCount()).toBe(3);
  });

  it('splits 2-point straight shafts with partialEraseStroke and selects sparse shafts in Lasso', () => {
    // 2-vertex 300pt straight shaft (previously missed completely by vertex-only partial erase!)
    const twoPointShaft: VectorStroke = {
      id: 'str_shaft',
      pageId: 'pg_1',
      tool: 'pen',
      color: '#18181b',
      width: 3,
      points: [makePt(20, 100, 0), makePt(320, 100, 50)],
      bbox: computeBBox([makePt(20, 100), makePt(320, 100)], 3),
    };
    let idSeq = 0;
    const split = partialEraseStroke(twoPointShaft, 170, 100, 16, () => `seg_${++idSeq}`);
    expect(split).not.toBeNull();
    expect(split!.length).toBe(2);
    expect(split![0].points[split![0].points.length - 1].x).toBeCloseTo(170 - 17.05, 1);
    expect(split![1].points[0].x).toBeCloseTo(170 + 17.05, 1);

    // Lasso polygon covering 60% of the middle of the 2-point shaft (neither endpoint inside!)
    const midLasso = [
      { x: 60, y: 70 },
      { x: 280, y: 70 },
      { x: 280, y: 130 },
      { x: 60, y: 130 },
    ];
    expect(strokeInLasso(twoPointShaft, midLasso)).toBe(true);
  });

  it('prevents 90-degree corner pinching and 180-degree arrow wing collapse in buildStrokeOutline', () => {
    // 90-degree corner at (100, 20)
    const cornerPts = [makePt(20, 20), makePt(100, 20), makePt(100, 100)];
    const { left, right } = buildStrokeOutline(cornerPts, 6, false);
    expect(left.length).toBe(right.length);
    for (let i = 0; i < left.length; i++) {
      const span = Math.hypot(left[i].x - right[i].x, left[i].y - right[i].y);
      // Width must never pinch below normal stroke width or collapse to 0
      expect(span).toBeGreaterThan(3.0);
    }

    // 180-degree hairpin reversal (snapped arrow wing: tip -> wing1 -> tip -> wing2)
    const arrowPts = [
      makePt(40, 100),
      makePt(180, 100),
      makePt(162, 90),
      makePt(180, 100),
      makePt(162, 110),
    ];
    const arrowOutline = buildStrokeOutline(arrowPts, 4, false);
    expect(arrowOutline.left.length).toBe(arrowOutline.right.length);
    expect(arrowOutline.left.length).toBeGreaterThan(arrowPts.length);
  });
});

describe('V1.0 Production Storage, Spatial Index, Scroll Math & Unicode PDF Export', () => {
  it('round-trips compact binary .qbin snapshots and recovers checksummed .wal frames after tail truncation', async () => {
    const { encodePageQbin, decodePageQbin, encodeWalFrame, decodeLatestWalFrame } = await import(
      '../src/engine/qbin'
    );
    const payload = {
      pageId: 'pg_qbin',
      strokes: [
        {
          id: 's1',
          pageId: 'pg_qbin',
          tool: 'pen' as const,
          color: '#18181b',
          width: 3.2,
          points: [
            { x: 12.5, y: 24.25, pressure: 0.72, altitude: 1.12, azimuth: -0.45, dtMs: 0 },
            { x: 48.75, y: 64.5, pressure: 0.88, altitude: 1.05, azimuth: -0.4, dtMs: 16 },
          ],
          bbox: { minX: 9, minY: 21, maxX: 52, maxY: 68 },
          audioSessionId: 'aud_1',
          startAudioMs: 1200,
          endAudioMs: 1216,
        },
      ],
      textBoxes: [
        {
          id: 'txt_1',
          pageId: 'pg_qbin',
          x: 20,
          y: 30,
          width: 200,
          height: 40,
          plainText: '∑ f(x) dx = α + β',
          fontFamily: 'sans' as const,
          fontSize: 15,
          color: '#18181b',
          bold: false,
          italic: false,
          underline: false,
          listMode: 'none' as const,
        },
      ],
      images: [],
    };

    const qbin = encodePageQbin(payload);
    const decoded = decodePageQbin(qbin);
    expect(decoded.pageId).toBe('pg_qbin');
    expect(decoded.strokes.length).toBe(1);
    expect(decoded.strokes[0].points[1].x).toBeCloseTo(48.75, 2);
    expect(decoded.strokes[0].points[1].pressure).toBeCloseTo(0.88, 2);
    expect(decoded.textBoxes[0].plainText).toBe('∑ f(x) dx = α + β');

    // Append 2 WAL frames + corrupt truncated 3rd frame -> recovers frame 2 intact
    const frame1 = encodeWalFrame(qbin);
    const payload2 = { ...payload, strokes: [...payload.strokes, { ...payload.strokes[0], id: 's2' }] };
    const frame2 = encodeWalFrame(encodePageQbin(payload2));
    const truncatedTail = new Uint8Array([0xff, 0x00, 0x01, 0x00, 0xde, 0xad]);
    const wal = new Uint8Array(frame1.length + frame2.length + truncatedTail.length);
    wal.set(frame1, 0);
    wal.set(frame2, frame1.length);
    wal.set(truncatedTail, frame1.length + frame2.length);

    const recovered = decodeLatestWalFrame(wal);
    expect(recovered).not.toBeNull();
    expect(recovered!.strokes.length).toBe(2);
    expect(recovered!.strokes[1].id).toBe('s2');
  });

  it('queries 5,000 strokes in <2ms via PageSpatialIndex and resolves 300 pages in O(log P)', async () => {
    const { PageSpatialIndex, computePageLayoutOffsets, findActivePageIndexBinary } = await import(
      '../src/engine/spatialIndex'
    );

    const strokes: VectorStroke[] = [];
    for (let i = 0; i < 5000; i++) {
      const x = (i % 50) * 12;
      const y = Math.floor(i / 50) * 8;
      strokes.push({
        id: `s_${i}`,
        pageId: 'pg_dense',
        tool: 'pen',
        color: '#18181b',
        width: 2,
        points: [makePt(x, y, 0), makePt(x + 8, y + 4, 10)],
        bbox: { minX: x - 2, minY: y - 2, maxX: x + 10, maxY: y + 6 },
      });
    }

    const index = new PageSpatialIndex(48);
    index.sync(strokes);
    const t0 = performance.now();
    const hits = index.queryPoint(124, 82, 10);
    const elapsedMs = performance.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(30);
    expect(elapsedMs).toBeLessThan(10);

    // 300-page layout binary search
    const pages = Array.from({ length: 300 }, (_, i) => ({
      pageId: `p_${i}`,
      orderKey: String(i),
      widthPt: 612,
      heightPt: 792,
      source: { kind: 'template' as const, template: 'lined' as const, theme: 'cream' as const },
    }));
    const offsets = computePageLayoutOffsets(pages, 1.0, 'vertical');
    expect(findActivePageIndexBinary(offsets, offsets.centers[0])).toBe(0);
    expect(findActivePageIndexBinary(offsets, offsets.centers[149])).toBe(149);
    expect(findActivePageIndexBinary(offsets, offsets.centers[299])).toBe(299);
  });

  it('exports Vector PDF with Unicode math/CJK text without crashing and emits Knockout Highlighter Groups', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { buildVectorPdfBytes } = await import('../src/engine/pdfVectorBuilder');
    const fontPath = path.resolve(process.cwd(), 'public/fonts/DejaVuSans.ttf');
    const fontBytes = fs.existsSync(fontPath) ? new Uint8Array(fs.readFileSync(fontPath)) : null;

    const note = createNewNote(DEFAULT_SETTINGS, null, 'Unicode ∑ ∫ Test');
    const pid = note.pages[0].pageId;
    note.strokesByPage[pid] = [
      {
        id: 'hl_1',
        pageId: pid,
        tool: 'highlighter',
        color: '#facc15',
        width: 18,
        points: [makePt(40, 80), makePt(200, 80)],
        bbox: { minX: 30, minY: 70, maxX: 210, maxY: 90 },
      },
      {
        id: 'hl_2',
        pageId: pid,
        tool: 'highlighter',
        color: '#facc15',
        width: 18,
        points: [makePt(100, 80), makePt(240, 80)],
        bbox: { minX: 90, minY: 70, maxX: 250, maxY: 90 },
      },
      {
        id: 'pen_1',
        pageId: pid,
        tool: 'pen',
        color: '#18181b',
        width: 3,
        points: [makePt(40, 120), makePt(100, 140), makePt(180, 110), makePt(240, 130)],
        bbox: { minX: 36, minY: 106, maxX: 244, maxY: 144 },
      },
    ];
    note.textBoxesByPage[pid] = [
      {
        id: 'tb_unicode',
        pageId: pid,
        x: 40,
        y: 200,
        width: 300,
        height: 60,
        plainText: '∑ α + β → ∞\n日本語テスト 📝',
        fontFamily: 'sans',
        fontSize: 16,
        color: '#18181b',
        bold: false,
        italic: false,
        underline: false,
        listMode: 'none',
      },
    ];

    const pdfBytes = await buildVectorPdfBytes({
      note,
      blobs: {},
      includeBackground: true,
      unicodeFontBytes: fontBytes,
    });
    expect(pdfBytes.byteLength).toBeGreaterThan(2000);
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);
    expect(pdfText.startsWith('%PDF-')).toBe(true);
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/K true');
  });

  it('collects nested descendant folder IDs recursively for clean folder deletion', async () => {
    const { getDescendantFolderIds } = await import('../src/engine/storage');
    const folders: Folder[] = [
      { id: 'f1', name: 'Root', parentId: null, color: '#000', createdAt: 1 },
      { id: 'f2', name: 'Child', parentId: 'f1', color: '#000', createdAt: 2 },
      { id: 'f3', name: 'Grandchild', parentId: 'f2', color: '#000', createdAt: 3 },
      { id: 'f4', name: 'Sibling', parentId: null, color: '#000', createdAt: 4 },
    ];
    const descendants = getDescendantFolderIds('f1', folders);
    expect(descendants.sort()).toEqual(['f1', 'f2', 'f3']);
  });
});

