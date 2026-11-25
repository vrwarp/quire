import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ChevronLeft,
  Download,
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
  Lasso,
  Layers,
  Mic,
  MicOff,
  Moon,
  Pause,
  PenTool,
  Play,
  Redo2,
  RotateCcw,
  RotateCw,
  Square,
  Star,
  Tag,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-preact';
import type {
  AppSettings,
  EraserMode,
  ImageItem,
  NoteDocument,
  PageDescriptor,
  PaperTheme,
  StrokePoint,
  TelemetrySnapshot,
  TextBoxItem,
  ToolKind,
  UndoCommand,
  VectorStroke,
} from '../types';
import { ProMotionGovernor } from '../engine/promotion';
import { createScrollBus } from '../engine/scrollBus';
import {
  OneEuroFilter,
  computeBBox,
  hitTestStroke,
  isScribbleEraseGesture,
  partialEraseStroke,
  recognizeShape,
  strokeInLasso,
} from '../engine/inkMath';
import {
  PalmRejectionGuard,
  attachMultiFingerUndoRedo,
  unpackPointerSamples,
} from '../engine/inputRouter';
import { AudioSyncRecorder, formatDuration } from '../engine/audio';
import { createId, quireStorage } from '../engine/storage';
import { drawVectorStroke } from '../engine/canvasRenderer';
import { pdfEngine } from '../engine/pdfEngine';
import type { InkWorkerMessage } from '../workers/ink.worker';
import { PageSlot } from './PageSlot';

interface NoteEditorProps {
  note: NoteDocument;
  settings: AppSettings;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onBackToLibrary: () => void;
  onUpdateNote: (updated: NoteDocument) => void;
  onOpenPageManager: (activePageIndex: number) => void;
  onOpenExport: (activePageIndex: number) => void;
  onToast: (msg: string) => void;
  jumpToPageRequest: number | null;
  onClearJumpRequest: () => void;
}

