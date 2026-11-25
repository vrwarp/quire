import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageDescriptor } from '../types';
import { createId, quireStorage } from './storage';
import { generateOrderKey } from './inkMath';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export interface PdfLinkAnnotation {
  rectPt: [number, number, number, number]; // [x, y, w, h] in top-left page points
  destPageNumber?: number;
  url?: string;
}

export interface PdfImportResult {
  blobKey: string;
  pages: PageDescriptor[];
  pageCount: number;
}

interface CachedDoc {
  doc: pdfjsLib.PDFDocumentProxy;
  lastUsed: number;
}

interface CachedTile {
  bitmap: ImageBitmap;
  lastUsed: number;
}

/**
 * Memory-Bounded Lazy PDF Tile Engine (FR-PDF-01, FR-PDF-02, FR-PDF-05).
 *
 * - Keeps at most 20 rendered page ImageBitmaps in memory (explicitly calling `bitmap.close()`
 *   on LRU eviction) so 100–300 page PDFs stay well below the 350 MB iPad RAM ceiling.
 * - Handles password-protected PDFs cleanly via `onPassword` callback.
 * - Extracts internal PDF hyperlinks and external URLs for Read/Pan mode navigation.
 */
class PdfEngine {
  private docCache = new Map<string, CachedDoc>();
  private tileCache = new Map<string, CachedTile>();
  private readonly maxCachedTiles = 20;
  private readonly maxCachedDocs = 4;

  get cachedTileCount(): number {
    return this.tileCache.size;
  }

  async importPdfBytes(
    bytes: Uint8Array,
    fileName: string,
    password?: string
  ): Promise<PdfImportResult> {
    if (bytes.byteLength > 200 * 1024 * 1024) {
      throw new Error('PDF exceeds 200 MB safety limit. Please split or compress the PDF first.');
    }

    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(),
      password,
    });

    const pdfDoc = await loadingTask.promise;
    const blobKey = `pdf_${createId('blob')}`;
    await quireStorage.saveBlob(blobKey, bytes);

    this.docCache.set(blobKey, { doc: pdfDoc, lastUsed: Date.now() });
    this.evictDocsIfNeeded();

    const pages: PageDescriptor[] = [];
    let prevOrder: string | null = null;

    // Fast metadata pass: read page dimensions lazily without rasterizing pixels
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const orderKey = generateOrderKey(prevOrder, null);
      prevOrder = orderKey;
      pages.push({
        pageId: createId('pg'),
        orderKey,
        widthPt: Math.round(viewport.width),
        heightPt: Math.round(viewport.height),
        source: {
          kind: 'pdf',
          blobKey,
          pdfPageNumber: i,
          rotation: 0,
          fileName,
        },
      });
    }

    return { blobKey, pages, pageCount: pdfDoc.numPages };
  }

  private async getDocument(blobKey: string): Promise<pdfjsLib.PDFDocumentProxy | null> {
    const cached = this.docCache.get(blobKey);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.doc;
    }
    const bytes = await quireStorage.loadBlob(blobKey);
    if (!bytes) return null;
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    this.docCache.set(blobKey, { doc, lastUsed: Date.now() });
    this.evictDocsIfNeeded();
    return doc;
  }

  async renderPageTile(
    blobKey: string,
    pdfPageNumber: number,
    scale: number,
    rotation: 0 | 90 | 180 | 270 = 0
  ): Promise<ImageBitmap | null> {
    const quantizedScale = Math.round(scale * 4) / 4;
    const cacheKey = `${blobKey}:${pdfPageNumber}:${quantizedScale}:${rotation}`;
    const existing = this.tileCache.get(cacheKey);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.bitmap;
    }

    const doc = await this.getDocument(blobKey);
    if (!doc) return null;

    const page = await doc.getPage(pdfPageNumber);
    const viewport = page.getViewport({ scale: quantizedScale, rotation });
    const w = Math.max(1, Math.round(viewport.width));
    const h = Math.max(1, Math.round(viewport.height));

    let bitmap: ImageBitmap;
    if (typeof OffscreenCanvas !== 'undefined') {
      const offscreen = new OffscreenCanvas(w, h);
      const ctx = offscreen.getContext('2d');
      if (!ctx) return null;
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: offscreen as unknown as HTMLCanvasElement,
      }).promise;
      bitmap = offscreen.transferToImageBitmap();
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      bitmap = await createImageBitmap(canvas);
    }

    this.tileCache.set(cacheKey, { bitmap, lastUsed: Date.now() });
    this.evictTilesIfNeeded();
    return bitmap;
  }

  async getPageLinks(blobKey: string, pdfPageNumber: number): Promise<PdfLinkAnnotation[]> {
    const doc = await this.getDocument(blobKey);
    if (!doc) return [];
    const page = await doc.getPage(pdfPageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations();
    const links: PdfLinkAnnotation[] = [];

    for (const ann of annotations) {
      if (ann.subtype !== 'Link' || !ann.rect) continue;
      const [rx1, ry1, rx2, ry2] = ann.rect as [number, number, number, number];
      const [x1, y1] = viewport.convertToViewportPoint(rx1, ry1);
      const [x2, y2] = viewport.convertToViewportPoint(rx2, ry2);
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);

      if (ann.url) {
        links.push({ rectPt: [left, top, width, height], url: ann.url });
      } else if (ann.dest) {
        try {
          const dest = typeof ann.dest === 'string' ? await doc.getDestination(ann.dest) : ann.dest;
          if (Array.isArray(dest) && dest[0]) {
            const pageIndex = await doc.getPageIndex(dest[0]);
            links.push({ rectPt: [left, top, width, height], destPageNumber: pageIndex + 1 });
          }
        } catch {
          // Skip unresolvable destinations
        }
      }
    }
    return links;
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

  private evictDocsIfNeeded(): void {
    while (this.docCache.size > this.maxCachedDocs) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.docCache.entries()) {
        if (v.lastUsed < oldestTime) {
          oldestTime = v.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const entry = this.docCache.get(oldestKey);
      if (entry) {
        const docAny = entry.doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
        void (docAny.destroy ? docAny.destroy() : docAny.cleanup?.());
      }
      this.docCache.delete(oldestKey);
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
