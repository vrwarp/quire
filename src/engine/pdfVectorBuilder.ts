import {
  PDFDocument,
  PDFName,
  PDFPage,
  BlendMode,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { NoteDocument, PageDescriptor, PaperTheme, VectorStroke } from '../types';
import { buildStrokeOutline } from './inkMath';
import { resolveStrokeColor } from './canvasRenderer';
import { PAPER_THEME_PALETTE, getPaperTemplateGeometry } from './paperTemplate';

export interface VectorPdfBuildInput {
  note: NoteDocument;
  blobs: Record<string, Uint8Array>;
  includeBackground: boolean;
  pageIndices?: number[];
  unicodeFontBytes?: Uint8Array | null;
  onProgress?: (pct: number, label: string) => void;
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

/**
 * Converts a polyline into smooth SVG cubic-Bézier (`C`) path commands via Catmull-Rom tangents.
 */
function appendSmoothCubicSvg(d: string[], pts: Array<{ x: number; y: number }>): void {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    d.push(`L ${pts[1].x.toFixed(2)} ${pts[1].y.toFixed(2)}`);
    return;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d.push(
      `C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
    );
  }
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
 * Normalizes cropped or WebP images to PNG bytes via OffscreenCanvas when available.
 */
async function prepareImageForPdf(
  bytes: Uint8Array,
  crop: { x: number; y: number; w: number; h: number }
): Promise<{ bytes: Uint8Array; isPng: boolean } | null> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const needsCrop = crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999;

  if (!needsCrop && (isPng || isJpg)) {
    return { bytes, isPng };
  }

  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const sx = Math.max(0, Math.round(crop.x * bmp.width));
      const sy = Math.max(0, Math.round(crop.y * bmp.height));
      const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(crop.w * bmp.width)));
      const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(crop.h * bmp.height)));
      const canvas = new OffscreenCanvas(sw, sh);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
        bmp.close();
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { bytes: new Uint8Array(await blob.arrayBuffer()), isPng: true };
      }
      bmp.close();
    } catch {
      // Fallback below
    }
  }

  return isPng || isJpg ? { bytes, isPng } : null;
}

/**
 * Fallback 3x rasterizer for text lines containing glyphs absent from DejaVuSans (e.g., CJK / emoji).
 */
async function rasterizeFallbackTextLine(
  text: string,
  fontSize: number,
  colorHex: string,
  bold: boolean,
  italic: boolean,
  fontFamily: 'sans' | 'serif' | 'mono'
): Promise<{ pngBytes: Uint8Array; widthPt: number; heightPt: number } | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const scale = 3;
  const family =
    fontFamily === 'serif'
      ? 'Georgia, serif'
      : fontFamily === 'mono'
      ? 'ui-monospace, Menlo, monospace'
      : 'sans-serif';
  const fontSpec = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize * scale}px ${family}`;

  const measure = new OffscreenCanvas(16, 16);
  const mctx = measure.getContext('2d');
  if (!mctx) return null;
  mctx.font = fontSpec;
  const widthPx = Math.max(8, Math.ceil(mctx.measureText(text).width) + 8);
  const heightPx = Math.max(12, Math.ceil(fontSize * 1.45 * scale));

  const canvas = new OffscreenCanvas(widthPx, heightPx);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = fontSpec;
  ctx.fillStyle = colorHex;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 2, 2);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    pngBytes: new Uint8Array(await blob.arrayBuffer()),
    widthPt: widthPx / scale,
    heightPt: heightPx / scale,
  };
}

function canFontEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Draws a single-color group of Highlighter strokes inside an isolated PDF Knockout
 * Transparency Group (`/I true /K true`) composited with Multiply/Screen at constant opacity
 * so overlapping passes never darken in PDF viewers (TDD §7.4).
 */
async function drawKnockoutHighlighterGroup(
  outPdf: PDFDocument,
  targetPage: PDFPage,
  colorHex: string,
  strokes: VectorStroke[],
  pageWidth: number,
  pageHeight: number,
  opacity: number,
  blendMode: BlendMode
): Promise<void> {
  const scratchDoc = await PDFDocument.create();
  const scratchPage = scratchDoc.addPage([pageWidth, pageHeight]);
  const c = hexToRgb(colorHex);
  const pdfColor = rgb(c.r, c.g, c.b);

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    if (stroke.points.length === 1) {
      scratchPage.drawCircle({
        x: stroke.points[0].x,
        y: pageHeight - stroke.points[0].y,
        size: stroke.width * 0.5,
        color: pdfColor,
      });
      continue;
    }
    const pathParts = [`M ${stroke.points[0].x.toFixed(2)} ${stroke.points[0].y.toFixed(2)}`];
    for (let i = 1; i < stroke.points.length; i++) {
      pathParts.push(`L ${stroke.points[i].x.toFixed(2)} ${stroke.points[i].y.toFixed(2)}`);
    }
    scratchPage.drawSvgPath(pathParts.join(' '), {
      x: 0,
      y: pageHeight,
      borderColor: pdfColor,
      borderWidth: stroke.width,
    });
  }

  const [embedded] = await outPdf.embedPages([scratchPage]);
  await embedded.embed();
  const xObjStream = outPdf.context.lookup(embedded.ref) as { dict?: { set: (k: PDFName, v: unknown) => void } } | undefined;
  if (xObjStream?.dict) {
    const groupDict = outPdf.context.obj({
      Type: PDFName.of('Group'),
      S: PDFName.of('Transparency'),
      I: true,
      K: true,
    });
    xObjStream.dict.set(PDFName.of('Group'), groupDict);
  }

  targetPage.drawPage(embedded, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
    opacity,
    blendMode,
  });
}

