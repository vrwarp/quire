import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import {
  OneEuroFilter,
  buildStrokeOutline,
  computeBBox,
  hitTestStroke,
  isScribbleEraseGesture,
  partialEraseStroke,
  recognizeShape,
  strokeInLasso,
} from '../src/engine/inkMath';
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
