import type { PageDescriptor, PaperTheme, TextBoxItem, VectorStroke } from '../types';
import { drawPaperTemplateCanvas } from './paperTemplate';
import { renderDryHighlighterLayer, renderDryPenLayer, resolveStrokeColor } from './canvasRenderer';
import { pdfEngine } from './pdfEngine';
import { quireStorage } from './storage';

/**
 * Background Page Thumbnail Generator & OPFS Cache (320px wide).
 * Gives Library Cards & Page Manager real visual previews of PDFs + handwritten ink.
 */

const memoryThumbUrls = new Map<string, string>();
const inFlightThumbs = new Map<string, Promise<string | null>>();

export function getCachedThumbUrl(pageId: string): string | null {
  return memoryThumbUrls.get(pageId) ?? null;
}

export async function loadThumbUrl(pageId: string): Promise<string | null> {
  const mem = memoryThumbUrls.get(pageId);
  if (mem) return mem;

  const existing = inFlightThumbs.get(pageId);
  if (existing) return existing;

  const p = (async () => {
    try {
      const bytes = await quireStorage.loadThumbnail(pageId);
      if (!bytes || bytes.byteLength === 0) return null;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }));
      memoryThumbUrls.set(pageId, url);
      return url;
    } catch {
      return null;
    } finally {
      inFlightThumbs.delete(pageId);
    }
  })();

  inFlightThumbs.set(pageId, p);
  return p;
}

export async function generateAndCacheThumbnail(
  page: PageDescriptor,
  strokes: VectorStroke[],
  textBoxes: TextBoxItem[]
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const targetW = 320;
  const scale = targetW / Math.max(1, page.widthPt);
  const w = Math.max(1, Math.round(page.widthPt * scale));
  const h = Math.max(1, Math.round(page.heightPt * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
  if (page.source.kind === 'pdf') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const tile = await pdfEngine.renderPageTile(
      page.source.blobKey,
      page.source.pdfPageNumber,
      Math.max(0.5, scale),
      page.source.rotation
    );
    if (tile) ctx.drawImage(tile, 0, 0, w, h);
  } else {
    drawPaperTemplateCanvas(ctx, page.source.template, paperTheme, page.widthPt, page.heightPt, scale, {
      fillBackground: true,
      drawRules: true,
    });
  }

  if (strokes.length > 0) {
    const hlCanvas = document.createElement('canvas');
    renderDryHighlighterLayer(hlCanvas, strokes, page.widthPt, page.heightPt, scale, paperTheme);
    if (hlCanvas.width > 1) {
      ctx.save();
      ctx.globalCompositeOperation = page.source.kind === 'pdf' ? 'multiply' : 'source-over';
      ctx.drawImage(hlCanvas, 0, 0, w, h);
      ctx.restore();
    }

    const penCanvas = document.createElement('canvas');
    renderDryPenLayer(penCanvas, strokes, page.widthPt, page.heightPt, scale, paperTheme);
    if (penCanvas.width > 1) {
      ctx.drawImage(penCanvas, 0, 0, w, h);
    }
  }

  if (textBoxes.length > 0) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';
    for (const box of textBoxes) {
      if (!box.plainText.trim()) continue;
      ctx.font = `${box.bold ? '700 ' : '400 '}${box.fontSize}px sans-serif`;
      ctx.fillStyle = resolveStrokeColor(box.color, paperTheme, 'pen');
      ctx.fillText(box.plainText.split('\n')[0], box.x + 6, box.y + 4, Math.max(40, box.width - 12));
    }
    ctx.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', 0.78);
  });
  if (!blob) return null;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await quireStorage.saveThumbnail(page.pageId, bytes);

  const prevUrl = memoryThumbUrls.get(page.pageId);
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  const nextUrl = URL.createObjectURL(blob);
  memoryThumbUrls.set(page.pageId, nextUrl);
  return nextUrl;
}
