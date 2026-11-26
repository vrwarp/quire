import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  BBox,
  EraserMode,
  EraserSizePreset,
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
  StylusKinematicPredictor,
  computeBBox,
  createSnappedShapeDescriptor,
  generateOrderKey,
  hitTestStroke,
  partialEraseStroke,
  recognizeShape,
  strokeInLasso,
  updateSnappedShape,
  type SnappedShapeDescriptor,
} from '../engine/inkMath';
import {
  PalmRejectionGuard,
  attachMultiFingerUndoRedo,
  unpackPointerSamples,
} from '../engine/inputRouter';
import { AudioSyncRecorder, formatDuration } from '../engine/audio';
import { createBlankPage, createId, quireStorage } from '../engine/storage';
import { drawVectorStroke } from '../engine/canvasRenderer';
import { pdfEngine } from '../engine/pdfEngine';
import type { InkWorkerMessage } from '../workers/ink.worker';
import { PageSlot } from './PageSlot';

const EMPTY_STROKES: VectorStroke[] = [];
const EMPTY_TEXTBOXES: TextBoxItem[] = [];
const EMPTY_IMAGES: ImageItem[] = [];
const EMPTY_HIDDEN_IDS = new Set<string>();
const ERASER_SIZE_PX: Record<EraserSizePreset, number> = {
  small: 8,
  medium: 16,
  large: 30,
};

interface NoteEditorProps {
  note: NoteDocument;
  settings: AppSettings;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onBackToLibrary: () => void;
  onUpdateNote: (updated: NoteDocument) => void;
  onUpdateSettings: (next: AppSettings) => void;
  onOpenPageManager: (activePageIndex: number) => void;
  onOpenExport: (activePageIndex: number) => void;
  onToast: (msg: string, durationMs?: number) => void;
  jumpToPageRequest: number | null;
  onClearJumpRequest: () => void;
}

