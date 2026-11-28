import type { PageDescriptor } from '../types';
import { createId, quireStorage } from './storage';
import { generateOrderKey } from './inkMath';
import { logDiagnostic } from './diagnostics';
import type {
  PdfWorkerLink,
  PdfWorkerRequest,
  PdfWorkerResponse,
  PdfWorkerSubRect,
} from '../workers/pdf.worker';

export type PdfLinkAnnotation = PdfWorkerLink;
export type PdfSubRect = PdfWorkerSubRect;

export interface PdfImportResult {
  blobKey: string;
  pages: PageDescriptor[];
  pageCount: number;
  wasEncryptedUnlocked: boolean;
}

interface CachedTile {
  bitmap: ImageBitmap;
  lastUsed: number;
}

interface WorkerSlot {
  worker: Worker;
  rpcId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  knownBlobs: Set<string>;
}

/**
 * Memory-Bounded PDFium-WASM Tile Engine (2-Worker Pool — TDD §2 & §5.1).
 *
 * - Spawns up to 2 dedicated `PDFTileWorker`s running PDFium-WASM for parallel
 *   off-main-thread page rasterization & zoomed viewport sub-tiles.
 * - Unlocks password-protected PDFs via PDFium at import time so reloads & vector
 *   exports work seamlessly without storing plaintext passwords.
 * - Enforces a strict 16-tile `ImageBitmap` LRU (`bitmap.close()` on eviction) and
 *   automatically trims worker & tile caches on `visibilitychange === 'hidden'`.
 */
class PdfEngine {
  private pool: WorkerSlot[] = [];
  private nextWorkerIdx = 0;
  private readonly poolSize = 2;
  private tileCache = new Map<string, CachedTile>();
  private inFlightTiles = new Map<string, Promise<ImageBitmap | null>>();
  private readonly maxCachedTiles = 16;
  private visibilityAttached = false;

  get cachedTileCount(): number {
    return this.tileCache.size;
  }

