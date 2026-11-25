# Quire — 120 Hz Local-First Web Notes & PDF Annotation

**Quire** is a fast, local-first handwritten note-taking, multi-page PDF annotation, and stroke-synced audio review web application / standalone PWA designed for **iPadOS 18.4+ ProMotion (120 Hz)**, macOS, Windows, and Android tablets.

## Key Architectural Highlights

- **120 Hz iOS/iPadOS Safari & PWA Rendering (`OffscreenCanvas` + ProMotion Governor)**:
  - Transfers the wet-ink `<canvas>` to a dedicated worker (`src/workers/ink.worker.ts`) via `transferControlToOffscreen()`, drawing directly on incoming `MessagePort` frames (never waiting on WebKit’s 60 Hz worker `requestAnimationFrame`) so WebKit commits zero-copy `IOSurface` frames out-of-band via `AsyncSetLayerContents`.
  - Pairs an on-demand **ProMotion Governor** (`src/engine/promotion.ts`) — `.quire-rate-mark`, `.quire-display-pacer`, empty `rAF` scroll-IPC flusher, and `.quire-scroll-keep` — with a **120 Hz vsync-phase-locked scroll bus** (`src/engine/scrollBus.ts`).
- **240 Hz Apple Pencil Capture & Vector Ink (`src/engine/inkMath.ts`, `src/engine/inputRouter.ts`)**:
  - Unpacks `getCoalescedEvents()` and `getPredictedEvents()` with `pressure`, `altitudeAngle`, and `azimuthAngle`, smoothed by a 1€ filter and extruded into pressure-sensitive vector ribbons.
  - Includes **Single-Layer Non-Darkening Highlighter** (`mix-blend-mode: multiply` behind pen ink), **Whole-Stroke & Analytical Partial Vector Eraser**, **400 ms Hold-to-Snap Geometric Shapes**, **120 FPS Lifted Lasso**, **Quick-Hold Thumb Pill**, **Scribble-Scratch Erase**, **2/3-finger Undo/Redo**, and **Typed Text Boxes**.
- **Virtualized Multi-Page PDF Engine (`src/engine/pdfEngine.ts`)**:
  - Lazy page rendering with a bounded `ImageBitmap` LRU cache (`bitmap.close()` on eviction), password-protected PDF support, internal PDF hyperlinks in Pan/Read mode, and `O(1)` mixed-page management (insert/reorder/duplicate/delete + per-page templates).
- **Crash-Safe Audio Sync (`src/engine/audio.ts`)**:
  - Hardware AAC `MediaRecorder` flushing chunks to OPFS every 10 seconds, Screen Wake Lock + OLED Dim Curtain, tap-stroke-to-jump playback with configurable pre-roll, variable speed (`0.5x–2.0x`), `±15s` skip, and 120 FPS progressive stroke replay.
- **Local-First OPFS/IndexedDB Storage, Delta Sync & True Vector Export (`src/engine/storage.ts`, `src/engine/syncEngine.ts`, `src/engine/exportEngine.ts`)**:
  - 5-level nested folders, tags, Favorites, Recents, 30-day Recently Deleted, `<10 ms` local search, non-destructive HLC Conflict Copies, true cubic-Bézier Vector PDF export, 2x PNG export, and lossless `.quire` archive export/import.

## Getting Started

```bash
npm install
npm run dev        # Start Vite dev server
npm test           # Run Vitest unit test suite
npm run build      # TypeScript check + production bundle
python3 tests/e2e_validate.py  # Run Playwright E2E suite (CUJ 1–7)
```

See [docs/TDD.md](docs/TDD.md) for the complete technical design document.
