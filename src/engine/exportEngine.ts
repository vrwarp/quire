import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { AppSettings, Folder, NoteDocument, PaperTheme } from '../types';
import { renderDryHighlighterLayer, renderDryPenLayer, resolveStrokeColor } from './canvasRenderer';
import { drawPaperTemplateCanvas } from './paperTemplate';
import { buildVectorPdfBytes } from './pdfVectorBuilder';
import { quireStorage } from './storage';
import { pdfEngine } from './pdfEngine';
import { mergeNoteVersions } from './syncEngine';
import { logDiagnostic } from './diagnostics';
import type { ExportWorkerRequest, ExportWorkerResponse } from '../workers/export.worker';

export interface PdfExportOptions {
  includeBackground: boolean;
  pageIndices?: number[]; // 0-based; undefined = all pages
  onProgress?: (pct: number, label: string) => void;
}

export interface QuireImportSummary {
  kind: 'single-note' | 'full-library';
  importedNotes: NoteDocument[];
  conflictCopies: NoteDocument[];
  importedFolders: Folder[];
  restoredSettings?: AppSettings;
}

let exportWorker: Worker | null = null;
let exportRpcId = 0;
const pendingExportRpc = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    onProgress?: (pct: number, label: string) => void;
  }
>();

function getExportWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!exportWorker) {
    exportWorker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
      type: 'module',
      name: 'quire-export-worker',
    });
    exportWorker.onmessage = (ev: MessageEvent<ExportWorkerResponse>) => {
      const { id, ok, progress, result, error } = ev.data;
      const entry = pendingExportRpc.get(id);
      if (!entry) return;
      if (progress) {
        entry.onProgress?.(progress.pct, progress.label);
        return;
      }
      pendingExportRpc.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error || 'ExportWorker error'));
    };
    exportWorker.onerror = (ev) => {
      logDiagnostic('error', 'export.worker', 'ExportWorker runtime error', ev.message);
    };
  }
  return exportWorker;
}

function callExportWorker<T>(
  method: ExportWorkerRequest['method'],
  params: Record<string, unknown>,
  transfer: Transferable[] = [],
  onProgress?: (pct: number, label: string) => void
): Promise<T> {
  const worker = getExportWorker();
  if (!worker) {
    return Promise.reject(new Error('ExportWorker unavailable'));
  }
  const id = ++exportRpcId;
  return new Promise<T>((resolve, reject) => {
    pendingExportRpc.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
      onProgress,
    });
    worker.postMessage({ id, method, params } satisfies ExportWorkerRequest, transfer);
  });
}

function getUnicodeFontUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const base = import.meta.env.BASE_URL || '/';
  return new URL(`${base}fonts/DejaVuSans.ttf`, window.location.origin).href;
}

async function collectBlobsForNotes(notes: NoteDocument[]): Promise<Record<string, Uint8Array>> {
  const blobKeys = new Set<string>();
  for (const note of notes) {
    for (const p of note.pages) {
      if (p.source.kind === 'pdf') blobKeys.add(p.source.blobKey);
    }
    for (const imgs of Object.values(note.imagesByPage)) {
      for (const img of imgs) blobKeys.add(img.blobKey);
    }
    for (const aud of note.audioSessions) {
      blobKeys.add(aud.blobKey);
    }
  }

  const blobs: Record<string, Uint8Array> = {};
  for (const key of blobKeys) {
    const data = await quireStorage.loadBlob(key);
    if (data) blobs[key] = data;
  }
  return blobs;
}

/**
 * Exports a NoteDocument as a crisp Vector PDF (FR-SYN-03) inside ExportWorker.
 */