export function NoteEditor({
  note,
  settings,
  onBackToLibrary,
  onUpdateNote,
  onUpdateSettings,
  onOpenPageManager,
  onOpenExport,
  onToast,
  jumpToPageRequest,
  onClearJumpRequest,
}: NoteEditorProps) {
  const stageWrapperRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pagesTrackRef = useRef<HTMLDivElement>(null);
  const wetCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const hzPillRef = useRef<HTMLSpanElement>(null);
  const hzLatencySpanRef = useRef<HTMLSpanElement>(null);
  const pendingScrollRestoreRef = useRef<{ left: number; top: number } | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const fallbackWetCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const wetSeqRef = useRef(0);
  const governorRef = useRef<ProMotionGovernor | null>(null);
  const palmGuardRef = useRef(new PalmRejectionGuard(250));
  // High-cutoff micro-filter used ONLY for coarse mouse/finger; Apple Pencil uses 0ms raw 240Hz coords
  const filterXRef = useRef(new OneEuroFilter(22.0, 0.35));
  const filterYRef = useRef(new OneEuroFilter(22.0, 0.35));
  const predictorRef = useRef(new StylusKinematicPredictor());
  const audioRecorderRef = useRef<AudioSyncRecorder | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const undoStackRef = useRef<UndoCommand[]>([]);
  const redoStackRef = useRef<UndoCommand[]>([]);

  const [tool, setTool] = useState<ToolKind>('pen');
  const [thumbEraserHeld, setThumbEraserHeld] = useState(false);
  const effectiveTool: ToolKind = thumbEraserHeld ? 'eraser' : tool;
  const lastInkToolRef = useRef<'pen' | 'highlighter'>('pen');

  const [eraserMode, setEraserMode] = useState<EraserMode>('partial');
  const [penColor, setPenColor] = useState(settings.penColorPresets[0]);
  const [hlColor, setHlColor] = useState(settings.highlighterColorPresets[0]);
  const [penWidth, setPenWidth] = useState(2.8);
  const [hlWidth, setHlWidth] = useState(18);
  const [zoom, setZoom] = useState(1);
  const [fitWidthMode, setFitWidthMode] = useState(true);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedTextBoxId, setSelectedTextBoxId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const fitWidthModeRef = useRef(fitWidthMode);
  fitWidthModeRef.current = fitWidthMode;
  const activePageIndexRef = useRef(activePageIndex);
  activePageIndexRef.current = activePageIndex;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Lasso state
  const [lassoPageId, setLassoPageId] = useState<string | null>(null);
  const [lassoStrokeIds, setLassoStrokeIds] = useState<string[]>([]);
  const [lassoPolygon, setLassoPolygon] = useState<Array<{ x: number; y: number }>>([]);
  const lassoBBoxRef = useRef<BBox | null>(null);
  const lassoDragRef = useRef<{
    active: boolean;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    scale: number;
    anchorX: number;
    anchorY: number;
    startCornerDist: number;
    pageEl: HTMLDivElement | null;
  }>({
    active: false,
    mode: 'move',
    startX: 0,
    startY: 0,
    dx: 0,
    dy: 0,
    scale: 1,
    anchorX: 0,
    anchorY: 0,
    startCornerDist: 1,
    pageEl: null,
  });

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

  // Live 120 Hz Telemetry (mounted once; hot-path latency & boost updates mutate DOM refs directly)
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    boostActive: false,
    offscreenCanvasActive: false,
    rendererBackend: '2d-main',
    estimatedHz: 60,
    lastInkLatencyMs: 0,
    activeStrokesOnPage: 0,
    cachedPdfTiles: 0,
  });

  // Active in-progress drawing state (kept in refs with cached geometry so pointermove does 0 DOM reflows!)
  const activeStrokeRef = useRef<{
    seq: number;
    pointerId: number;
    pointerType: string;
    page: PageDescriptor;
    pageEl: HTMLDivElement;
    pageLeft: number;
    pageTop: number;
    offsetX: number;
    offsetY: number;
    tool: 'pen' | 'highlighter';
    color: string;
    width: number;
    paperTheme: PaperTheme;
    points: StrokePoint[];
    startPerf: number;
    lastBatchPerf: number;
    lastRawTimeStamp: number;
    audioSessionId?: string;
    startAudioMs?: number;
    dwellTimer: number;
    snappedKind?: string;
    snappedShape?: SnappedShapeDescriptor;
  } | null>(null);

  const noteRef = useRef(note);
  noteRef.current = note;

  const hiddenStrokeIds = useMemo(
    () => (lassoStrokeIds.length === 0 ? EMPTY_HIDDEN_IDS : new Set(lassoStrokeIds)),
    [lassoStrokeIds]
  );

  const sendToWetWorker = useCallback((msg: InkWorkerMessage) => {
    if (workerRef.current) {
      workerRef.current.postMessage(msg);
      return;
    }
    // Graceful 2D main-thread fallback if OffscreenCanvas transfer is unavailable
    const ctx = fallbackWetCtxRef.current;
    const canvas = wetCanvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (msg.type === 'clear') {
      if (msg.seq !== undefined && msg.seq !== wetSeqRef.current) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else if (msg.type === 'eraser-cursor') {
      const cx = msg.offsetX + msg.x * msg.zoom;
      const cy = msg.offsetY + msg.y * msg.zoom;
      const rCss = Math.max(4, msg.radiusPt * msg.zoom);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      ctx.arc(cx, cy, rCss, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 90, 50, 0.12)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(24, 24, 27, 0.8)';
      ctx.stroke();
      ctx.restore();
    } else if (
      msg.type === 'wet-start' ||
      msg.type === 'wet-append' ||
      msg.type === 'wet-trim' ||
      msg.type === 'wet-replace'
    ) {
      const cur = activeStrokeRef.current;
      if (!cur || msg.seq !== cur.seq) return;
      const pts =
        msg.type === 'wet-append' ? [...cur.points, ...msg.predicted] : cur.points;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(cur.offsetX, cur.offsetY);
      ctx.scale(msg.zoom, msg.zoom);
      drawVectorStroke(
        ctx,
        { tool: cur.tool, color: cur.color, width: cur.width, points: pts },
        cur.paperTheme
      );
      ctx.restore();
    }
  }, []);

  // 1. Mount ProMotion 120 Hz Governor + O(1) Dirty-Rect 2D OffscreenCanvas Worker + 120 Hz Scroll Bus
  useEffect(() => {
    const wrapper = stageWrapperRef.current;
    const scroller = scrollerRef.current;
    const wetCanvas = wetCanvasRef.current;
    if (!wrapper || !scroller || !wetCanvas) return;

    const governor = new ProMotionGovernor(wrapper, {
      holdMs: 850,
      onStatusChange: (active) => {
        hzPillRef.current?.classList.toggle('boosted', active);
      },
    });
    governorRef.current = governor;

    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
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
            // Update latency badge via direct DOM ref so active 120 Hz strokes cause ZERO Preact VDOM re-renders!
            if (hzLatencySpanRef.current) {
              hzLatencySpanRef.current.textContent =
                ev.data.renderMs > 0 ? ` · ${ev.data.renderMs}ms` : '';
            }
            if (hzPillRef.current) {
              hzPillRef.current.title = `Backend: 2d-offscreen | Ink GPU pass: ${ev.data.renderMs}ms | Cached PDF tiles: ${pdfEngine.cachedTileCount}`;
            }
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
      const curDpr = Math.min(1.5, window.devicePixelRatio || 1);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'resize', width: r.width, height: r.height, dpr: curDpr });
      } else {
        wetCanvas.width = Math.round(r.width * curDpr);
        wetCanvas.height = Math.round(r.height * curDpr);
      }
      if (fitWidthModeRef.current) {
        const page = noteRef.current.pages[activePageIndexRef.current] ?? noteRef.current.pages[0];
        const pageW = page?.widthPt ?? 612;
        const availableW = Math.max(240, scroller.clientWidth - 72);
        const nextFit = Math.max(0.5, Math.min(4, Number((availableW / pageW).toFixed(3))));
        setZoom(nextFit);
      }
    });
    resizeObs.observe(wrapper);

    // 120 Hz Scroll Bus tracking active page index smoothly
    const scrollBus = createScrollBus({
      read: () => ({ left: scroller.scrollLeft, top: scroller.scrollTop }),
      onReading: () => {
        governor.wake();
        if (activeStrokeRef.current) return;
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

    // Pinch-to-Zoom (2-finger touch with temporary touchmove, Safari gesture*, and Ctrl+Wheel trackpad)
    // Uses GPU transform preview during the gesture and commits crisp vector zoom on gesture end.
    const pinch = {
      active: false,
      source: 'none' as 'none' | 'touch' | 'gesture' | 'wheel',
      startZoom: 1,
      targetZoom: 1,
      startDist: 1,
      startMidX: 0,
      startMidY: 0,
      curMidX: 0,
      curMidY: 0,
      baseLeft: 0,
      baseTop: 0,
      ax: 0,
      ay: 0,
      startScrollLeft: 0,
      startScrollTop: 0,
      wheelTimer: 0,
    };

    const clampZoom = (z: number) => Math.max(0.5, Math.min(4, Number(z.toFixed(3))));

    const beginPinch = (
      source: 'touch' | 'gesture' | 'wheel',
      midX: number,
      midY: number,
      startDist: number
    ) => {
      const track = pagesTrackRef.current;
      if (!track) return;
      window.clearTimeout(pinch.wheelTimer);
      const trackRect = track.getBoundingClientRect();
      pinch.active = true;
      pinch.source = source;
      pinch.startZoom = zoomRef.current;
      pinch.targetZoom = zoomRef.current;
      pinch.startDist = Math.max(10, startDist);
      pinch.startMidX = midX;
      pinch.startMidY = midY;
      pinch.curMidX = midX;
      pinch.curMidY = midY;
      pinch.baseLeft = trackRect.left;
      pinch.baseTop = trackRect.top;
      pinch.ax = midX - trackRect.left;
      pinch.ay = midY - trackRect.top;
      pinch.startScrollLeft = scroller.scrollLeft;
      pinch.startScrollTop = scroller.scrollTop;
      track.style.willChange = 'transform';
      governor.wake();
    };

    const getFitWidthForScroller = () => {
      const page = noteRef.current.pages[activePageIndexRef.current] ?? noteRef.current.pages[0];
      const pageW = page?.widthPt ?? 612;
      const availableW = Math.max(240, scroller.clientWidth - 72);
      return Math.max(0.5, Math.min(4, Number((availableW / pageW).toFixed(3))));
    };

    const previewPinch = (nextZoomRaw: number, curMidX: number, curMidY: number) => {
      const track = pagesTrackRef.current;
      if (!track || !pinch.active) return;
      let nextZoom = clampZoom(nextZoomRaw);
      const fitZoom = getFitWidthForScroller();
      if (Math.abs(nextZoom - fitZoom) / fitZoom <= 0.06) {
        nextZoom = fitZoom;
      }
      const ratio = nextZoom / pinch.startZoom;
      const tx = curMidX - pinch.baseLeft - ratio * pinch.ax;
      const ty = curMidY - pinch.baseTop - ratio * pinch.ay;
      track.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${ratio})`;
      pinch.targetZoom = nextZoom;
      pinch.curMidX = curMidX;
      pinch.curMidY = curMidY;
      governor.wake();
    };

    const commitPinch = () => {
      if (!pinch.active) return;
      const track = pagesTrackRef.current;
      const fitZoom = getFitWidthForScroller();
      const snappedToFit = Math.abs(pinch.targetZoom - fitZoom) / fitZoom <= 0.06;
      const nextZoom = snappedToFit ? fitZoom : pinch.targetZoom;
      const ratio = nextZoom / pinch.startZoom;
      const nextLeft = snappedToFit
        ? 0
        : Math.max(
            0,
            pinch.startScrollLeft + pinch.ax * (ratio - 1) - (pinch.curMidX - pinch.startMidX)
          );
      const nextTop = Math.max(
        0,
        pinch.startScrollTop + pinch.ay * (ratio - 1) - (pinch.curMidY - pinch.startMidY)
      );
      const changed = Math.abs(nextZoom - pinch.startZoom) > 0.004;

      pinch.active = false;
      pinch.source = 'none';
      window.clearTimeout(pinch.wheelTimer);

      if (track) {
        track.style.transform = '';
        track.style.willChange = '';
      }
      setFitWidthMode(snappedToFit);

      if (changed) {
        pendingScrollRestoreRef.current = { left: nextLeft, top: nextTop };
        setZoom(nextZoom);
      } else {
        scroller.scrollLeft = nextLeft;
        scroller.scrollTop = nextTop;
      }
    };

    const onPinchTouchMove = (e: TouchEvent) => {
      if (!pinch.active || pinch.source !== 'touch' || e.touches.length < 2) return;
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      previewPinch(pinch.startZoom * (dist / pinch.startDist), midX, midY);
    };

    const detachTempTouchPinch = () => {
      window.removeEventListener('touchmove', onPinchTouchMove);
      window.removeEventListener('touchend', onPinchTouchEnd);
      window.removeEventListener('touchcancel', onPinchTouchEnd);
    };

    const onPinchTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        detachTempTouchPinch();
        if (pinch.active && pinch.source === 'touch') {
          commitPinch();
        }
      }
    };

    const onPinchTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      // If a finger stroke started moments before the 2nd finger landed, cancel it cleanly
      if (activeStrokeRef.current && activeStrokeRef.current.pointerType !== 'pen') {
        window.clearTimeout(activeStrokeRef.current.dwellTimer);
        activeStrokeRef.current = null;
        wetSeqRef.current += 1;
        sendToWetWorker({ type: 'clear' });
      }
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      beginPinch('touch', midX, midY, dist);
      // Dynamically attach non-passive touchmove ONLY during active 2-finger pinch!
      window.addEventListener('touchmove', onPinchTouchMove, { passive: false });
      window.addEventListener('touchend', onPinchTouchEnd, { passive: true });
      window.addEventListener('touchcancel', onPinchTouchEnd, { passive: true });
    };

    // Passive Single-Finger Double-Tap Zoom (toggles Fit Width <-> ~2x anchored on tap point)
    let tapStartX = 0;
    let tapStartY = 0;
    let tapStartAt = 0;
    let tapValid = false;
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const onDoubleTapTouchStart = (e: TouchEvent) => {
      if (
        e.touches.length !== 1 ||
        settingsRef.current.fingerDrawMode ||
        palmGuardRef.current.isSuppressedNow()
      ) {
        tapValid = false;
        return;
      }
      const t = e.touches[0] as Touch & { touchType?: string };
      if (t.touchType === 'stylus') {
        tapValid = false;
        return;
      }
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest('button, input, textarea, select, a, .canvas-textbox')) {
        tapValid = false;
        return;
      }
      tapStartX = t.clientX;
      tapStartY = t.clientY;
      tapStartAt = performance.now();
      tapValid = true;
    };

    const onDoubleTapTouchEnd = (e: TouchEvent) => {
      if (!tapValid || e.touches.length !== 0 || e.changedTouches.length !== 1) {
        tapValid = false;
        return;
      }
      tapValid = false;
      const t = e.changedTouches[0] as Touch & { touchType?: string };
      if (t.touchType === 'stylus' || palmGuardRef.current.isSuppressedNow()) return;
      const now = performance.now();
      const drift = Math.hypot(t.clientX - tapStartX, t.clientY - tapStartY);
      if (drift > 12 || now - tapStartAt > 240) return;

      if (now - lastTapAt <= 280 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) <= 32) {
        lastTapAt = 0;
        const track = pagesTrackRef.current;
        if (!track) return;
        const trackRect = track.getBoundingClientRect();
        const ax = t.clientX - trackRect.left;
        const ay = t.clientY - trackRect.top;
        const curZoom = zoomRef.current;
        const fitZoom = getFitWidthForScroller();
        const isNearFit = fitWidthModeRef.current || Math.abs(curZoom - fitZoom) / fitZoom < 0.08;
        const nextZoom = isNearFit ? clampZoom(fitZoom * 2) : fitZoom;
        const ratio = nextZoom / curZoom;
        const nextLeft = isNearFit
          ? Math.max(0, scroller.scrollLeft + ax * (ratio - 1))
          : 0;
        const nextTop = Math.max(0, scroller.scrollTop + ay * (ratio - 1));
        setFitWidthMode(!isNearFit);
        pendingScrollRestoreRef.current = { left: nextLeft, top: nextTop };
        setZoom(nextZoom);
      } else {
        lastTapAt = now;
        lastTapX = t.clientX;
        lastTapY = t.clientY;
      }
    };

    type SafariGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
    const onGestureStart = (ev: Event) => {
      const e = ev as SafariGestureEvent;
      e.preventDefault();
      if (!pinch.active) {
        const sr = scroller.getBoundingClientRect();
        beginPinch(
          'gesture',
          e.clientX ?? sr.left + sr.width / 2,
          e.clientY ?? sr.top + sr.height / 2,
          100
        );
      }
    };
    const onGestureChange = (ev: Event) => {
      const e = ev as SafariGestureEvent;
      e.preventDefault();
      if (pinch.active && pinch.source === 'gesture' && typeof e.scale === 'number') {
        previewPinch(
          pinch.startZoom * e.scale,
          e.clientX ?? pinch.curMidX,
          e.clientY ?? pinch.curMidY
        );
      }
    };
    const onGestureEnd = (ev: Event) => {
      ev.preventDefault();
      if (pinch.active && pinch.source === 'gesture') {
        commitPinch();
      }
    };

    const onPinchWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!pinch.active) {
        beginPinch('wheel', e.clientX, e.clientY, 100);
      }
      const factor = Math.exp(-e.deltaY * 0.01);
      previewPinch(pinch.targetZoom * factor, e.clientX, e.clientY);
      window.clearTimeout(pinch.wheelTimer);
      pinch.wheelTimer = window.setTimeout(() => {
        if (pinch.active && pinch.source === 'wheel') {
          commitPinch();
        }
      }, 100);
    };

    scroller.addEventListener('touchstart', onPinchTouchStart, { passive: true });
    scroller.addEventListener('touchstart', onDoubleTapTouchStart, { passive: true });
    scroller.addEventListener('touchend', onDoubleTapTouchEnd, { passive: true });
    scroller.addEventListener('gesturestart', onGestureStart, { passive: false });
    scroller.addEventListener('gesturechange', onGestureChange, { passive: false });
    scroller.addEventListener('gestureend', onGestureEnd, { passive: false });
    scroller.addEventListener('wheel', onPinchWheel, { passive: false });

    const detachMultiFinger = attachMultiFingerUndoRedo(scroller, {
      onUndo: () => performUndo(true),
      onRedo: () => performRedo(true),
      shouldSuppress: () => palmGuardRef.current.isSuppressedNow(),
    });

    return () => {
      detachTempTouchPinch();
      window.clearTimeout(pinch.wheelTimer);
      scroller.removeEventListener('touchstart', onPinchTouchStart);
      scroller.removeEventListener('touchstart', onDoubleTapTouchStart);
      scroller.removeEventListener('touchend', onDoubleTapTouchEnd);
      scroller.removeEventListener('gesturestart', onGestureStart);
      scroller.removeEventListener('gesturechange', onGestureChange);
      scroller.removeEventListener('gestureend', onGestureEnd);
      scroller.removeEventListener('wheel', onPinchWheel);
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

  const computeFitWidthZoom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return 1;
    const page = noteRef.current.pages[activePageIndexRef.current] ?? noteRef.current.pages[0];
    const pageW = page?.widthPt ?? 612;
    const horizontalMargin = 72; // 36px margin on either side
    const availableW = Math.max(240, scroller.clientWidth - horizontalMargin);
    return Math.max(0.5, Math.min(4, Number((availableW / pageW).toFixed(3))));
  }, []);

  // Default every newly opened note synchronously to Fit Width before first paint
  useLayoutEffect(() => {
    setZoom(computeFitWidthZoom());
  }, [computeFitWidthZoom]);

  // Restore scroll anchor synchronously after a pinch-to-zoom or double-tap zoom commit updates page layout
  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore || !scrollerRef.current) return;
    pendingScrollRestoreRef.current = null;
    scrollerRef.current.scrollLeft = restore.left;
    scrollerRef.current.scrollTop = restore.top;
  }, [zoom]);

  const toggleFitWidth = useCallback(() => {
    setFitWidthMode((prev) => {
      const next = !prev;
      if (next) {
        setZoom(computeFitWidthZoom());
      }
      return next;
    });
  }, [computeFitWidthZoom]);

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

  const performUndo = useCallback(
    (fromGesture = false) => {
      const cmd = undoStackRef.current.pop();
      if (!cmd) return;
      cmd.undo();
      redoStackRef.current.push(cmd);
      if (fromGesture) onToast(`Undo: ${cmd.description}`, 1400);
    },
    [onToast]
  );

  const performRedo = useCallback(
    (fromGesture = false) => {
      const cmd = redoStackRef.current.pop();
      if (!cmd) return;
      cmd.redo();
      undoStackRef.current.push(cmd);
      if (fromGesture) onToast(`Redo: ${cmd.description}`, 1400);
    },
    [onToast]
  );

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
        const cur = noteRef.current;
        const lastPage = cur.pages[cur.pages.length - 1];
        const shouldAppendNextPage =
          list.length > 0 && lastPage !== undefined && lastPage.pageId === pageId;

        let nextPages = cur.pages;
        const nextStrokesByPage = { ...cur.strokesByPage, [pageId]: list };
        let nextTextBoxesByPage = cur.textBoxesByPage;
        let nextImagesByPage = cur.imagesByPage;

        if (shouldAppendNextPage) {
          const tpl =
            lastPage.source.kind === 'template'
              ? lastPage.source.template
              : settings.defaultTemplate;
          const theme =
            lastPage.source.kind === 'template'
              ? lastPage.source.theme
              : settings.defaultPaperTheme;
          const nextPage = createBlankPage(tpl, theme, generateOrderKey(lastPage.orderKey));
          nextPages = [...cur.pages, nextPage];
          nextStrokesByPage[nextPage.pageId] = [];
          nextTextBoxesByPage = { ...cur.textBoxesByPage, [nextPage.pageId]: [] };
          nextImagesByPage = { ...cur.imagesByPage, [nextPage.pageId]: [] };
        }

        const next: NoteDocument = {
          ...cur,
          updatedAt: Date.now(),
          pages: nextPages,
          strokesByPage: nextStrokesByPage,
          textBoxesByPage: nextTextBoxesByPage,
          imagesByPage: nextImagesByPage,
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
    [onUpdateNote, pushCommand, settings.defaultTemplate, settings.defaultPaperTheme]
  );

  const getPageOffsets = (pageEl: HTMLDivElement) => {
    const wrapRect = stageWrapperRef.current!.getBoundingClientRect();
    const pRect = pageEl.getBoundingClientRect();
    return { offsetX: pRect.left - wrapRect.left, offsetY: pRect.top - wrapRect.top, pRect };
  };

  const getEraserRadiusPt = () =>
    (ERASER_SIZE_PX[settingsRef.current.eraserSize ?? 'medium'] ?? 16) / zoomRef.current;

  /* ============================================================================
     Pointer Input Handling (240 Hz Coalesced + Predicted + Palm Rejection)
     ============================================================================ */
  const handlePointerDown = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    governorRef.current?.wake();

    if (e.pointerType === 'pen') {
      palmGuardRef.current.notePenDown();
      // If a resting palm touched down moments before the Apple Pencil nib, preempt it immediately!
      if (activeStrokeRef.current && activeStrokeRef.current.pointerType !== 'pen') {
        window.clearTimeout(activeStrokeRef.current.dwellTimer);
        activeStrokeRef.current = null;
      }
    } else if (
      palmGuardRef.current.shouldRejectTouch(e) ||
      (e.pointerType === 'touch' && (e.width > 28 || e.height > 28))
    ) {
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

    // Eraser tool (Analytical Precision Partial or Whole-Stroke + live 120 Hz cursor ring)
    if (effectiveTool === 'eraser') {
      const radiusPt = getEraserRadiusPt();
      applyEraserAt(page.pageId, xPt, yPt);
      sendToWetWorker({
        type: 'eraser-cursor',
        offsetX,
        offsetY,
        zoom,
        x: xPt,
        y: yPt,
        radiusPt,
      });
      const nowPerf = e.timeStamp || performance.now();
      activeStrokeRef.current = {
        seq: 0,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        page,
        pageEl,
        pageLeft: pRect.left,
        pageTop: pRect.top,
        offsetX,
        offsetY,
        tool: 'pen',
        color: 'eraser',
        width: radiusPt,
        paperTheme: 'light',
        points: [],
        startPerf: nowPerf,
        lastBatchPerf: nowPerf,
        lastRawTimeStamp: e.timeStamp || 0,
        dwellTimer: 0,
      };
      return;
    }

    // Lasso tool: hit-test corner resize handles, inside bbox move, or tap-outside dismiss
    if (effectiveTool === 'lasso') {
      if (lassoPageId === page.pageId && lassoStrokeIds.length > 0 && lassoBBoxRef.current) {
        const box = lassoBBoxRef.current;
        const pad = 6 / Math.max(0.5, zoom);
        const cornerHitR = 18 / Math.max(0.5, zoom);
        const corners = [
          { x: box.minX - pad, y: box.minY - pad, oppX: box.maxX, oppY: box.maxY },
          { x: box.maxX + pad, y: box.minY - pad, oppX: box.minX, oppY: box.maxY },
          { x: box.maxX + pad, y: box.maxY + pad, oppX: box.minX, oppY: box.minY },
          { x: box.minX - pad, y: box.maxY + pad, oppX: box.maxX, oppY: box.minY },
        ];
        const hitCorner = corners.find((c) => Math.hypot(xPt - c.x, yPt - c.y) <= cornerHitR);
        if (hitCorner) {
          lassoDragRef.current = {
            active: true,
            mode: 'resize',
            startX: xPt,
            startY: yPt,
            dx: 0,
            dy: 0,
            scale: 1,
            anchorX: hitCorner.oppX,
            anchorY: hitCorner.oppY,
            startCornerDist: Math.max(12, Math.hypot(xPt - hitCorner.oppX, yPt - hitCorner.oppY)),
            pageEl,
          };
          return;
        }
        const insidePad = 10 / Math.max(0.5, zoom);
        if (
          xPt >= box.minX - insidePad &&
          xPt <= box.maxX + insidePad &&
          yPt >= box.minY - insidePad &&
          yPt <= box.maxY + insidePad
        ) {
          lassoDragRef.current = {
            active: true,
            mode: 'move',
            startX: xPt,
            startY: yPt,
            dx: 0,
            dy: 0,
            scale: 1,
            anchorX: (box.minX + box.maxX) / 2,
            anchorY: (box.minY + box.maxY) / 2,
            startCornerDist: 1,
            pageEl,
          };
          return;
        }
        // Tapped outside selection: dismiss cleanly (and allow starting a new marquee if dragged)
        clearLasso();
      }
      setLassoPageId(page.pageId);
      setLassoStrokeIds([]);
      setLassoPolygon([{ x: xPt, y: yPt }]);
      return;
    }

    // Pen or Highlighter stroke start — ZERO filter lag on Apple Pencil!
    const inkTool = effectiveTool === 'highlighter' ? 'highlighter' : 'pen';
    const color = inkTool === 'highlighter' ? hlColor : penColor;
    const width = inkTool === 'highlighter' ? hlWidth : penWidth;
    const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
    const startPerf = e.timeStamp || performance.now();

    const isPen = e.pointerType === 'pen';
    filterXRef.current.reset();
    filterYRef.current.reset();
    predictorRef.current.reset();

    const fx = isPen ? xPt : filterXRef.current.filter(xPt, startPerf);
    const fy = isPen ? yPt : filterYRef.current.filter(yPt, startPerf);

    const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    const firstPt: StrokePoint = {
      x: fx,
      y: fy,
      pressure: isPen ? e.pressure || 0.5 : 0.5,
      altitude: anyE.altitudeAngle ?? Math.PI / 2,
      azimuth: anyE.azimuthAngle ?? 0,
      dtMs: 0,
    };
    predictorRef.current.pushSample(firstPt, startPerf);

    const audioSessionId =
      recordingState === 'recording' ? audioRecorderRef.current?.activeSessionId ?? undefined : undefined;
    const startAudioMs =
      recordingState === 'recording' ? audioRecorderRef.current?.getElapsedMs() : undefined;

    const seq = ++wetSeqRef.current;

    activeStrokeRef.current = {
      seq,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      page,
      pageEl,
      pageLeft: pRect.left,
      pageTop: pRect.top,
      offsetX,
      offsetY,
      tool: inkTool,
      color,
      width,
      paperTheme,
      points: [firstPt],
      startPerf,
      lastBatchPerf: startPerf,
      lastRawTimeStamp: e.timeStamp || 0,
      audioSessionId,
      startAudioMs,
      dwellTimer: 0,
    };

    // Dispatch wet-start immediately (<0.1ms) so initial pen-down dot renders on the very next 120 Hz scanout!
    sendToWetWorker({
      type: 'wet-start',
      seq,
      tool: inkTool,
      color,
      width,
      paperTheme,
      offsetX,
      offsetY,
      zoom,
      point: firstPt,
    });
  };

  const handlePointerMove = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    if (e.pointerType === 'touch' && palmGuardRef.current.shouldRejectTouch(e)) return;

    // Active Lasso marquee, move, or corner resize
    if (effectiveTool === 'lasso') {
      const { offsetX, offsetY, pRect } = getPageOffsets(pageEl);
      const pt = { x: (e.clientX - pRect.left) / zoom, y: (e.clientY - pRect.top) / zoom };
      const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
      if (lassoDragRef.current.active) {
        if (lassoDragRef.current.mode === 'resize') {
          const curDist = Math.max(
            8,
            Math.hypot(pt.x - lassoDragRef.current.anchorX, pt.y - lassoDragRef.current.anchorY)
          );
          lassoDragRef.current.scale = Math.max(
            0.25,
            Math.min(4, curDist / lassoDragRef.current.startCornerDist)
          );
          lassoDragRef.current.dx = 0;
          lassoDragRef.current.dy = 0;
        } else {
          lassoDragRef.current.dx = pt.x - lassoDragRef.current.startX;
          lassoDragRef.current.dy = pt.y - lassoDragRef.current.startY;
          lassoDragRef.current.scale = 1;
        }
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
          bbox: lassoBBoxRef.current,
          liftedStrokes: lifted,
          dx: lassoDragRef.current.dx,
          dy: lassoDragRef.current.dy,
          scale: lassoDragRef.current.scale,
          anchorX: lassoDragRef.current.anchorX,
          anchorY: lassoDragRef.current.anchorY,
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
          bbox: null,
          liftedStrokes: [],
          dx: 0,
          dy: 0,
          scale: 1,
          anchorX: 0,
          anchorY: 0,
        });
      }
      return;
    }

    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    governorRef.current?.wake();

    // ZERO DOM reflows on the hot ink path: use cached pageLeft / pageTop from pointerdown!
    const toPageCoords = (cx: number, cy: number) => ({
      x: (cx - active.pageLeft) / zoom,
      y: (cy - active.pageTop) / zoom,
    });

    // Active Eraser sweep + live 120 Hz circular cursor ring
    if (active.color === 'eraser') {
      const pt = toPageCoords(e.clientX, e.clientY);
      applyEraserAt(page.pageId, pt.x, pt.y);
      sendToWetWorker({
        type: 'eraser-cursor',
        offsetX: active.offsetX,
        offsetY: active.offsetY,
        zoom,
        x: pt.x,
        y: pt.y,
        radiusPt: getEraserRadiusPt(),
      });
      return;
    }

    // Post-snap dynamic shape adjustment: stretch/rotate/scale snapped shape live before pen lift!
    if (active.snappedShape) {
      const pt = toPageCoords(e.clientX, e.clientY);
      active.points = updateSnappedShape(active.snappedShape, pt.x, pt.y);
      sendToWetWorker({
        type: 'wet-replace',
        seq: active.seq,
        tool: active.tool,
        color: active.color,
        width: active.width,
        paperTheme: active.paperTheme,
        offsetX: active.offsetX,
        offsetY: active.offsetY,
        zoom,
        points: active.points,
        snapBadge: `Snapped: ${active.snappedShape.kind}`,
      });
      return;
    }

    // Unpack 240 Hz coalesced + UIKit predicted samples with overlap/backtrack deduplication
    const {
      coalesced,
      predicted: nativePredicted,
      maxRawTimeStamp,
    } = unpackPointerSamples(
      e,
      toPageCoords,
      active.startPerf,
      active.lastBatchPerf,
      active.lastRawTimeStamp,
      active.points
    );
    active.lastBatchPerf = e.timeStamp || performance.now();
    active.lastRawTimeStamp = maxRawTimeStamp;

    const isPen = active.pointerType === 'pen';
    const newPoints: StrokePoint[] = [];
    let movedDist = 0;

    for (const item of coalesced) {
      const raw = item.point;
      // Zero filter delay for Apple Pencil; fast 22Hz micro-smoothing only for mouse/finger
      const fx = isPen ? raw.x : filterXRef.current.filter(raw.x, item.exactTimeMs);
      const fy = isPen ? raw.y : filterYRef.current.filter(raw.y, item.exactTimeMs);
      const prev = active.points[active.points.length - 1];
      const d = Math.hypot(fx - prev.x, fy - prev.y);
      if (d >= 0.35) {
        movedDist += d;
        const accepted: StrokePoint = { ...raw, x: fx, y: fy };
        active.points.push(accepted);
        newPoints.push(accepted);
        predictorRef.current.pushSample(accepted, item.exactTimeMs);
      }
    }

    if (newPoints.length === 0) return;

    // Compute 2nd-order curvature-damped kinematic predicted tip (solves WebKit Bug 284852 + pipeline lag!)
    const lastCommitted = active.points[active.points.length - 1];
    const predictedTip = predictorRef.current.predict(
      lastCommitted,
      nativePredicted,
      settings.predictionLookaheadMs ?? 10
    );

    // Stream ONLY O(1) delta points + transient predicted tip to 2D OffscreenCanvas worker!
    sendToWetWorker({
      type: 'wet-append',
      seq: active.seq,
      offsetX: active.offsetX,
      offsetY: active.offsetY,
      zoom,
      newPoints,
      predicted: predictedTip,
    });

    // Reset 400ms Hold-to-Snap shape dwell timer whenever stylus moves
    if (movedDist > 2.2) {
      window.clearTimeout(active.dwellTimer);
      active.dwellTimer = window.setTimeout(() => {
        const cur = activeStrokeRef.current;
        if (!cur || cur.points.length < 5 || cur.snappedShape) return;
        const recognized = recognizeShape(cur.points);
        if (recognized && recognized.kind !== 'freehand') {
          const rawTip = cur.points[cur.points.length - 1];
          cur.snappedShape = createSnappedShapeDescriptor(
            recognized.kind,
            recognized.snappedPoints,
            rawTip
          );
          cur.points = recognized.snappedPoints;
          cur.snappedKind = recognized.kind;
          sendToWetWorker({
            type: 'wet-replace',
            seq: cur.seq,
            tool: cur.tool,
            color: cur.color,
            width: cur.width,
            paperTheme: cur.paperTheme,
            offsetX: cur.offsetX,
            offsetY: cur.offsetY,
            zoom,
            points: cur.points,
            snapBadge: `Snapped: ${recognized.kind}`,
          });
        }
      }, 400);
    }
  };

  const handlePointerUp = (e: PointerEvent, page: PageDescriptor, pageEl: HTMLDivElement) => {
    if (e.pointerType === 'pen') {
      palmGuardRef.current.notePenUp();
    }

    // Finish Lasso selection or commit Lasso move/resize
    if (effectiveTool === 'lasso') {
      if (lassoDragRef.current.active) {
        const { dx, dy, scale, anchorX, anchorY } = lassoDragRef.current;
        lassoDragRef.current.active = false;
        const idSet = new Set(lassoStrokeIds);
        let updatedLifted: VectorStroke[] = (noteRef.current.strokesByPage[page.pageId] ?? []).filter(
          (s) => idSet.has(s.id)
        );
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(scale - 1) > 0.01) {
          updatedLifted = updatedLifted.map((s) => {
            const pts = s.points.map((p) => ({
              ...p,
              x: anchorX + (p.x - anchorX) * scale + dx,
              y: anchorY + (p.y - anchorY) * scale + dy,
            }));
            return { ...s, points: pts, bbox: computeBBox(pts, s.width) };
          });
          const updatedMap = new Map(updatedLifted.map((s) => [s.id, s]));
          mutatePageStrokes(
            page.pageId,
            (prev) => prev.map((s) => updatedMap.get(s.id) ?? s),
            'Transform Lasso selection'
          );
          const allPts = updatedLifted.flatMap((s) => s.points);
          if (allPts.length > 0) {
            const newBox = computeBBox(allPts, 0);
            lassoBBoxRef.current = newBox;
            lassoDragRef.current.anchorX = (newBox.minX + newBox.maxX) / 2;
            lassoDragRef.current.anchorY = (newBox.minY + newBox.maxY) / 2;
          }
          lassoDragRef.current.dx = 0;
          lassoDragRef.current.dy = 0;
          lassoDragRef.current.scale = 1;
        }
        // Keep the lifted selection & bounding box visible until the user taps outside!
        const { offsetX, offsetY } = getPageOffsets(pageEl);
        sendToWetWorker({
          type: 'lasso-overlay',
          offsetX,
          offsetY,
          zoom,
          paperTheme: page.source.kind === 'template' ? page.source.theme : 'light',
          polygon: [],
          bbox: lassoBBoxRef.current,
          liftedStrokes: updatedLifted,
          dx: 0,
          dy: 0,
          scale: 1,
          anchorX: lassoDragRef.current.anchorX,
          anchorY: lassoDragRef.current.anchorY,
        });
        return;
      }

      if (lassoPolygon.length >= 3 && lassoStrokeIds.length === 0) {
        const strokes = noteRef.current.strokesByPage[page.pageId] ?? [];
        const matched = strokes.filter((s) => strokeInLasso(s, lassoPolygon));
        if (matched.length > 0) {
          const ids = matched.map((s) => s.id);
          const allPts = matched.flatMap((s) => s.points);
          const box = computeBBox(allPts, 0);
          lassoBBoxRef.current = box;
          lassoDragRef.current.anchorX = (box.minX + box.maxX) / 2;
          lassoDragRef.current.anchorY = (box.minY + box.maxY) / 2;
          lassoDragRef.current.scale = 1;
          setLassoStrokeIds(ids);
          const { offsetX, offsetY } = getPageOffsets(pageEl);
          sendToWetWorker({
            type: 'lasso-overlay',
            offsetX,
            offsetY,
            zoom,
            paperTheme: page.source.kind === 'template' ? page.source.theme : 'light',
            polygon: [],
            bbox: box,
            liftedStrokes: matched,
            dx: 0,
            dy: 0,
            scale: 1,
            anchorX: lassoDragRef.current.anchorX,
            anchorY: lassoDragRef.current.anchorY,
          });
        } else {
          setLassoPolygon([]);
          lassoBBoxRef.current = null;
          wetSeqRef.current += 1;
          sendToWetWorker({ type: 'clear' });
        }
      } else if (lassoStrokeIds.length === 0 && lassoPolygon.length > 0) {
        setLassoPolygon([]);
        lassoBBoxRef.current = null;
        wetSeqRef.current += 1;
        sendToWetWorker({ type: 'clear' });
      }
      return;
    }

    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    window.clearTimeout(active.dwellTimer);

    if (active.color === 'eraser') {
      activeStrokeRef.current = null;
      wetSeqRef.current += 1;
      sendToWetWorker({ type: 'clear' });
      if (settings.eraserAutoReturn && tool === 'eraser' && !thumbEraserHeld) {
        setTool(lastInkToolRef.current);
      }
      return;
    }

    // Trim transient lookahead tip / snap badge on the Wet surface while keeping the exact stroke
    // visible until WebKit's next Page::updateRendering() -> CommitLayerTree presents the Dry layer!
    const finishedSeq = active.seq;
    sendToWetWorker({
      type: 'wet-trim',
      seq: finishedSeq,
      offsetX: active.offsetX,
      offsetY: active.offsetY,
      zoom,
    });
    activeStrokeRef.current = null;

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

    // Clear Wet OffscreenCanvas in a post-rAF macrotask strictly AFTER WebKit flushes the Dry CommitLayerTree
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        sendToWetWorker({ type: 'clear', seq: finishedSeq });
      }, 0);
    });
  };

  const applyEraserAt = (pageId: string, xPt: number, yPt: number) => {
    const radius = getEraserRadiusPt();
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
    if (
      lassoStrokeIds.length === 0 &&
      lassoPolygon.length === 0 &&
      lassoPageId === null &&
      lassoBBoxRef.current === null
    ) {
      return;
    }
    lassoBBoxRef.current = null;
    lassoDragRef.current.active = false;
    setLassoStrokeIds((prev) => (prev.length === 0 ? prev : []));
    setLassoPolygon((prev) => (prev.length === 0 ? prev : []));
    setLassoPageId(null);
    wetSeqRef.current += 1;
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
    const { anchorX, anchorY } = lassoDragRef.current;
    mutatePageStrokes(
      lassoPageId,
      (prev) =>
        prev.map((s) => {
          if (!idSet.has(s.id)) return s;
          const pts = s.points.map((p) => ({
            ...p,
            x: anchorX + (p.x - anchorX) * factor,
            y: anchorY + (p.y - anchorY) * factor,
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
            ref={hzPillRef}
            id="telemetry-hz-pill"
            class={`hz-pill ${telemetry.boostActive ? 'boosted' : ''}`}
            title={`Backend: ${telemetry.rendererBackend} | Prediction: ${settings.predictionLookaheadMs}ms`}
          >
            <span class="hz-dot" />
            {telemetry.offscreenCanvasActive
              ? telemetry.rendererBackend === 'webgl2'
                ? '120Hz WebGL2'
                : '120Hz Offscreen'
              : 'Canvas'}
            <span ref={hzLatencySpanRef} />
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
            id="btn-zoom-out"
            type="button"
            class="btn-icon"
            title="Zoom Out"
            aria-label="Zoom Out"
            onClick={() => {
              setFitWidthMode(false);
              setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
            }}
          >
            <ZoomOut size={16} />
          </button>
          <span
            id="zoom-percent-label"
            style={{ fontSize: '11.5px', fontFamily: 'var(--font-mono)', minWidth: '38px', textAlign: 'center' }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            id="btn-zoom-in"
            type="button"
            class="btn-icon"
            title="Zoom In"
            aria-label="Zoom In"
            onClick={() => {
              setFitWidthMode(false);
              setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))));
            }}
          >
            <ZoomIn size={16} />
          </button>
          <button
            id="btn-zoom-fit-width"
            type="button"
            class={`btn-secondary ${fitWidthMode ? 'active' : ''}`}
            title="Zoom to fit page width (with side margins)"
            aria-label="Fit Width"
            aria-pressed={fitWidthMode}
            style={{
              padding: '4px 8px',
              fontSize: '11.5px',
              ...(fitWidthMode
                ? {
                    background: 'var(--accent)',
                    color: '#ffffff',
                    borderColor: 'var(--accent)',
                  }
                : {}),
            }}
            onClick={toggleFitWidth}
          >
            Fit
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
            lastInkToolRef.current = 'pen';
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
            lastInkToolRef.current = 'highlighter';
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button
              id="btn-eraser-mode"
              type="button"
              class="btn-secondary"
              style={{ padding: '4px 8px', fontSize: '11.5px' }}
              onClick={() => setEraserMode((m) => (m === 'stroke' ? 'partial' : 'stroke'))}
            >
              {eraserMode === 'stroke' ? 'Whole' : 'Partial'}
            </button>
            {(['small', 'medium', 'large'] as const).map((sz) => {
              const active = (settings.eraserSize ?? 'medium') === sz;
              return (
                <button
                  key={sz}
                  id={`btn-eraser-size-${sz}`}
                  type="button"
                  class="btn-secondary"
                  aria-pressed={active}
                  title={`Eraser size: ${sz}`}
                  style={{
                    padding: '4px 7px',
                    fontSize: '11px',
                    fontWeight: 600,
                    ...(active
                      ? {
                          background: 'var(--accent)',
                          color: '#ffffff',
                          borderColor: 'var(--accent)',
                        }
                      : {}),
                  }}
                  onClick={() => onUpdateSettings({ ...settings, eraserSize: sz })}
                >
                  {sz[0].toUpperCase()}
                </button>
              );
            })}
            <button
              id="btn-eraser-auto-return"
              type="button"
              class="btn-secondary"
              aria-pressed={settings.eraserAutoReturn}
              title="Automatically return to Pen after erasing"
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                ...(settings.eraserAutoReturn
                  ? {
                      background: 'var(--accent)',
                      color: '#ffffff',
                      borderColor: 'var(--accent)',
                    }
                  : {}),
              }}
              onClick={() =>
                onUpdateSettings({ ...settings, eraserAutoReturn: !settings.eraserAutoReturn })
              }
            >
              Auto-Pen
            </button>
          </div>
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
          onClick={() => performUndo()}
        >
          <Undo2 size={16} />
        </button>
        <button
          id="btn-redo"
          type="button"
          class="btn-icon"
          title="Redo (Cmd+Shift+Z or 3-finger tap)"
          aria-label="Redo"
          onClick={() => performRedo()}
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
          <div
            ref={pagesTrackRef}
            class={`stage-pages-track dir-${note.scrollDirection} ${
              !fitWidthMode && zoom > computeFitWidthZoom() * 1.03 ? 'is-zoomed-in' : ''
            }`}
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
                  strokes={note.strokesByPage[page.pageId] ?? EMPTY_STROKES}
                  textBoxes={note.textBoxesByPage[page.pageId] ?? EMPTY_TEXTBOXES}
                  images={note.imagesByPage[page.pageId] ?? EMPTY_IMAGES}
                  hiddenStrokeIds={page.pageId === lassoPageId ? hiddenStrokeIds : EMPTY_HIDDEN_IDS}
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
