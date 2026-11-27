import { PDFDocument, rgb, StandardFonts, BlendMode, PDFPage } from 'pdf-lib';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { NoteDocument, PageDescriptor, PaperTheme } from '../types';
import { buildStrokeOutline } from './inkMath';
import { resolveStrokeColor, renderDryHighlighterLayer, renderDryPenLayer } from './canvasRenderer';
import { quireStorage } from './storage';
import { pdfEngine } from './pdfEngine';

export interface PdfExportOptions {
  includeBackground: boolean;
  pageIndices?: number[]; // 0-based; undefined = all pages
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

function drawPaperTemplatePdf(page: PDFPage, desc: PageDescriptor): void {
  if (desc.source.kind !== 'template') return;
  const { template, theme } = desc.source;
  const { widthPt: w, heightPt: h } = desc;

  const bg =
    theme === 'dark'
      ? rgb(0.09, 0.1, 0.12)
      : theme === 'cream'
      ? rgb(0.98, 0.965, 0.933)
      : rgb(1, 1, 1);
  page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: bg });

  if (template === 'blank') return;

  const lineColor =
    theme === 'dark'
      ? rgb(0.22, 0.24, 0.28)
      : theme === 'cream'
      ? rgb(0.84, 0.81, 0.75)
      : rgb(0.86, 0.88, 0.91);

  const spacing = 26;
  if (template === 'lined') {
    for (let y = h - 72; y >= 36; y -= spacing) {
      page.drawLine({ start: { x: 36, y }, end: { x: w - 36, y }, thickness: 0.6, color: lineColor });
    }
    page.drawLine({
      start: { x: 64, y: 0 },
      end: { x: 64, y: h },
      thickness: 0.75,
      color: theme === 'dark' ? rgb(0.45, 0.22, 0.2) : rgb(0.9, 0.65, 0.62),
    });
  } else if (template === 'grid') {
    for (let x = 24; x < w; x += spacing) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: h }, thickness: 0.5, color: lineColor });
    }
    for (let y = 24; y < h; y += spacing) {
      page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.5, color: lineColor });
    }
  } else if (template === 'dotted') {
    for (let x = 24; x < w; x += spacing) {
      for (let y = 24; y < h; y += spacing) {
        page.drawCircle({ x, y, size: 1, color: lineColor });
      }
    }
  }
}

/**
 * Exports a NoteDocument as a crisp Vector PDF (FR-SYN-03).
 *
 * - Preserves original imported PDF pages, selectable text, and vector graphics.
 * - Renders Highlighter strokes with Multiply blend mode behind pen ink.
 * - Renders variable-width Pen strokes as closed vector SVG paths (infinite zoom sharpness).
 * - Embeds typed text boxes and inserted images.
 */
