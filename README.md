# Quire v1.0 — 120 Hz Local-First Web Notes & PDF Annotation

**Quire** is a fast, zero-backend, zero-telemetry, 100% local-first handwritten note-taking, multi-page PDF annotation, and stroke-synced audio review PWA built for **iPadOS 18.4+ ProMotion (120 Hz)**, macOS, Windows, and Android tablets.

## Production Architecture Highlights

- **120 Hz Dedicated `InkRenderWorker` (`src/workers/ink.worker.ts`) & ProMotion Governor (`src/engine/promotion.ts`)**:
  - Transfers the wet-ink `<canvas>` via `transferControlToOffscreen()` to a single-surface desynchronized 2D `OffscreenCanvas` worker with `O(1)` delta point streaming and tight dirty-rect clearing (zero WebKit GPU readback stalls or pen-lift blinks).
  - Pairs an on-demand ProMotion Governor with `O(log P)` virtualized scroll-offset binary search (`src/engine/spatialIndex.ts`) and per-page 2D spatial indexing for `<0.15 ms` eraser, lasso, and audio tap-to-jump queries on 5,000+ stroke pages.
- **240 Hz Apple Pencil Capture & Vector Ink (`src/engine/inkMath.ts`, `src/engine/inputRouter.ts`)**:
  - Unpacks `getCoalescedEvents()` and `getPredictedEvents()` with `pressure`, `altitudeAngle`, and `azimuthAngle`, Barry–Goldman Centripetal Catmull-Rom interpolation, single-layer non-darkening Highlighter, whole-stroke & analytical partial Vector Eraser, 400 ms Hold-to-Snap shapes, 120 FPS Lifted Lasso, Quick-Hold Thumb Pill, 2/3-finger Undo/Redo, and Typed Text Boxes.
- **Dedicated `StorageSyncWorker` (`src/workers/storage.worker.ts`, `src/engine/storage.ts`, `src/engine/qbin.ts`)**:
  - SQLite 3.54 WASM (`opfs-sahpool` VFS + FTS5 full-text search) + OPFS `FileSystemSyncAccessHandle` `.qbin` binary page snapshots and checksummed `.wal` stroke logs, reference-counted blob GC, automatic `quire-local-v1` IndexedDB migration, `BroadcastChannel` single-active-window lock handoff (`src/engine/windowLock.ts`), and Private Browsing IndexedDB fallback.
- **2-Worker `PDFium-WASM` Pool (`src/workers/pdf.worker.ts`, `src/engine/pdfEngine.ts`)**:
  - Off-main-thread PDFium-WASM rendering with bounded `ImageBitmap` LRU (`<350 MB` RAM ceiling + `visibilitychange` trim), crisp high-zoom (`>2x`) viewport sub-tiles, internal/external link extraction, and local password-PDF unlocking.
- **Off-Main-Thread `ExportWorker` (`src/workers/export.worker.ts`, `src/engine/pdfVectorBuilder.ts`, `src/engine/exportEngine.ts`)**:
  - True cubic-Bézier Vector PDF export with `@pdf-lib/fontkit` Unicode font subsetting + automatic 3x CJK/emoji raster fallback, PDF Knockout Transparency Groups (`/K true`) for non-darkening highlighters, 2x Retina PNG export, lossless single-note & Full-Library `.quire` streaming backup/restore with HLC conflict-safe merging, native Share Sheet (`navigator.share`), and optional Chromium local-folder auto-backup.
- **Crash-Safe App-Level Audio Sync (`src/engine/audio.ts`)**:
  - `O(1)` 10-second OPFS `SyncAccessHandle` chunk appends with SQLite duration/segment checkpointing, `visibilitychange` auto-segmentation, Screen Wake Lock (+ iPadOS `<18.4` video fallback) + OLED Dim Curtain, `preservesPitch`, session rename/delete/export, and an App-level floating recording bar that survives navigating across notes.
- **Air-Gapped Offline PWA (`src/sw.ts`, `src/engine/pwa.ts`, `index.html`)**:
  - Workbox two-tier caching (Tier-1 eager App Shell + Ink + SQLite WASM; Tier-2 `requestIdleCallback` warm-up for PDFium-WASM & Unicode export font), safe "Update Ready" prompts, `window.launchQueue` (`file_handlers`) & `POST ?share-target=1` interception, strict `<meta>` CSP (`connect-src 'self' blob: data:`), `ErrorBoundary` with emergency `.quire` export, and local-only Diagnostics log export.

## Getting Started

```bash
npm install
npm run dev                        # Start Vite dev server
npm run lint                       # Run oxlint across src/ and tests/
npm test                           # Run Vitest unit test suite
VITE_BASE_PATH=/quire/ npm run build  # TypeScript check + GitHub Pages production bundle
E2E_BROWSER=all python3 tests/e2e_validate.py  # Run Playwright Chromium + WebKit E2E suite
```

See [docs/TDD.md](docs/TDD.md) for the complete V1.0 technical design document.
