import { PDFDocument, rgb, StandardFonts, BlendMode, PDFPage, degrees } from 'pdf-lib';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { NoteDocument, PageDescriptor, PaperTheme } from '../types';
import { buildStrokeOutline } from './inkMath';
import { resolveStrokeColor, renderDryHighlighterLayer, renderDryPenLayer } from './canvasRenderer';
import {
  PAPER_THEME_PALETTE,
  drawPaperTemplateCanvas,
  getPaperTemplateGeometry,
} from './paperTemplate';
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
  const palette = PAPER_THEME_PALETTE[theme];

  page.drawRectangle({
    x: 0,
    y: 0,
    width: w,
    height: h,
    color: rgb(palette.bgRgb.r, palette.bgRgb.g, palette.bgRgb.b),
  });

  if (template === 'blank') return;

  const geom = getPaperTemplateGeometry(template, w, h);
  const lineColor = rgb(palette.rulePdfRgb.r, palette.rulePdfRgb.g, palette.rulePdfRgb.b);
  const marginColor = rgb(palette.marginPdfRgb.r, palette.marginPdfRgb.g, palette.marginPdfRgb.b);

  if (geom.kind === 'lined') {
    for (const yTop of geom.ruleYsPt) {
      const yPdf = h - yTop;
      page.drawLine({
        start: { x: 0, y: yPdf },
        end: { x: w, y: yPdf },
        thickness: geom.ruleStrokeWidthPt,
        color: lineColor,
      });
    }
    page.drawLine({
      start: { x: geom.marginXPt, y: 0 },
      end: { x: geom.marginXPt, y: h },
      thickness: geom.marginStrokeWidthPt,
      color: marginColor,
    });
  } else if (geom.kind === 'grid') {
    for (const x of geom.verticalXsPt) {
      page.drawLine({
        start: { x, y: 0 },
        end: { x, y: h },
        thickness: geom.strokeWidthPt,
        color: lineColor,
      });
    }
    for (const yTop of geom.horizontalYsPt) {
      const yPdf = h - yTop;
      page.drawLine({
        start: { x: 0, y: yPdf },
        end: { x: w, y: yPdf },
        thickness: geom.strokeWidthPt,
        color: lineColor,
      });
    }
  } else if (geom.kind === 'dotted') {
    for (const yTop of geom.ysPt) {
      const yPdf = h - yTop;
      for (const x of geom.xsPt) {
        page.drawCircle({ x, y: yPdf, size: geom.radiusPt, color: lineColor });
      }
    }
  }
}