export function NoteEditor({
  note,
  settings,
  onBackToLibrary,
  onUpdateNote,
  onOpenPageManager,
  onOpenExport,
  onToast,
  jumpToPageRequest,
  onClearJumpRequest,
}: NoteEditorProps) {
  const stageWrapperRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wetCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const workerRef = useRef<Worker | null>(null);
  const fallbackWetCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const governorRef = useRef<ProMotionGovernor | null>(null);
  const palmGuardRef = useRef(new PalmRejectionGuard(250));
  const filterXRef = useRef(new OneEuroFilter(1.4, 0.04));
  const filterYRef = useRef(new OneEuroFilter(1.4, 0.04));
  const audioRecorderRef = useRef<AudioSyncRecorder | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const undoStackRef = useRef<UndoCommand[]>([]);
  const redoStackRef = useRef<UndoCommand[]>([]);

  const [tool, setTool] = useState<ToolKind>('pen');
  const [thumbEraserHeld, setThumbEraserHeld] = useState(false);
  const effectiveTool: ToolKind = thumbEraserHeld ? 'eraser' : tool;

  const [eraserMode, setEraserMode] = useState<EraserMode>('stroke');
  const [penColor, setPenColor] = useState(settings.penColorPresets[0]);
  const [hlColor, setHlColor] = useState(settings.highlighterColorPresets[0]);
  const [penWidth, setPenWidth] = useState(2.8);
  const [hlWidth, setHlWidth] = useState(18);
  const [zoom, setZoom] = useState(1);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedTextBoxId, setSelectedTextBoxId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  // Lasso state
  const [lassoPageId, setLassoPageId] = useState<string | null>(null);
  const [lassoStrokeIds, setLassoStrokeIds] = useState<string[]>([]);
  const [lassoPolygon, setLassoPolygon] = useState<Array<{ x: number; y: number }>>([]);
  const lassoDragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    scale: number;
    centerX: number;
    centerY: number;
    pageEl: HTMLDivElement | null;
  }>({ active: false, startX: 0, startY: 0, dx: 0, dy: 0, scale: 1, centerX: 0, centerY: 0, pageEl: null });

  // Audio recording & playback state
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [dimCurtain, setDimCurtain] = useState(false);
  const [playbackSessionId, setPlaybackSessionId] = useState<string | null>(
    note.audioSessions[0]?.id ?? null
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [audioBarOpen, setAudioBarOpen] = useState(note.audioSessions.length > 0);

  // Live 120 Hz Telemetry
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    boostActive: false,
    offscreenCanvasActive: false,
    rendererBackend: '2d-main',
    estimatedHz: 60,
    lastInkLatencyMs: 0,
    activeStrokesOnPage: 0,
    cachedPdfTiles: 0,
  });

  // Active in-progress drawing state (kept in refs for zero React re-renders during 120 Hz ink!)
  const activeStrokeRef = useRef<{
    pointerId: number;
    page: PageDescriptor;
    pageEl: HTMLDivElement;
    tool: 'pen' | 'highlighter';
    color: string;
    width: number;
    points: StrokePoint[];
    startPerf: number;
    audioSessionId?: string;
    startAudioMs?: number;
    dwellTimer: number;
    snappedKind?: string;
  } | null>(null);

  const noteRef = useRef(note);
  noteRef.current = note;

  const hiddenStrokeIds = useMemo(() => new Set(lassoStrokeIds), [lassoStrokeIds]);

  const sendToWetWorker = useCallback((msg: InkWorkerMessage) => {
    if (workerRef.current) {
      workerRef.current.postMessage(msg);
      return;
    }
    // Graceful 2D main-thread fallback if OffscreenCanvas transfer is unavailable
    const ctx = fallbackWetCtxRef.current;
    const canvas = wetCanvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (msg.type === 'clear') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else if (msg.type === 'wet-stroke') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(msg.offsetX, msg.offsetY);
      ctx.scale(msg.zoom, msg.zoom);
      drawVectorStroke(
        ctx,
        {
          tool: msg.tool,
          color: msg.color,
          width: msg.width,
          points: [...msg.points, ...msg.predicted],
        },
        msg.paperTheme
      );
      ctx.restore();
    }
  }, []);

  // 1. Mount ProMotion 120 Hz Governor + OffscreenCanvas InkRenderWorker + 120 Hz Scroll Bus
  useEffect(() => {
    const wrapper = stageWrapperRef.current;
    const scroller = scrollerRef.current;
    const wetCanvas = wetCanvasRef.current;
    if (!wrapper || !scroller || !wetCanvas) return;

    const governor = new ProMotionGovernor(wrapper, {
      holdMs: 850,
      onStatusChange: (active) =>
        setTelemetry((prev) => ({
          ...prev,
          boostActive: active,
          estimatedHz: active ? 120 : 60,
        })),
    });
    governorRef.current = governor;

    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const rect = wrapper.getBoundingClientRect();

    // Transfer wet canvas to Dedicated OffscreenCanvas Worker (120 Hz AsyncSetLayerContents path)
    if (
      typeof OffscreenCanvas !== 'undefined' &&
      typeof wetCanvas.transferControlToOffscreen === 'function'
    ) {
      try {
        const offscreen = wetCanvas.transferControlToOffscreen();
        const worker = new Worker(new URL('../workers/ink.worker.ts', import.meta.url), {
          type: 'module',
          name: 'quire-ink-worker',
        });
        worker.onmessage = (ev) => {
          if (ev.data?.type === 'ready') {
            setTelemetry((prev) => ({
              ...prev,
              offscreenCanvasActive: true,
              rendererBackend: ev.data.backend,
            }));
          } else if (ev.data?.type === 'telemetry') {
            setTelemetry((prev) => ({
              ...prev,
              lastInkLatencyMs: ev.data.renderMs,
              cachedPdfTiles: pdfEngine.cachedTileCount,
            }));
          }
        };
        worker.postMessage(
          { type: 'init', canvas: offscreen, width: rect.width, height: rect.height, dpr },
          [offscreen]
        );
        workerRef.current = worker;
      } catch {
        wetCanvas.width = Math.round(rect.width * dpr);
        wetCanvas.height = Math.round(rect.height * dpr);
        fallbackWetCtxRef.current = wetCanvas.getContext('2d');
      }
    } else {
      wetCanvas.width = Math.round(rect.width * dpr);
      wetCanvas.height = Math.round(rect.height * dpr);
      fallbackWetCtxRef.current = wetCanvas.getContext('2d');
    }

    const resizeObs = new ResizeObserver(() => {
      const r = wrapper.getBoundingClientRect();
      const curDpr = Math.min(2.5, window.devicePixelRatio || 1);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'resize', width: r.width, height: r.height, dpr: curDpr });
      } else {
        wetCanvas.width = Math.round(r.width * curDpr);
        wetCanvas.height = Math.round(r.height * curDpr);
      }
    });
    resizeObs.observe(wrapper);

    // 120 Hz Scroll Bus tracking active page index smoothly
    const scrollBus = createScrollBus({
      read: () => ({ left: scroller.scrollLeft, top: scroller.scrollTop }),
      onReading: () => {
        governor.wake();
        const slots = scroller.querySelectorAll<HTMLElement>('[data-page-index]');
        const scrollerRect = scroller.getBoundingClientRect();
        const midY = scrollerRect.top + scrollerRect.height * 0.45;
        const midX = scrollerRect.left + scrollerRect.width * 0.5;
        let bestIdx = 0;
        let bestDist = Infinity;
        slots.forEach((slot) => {
          const sr = slot.getBoundingClientRect();
          const cx = sr.left + sr.width / 2;
          const cy = sr.top + sr.height / 2;
          const dist = Math.hypot(cx - midX, cy - midY);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = parseInt(slot.dataset.pageIndex ?? '0', 10);
          }
        });
        setActivePageIndex(bestIdx);
      },
    });

    const onScroll = () => scrollBus.wake();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('touchstart', onScroll, { passive: true });
    scroller.addEventListener('wheel', onScroll, { passive: true });

    const detachMultiFinger = attachMultiFingerUndoRedo(scroller, {
      onUndo: () => performUndo(),
      onRedo: () => performRedo(),
    });

    return () => {
      detachMultiFinger();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('touchstart', onScroll);
      scroller.removeEventListener('wheel', onScroll);
      scrollBus.dispose();
      resizeObs.disconnect();
      workerRef.current?.terminate();
      workerRef.current = null;
      governor.dispose();
    };
  }, []);

  // Jump to requested page from Page Manager or PDF internal link
  useEffect(() => {
    if (jumpToPageRequest === null || !scrollerRef.current) return;
    const slot = scrollerRef.current.querySelector<HTMLElement>(
      `[data-page-index="${jumpToPageRequest}"]`
    );
    slot?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    setActivePageIndex(jumpToPageRequest);
    onClearJumpRequest();
  }, [jumpToPageRequest, onClearJumpRequest]);

  // Recording elapsed timer
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = window.setInterval(() => {
      if (audioRecorderRef.current) {
        setRecordingElapsedMs(audioRecorderRef.current.getElapsedMs());
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [recordingState]);

  // 120 FPS Audio-Synced Progressive Ink Replay Loop (FR-AUD-03)
  useEffect(() => {
    if (!isPlaying || !playbackSessionId) {
      sendToWetWorker({ type: 'clear' });
      return;
    }
    governorRef.current?.setPinned(true);
    let stopped = false;
    const ch = new MessageChannel();

    const step = () => {
      if (stopped) return;
      const el = audioElRef.current;
      if (el) {
        const ms = el.currentTime * 1000;
        setPlaybackTimeMs(ms);
        const curPage = noteRef.current.pages[activePageIndex];
        const pageEl = scrollerRef.current?.querySelector<HTMLDivElement>(
          `[data-page-id="${curPage?.pageId}"]`
        );
        const wrapRect = stageWrapperRef.current?.getBoundingClientRect();
        if (curPage && pageEl && wrapRect) {
          const pRect = pageEl.getBoundingClientRect();
          const strokes = noteRef.current.strokesByPage[curPage.pageId] ?? [];
          const activeStrokes = strokes
            .filter(
              (s) =>
                s.audioSessionId === playbackSessionId &&
                s.startAudioMs !== undefined &&
                s.endAudioMs !== undefined &&
                ms >= s.startAudioMs &&
                ms <= s.endAudioMs + 120
            )
            .map((stroke) => ({
              stroke,
              elapsedDtMs: Math.max(0, ms - (stroke.startAudioMs ?? 0)),
            }));
          sendToWetWorker({
            type: 'replay-frame',
            offsetX: pRect.left - wrapRect.left,
            offsetY: pRect.top - wrapRect.top,
            zoom,
            paperTheme: curPage.source.kind === 'template' ? curPage.source.theme : 'light',
            activeStrokes,
          });
        }
      }
      window.setTimeout(() => {
        if (!stopped) ch.port2.postMessage(null);
      }, 8);
    };

    ch.port1.onmessage = step;
    ch.port1.start();
    step();

    return () => {
      stopped = true;
      ch.port1.close();
      ch.port2.close();
      governorRef.current?.setPinned(false);
      sendToWetWorker({ type: 'clear' });
    };
  }, [isPlaying, playbackSessionId, activePageIndex, zoom, sendToWetWorker]);

  // Undo / Redo helpers (50+ steps per session, CUJ 2)
  const pushCommand = useCallback((cmd: UndoCommand) => {
    undoStackRef.current.push(cmd);
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const performUndo = useCallback(() => {
    const cmd = undoStackRef.current.pop();
    if (!cmd) return;
    cmd.undo();
    redoStackRef.current.push(cmd);
  }, []);

  const performRedo = useCallback(() => {
    const cmd = redoStackRef.current.pop();
    if (!cmd) return;
    cmd.redo();
    undoStackRef.current.push(cmd);
  }, []);

  // Keyboard shortcuts (Cmd+Z / Cmd+Shift+Z)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT') {
          return;
        }
        e.preventDefault();
        if (e.shiftKey) performRedo();
        else performUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [performUndo, performRedo]);

  const mutatePageStrokes = useCallback(
    (pageId: string, updater: (prev: VectorStroke[]) => VectorStroke[], label: string) => {
      const before = noteRef.current.strokesByPage[pageId] ?? [];
      const after = updater(before);
      const apply = (list: VectorStroke[]) => {
        const next: NoteDocument = {
          ...noteRef.current,
          updatedAt: Date.now(),
          strokesByPage: { ...noteRef.current.strokesByPage, [pageId]: list },
        };
        onUpdateNote(next);
      };
      apply(after);
      pushCommand({
        description: label,
        undo: () => apply(before),
        redo: () => apply(after),
      });
    },
    [onUpdateNote, pushCommand]
  );

  const getPageOffsets = (pageEl: HTMLDivElement) => {
    const wrapRect = stageWrapperRef.current!.getBoundingClientRect();
    const pRect = pageEl.getBoundingClientRect();
    return { offsetX: pRect.left - wrapRect.left, offsetY: pRect.top - wrapRect.top, pRect };
  };

  /* ============================================================================
     Pointer Input Handling (240 Hz Coalesced + Predicted + Palm Rejection)
     ============================================================================ */
  const handlePointerDown = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    governorRef.current?.wake();

    if (e.pointerType === 'pen') {
      palmGuardRef.current.notePenDown();
    } else if (palmGuardRef.current.shouldRejectTouch(e)) {
      return;
    }

    // If finger-draw is off and user touches with finger, let native UIScrollView pan!
    if (e.pointerType === 'touch' && !settings.fingerDrawMode && effectiveTool !== 'pan') {
      return;
    }

    const { offsetX, offsetY, pRect } = getPageOffsets(pageEl);
    const xPt = (e.clientX - pRect.left) / zoom;
    const yPt = (e.clientY - pRect.top) / zoom;

    // Audio Playback Tap-Stroke-to-Jump (FR-AUD-02)
    if (effectiveTool === 'pan' && playbackSessionId) {
      const strokes = noteRef.current.strokesByPage[page.pageId] ?? [];
      const hit = strokes.find(
        (s) => s.audioSessionId && hitTestStroke(s, xPt, yPt, 12 / zoom)
      );
      if (hit && hit.startAudioMs !== undefined) {
        void jumpAudioToStroke(hit.audioSessionId!, hit.startAudioMs);
        return;
      }
    }

    if (effectiveTool === 'pan') {
      setSelectedTextBoxId(null);
      setSelectedImageId(null);
      return;
    }

    // Text Box tool: drop a new typed text box at tap point (FR-INK-06)
    if (effectiveTool === 'text') {
      const newBox: TextBoxItem = {
        id: createId('txt'),
        pageId: page.pageId,
        x: Math.max(12, Math.min(page.widthPt - 180, xPt)),
        y: Math.max(12, Math.min(page.heightPt - 60, yPt)),
        width: 210,
        height: 44,
        plainText: '',
        fontFamily: 'sans',
        fontSize: 15,
        color: penColor,
        bold: false,
        italic: false,
        underline: false,
        listMode: 'none',
        audioSessionId: audioRecorderRef.current?.activeSessionId ?? undefined,
        startAudioMs:
          recordingState === 'recording' ? audioRecorderRef.current?.getElapsedMs() : undefined,
      };
      const prevBoxes = noteRef.current.textBoxesByPage[page.pageId] ?? [];
      onUpdateNote({
        ...noteRef.current,
        updatedAt: Date.now(),
        textBoxesByPage: {
          ...noteRef.current.textBoxesByPage,
          [page.pageId]: [...prevBoxes, newBox],
        },
      });
      setSelectedTextBoxId(newBox.id);
      return;
    }

    pageEl.setPointerCapture?.(e.pointerId);

    // Eraser tool (Whole-Stroke or Analytical Precision Partial Erase)
    if (effectiveTool === 'eraser') {
      applyEraserAt(page.pageId, xPt, yPt);
      activeStrokeRef.current = {
        pointerId: e.pointerId,
        page,
        pageEl,
        tool: 'pen',
        color: 'eraser',
        width: 14,
        points: [],
        startPerf: e.timeStamp,
        dwellTimer: 0,
      };
      return;
    }

    // Lasso tool: either drag existing lifted selection OR draw new selection marquee
    if (effectiveTool === 'lasso') {
      if (lassoPageId === page.pageId && lassoStrokeIds.length > 0) {
        lassoDragRef.current = {
          active: true,
          startX: xPt,
          startY: yPt,
          dx: 0,
          dy: 0,
          scale: lassoDragRef.current.scale || 1,
          centerX: lassoDragRef.current.centerX,
          centerY: lassoDragRef.current.centerY,
          pageEl,
        };
        return;
      }
      setLassoPageId(page.pageId);
      setLassoStrokeIds([]);
      setLassoPolygon([{ x: xPt, y: yPt }]);
      return;
    }

    // Pen or Highlighter stroke start
    const inkTool = effectiveTool === 'highlighter' ? 'highlighter' : 'pen';
    const color = inkTool === 'highlighter' ? hlColor : penColor;
    const width = inkTool === 'highlighter' ? hlWidth : penWidth;

    filterXRef.current.reset();
    filterYRef.current.reset();
    const fx = filterXRef.current.filter(xPt, e.timeStamp);
    const fy = filterYRef.current.filter(yPt, e.timeStamp);

    const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    const firstPt: StrokePoint = {
      x: fx,
      y: fy,
      pressure: e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5,
      altitude: anyE.altitudeAngle ?? Math.PI / 2,
      azimuth: anyE.azimuthAngle ?? 0,
      dtMs: 0,
    };

    const audioSessionId =
      recordingState === 'recording' ? audioRecorderRef.current?.activeSessionId ?? undefined : undefined;
    const startAudioMs =
      recordingState === 'recording' ? audioRecorderRef.current?.getElapsedMs() : undefined;

    activeStrokeRef.current = {
      pointerId: e.pointerId,
      page,
      pageEl,
      tool: inkTool,
      color,
      width,
      points: [firstPt],
      startPerf: e.timeStamp,
      audioSessionId,
      startAudioMs,
      dwellTimer: 0,
    };

    const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
    sendToWetWorker({
      type: 'wet-stroke',
      tool: inkTool,
      color,
      width,
      paperTheme,
      offsetX,
      offsetY,
      zoom,
      points: [firstPt],
      predicted: [],
    });
  };

  const handlePointerMove = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    if (e.pointerType === 'touch' && palmGuardRef.current.shouldRejectTouch(e)) return;

    const { offsetX, offsetY, pRect } = getPageOffsets(pageEl);
    const toPageCoords = (cx: number, cy: number) => ({
      x: (cx - pRect.left) / zoom,
      y: (cy - pRect.top) / zoom,
    });

    // Active Lasso marquee or drag
    if (effectiveTool === 'lasso') {
      const pt = toPageCoords(e.clientX, e.clientY);
      const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
      if (lassoDragRef.current.active) {
        lassoDragRef.current.dx = pt.x - lassoDragRef.current.startX;
        lassoDragRef.current.dy = pt.y - lassoDragRef.current.startY;
        const lifted = (noteRef.current.strokesByPage[page.pageId] ?? []).filter((s) =>
          lassoStrokeIds.includes(s.id)
        );
        sendToWetWorker({
          type: 'lasso-overlay',
          offsetX,
          offsetY,
          zoom,
          paperTheme,
          polygon: lassoPolygon,
          liftedStrokes: lifted,
          dx: lassoDragRef.current.dx,
          dy: lassoDragRef.current.dy,
          scale: lassoDragRef.current.scale,
          centerX: lassoDragRef.current.centerX,
          centerY: lassoDragRef.current.centerY,
        });
        return;
      }
      if (lassoPolygon.length > 0 && lassoStrokeIds.length === 0 && e.buttons > 0) {
        const nextPoly = [...lassoPolygon, pt];
        setLassoPolygon(nextPoly);
        sendToWetWorker({
          type: 'lasso-overlay',
          offsetX,
          offsetY,
          zoom,
          paperTheme,
          polygon: nextPoly,
          liftedStrokes: [],
          dx: 0,
          dy: 0,
          scale: 1,
          centerX: 0,
          centerY: 0,
        });
      }
      return;
    }

    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    governorRef.current?.wake();

    // Active Eraser sweep
    if (active.color === 'eraser') {
      const pt = toPageCoords(e.clientX, e.clientY);
      applyEraserAt(page.pageId, pt.x, pt.y);
      return;
    }

    // Unpack 240 Hz coalesced + UIKit predicted samples
    const { coalesced, predicted } = unpackPointerSamples(e, toPageCoords, active.startPerf);
    let movedDist = 0;
    for (const raw of coalesced) {
      const fx = filterXRef.current.filter(raw.x, active.startPerf + raw.dtMs);
      const fy = filterYRef.current.filter(raw.y, active.startPerf + raw.dtMs);
      const prev = active.points[active.points.length - 1];
      const d = Math.hypot(fx - prev.x, fy - prev.y);
      if (d >= 0.45) {
        movedDist += d;
        active.points.push({ ...raw, x: fx, y: fy });
      }
    }

    // Reset 400ms Hold-to-Snap shape dwell timer whenever stylus moves
    if (movedDist > 2.2) {
      window.clearTimeout(active.dwellTimer);
      active.snappedKind = undefined;
      active.dwellTimer = window.setTimeout(() => {
        const cur = activeStrokeRef.current;
        if (!cur || cur.points.length < 5) return;
        const recognized = recognizeShape(cur.points);
        if (recognized) {
          cur.points = recognized.snappedPoints;
          cur.snappedKind = recognized.kind;
          const pTheme: PaperTheme = cur.page.source.kind === 'template' ? cur.page.source.theme : 'light';
          const offs = getPageOffsets(cur.pageEl);
          sendToWetWorker({
            type: 'wet-stroke',
            tool: cur.tool,
            color: cur.color,
            width: cur.width,
            paperTheme: pTheme,
            offsetX: offs.offsetX,
            offsetY: offs.offsetY,
            zoom,
            points: cur.points,
            predicted: [],
            snapBadge: `Snapped: ${recognized.kind}`,
          });
        }
      }, 400);
    }

    const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
    sendToWetWorker({
      type: 'wet-stroke',
      tool: active.tool,
      color: active.color,
      width: active.width,
      paperTheme,
      offsetX,
      offsetY,
      zoom,
      points: active.points,
      predicted,
      snapBadge: active.snappedKind ? `Snapped: ${active.snappedKind}` : undefined,
    });
  };

  const handlePointerUp = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    if (e.pointerType === 'pen') {
      palmGuardRef.current.notePenUp();
    }

    // Finish Lasso selection or commit Lasso move
    if (effectiveTool === 'lasso') {
      if (lassoDragRef.current.active) {
        const { dx, dy, scale, centerX, centerY } = lassoDragRef.current;
        lassoDragRef.current.active = false;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(scale - 1) > 0.01) {
          const idSet = new Set(lassoStrokeIds);
          mutatePageStrokes(
            page.pageId,
            (prev) =>
              prev.map((s) => {
                if (!idSet.has(s.id)) return s;
                const pts = s.points.map((p) => ({
                  ...p,
                  x: centerX + (p.x - centerX) * scale + dx,
                  y: centerY + (p.y - centerY) * scale + dy,
                }));
                return { ...s, points: pts, bbox: computeBBox(pts, s.width) };
              }),
            'Transform Lasso selection'
          );
          setLassoPolygon((poly) => poly.map((p) => ({ x: p.x + dx, y: p.y + dy })));
          lassoDragRef.current.dx = 0;
          lassoDragRef.current.dy = 0;
          lassoDragRef.current.scale = 1;
        }
        sendToWetWorker({ type: 'clear' });
        return;
      }

      if (lassoPolygon.length >= 3 && lassoStrokeIds.length === 0) {
        const strokes = noteRef.current.strokesByPage[page.pageId] ?? [];
        const matched = strokes.filter((s) => strokeInLasso(s, lassoPolygon));
        if (matched.length > 0) {
          const ids = matched.map((s) => s.id);
          const allPts = matched.flatMap((s) => s.points);
          const box = computeBBox(allPts, 0);
          lassoDragRef.current.centerX = (box.minX + box.maxX) / 2;
          lassoDragRef.current.centerY = (box.minY + box.maxY) / 2;
          lassoDragRef.current.scale = 1;
          setLassoStrokeIds(ids);
          const { offsetX, offsetY } = getPageOffsets(pageEl);
          sendToWetWorker({
            type: 'lasso-overlay',
            offsetX,
            offsetY,
            zoom,
            paperTheme: page.source.kind === 'template' ? page.source.theme : 'light',
            polygon: lassoPolygon,
            liftedStrokes: matched,
            dx: 0,
            dy: 0,
            scale: 1,
            centerX: lassoDragRef.current.centerX,
            centerY: lassoDragRef.current.centerY,
          });
        } else {
          setLassoPolygon([]);
          sendToWetWorker({ type: 'clear' });
        }
      }
      return;
    }

    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    window.clearTimeout(active.dwellTimer);
    activeStrokeRef.current = null;

    if (active.color === 'eraser') return;

    // Optional Scribble-Scratch Quick Erase (WebKit double-tap alternative)
    if (settings.scribbleEraseEnabled && active.tool === 'pen' && isScribbleEraseGesture(active.points)) {
      const scribbleBox = computeBBox(active.points, 6);
      mutatePageStrokes(
        page.pageId,
        (prev) =>
          prev.filter(
            (s) =>
              s.bbox.maxX < scribbleBox.minX ||
              s.bbox.minX > scribbleBox.maxX ||
              s.bbox.maxY < scribbleBox.minY ||
              s.bbox.minY > scribbleBox.maxY
          ),
        'Scribble erase'
      );
      sendToWetWorker({ type: 'clear' });
      onToast('Scribble-erased ink');
      return;
    }

    const endAudioMs =
      active.audioSessionId && recordingState === 'recording'
        ? audioRecorderRef.current?.getElapsedMs()
        : active.startAudioMs !== undefined
        ? active.startAudioMs + (active.points[active.points.length - 1]?.dtMs ?? 0)
        : undefined;

    const committed: VectorStroke = {
      id: createId('str'),
      pageId: page.pageId,
      tool: active.tool,
      color: active.color,
      width: active.width,
      points: active.points,
      bbox: computeBBox(active.points, active.width),
      shapeKind: (active.snappedKind as VectorStroke['shapeKind']) ?? 'freehand',
      audioSessionId: active.audioSessionId,
      startAudioMs: active.startAudioMs,
      endAudioMs,
    };

    mutatePageStrokes(page.pageId, (prev) => [...prev, committed], 'Add stroke');
    sendToWetWorker({ type: 'clear' });
  };

  const applyEraserAt = (pageId: string, xPt: number, yPt: number) => {
    const radius = 14 / zoom;
    const strokes = noteRef.current.strokesByPage[pageId] ?? [];
    if (eraserMode === 'stroke') {
      const hit = strokes.some((s) => hitTestStroke(s, xPt, yPt, radius));
      if (!hit) return;
      mutatePageStrokes(
        pageId,
        (prev) => prev.filter((s) => !hitTestStroke(s, xPt, yPt, radius)),
        'Erase stroke'
      );
    } else {
      let changed = false;
      const next: VectorStroke[] = [];
      for (const s of strokes) {
        const split = partialEraseStroke(s, xPt, yPt, radius, () => createId('str'));
        if (split !== null) {
          changed = true;
          next.push(...split);
        } else {
          next.push(s);
        }
      }
      if (changed) {
        mutatePageStrokes(pageId, () => next, 'Partial vector erase');
      }
    }
  };

  /* ============================================================================
     Lasso Batch Actions (Recolor / Scale / Duplicate / Delete)
     ============================================================================ */
  const clearLasso = () => {
    setLassoStrokeIds([]);
    setLassoPolygon([]);
    setLassoPageId(null);
    sendToWetWorker({ type: 'clear' });
  };

  const recolorLasso = (newColor: string) => {
    if (!lassoPageId || lassoStrokeIds.length === 0) return;
    const idSet = new Set(lassoStrokeIds);
    mutatePageStrokes(
      lassoPageId,
      (prev) => prev.map((s) => (idSet.has(s.id) ? { ...s, color: newColor } : s)),
      'Recolor Lasso selection'
    );
    clearLasso();
  };

  const scaleLasso = (factor: number) => {
    if (!lassoPageId || lassoStrokeIds.length === 0) return;
    const idSet = new Set(lassoStrokeIds);
    const { centerX, centerY } = lassoDragRef.current;
    mutatePageStrokes(
      lassoPageId,
      (prev) =>
        prev.map((s) => {
          if (!idSet.has(s.id)) return s;
          const pts = s.points.map((p) => ({
            ...p,
            x: centerX + (p.x - centerX) * factor,
            y: centerY + (p.y - centerY) * factor,
          }));
          return { ...s, points: pts, bbox: computeBBox(pts, s.width) };
        }),
      'Resize Lasso selection'
    );
    clearLasso();
  };

  const duplicateLasso = () => {
    if (!lassoPageId || lassoStrokeIds.length === 0) return;
    const idSet = new Set(lassoStrokeIds);
    mutatePageStrokes(
      lassoPageId,
      (prev) => {
        const copies = prev
          .filter((s) => idSet.has(s.id))
          .map((s) => {
            const pts = s.points.map((p) => ({ ...p, x: p.x + 24, y: p.y + 24 }));
            return { ...s, id: createId('str'), points: pts, bbox: computeBBox(pts, s.width) };
          });
        return [...prev, ...copies];
      },
      'Duplicate Lasso selection'
    );
    clearLasso();
  };

  const deleteLasso = () => {
    if (!lassoPageId || lassoStrokeIds.length === 0) return;
    const idSet = new Set(lassoStrokeIds);
    mutatePageStrokes(
      lassoPageId,
      (prev) => prev.filter((s) => !idSet.has(s.id)),
      'Delete Lasso selection'
    );
    clearLasso();
  };

  /* ============================================================================
     Audio Recording & Playback Controls (FR-AUD-01..04)
     ============================================================================ */
  const toggleRecording = async () => {
    if (recordingState === 'idle') {
      try {
        const rec = new AudioSyncRecorder({
          onInterruption: (reason) => {
            setRecordingState('paused');
            onToast(reason);
          },
        });
        const session = await rec.start(noteRef.current.audioSessions.length);
        audioRecorderRef.current = rec;
        setRecordingState('recording');
        setRecordingElapsedMs(0);
        setPlaybackSessionId(session.id);
        setAudioBarOpen(true);
        onUpdateNote({
          ...noteRef.current,
          updatedAt: Date.now(),
          audioSessions: [...noteRef.current.audioSessions, session],
        });
      } catch (err) {
        onToast(`Microphone unavailable: ${(err as Error).message}`);
      }
    } else if (recordingState === 'recording') {
      audioRecorderRef.current?.pause();
      setRecordingState('paused');
    } else {
      audioRecorderRef.current?.resume();
      setRecordingState('recording');
    }
  };

  const stopRecording = async () => {
    const rec = audioRecorderRef.current;
    if (!rec) return;
    const sid = rec.activeSessionId;
    const { durationMs, segments } = await rec.stop();
    setRecordingState('idle');
    setDimCurtain(false);
    if (sid) {
      onUpdateNote({
        ...noteRef.current,
        updatedAt: Date.now(),
        audioSessions: noteRef.current.audioSessions.map((s) =>
          s.id === sid ? { ...s, durationMs, segments } : s
        ),
      });
    }
    onToast(`Saved audio recording (${formatDuration(durationMs)})`);
  };

  const ensurePlaybackAudioLoaded = async (sessionId: string): Promise<HTMLAudioElement | null> => {
    const session = noteRef.current.audioSessions.find((s) => s.id === sessionId);
    if (!session) return null;
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
      audioElRef.current.onended = () => setIsPlaying(false);
    }
    const el = audioElRef.current;
    if (el.dataset.sessionId !== sessionId) {
      const bytes = await quireStorage.loadBlob(session.blobKey);
      if (!bytes) return null;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: session.mimeType }));
      el.src = url;
      el.dataset.sessionId = sessionId;
    }
    el.playbackRate = playbackRate;
    return el;
  };

  const jumpAudioToStroke = async (sessionId: string, startAudioMs: number) => {
    setPlaybackSessionId(sessionId);
    setAudioBarOpen(true);
    const el = await ensurePlaybackAudioLoaded(sessionId);
    if (!el) return;
    const targetSec = Math.max(0, (startAudioMs - settings.audioPreRollMs) / 1000);
    el.currentTime = targetSec;
    setPlaybackTimeMs(targetSec * 1000);
    await el.play().catch(() => {});
    setIsPlaying(true);
  };

  const togglePlayback = async () => {
    const sid = playbackSessionId ?? note.audioSessions[0]?.id;
    if (!sid) return;
    const el = await ensurePlaybackAudioLoaded(sid);
    if (!el) return;
    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
    } else {
      await el.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const skipAudio = (deltaSec: number) => {
    const el = audioElRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + deltaSec));
    setPlaybackTimeMs(el.currentTime * 1000);
  };

  /* ============================================================================
     Image Insertion & Cropping (FR-PDF-03)
     ============================================================================ */
  const handleInsertImageFile = async (file: File, targetPageId?: string, xPt = 80, yPt = 100) => {
    const page = note.pages.find((p) => p.pageId === targetPageId) ?? note.pages[activePageIndex];
    if (!page) return;
    const blobKey = `img_${createId('blob')}`;
    await quireStorage.saveBlob(blobKey, file);
    const newImg: ImageItem = {
      id: createId('img'),
      pageId: page.pageId,
      blobKey,
      x: xPt,
      y: yPt,
      width: 240,
      height: 180,
      rotation: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
    };
    const prev = noteRef.current.imagesByPage[page.pageId] ?? [];
    onUpdateNote({
      ...noteRef.current,
      updatedAt: Date.now(),
      imagesByPage: { ...noteRef.current.imagesByPage, [page.pageId]: [...prev, newImg] },
    });
    setSelectedImageId(newImg.id);
    onToast('Inserted image onto page');
  };

  const addTag = (e: Event) => {
    e.preventDefault();
    const clean = tagDraft.trim().replace(/^#/, '');
    if (!clean || note.tags.includes(clean)) {
      setTagDraft('');
      setTagInputOpen(false);
      return;
    }
    onUpdateNote({ ...note, updatedAt: Date.now(), tags: [...note.tags, clean] });
    setTagDraft('');
    setTagInputOpen(false);
  };

  const activeSession = note.audioSessions.find((s) => s.id === playbackSessionId) ?? note.audioSessions[0];
  const colorPresets =
    effectiveTool === 'highlighter' ? settings.highlighterColorPresets : settings.penColorPresets;
  const currentColor = effectiveTool === 'highlighter' ? hlColor : penColor;

  return (
    <div class="editor-shell">
      {/* Top Editor Header */}
      <header class="editor-header">
        <div class="editor-header-left">
          <button
            id="btn-back-library"
            type="button"
            class="btn-icon"
            title="Back to Library"
            aria-label="Back to Library"
            onClick={onBackToLibrary}
          >
            <ChevronLeft size={20} />
          </button>
          <input
            id="input-note-title"
            class="note-title-input"
            type="text"
            aria-label="Note title"
            value={note.title}
            onInput={(e) =>
              onUpdateNote({
                ...note,
                updatedAt: Date.now(),
                title: (e.target as HTMLInputElement).value,
              })
            }
          />
          <button
            type="button"
            class={`btn-icon ${note.isFavorite ? 'active' : ''}`}
            title="Favorite note"
            aria-label="Toggle favorite"
            onClick={() => onUpdateNote({ ...note, isFavorite: !note.isFavorite })}
          >
            <Star size={16} fill={note.isFavorite ? 'currentColor' : 'none'} />
          </button>
          <button
            id="btn-toggle-tag"
            type="button"
            class="btn-icon"
            title="Add tag"
            aria-label="Add tag"
            onClick={() => setTagInputOpen((v) => !v)}
          >
            <Tag size={15} />
          </button>
          {tagInputOpen && (
            <form onSubmit={addTag} style={{ display: 'flex', gap: '4px' }}>
              <input
                id="input-add-tag"
                type="text"
                placeholder="#tag"
                value={tagDraft}
                onInput={(e) => setTagDraft((e.target as HTMLInputElement).value)}
                style={{
                  width: '92px',
                  padding: '3px 7px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface-2)',
                  fontSize: '12px',
                }}
              />
            </form>
          )}
        </div>

        <div class="editor-header-right">
          <span
            id="telemetry-hz-pill"
            class={`hz-pill ${telemetry.boostActive ? 'boosted' : ''}`}
            title={`Backend: ${telemetry.rendererBackend} | Ink render: ${telemetry.lastInkLatencyMs}ms | Cached PDF tiles: ${telemetry.cachedPdfTiles}`}
          >
            <span class="hz-dot" />
            {telemetry.offscreenCanvasActive ? '120Hz Offscreen' : 'Canvas'}
            {telemetry.lastInkLatencyMs > 0 ? ` · ${telemetry.lastInkLatencyMs}ms` : ''}
          </span>

          <button
            id="btn-audio-record"
            type="button"
            class={`btn-icon ${recordingState !== 'idle' ? 'active' : ''}`}
            title={recordingState === 'idle' ? 'Record Audio Sync' : 'Pause / Resume Recording'}
            aria-label="Record Audio"
            onClick={toggleRecording}
          >
            {recordingState === 'recording' ? <Mic size={17} color="#dc2626" /> : <MicOff size={17} />}
          </button>

          <button
            id="btn-open-page-manager"
            type="button"
            class="btn-icon"
            title="Page Manager & Per-Page Templates"
            aria-label="Open Page Manager"
            onClick={() => onOpenPageManager(activePageIndex)}
          >
            <Layers size={17} />
          </button>

          <button
            type="button"
            class="btn-icon"
            title="Insert Image"
            aria-label="Insert Image"
            onClick={() => imageInputRef.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) void handleInsertImageFile(file);
              (e.target as HTMLInputElement).value = '';
            }}
          />

          <button
            type="button"
            class="btn-icon"
            title={`Switch to ${note.scrollDirection === 'vertical' ? 'Horizontal' : 'Vertical'} Scroll`}
            aria-label="Toggle Scroll Direction"
            onClick={() =>
              onUpdateNote({
                ...note,
                scrollDirection: note.scrollDirection === 'vertical' ? 'horizontal' : 'vertical',
              })
            }
          >
            {note.scrollDirection === 'vertical' ? '↕' : '↔'}
          </button>

          <button
            type="button"
            class="btn-icon"
            title="Zoom Out"
            aria-label="Zoom Out"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
          >
            <ZoomOut size={16} />
          </button>
          <span style={{ fontSize: '11.5px', fontFamily: 'var(--font-mono)', minWidth: '38px', textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            class="btn-icon"
            title="Zoom In"
            aria-label="Zoom In"
            onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
          >
            <ZoomIn size={16} />
          </button>

          <button
            id="btn-open-export"
            type="button"
            class="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '12.5px' }}
            onClick={() => onOpenExport(activePageIndex)}
          >
            <Download size={14} /> Export
          </button>
        </div>
      </header>

      {/* Floating / Dockable Ink Toolbar (FR-INK-09) */}
      <nav
        class={`ink-toolbar dock-${settings.toolbarDock}`}
        aria-label="Drawing Tools"
      >
        <button
          id="tool-pen"
          type="button"
          class={`btn-icon ${effectiveTool === 'pen' ? 'active' : ''}`}
          title="Pen (Hold 400ms to snap shape)"
          aria-label="Pen Tool"
          onClick={() => {
            clearLasso();
            setTool('pen');
          }}
        >
          <PenTool size={17} />
        </button>
        <button
          id="tool-highlighter"
          type="button"
          class={`btn-icon ${effectiveTool === 'highlighter' ? 'active' : ''}`}
          title="Single-Layer Background Highlighter"
          aria-label="Highlighter Tool"
          onClick={() => {
            clearLasso();
            setTool('highlighter');
          }}
        >
          <Highlighter size={17} />
        </button>
        <button
          id="tool-eraser"
          type="button"
          class={`btn-icon ${effectiveTool === 'eraser' ? 'active' : ''}`}
          title={`Eraser (${eraserMode === 'stroke' ? 'Whole Stroke' : 'Partial Precision'})`}
          aria-label="Eraser Tool"
          onClick={() => {
            clearLasso();
            if (tool === 'eraser') {
              setEraserMode((m) => (m === 'stroke' ? 'partial' : 'stroke'));
            } else {
              setTool('eraser');
            }
          }}
        >
          <Eraser size={17} />
        </button>
        <button
          id="tool-lasso"
          type="button"
          class={`btn-icon ${effectiveTool === 'lasso' ? 'active' : ''}`}
          title="Lasso Select (Move, Resize, Recolor)"
          aria-label="Lasso Tool"
          onClick={() => setTool('lasso')}
        >
          <Lasso size={17} />
        </button>
        <button
          id="tool-text"
          type="button"
          class={`btn-icon ${effectiveTool === 'text' ? 'active' : ''}`}
          title="Typed Text Box"
          aria-label="Text Tool"
          onClick={() => {
            clearLasso();
            setTool('text');
          }}
        >
          <Type size={17} />
        </button>
        <button
          id="tool-pan"
          type="button"
          class={`btn-icon ${effectiveTool === 'pan' ? 'active' : ''}`}
          title="Read / Pan / Tap-to-Jump Audio & PDF Links"
          aria-label="Pan and Read Mode"
          onClick={() => {
            clearLasso();
            setTool('pan');
          }}
        >
          <Hand size={17} />
        </button>

        <span class="toolbar-divider" />

        {effectiveTool === 'eraser' ? (
          <button
            id="btn-eraser-mode"
            type="button"
            class="btn-secondary"
            style={{ padding: '4px 8px', fontSize: '11.5px' }}
            onClick={() => setEraserMode((m) => (m === 'stroke' ? 'partial' : 'stroke'))}
          >
            {eraserMode === 'stroke' ? 'Whole' : 'Partial'}
          </button>
        ) : (
          <>
            <div class="swatch-row">
              {colorPresets.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  class={`color-swatch ${currentColor === hex ? 'active' : ''}`}
                  style={{ background: hex }}
                  aria-label={`Color ${hex}`}
                  onClick={() =>
                    effectiveTool === 'highlighter' ? setHlColor(hex) : setPenColor(hex)
                  }
                />
              ))}
            </div>
            <input
              class="width-slider"
              type="range"
              aria-label="Stroke width"
              min={effectiveTool === 'highlighter' ? 10 : 1}
              max={effectiveTool === 'highlighter' ? 32 : 12}
              step={0.5}
              value={effectiveTool === 'highlighter' ? hlWidth : penWidth}
              onInput={(e) => {
                const v = parseFloat((e.target as HTMLInputElement).value);
                if (effectiveTool === 'highlighter') setHlWidth(v);
                else setPenWidth(v);
              }}
            />
          </>
        )}

        <span class="toolbar-divider" />

        <button
          id="btn-undo"
          type="button"
          class="btn-icon"
          title="Undo (Cmd+Z or 2-finger tap)"
          aria-label="Undo"
          onClick={performUndo}
        >
          <Undo2 size={16} />
        </button>
        <button
          id="btn-redo"
          type="button"
          class="btn-icon"
          title="Redo (Cmd+Shift+Z or 3-finger tap)"
          aria-label="Redo"
          onClick={performRedo}
        >
          <Redo2 size={16} />
        </button>
      </nav>

      {/* Lasso Contextual Actions */}
      {lassoStrokeIds.length > 0 && (
        <div class="lasso-actions" role="toolbar" aria-label="Lasso Selection Actions">
          <span style={{ fontWeight: 600 }}>{lassoStrokeIds.length} selected</span>
          <span class="toolbar-divider" />
          {settings.penColorPresets.slice(0, 4).map((hex) => (
            <button
              key={hex}
              type="button"
              class="color-swatch"
              style={{ background: hex, width: '16px', height: '16px' }}
              aria-label={`Recolor selection to ${hex}`}
              onClick={() => recolorLasso(hex)}
            />
          ))}
          <button type="button" class="btn-secondary" style={{ padding: '3px 7px', fontSize: '11.5px' }} onClick={() => scaleLasso(1.15)}>
            +Size
          </button>
          <button type="button" class="btn-secondary" style={{ padding: '3px 7px', fontSize: '11.5px' }} onClick={() => scaleLasso(0.85)}>
            -Size
          </button>
          <button type="button" class="btn-secondary" style={{ padding: '3px 7px', fontSize: '11.5px' }} onClick={duplicateLasso}>
            Duplicate
          </button>
          <button
            type="button"
            class="btn-secondary"
            style={{ padding: '3px 7px', fontSize: '11.5px', color: 'var(--danger)' }}
            onClick={deleteLasso}
          >
            Delete
          </button>
        </div>
      )}

      {/* Two-Plane 120 Hz Hybrid Stage */}
      <div ref={stageWrapperRef} class="stage-wrapper">
        {/* 120 Hz Dedicated OffscreenCanvas Wet Ink & Replay Plane */}
        <canvas ref={wetCanvasRef} class="wet-canvas-overlay" />

        {/* Native Compositor Scroll Stage (Vertical Continuous or Horizontal Snap) */}
        <div
          ref={scrollerRef}
          id="stage-scroller"
          class={`stage-scroller dir-${note.scrollDirection}`}
        >
          {note.pages.map((page, idx) => {
            const isVisible = Math.abs(idx - activePageIndex) <= 2;
            return (
              <PageSlot
                key={page.pageId}
                page={page}
                pageIndex={idx}
                zoom={zoom}
                isVisible={isVisible}
                activeTool={effectiveTool}
                fingerDrawMode={settings.fingerDrawMode}
                strokes={note.strokesByPage[page.pageId] ?? []}
                textBoxes={note.textBoxesByPage[page.pageId] ?? []}
                images={note.imagesByPage[page.pageId] ?? []}
                hiddenStrokeIds={page.pageId === lassoPageId ? hiddenStrokeIds : new Set()}
                selectedTextBoxId={selectedTextBoxId}
                selectedImageId={selectedImageId}
                replaySessionId={isPlaying ? playbackSessionId : null}
                replayTimeMs={playbackTimeMs}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onSelectTextBox={setSelectedTextBoxId}
                onUpdateTextBox={(pid, box) => {
                  const prev = noteRef.current.textBoxesByPage[pid] ?? [];
                  onUpdateNote({
                    ...noteRef.current,
                    updatedAt: Date.now(),
                    textBoxesByPage: {
                      ...noteRef.current.textBoxesByPage,
                      [pid]: prev.map((b) => (b.id === box.id ? box : b)),
                    },
                  });
                }}
                onDeleteTextBox={(pid, id) => {
                  const prev = noteRef.current.textBoxesByPage[pid] ?? [];
                  onUpdateNote({
                    ...noteRef.current,
                    updatedAt: Date.now(),
                    textBoxesByPage: {
                      ...noteRef.current.textBoxesByPage,
                      [pid]: prev.filter((b) => b.id !== id),
                    },
                  });
                  setSelectedTextBoxId(null);
                }}
                onSelectImage={setSelectedImageId}
                onUpdateImage={(pid, img) => {
                  const prev = noteRef.current.imagesByPage[pid] ?? [];
                  onUpdateNote({
                    ...noteRef.current,
                    updatedAt: Date.now(),
                    imagesByPage: {
                      ...noteRef.current.imagesByPage,
                      [pid]: prev.map((i) => (i.id === img.id ? img : i)),
                    },
                  });
                }}
                onDeleteImage={(pid, id) => {
                  const prev = noteRef.current.imagesByPage[pid] ?? [];
                  onUpdateNote({
                    ...noteRef.current,
                    updatedAt: Date.now(),
                    imagesByPage: {
                      ...noteRef.current.imagesByPage,
                      [pid]: prev.filter((i) => i.id !== id),
                    },
                  });
                  setSelectedImageId(null);
                }}
                onJumpToPdfPage={(pdfPageNum) => {
                  const targetIdx = note.pages.findIndex(
                    (p) => p.source.kind === 'pdf' && p.source.pdfPageNumber === pdfPageNum
                  );
                  if (targetIdx >= 0) {
                    const slot = scrollerRef.current?.querySelector<HTMLElement>(
                      `[data-page-index="${targetIdx}"]`
                    );
                    slot?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                onDropFile={(file, pid, xPt, yPt) => {
                  if (file.type.startsWith('image/')) {
                    void handleInsertImageFile(file, pid, xPt, yPt);
                  }
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Spring-Loaded Quick-Hold Thumb Pill (WebKit Apple Pencil Double-Tap Replacement) */}
      <button
        id="btn-thumb-eraser"
        type="button"
        class={`thumb-pill ${thumbEraserHeld ? 'held' : ''}`}
        title="Hold with non-dominant thumb to temporarily erase"
        onPointerDown={(e) => {
          e.preventDefault();
          setThumbEraserHeld(true);
        }}
        onPointerUp={() => setThumbEraserHeld(false)}
        onPointerCancel={() => setThumbEraserHeld(false)}
        onPointerLeave={() => setThumbEraserHeld(false)}
      >
        <Eraser size={14} />
        {thumbEraserHeld ? 'Erasing' : 'Hold: Erase'}
      </button>

      {/* Audio Recording & Synced Playback Bar (FR-AUD-01..04) */}
      {(audioBarOpen || recordingState !== 'idle') && (
        <div class="audio-bar" role="region" aria-label="Audio Recording and Synced Playback">
          {recordingState !== 'idle' ? (
            <>
              <span class="rec-dot" />
              <strong style={{ fontFamily: 'var(--font-mono)' }}>
                {formatDuration(recordingElapsedMs)}
              </strong>
              <button
                type="button"
                class="btn-secondary"
                style={{ padding: '4px 9px', fontSize: '12px' }}
                onClick={toggleRecording}
              >
                {recordingState === 'recording' ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                class="btn-icon"
                title="OLED Dim Curtain (saves battery while Wake Lock stays active)"
                aria-label="Dim screen while recording"
                onClick={() => setDimCurtain(true)}
              >
                <Moon size={15} />
              </button>
              <button
                id="btn-stop-recording"
                type="button"
                class="btn-primary"
                style={{ padding: '4px 10px', fontSize: '12px' }}
                onClick={stopRecording}
              >
                <Square size={12} /> Stop
              </button>
            </>
          ) : (
            activeSession && (
              <>
                <button
                  type="button"
                  class="btn-icon"
                  aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
                  onClick={togglePlayback}
                >
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                  type="button"
                  class="btn-icon"
                  title="Skip back 15s"
                  aria-label="Skip back 15 seconds"
                  onClick={() => skipAudio(-15)}
                >
                  <RotateCcw size={15} />
                </button>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                  {formatDuration(playbackTimeMs)} / {formatDuration(activeSession.durationMs)}
                </span>
                <input
                  class="audio-scrubber"
                  type="range"
                  aria-label="Audio timeline"
                  min={0}
                  max={Math.max(1000, activeSession.durationMs)}
                  value={playbackTimeMs}
                  onInput={(e) => {
                    const ms = parseFloat((e.target as HTMLInputElement).value);
                    setPlaybackTimeMs(ms);
                    if (audioElRef.current) audioElRef.current.currentTime = ms / 1000;
                  }}
                />
                <button
                  type="button"
                  class="btn-icon"
                  title="Skip forward 15s"
                  aria-label="Skip forward 15 seconds"
                  onClick={() => skipAudio(15)}
                >
                  <RotateCw size={15} />
                </button>
                <select
                  aria-label="Playback speed"
                  value={playbackRate}
                  onChange={(e) => {
                    const r = parseFloat((e.target as HTMLSelectElement).value);
                    setPlaybackRate(r);
                    if (audioElRef.current) audioElRef.current.playbackRate = r;
                  }}
                  style={{
                    padding: '3px 6px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--surface-2)',
                    fontSize: '12px',
                  }}
                >
                  {[0.5, 1.0, 1.25, 1.5, 2.0].map((r) => (
                    <option key={r} value={r}>
                      {r}x
                    </option>
                  ))}
                </select>
              </>
            )
          )}
        </div>
      )}

      {/* OLED Battery-Saver Dim Curtain while Wake Lock Recording is Active */}
      {dimCurtain && (
        <div
          class="oled-dim-curtain"
          onPointerDown={() => setDimCurtain(false)}
          role="button"
          tabIndex={0}
        >
          <span class="rec-dot" />
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '26px' }}>
            {formatDuration(recordingElapsedMs)}
          </div>
          <div style={{ fontSize: '13px', opacity: 0.72 }}>
            Recording audio safely (10s OPFS flush). Tap or touch Pencil anywhere to wake.
          </div>
        </div>
      )}
    </div>
  );
}