export async function buildVectorPdfBytes(input: VectorPdfBuildInput): Promise<Uint8Array> {
  const { note, blobs, includeBackground, pageIndices, unicodeFontBytes, onProgress } = input;
  const outPdf = await PDFDocument.create();
  outPdf.registerFontkit(fontkit);
  outPdf.setTitle(note.title);
  outPdf.setCreator('Quire Web v1.0 (120 Hz Vector Ink Engine)');

  let unicodeFont: PDFFont | null = null;
  if (unicodeFontBytes && unicodeFontBytes.byteLength > 0) {
    try {
      unicodeFont = await outPdf.embedFont(unicodeFontBytes, { subset: true });
    } catch {
      unicodeFont = null;
    }
  }

  const helvetica = await outPdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await outPdf.embedFont(StandardFonts.HelveticaBold);
  const times = await outPdf.embedFont(StandardFonts.TimesRoman);
  const courier = await outPdf.embedFont(StandardFonts.Courier);

  const loadedSourcePdfs = new Map<string, PDFDocument>();
  const indices =
    pageIndices && pageIndices.length > 0
      ? pageIndices.filter((i) => i >= 0 && i < note.pages.length)
      : note.pages.map((_, i) => i);

  for (let step = 0; step < indices.length; step++) {
    const idx = indices[step];
    onProgress?.(
      Math.round(((step + 0.5) / Math.max(1, indices.length)) * 90),
      `Rendering page ${step + 1} of ${indices.length}…`
    );

    const desc = note.pages[idx];
    let pdfPage: PDFPage;

    if (desc.source.kind === 'pdf') {
      let srcDoc = loadedSourcePdfs.get(desc.source.blobKey);
      if (!srcDoc) {
        const bytes = blobs[desc.source.blobKey];
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
      if (includeBackground) {
        drawPaperTemplatePdf(pdfPage, desc);
      }
    }

    const pageWidth = pdfPage.getWidth();
    const pageHeight = pdfPage.getHeight();
    const paperTheme: PaperTheme = desc.source.kind === 'template' ? desc.source.theme : 'light';

    // 1. Embedded images (with crop & WebP normalization)
    const images = note.imagesByPage[desc.pageId] ?? [];
    for (const img of images) {
      const rawBytes = blobs[img.blobKey];
      if (!rawBytes) continue;
      try {
        const prepared = await prepareImageForPdf(rawBytes, img.crop);
        if (!prepared) continue;
        const embedded = prepared.isPng
          ? await outPdf.embedPng(prepared.bytes)
          : await outPdf.embedJpg(prepared.bytes);
        pdfPage.drawImage(embedded, {
          x: img.x,
          y: pageHeight - img.y - img.height,
          width: img.width,
          height: img.height,
          rotate: img.rotation ? degrees(-img.rotation) : undefined,
        });
      } catch {
        // Ignore unsupported image codec
      }
    }

    const strokes = note.strokesByPage[desc.pageId] ?? [];
    const hlOpacity = paperTheme === 'dark' ? 0.28 : 0.34;
    const hlBlend = paperTheme === 'dark' ? BlendMode.Screen : BlendMode.Multiply;

    // 2. Non-Darkening Highlighter groups (Knockout Transparency Group per color)
    const hlByColor = new Map<string, VectorStroke[]>();
    for (const stroke of strokes) {
      if (stroke.tool !== 'highlighter' || stroke.points.length === 0) continue;
      const group = hlByColor.get(stroke.color) ?? [];
      group.push(stroke);
      hlByColor.set(stroke.color, group);
    }
    for (const [colorHex, group] of hlByColor.entries()) {
      await drawKnockoutHighlighterGroup(
        outPdf,
        pdfPage,
        colorHex,
        group,
        pageWidth,
        pageHeight,
        hlOpacity,
        hlBlend
      );
    }

    // 3. True Cubic-Bézier Vector Pen Strokes
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
      appendSmoothCubicSvg(d, left);
      const rightRev = right.slice().reverse();
      d.push(`L ${rightRev[0].x.toFixed(2)} ${rightRev[0].y.toFixed(2)}`);
      appendSmoothCubicSvg(d, rightRev);
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

    // 4. Typed text boxes (Unicode font + automatic 3x PNG fallback for CJK/emoji)
    const textBoxes = note.textBoxesByPage[desc.pageId] ?? [];
    for (const box of textBoxes) {
      if (!box.plainText.trim()) continue;
      const stdFont =
        box.fontFamily === 'serif'
          ? times
          : box.fontFamily === 'mono'
          ? courier
          : box.bold
          ? helveticaBold
          : helvetica;
      const resolvedHex = resolveStrokeColor(box.color, paperTheme, 'pen');
      const c = hexToRgb(resolvedHex);
      const lines = box.plainText.split('\n');
      const lineHeight = box.fontSize * 1.35;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const prefix =
          box.listMode === 'bullet'
            ? '• '
            : box.listMode === 'numbered'
            ? `${lineIdx + 1}. `
            : '';
        const fullLine = prefix + lines[lineIdx];
        if (!fullLine) continue;

        const yPos = pageHeight - box.y - box.fontSize - 4 - lineIdx * lineHeight;
        let chosenFont: PDFFont | null = null;
        if (canFontEncode(stdFont, fullLine)) {
          chosenFont = stdFont;
        } else if (unicodeFont && canFontEncode(unicodeFont, fullLine)) {
          chosenFont = unicodeFont;
        }

        if (chosenFont) {
          pdfPage.drawText(fullLine, {
            x: box.x + 6,
            y: yPos,
            size: box.fontSize,
            font: chosenFont,
            color: rgb(c.r, c.g, c.b),
            maxWidth: Math.max(40, box.width - 12),
          });
        } else {
          // Rasterize CJK / emoji line crisply at 3x DPI — zero crash!
          const raster = await rasterizeFallbackTextLine(
            fullLine,
            box.fontSize,
            resolvedHex,
            box.bold,
            box.italic,
            box.fontFamily
          );
          if (raster) {
            const img = await outPdf.embedPng(raster.pngBytes);
            pdfPage.drawImage(img, {
              x: box.x + 6,
              y: yPos - box.fontSize * 0.2,
              width: Math.min(Math.max(40, box.width - 12), raster.widthPt),
              height: raster.heightPt,
            });
          } else {
            // Headless Node fallback without OffscreenCanvas: strip unencodable chars safely
            const safeAscii = fullLine.replace(/[^\x20-\x7E]/g, '?');
            pdfPage.drawText(safeAscii, {
              x: box.x + 6,
              y: yPos,
              size: box.fontSize,
              font: stdFont,
              color: rgb(c.r, c.g, c.b),
              maxWidth: Math.max(40, box.width - 12),
            });
          }
        }
      }
    }
  }

  onProgress?.(96, 'Finalizing PDF stream…');
  const out = await outPdf.save();
  onProgress?.(100, 'Done');
  return out;
}