export async function exportNoteToVectorPdf(
  note: NoteDocument,
  options: PdfExportOptions = { includeBackground: true }
): Promise<Uint8Array> {
  options.onProgress?.(2, 'Loading page assets…');
  const blobs = await collectBlobsForNotes([note]);

  if (typeof Worker !== 'undefined') {
    const transfer: Transferable[] = [];
    const clonedBlobs: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(blobs)) {
      const copy = new Uint8Array(v);
      clonedBlobs[k] = copy;
      if (copy.byteLength > 0) transfer.push(copy.buffer);
    }
    return await callExportWorker<Uint8Array>(
      'exportVectorPdf',
      {
        note,
        blobs: clonedBlobs,
        includeBackground: options.includeBackground,
        pageIndices: options.pageIndices,
        fontUrl: getUnicodeFontUrl(),
      },
      transfer,
      options.onProgress
    );
  }

  return await buildVectorPdfBytes({
    note,
    blobs,
    includeBackground: options.includeBackground,
    pageIndices: options.pageIndices,
    unicodeFontBytes: null,
    onProgress: options.onProgress,
  });
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
        // Ignore unsupported image decode
      }
    }
  }

  const strokes = note.strokesByPage[desc.pageId] ?? [];
  const hlCanvas = document.createElement('canvas');
  renderDryHighlighterLayer(hlCanvas, strokes, desc.widthPt, desc.heightPt, scale, paperTheme);
  if (hlCanvas.width > 1) {
    ctx.save();
    ctx.globalCompositeOperation = desc.source.kind === 'pdf' ? 'multiply' : 'source-over';
    ctx.drawImage(hlCanvas, 0, 0);
    ctx.restore();
  }

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
      ctx.font = `${box.italic ? 'italic ' : ''}${box.bold ? '700 ' : '400 '}${box.fontSize}px ${family}`;
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
 * Exports a single note as a lossless `.quire` archive via ExportWorker.
 */
export async function exportNoteToQuireBundle(
  note: NoteDocument,
  onProgress?: (pct: number, label: string) => void
): Promise<Uint8Array> {
  const blobs = await collectBlobsForNotes([note]);
  const manifest = {
    formatVersion: 2,
    kind: 'quire-note',
    exportedAt: Date.now(),
    note,
  };

  if (typeof Worker !== 'undefined') {
    const transfer: Transferable[] = [];
    const cloned: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(blobs)) {
      const copy = new Uint8Array(v);
      cloned[k] = copy;
      if (copy.byteLength > 0) transfer.push(copy.buffer);
    }
    return await callExportWorker<Uint8Array>(
      'packArchive',
      { manifest, blobs: cloned },
      transfer,
      onProgress
    );
  }

  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const [k, v] of Object.entries(blobs)) files[`blobs/${k}`] = v;
  return zipSync(files, { level: 6 });
}

/**
 * Exports the entire local library (folders, notes, settings, deduplicated blobs)
 * as a single portable `.quire` backup archive.
 */
export async function exportFullLibraryBackup(
  onProgress?: (pct: number, label: string) => void
): Promise<Uint8Array> {
  onProgress?.(5, 'Reading library catalog…');
  const [notes, folders, settings] = await Promise.all([
    quireStorage.loadAllNotes(),
    quireStorage.loadAllFolders(),
    quireStorage.loadSettings(),
  ]);
  const blobs = await collectBlobsForNotes(notes);
  const manifest = {
    formatVersion: 2,
    kind: 'quire-library-backup',
    exportedAt: Date.now(),
    notes,
    folders,
    settings,
  };

  if (typeof Worker !== 'undefined') {
    const transfer: Transferable[] = [];
    const cloned: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(blobs)) {
      const copy = new Uint8Array(v);
      cloned[k] = copy;
      if (copy.byteLength > 0) transfer.push(copy.buffer);
    }
    return await callExportWorker<Uint8Array>(
      'packArchive',
      { manifest, blobs: cloned },
      transfer,
      onProgress
    );
  }

  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const [k, v] of Object.entries(blobs)) files[`blobs/${k}`] = v;
  return zipSync(files, { level: 6 });
}

/**
 * Restores either a single-note `.quire` or Full-Library `.quire` archive with HLC
 * conflict-safe merging (never silently overwriting divergent local ink).
 */