export async function exportNoteToVectorPdf(
  note: NoteDocument,
  options: PdfExportOptions = { includeBackground: true }
): Promise<Uint8Array> {
  const outPdf = await PDFDocument.create();
  outPdf.setTitle(note.title);
  outPdf.setCreator('Quire Web (120 Hz Vector Ink Engine)');

  const helvetica = await outPdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await outPdf.embedFont(StandardFonts.HelveticaBold);
  const times = await outPdf.embedFont(StandardFonts.TimesRoman);
  const courier = await outPdf.embedFont(StandardFonts.Courier);

  const loadedSourcePdfs = new Map<string, PDFDocument>();
  const indices =
    options.pageIndices && options.pageIndices.length > 0
      ? options.pageIndices.filter((i) => i >= 0 && i < note.pages.length)
      : note.pages.map((_, i) => i);

  for (const idx of indices) {
    const desc = note.pages[idx];
    let pdfPage: PDFPage;

    if (desc.source.kind === 'pdf') {
      let srcDoc = loadedSourcePdfs.get(desc.source.blobKey);
      if (!srcDoc) {
        const bytes = await quireStorage.loadBlob(desc.source.blobKey);
        if (bytes) {
          srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          loadedSourcePdfs.set(desc.source.blobKey, srcDoc);
        }
      }
      if (srcDoc && desc.source.pdfPageNumber <= srcDoc.getPageCount()) {
        const [copied] = await outPdf.copyPages(srcDoc, [desc.source.pdfPageNumber - 1]);
        pdfPage = outPdf.addPage(copied);
      } else {
        pdfPage = outPdf.addPage([desc.widthPt, desc.heightPt]);
      }
    } else {
      pdfPage = outPdf.addPage([desc.widthPt, desc.heightPt]);
      if (options.includeBackground) {
        drawPaperTemplatePdf(pdfPage, desc);
      }
    }

    const pageHeight = pdfPage.getHeight();
    const paperTheme: PaperTheme = desc.source.kind === 'template' ? desc.source.theme : 'light';

    // 1. Embedded images
    const images = note.imagesByPage[desc.pageId] ?? [];
    for (const img of images) {
      const bytes = await quireStorage.loadBlob(img.blobKey);
      if (!bytes) continue;
      try {
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const embedded = isPng ? await outPdf.embedPng(bytes) : await outPdf.embedJpg(bytes);
        pdfPage.drawImage(embedded, {
          x: img.x,
          y: pageHeight - img.y - img.height,
          width: img.width,
          height: img.height,
        });
      } catch {
        // Ignore unsupported image codec during export
      }
    }

    const strokes = note.strokesByPage[desc.pageId] ?? [];

    // 2. Vector Highlighter strokes (behind pen ink, Multiply blend mode)
    for (const stroke of strokes) {
      if (stroke.tool !== 'highlighter' || stroke.points.length < 2) continue;
      const c = hexToRgb(stroke.color);
      const pathParts = [`M ${stroke.points[0].x.toFixed(2)} ${stroke.points[0].y.toFixed(2)}`];
      for (let i = 1; i < stroke.points.length; i++) {
        pathParts.push(`L ${stroke.points[i].x.toFixed(2)} ${stroke.points[i].y.toFixed(2)}`);
      }
      pdfPage.drawSvgPath(pathParts.join(' '), {
        x: 0,
        y: pageHeight,
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: stroke.width,
        borderOpacity: paperTheme === 'dark' ? 0.28 : 0.34,
        blendMode: paperTheme === 'dark' ? BlendMode.Screen : BlendMode.Multiply,
      });
    }

    // 3. Vector Pen strokes (closed variable-width polygon outlines for infinite zoom crispness)
    for (const stroke of strokes) {
      if (stroke.tool !== 'pen' || stroke.points.length === 0) continue;
      const resolved = resolveStrokeColor(stroke.color, paperTheme, 'pen');
      const c = hexToRgb(resolved);
      const { left, right } = buildStrokeOutline(stroke.points, stroke.width, false);
      if (left.length === 0) continue;

      const d: string[] = [`M ${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)}`];
      for (let i = 1; i < left.length; i++) {
        d.push(`L ${left[i].x.toFixed(2)} ${left[i].y.toFixed(2)}`);
      }
      for (let i = right.length - 1; i >= 0; i--) {
        d.push(`L ${right[i].x.toFixed(2)} ${right[i].y.toFixed(2)}`);
      }
      d.push('Z');

      pdfPage.drawSvgPath(d.join(' '), {
        x: 0,
        y: pageHeight,
        color: rgb(c.r, c.g, c.b),
      });
    }

    // 4. Typed text boxes
    const textBoxes = note.textBoxesByPage[desc.pageId] ?? [];
    for (const box of textBoxes) {
      if (!box.plainText.trim()) continue;
      const font =
        box.fontFamily === 'serif'
          ? times
          : box.fontFamily === 'mono'
          ? courier
          : box.bold
          ? helveticaBold
          : helvetica;
      const c = hexToRgb(resolveStrokeColor(box.color, paperTheme, 'pen'));
      const lines = box.plainText.split('\n');
      const lineHeight = box.fontSize * 1.35;
      lines.forEach((line, lineIdx) => {
        const prefix =
          box.listMode === 'bullet'
            ? '• '
            : box.listMode === 'numbered'
            ? `${lineIdx + 1}. `
            : '';
        pdfPage.drawText(prefix + line, {
          x: box.x + 6,
          y: pageHeight - box.y - box.fontSize - 4 - lineIdx * lineHeight,
          size: box.fontSize,
          font,
          color: rgb(c.r, c.g, c.b),
          maxWidth: Math.max(40, box.width - 12),
        });
      });
    }
  }

  return await outPdf.save();
}