  private ensureVisibilityTrim(): void {
    if (this.visibilityAttached || typeof document === 'undefined') return;
    this.visibilityAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.trimMemoryForBackground();
      }
    });
  }

  private ensurePool(): WorkerSlot[] {
    this.ensureVisibilityTrim();
    if (this.pool.length > 0) return this.pool;
    if (typeof Worker === 'undefined') {
      throw new Error('PDFTileWorker requires Web Workers');
    }
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
        type: 'module',
        name: `quire-pdf-worker-${i}`,
      });
      const slot: WorkerSlot = {
        worker,
        rpcId: 0,
        pending: new Map(),
        knownBlobs: new Set(),
      };
      worker.onmessage = (ev: MessageEvent<PdfWorkerResponse>) => {
        const { id, ok, result, error } = ev.data;
        const entry = slot.pending.get(id);
        if (!entry) return;
        slot.pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error || 'PDFTileWorker RPC failed'));
      };
      worker.onerror = (ev) => {
        logDiagnostic('error', 'pdf.worker', `PDFTileWorker ${i} error`, ev.message);
      };
      this.pool.push(slot);
    }
    return this.pool;
  }

  private pickSlot(blobKey?: string): WorkerSlot {
    const pool = this.ensurePool();
    if (blobKey) {
      // Prefer a worker that already has this PDF open to avoid re-sending bytes
      const existing = pool.find((s) => s.knownBlobs.has(blobKey));
      if (existing) return existing;
    }
    const slot = pool[this.nextWorkerIdx % pool.length];
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % pool.length;
    return slot;
  }

  private callSlot<T>(
    slot: WorkerSlot,
    method: PdfWorkerRequest['method'],
    params?: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<T> {
    const id = ++slot.rpcId;
    return new Promise<T>((resolve, reject) => {
      slot.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      slot.worker.postMessage({ id, method, params } satisfies PdfWorkerRequest, transfer);
    });
  }

  async importPdfBytes(
    bytes: Uint8Array,
    fileName: string,
    password?: string
  ): Promise<PdfImportResult> {
    if (bytes.byteLength > 200 * 1024 * 1024) {
      throw new Error('PDF exceeds 200 MB safety limit. Please split or compress the PDF first.');
    }

    const slot = this.pickSlot();
    const copy = new Uint8Array(bytes);
    const inspected = await this.callSlot<{
      pageCount: number;
      dims: Array<{ widthPt: number; heightPt: number }>;
      unlockedBytes: Uint8Array | null;
    }>(slot, 'inspectAndUnlock', { bytes: copy, password: password ?? '' }, [copy.buffer]);

    const finalBytes = inspected.unlockedBytes ?? bytes;
    const blobKey = `pdf_${createId('blob')}`;
    await quireStorage.saveBlob(blobKey, finalBytes);

    const pages: PageDescriptor[] = [];
    let prevOrder: string | null = null;
    for (let i = 0; i < inspected.pageCount; i++) {
      const d = inspected.dims[i] ?? { widthPt: 612, heightPt: 792 };
      const orderKey = generateOrderKey(prevOrder, null);
      prevOrder = orderKey;
      pages.push({
        pageId: createId('pg'),
        orderKey,
        widthPt: d.widthPt,
        heightPt: d.heightPt,
        source: {
          kind: 'pdf',
          blobKey,
          pdfPageNumber: i + 1,
          rotation: 0,
          fileName,
        },
      });
    }

    return {
      blobKey,
      pages,
      pageCount: inspected.pageCount,
      wasEncryptedUnlocked: Boolean(inspected.unlockedBytes),
    };
  }

  async renderPageTile(
    blobKey: string,
    pdfPageNumber: number,
    scale: number,
    rotation: 0 | 90 | 180 | 270 = 0
  ): Promise<ImageBitmap | null> {
    const quantizedScale = Math.max(0.25, Math.round(scale * 4) / 4);
    const cacheKey = `${blobKey}:${pdfPageNumber}:${quantizedScale}:${rotation}`;
    const existing = this.tileCache.get(cacheKey);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.bitmap;
    }

    const inFlight = this.inFlightTiles.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<ImageBitmap | null> => {
      try {
        const slot = this.pickSlot(blobKey);
        let res = await this.callSlot<{ bitmap?: ImageBitmap; needsBytes?: boolean } | null>(
          slot,
          'renderTile',
          { blobKey, pageNumber: pdfPageNumber, scale: quantizedScale, rotation }
        );
        if (res && res.needsBytes) {
          const bytes = await quireStorage.loadBlob(blobKey);
          if (!bytes) return null;
          const transferCopy = new Uint8Array(bytes);
          res = await this.callSlot<{ bitmap?: ImageBitmap } | null>(
            slot,
            'renderTile',
            {
              blobKey,
              bytes: transferCopy,
              pageNumber: pdfPageNumber,
              scale: quantizedScale,
              rotation,
            },
            [transferCopy.buffer]
          );
          slot.knownBlobs.add(blobKey);
        }
        const bitmap = res?.bitmap ?? null;
        if (bitmap) {
          this.tileCache.set(cacheKey, { bitmap, lastUsed: Date.now() });
          this.evictTilesIfNeeded();
        }
        return bitmap;
      } catch (err) {
        logDiagnostic('warn', 'pdfEngine', `Tile render failed p.${pdfPageNumber}`, err);
        return null;
      } finally {
        this.inFlightTiles.delete(cacheKey);
      }
    })();

    this.inFlightTiles.set(cacheKey, promise);
    return promise;
  }

  /**
   * Renders a crisp high-DPI viewport sub-tile when zoomed in (>2x), avoiding the 2400px full-page blur cap.
   */
  async renderPageSubTile(
    blobKey: string,
    pdfPageNumber: number,
    scale: number,
    rotation: 0 | 90 | 180 | 270,
    subRect: PdfSubRect
  ): Promise<ImageBitmap | null> {
    try {
      const slot = this.pickSlot(blobKey);
      let res = await this.callSlot<{ bitmap?: ImageBitmap; needsBytes?: boolean } | null>(
        slot,
        'renderTile',
        { blobKey, pageNumber: pdfPageNumber, scale, rotation, subRect }
      );
      if (res && res.needsBytes) {
        const bytes = await quireStorage.loadBlob(blobKey);
        if (!bytes) return null;
        const copy = new Uint8Array(bytes);
        res = await this.callSlot<{ bitmap?: ImageBitmap } | null>(
          slot,
          'renderTile',
          { blobKey, bytes: copy, pageNumber: pdfPageNumber, scale, rotation, subRect },
          [copy.buffer]
        );
        slot.knownBlobs.add(blobKey);
      }
      return res?.bitmap ?? null;
    } catch {
      return null;
    }
  }

  async getPageLinks(blobKey: string, pdfPageNumber: number): Promise<PdfLinkAnnotation[]> {
    try {
      const slot = this.pickSlot(blobKey);
      let res = await this.callSlot<{ links?: PdfLinkAnnotation[]; needsBytes?: boolean }>(
        slot,
        'getPageLinks',
        { blobKey, pageNumber: pdfPageNumber }
      );
      if (res.needsBytes) {
        const bytes = await quireStorage.loadBlob(blobKey);
        if (!bytes) return [];
        const copy = new Uint8Array(bytes);
        res = await this.callSlot<{ links?: PdfLinkAnnotation[] }>(
          slot,
          'getPageLinks',
          { blobKey, bytes: copy, pageNumber: pdfPageNumber },
          [copy.buffer]
        );
        slot.knownBlobs.add(blobKey);
      }
      return res.links ?? [];
    } catch {
      return [];
    }
  }

  private evictTilesIfNeeded(): void {
    while (this.tileCache.size > this.maxCachedTiles) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.tileCache.entries()) {
        if (v.lastUsed < oldestTime) {
          oldestTime = v.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const entry = this.tileCache.get(oldestKey);
      entry?.bitmap.close();
      this.tileCache.delete(oldestKey);
    }
  }

  trimMemoryForBackground(): void {
    this.clearAllTiles();
    for (const slot of this.pool) {
      slot.knownBlobs.clear();
      void this.callSlot(slot, 'evictAll').catch(() => {});
    }
  }

  clearAllTiles(): void {
    for (const entry of this.tileCache.values()) {
      entry.bitmap.close();
    }
    this.tileCache.clear();
  }
}

export const pdfEngine = new PdfEngine();