export async function importQuireArchive(
  bytes: Uint8Array,
  onProgress?: (pct: number, label: string) => void
): Promise<QuireImportSummary> {
  let manifest: {
    formatVersion?: number;
    kind?: 'quire-note' | 'quire-library-backup';
    note?: NoteDocument;
    notes?: NoteDocument[];
    folders?: Folder[];
    settings?: AppSettings;
  };
  let blobs: Record<string, Uint8Array> = {};

  if (typeof Worker !== 'undefined') {
    const copy = new Uint8Array(bytes);
    const unpacked = await callExportWorker<{
      manifest: typeof manifest;
      blobs: Record<string, Uint8Array>;
    }>('unpackArchive', { bytes: copy }, [copy.buffer], onProgress);
    manifest = unpacked.manifest;
    blobs = unpacked.blobs;
  } else {
    const entries = unzipSync(bytes);
    const manifestBytes = entries['manifest.json'];
    if (!manifestBytes) throw new Error('Invalid .quire archive: missing manifest.json');
    manifest = JSON.parse(strFromU8(manifestBytes)) as typeof manifest;
    for (const [path, data] of Object.entries(entries)) {
      if (path.startsWith('blobs/')) {
        blobs[path.slice('blobs/'.length)] = data;
      }
    }
  }

  for (const [key, data] of Object.entries(blobs)) {
    await quireStorage.saveBlob(key, data);
  }

  const importedFolders: Folder[] = [];
  if (Array.isArray(manifest.folders)) {
    const existingFolders = await quireStorage.loadAllFolders();
    const existingIds = new Set(existingFolders.map((f) => f.id));
    for (const f of manifest.folders) {
      if (!existingIds.has(f.id)) {
        await quireStorage.saveFolder(f);
        importedFolders.push(f);
      }
    }
  }

  const incomingNotes: NoteDocument[] =
    manifest.kind === 'quire-library-backup' && Array.isArray(manifest.notes)
      ? manifest.notes
      : manifest.note
      ? [manifest.note]
      : [];

  if (incomingNotes.length === 0) {
    throw new Error('Invalid .quire archive: contains no notes');
  }

  const importedNotes: NoteDocument[] = [];
  const conflictCopies: NoteDocument[] = [];

  for (const incoming of incomingNotes) {
    const existing = await quireStorage.loadNote(incoming.id);
    if (!existing) {
      await quireStorage.saveNote(incoming);
      importedNotes.push(incoming);
    } else {
      const { merged, conflictCopy } = mergeNoteVersions(existing, incoming);
      await quireStorage.saveNote(merged);
      importedNotes.push(merged);
      if (conflictCopy) {
        await quireStorage.saveNote(conflictCopy);
        conflictCopies.push(conflictCopy);
      }
    }
  }

  return {
    kind: manifest.kind === 'quire-library-backup' ? 'full-library' : 'single-note',
    importedNotes,
    conflictCopies,
    importedFolders,
    restoredSettings: manifest.settings,
  };
}

/**
 * Legacy helper alias returning the first imported note (kept for test compatibility).
 */
export async function importQuireBundle(bytes: Uint8Array): Promise<NoteDocument> {
  const res = await importQuireArchive(bytes);
  return res.importedNotes[0];
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

/**
 * Uses the native iPadOS / iOS / Android Share Sheet when supported (`navigator.share({ files })`),
 * falling back cleanly to a browser file download.
 */
export async function shareOrDownloadFile(
  data: Uint8Array | Blob,
  fileName: string,
  mimeType: string,
  preferShareSheet = false
): Promise<'shared' | 'downloaded'> {
  const blob = data instanceof Blob ? data : new Blob([new Uint8Array(data)], { type: mimeType });
  if (preferShareSheet && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], fileName, { type: mimeType });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return 'shared';
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return 'shared';
      }
      // Fall through to download
    }
  }
  triggerFileDownload(blob, fileName, mimeType);
  return 'downloaded';
}

/**
 * Optional Chromium Local-Folder Auto-Backup via File System Access API (`showDirectoryPicker`).
 */
export function supportsLocalFolderPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function writeBytesToDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new Uint8Array(bytes));
  await writable.close();
}