/**
 * Exports a single page as a crisp 2x Retina PNG Blob (FR-SYN-03).
 */
export async function exportPageToPng(
  note: NoteDocument,
  pageIndex: number,
  includeBackground = true
): Promise<Blob> {
  const desc = note.pages[pageIndex];
  if (!desc) throw new Error('Invalid page index');
  const scale = 2;
  const w = Math.round(desc.widthPt * scale);
  const h = Math.round(desc.heightPt * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const paperTheme: PaperTheme = desc.source.kind === 'template' ? desc.source.theme : 'light';
  if (desc.source.kind === 'pdf') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const tile = await pdfEngine.renderPageTile(desc.source.blobKey, desc.source.pdfPageNumber, scale);
    if (tile) ctx.drawImage(tile, 0, 0, w, h);
  } else if (includeBackground) {
    ctx.fillStyle =
      paperTheme === 'dark' ? '#16181d' : paperTheme === 'cream' ? '#faf6ee' : '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  const strokes = note.strokesByPage[desc.pageId] ?? [];
  const hlCanvas = document.createElement('canvas');
  renderDryHighlighterLayer(hlCanvas, strokes, desc.widthPt, desc.heightPt, scale, paperTheme);
  ctx.save();
  ctx.globalCompositeOperation = paperTheme === 'dark' ? 'screen' : 'multiply';
  ctx.drawImage(hlCanvas, 0, 0);
  ctx.restore();

  const penCanvas = document.createElement('canvas');
  renderDryPenLayer(penCanvas, strokes, desc.widthPt, desc.heightPt, scale, paperTheme);
  ctx.drawImage(penCanvas, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))), 'image/png');
  });
}

/**
 * Exports a complete lossless `.quire` package archive (PRD 6.3, FR-SYN-02).
 */
export async function exportNoteToQuireBundle(note: NoteDocument): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(
      JSON.stringify(
        {
          formatVersion: 1,
          exportedAt: Date.now(),
          note,
        },
        null,
        2
      )
    ),
  };

  const blobKeys = new Set<string>();
  for (const p of note.pages) {
    if (p.source.kind === 'pdf') blobKeys.add(p.source.blobKey);
  }
  for (const imgs of Object.values(note.imagesByPage)) {
    for (const img of imgs) blobKeys.add(img.blobKey);
  }
  for (const aud of note.audioSessions) {
    blobKeys.add(aud.blobKey);
  }

  for (const key of blobKeys) {
    const data = await quireStorage.loadBlob(key);
    if (data) {
      files[`blobs/${key}`] = data;
    }
  }

  return zipSync(files, { level: 6 });
}

/**
 * Restores a `.quire` archive losslessly into local storage.
 */
export async function importQuireBundle(bytes: Uint8Array): Promise<NoteDocument> {
  const entries = unzipSync(bytes);
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) throw new Error('Invalid .quire archive: missing manifest.json');
  const parsed = JSON.parse(strFromU8(manifestBytes)) as { note: NoteDocument };
  const note = parsed.note;

  for (const [path, data] of Object.entries(entries)) {
    if (path.startsWith('blobs/')) {
      const key = path.slice('blobs/'.length);
      await quireStorage.saveBlob(key, data);
    }
  }
  await quireStorage.saveNote(note);
  return note;
}

export function triggerFileDownload(data: Uint8Array | Blob, fileName: string, mimeType: string): void {
  const blob = data instanceof Blob ? data : new Blob([new Uint8Array(data)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