/**
 * Exports a NoteDocument as a crisp Vector PDF (FR-SYN-03).
 *
 * - Preserves original imported PDF pages, selectable text, and vector graphics.
 * - Renders Highlighter strokes with Multiply/Screen blend mode behind pen ink.
 * - Renders variable-width Pen strokes as closed vector SVG paths + round endcaps.
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
        if (desc.source.rotation) {
          copied.setRotation(degrees(desc.source.rotation));
        }
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
          rotate: img.rotation ? degrees(-img.rotation) : undefined,
        });
      } catch {
        // Ignore unsupported image codec during export
      }
    }

    const strokes = note.strokesByPage[desc.pageId] ?? [];
    const hlOpacity = paperTheme === 'dark' ? 0.28 : 0.34;
    const hlBlend = paperTheme === 'dark' ? BlendMode.Screen : BlendMode.Multiply;

    // 2. Vector Highlighter strokes (behind pen ink, Multiply/Screen blend mode)
    for (const stroke of strokes) {
      if (stroke.tool !== 'highlighter' || stroke.points.length === 0) continue;
      const c = hexToRgb(stroke.color);
      if (stroke.points.length === 1) {
        pdfPage.drawCircle({
          x: stroke.points[0].x,
          y: pageHeight - stroke.points[0].y,
          size: stroke.width * 0.5,
          color: rgb(c.r, c.g, c.b),
          opacity: hlOpacity,
          blendMode: hlBlend,
        });
        continue;
      }
      const pathParts = [`M ${stroke.points[0].x.toFixed(2)} ${stroke.points[0].y.toFixed(2)}`];
      for (let i = 1; i < stroke.points.length; i++) {
        pathParts.push(`L ${stroke.points[i].x.toFixed(2)} ${stroke.points[i].y.toFixed(2)}`);
      }
      pdfPage.drawSvgPath(pathParts.join(' '), {
        x: 0,
        y: pageHeight,
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: stroke.width,
        borderOpacity: hlOpacity,
        blendMode: hlBlend,
      });
    }

    // 3. Vector Pen strokes (closed variable-width polygon outlines + round endcaps)
    for (const stroke of strokes) {
      if (stroke.tool !== 'pen' || stroke.points.length === 0) continue;
      const resolved = resolveStrokeColor(stroke.color, paperTheme, 'pen');
      const c = hexToRgb(resolved);
      const fillColor = rgb(c.r, c.g, c.b);

      if (stroke.points.length === 1) {
        const r = Math.max(0.75, stroke.width * 0.45);
        pdfPage.drawCircle({
          x: stroke.points[0].x,
          y: pageHeight - stroke.points[0].y,
          size: r,
          color: fillColor,
        });
        continue;
      }

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
        color: fillColor,
      });

      const startR = Math.max(
        0.5,
        Math.hypot(left[0].x - right[0].x, left[0].y - right[0].y) * 0.5
      );
      const endIdx = left.length - 1;
      const endR = Math.max(
        0.5,
        Math.hypot(left[endIdx].x - right[endIdx].x, left[endIdx].y - right[endIdx].y) * 0.5
      );
      const firstPt = stroke.points[0];
      const lastPt = stroke.points[stroke.points.length - 1];
      pdfPage.drawCircle({
        x: firstPt.x,
        y: pageHeight - firstPt.y,
        size: startR,
        color: fillColor,
      });
      pdfPage.drawCircle({
        x: lastPt.x,
        y: pageHeight - lastPt.y,
        size: endR,
        color: fillColor,
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
    const tile = await pdfEngine.renderPageTile(
      desc.source.blobKey,
      desc.source.pdfPageNumber,
      scale,
      desc.source.rotation
    );
    if (tile) ctx.drawImage(tile, 0, 0, w, h);
  } else if (includeBackground) {
    drawPaperTemplateCanvas(ctx, desc.source.template, paperTheme, desc.widthPt, desc.heightPt, scale, {
      fillBackground: true,
      drawRules: false,
    });
  }

  // Embedded images
  const images = note.imagesByPage[desc.pageId] ?? [];
  if (typeof createImageBitmap === 'function') {
    for (const img of images) {
      const bytes = await quireStorage.loadBlob(img.blobKey);
      if (!bytes) continue;
      try {
        const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
        const cropW = Math.max(0.1, img.crop.w);
        const cropH = Math.max(0.1, img.crop.h);
        const sx = img.crop.x * bmp.width;
        const sy = img.crop.y * bmp.height;
        const sw = Math.min(bmp.width - sx, cropW * bmp.width);
        const sh = Math.min(bmp.height - sy, cropH * bmp.height);
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(img.x + img.width / 2, img.y + img.height / 2);
        if (img.rotation) {
          ctx.rotate((img.rotation * Math.PI) / 180);
        }
        ctx.drawImage(bmp, sx, sy, sw, sh, -img.width / 2, -img.height / 2, img.width, img.height);
        ctx.restore();
        bmp.close();
      } catch {
        // Ignore unsupported image decode in headless environments
      }
    }
  }

  const strokes = note.strokesByPage[desc.pageId] ?? [];
  const hlCanvas = document.createElement('canvas');
  renderDryHighlighterLayer(hlCanvas, strokes, desc.widthPt, desc.heightPt, scale, paperTheme);
  if (hlCanvas.width > 1) {
    ctx.save();
    if (desc.source.kind === 'pdf') {
      ctx.globalCompositeOperation = 'multiply';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(hlCanvas, 0, 0);
    ctx.restore();
  }

  // Draw canonical paper template rules/grid/dots cleanly over highlighters and below pen ink
  if (desc.source.kind === 'template' && includeBackground) {
    drawPaperTemplateCanvas(ctx, desc.source.template, paperTheme, desc.widthPt, desc.heightPt, scale, {
      fillBackground: false,
      drawRules: true,
    });
  }

  const penCanvas = document.createElement('canvas');
  renderDryPenLayer(penCanvas, strokes, desc.widthPt, desc.heightPt, scale, paperTheme);
  if (penCanvas.width > 1) {
    ctx.drawImage(penCanvas, 0, 0);
  }

  // Typed text boxes
  const textBoxes = note.textBoxesByPage[desc.pageId] ?? [];
  if (textBoxes.length > 0) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';
    for (const box of textBoxes) {
      if (!box.plainText.trim()) continue;
      const family =
        box.fontFamily === 'serif'
          ? 'Georgia, serif'
          : box.fontFamily === 'mono'
          ? 'ui-monospace, Menlo, monospace'
          : '-apple-system, BlinkMacSystemFont, sans-serif';
      const style = `${box.italic ? 'italic ' : ''}${box.bold ? '700 ' : '400 '}${box.fontSize}px ${family}`;
      ctx.font = style;
      ctx.fillStyle = resolveStrokeColor(box.color, paperTheme, 'pen');
      const lines = box.plainText.split('\n');
      const lineHeight = box.fontSize * 1.38;
      lines.forEach((line, lineIdx) => {
        const prefix =
          box.listMode === 'bullet'
            ? '• '
            : box.listMode === 'numbered'
            ? `${lineIdx + 1}. `
            : '';
        ctx.fillText(prefix + line, box.x + 6, box.y + 4 + lineIdx * lineHeight);
      });
    }
    ctx.restore();
  }

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
