/// <reference lib="webworker" />
import { Zip, ZipDeflate, Unzip, UnzipInflate, strToU8, strFromU8 } from 'fflate';
import type { AppSettings, Folder, NoteDocument } from '../types';
import { buildVectorPdfBytes } from '../engine/pdfVectorBuilder';

/**
 * Dedicated ExportWorker (TDD §2 & §7.4):
 * - Off-main-thread Vector PDF synthesis (fontkit Unicode + Knockout Highlighters + Cubic Bézier)
 * - Streaming `fflate` `.quire` Note & Full-Library archive compression/decompression
 * - Zip-bomb & path-traversal safety bounds during import
 */

const MAX_UNZIPPED_BYTES = 512 * 1024 * 1024; // 512 MB safety cap

export interface ExportWorkerRequest {
  id: number;
  method: 'exportVectorPdf' | 'packArchive' | 'unpackArchive';
  params: Record<string, unknown>;
}

export interface ExportWorkerResponse {
  id: number;
  ok: boolean;
  progress?: { pct: number; label: string };
  result?: unknown;
  error?: string;
}

let cachedFontBytes: Uint8Array | null | undefined = undefined;

async function loadUnicodeFont(fontUrl?: string): Promise<Uint8Array | null> {
  if (cachedFontBytes !== undefined) return cachedFontBytes;
  if (!fontUrl) {
    cachedFontBytes = null;
    return null;
  }
  try {
    const resp = await fetch(fontUrl);
    if (!resp.ok) {
      cachedFontBytes = null;
      return null;
    }
    cachedFontBytes = new Uint8Array(await resp.arrayBuffer());
    return cachedFontBytes;
  } catch {
    cachedFontBytes = null;
    return null;
  }
}

function streamZipFiles(
  entries: Array<{ path: string; data: Uint8Array }>,
  onProgress?: (pct: number, label: string) => void
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalLen = 0;

    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      if (chunk && chunk.byteLength > 0) {
        chunks.push(chunk);
        totalLen += chunk.byteLength;
      }
      if (final) {
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        resolve(merged);
      }
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      onProgress?.(
        Math.round(((i + 0.5) / Math.max(1, entries.length)) * 95),
        `Packing ${entry.path}…`
      );
      const isAlreadyCompressed =
        entry.path.endsWith('.pdf') ||
        entry.path.endsWith('.m4a') ||
        entry.path.endsWith('.webm') ||
        entry.path.endsWith('.jpg') ||
        entry.path.endsWith('.png') ||
        entry.path.endsWith('.webp');
      const stream = new ZipDeflate(entry.path, { level: isAlreadyCompressed ? 1 : 6 });
      zip.add(stream);
      stream.push(entry.data, true);
    }

    zip.end();
    onProgress?.(100, 'Archive ready');
  });
}

function streamUnzipBytes(
  bytes: Uint8Array,
  onProgress?: (pct: number, label: string) => void
): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const files: Record<string, Uint8Array> = {};
    let totalExtracted = 0;
    let failed = false;

    const unzip = new Unzip((file) => {
      const safeName = file.name.replace(/^\/+/, '');
      if (!safeName || safeName.includes('..') || safeName.includes('\\')) {
        failed = true;
        reject(new Error(`Unsafe archive entry path: ${file.name}`));
        return;
      }
      const chunks: Uint8Array[] = [];
      let fileLen = 0;
      file.ondata = (err, data, final) => {
        if (failed) return;
        if (err) {
          failed = true;
          reject(err);
          return;
        }
        if (data && data.byteLength > 0) {
          totalExtracted += data.byteLength;
          if (totalExtracted > MAX_UNZIPPED_BYTES) {
            failed = true;
            reject(new Error('Archive exceeds 512 MB safety limit'));
            return;
          }
          chunks.push(data);
          fileLen += data.byteLength;
        }
        if (final) {
          const out = new Uint8Array(fileLen);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.byteLength;
          }
          files[safeName] = out;
        }
      };
      file.start();
    });

    unzip.register(UnzipInflate);
    onProgress?.(35, 'Decompressing .quire archive…');
    try {
      unzip.push(bytes, true);
      if (!failed) {
        onProgress?.(100, 'Archive unpacked');
        resolve(files);
      }
    } catch (err) {
      if (!failed) reject(err);
    }
  });
}

self.onmessage = async (ev: MessageEvent<ExportWorkerRequest>) => {
  const { id, method, params } = ev.data;
  const emitProgress = (pct: number, label: string) => {
    self.postMessage({ id, ok: true, progress: { pct, label } } satisfies ExportWorkerResponse);
  };

  try {
    if (method === 'exportVectorPdf') {
      const note = params.note as NoteDocument;
      const blobs = params.blobs as Record<string, Uint8Array>;
      const includeBackground = Boolean(params.includeBackground);
      const pageIndices = params.pageIndices as number[] | undefined;
      const fontUrl = params.fontUrl as string | undefined;

      emitProgress(5, 'Loading Unicode font…');
      const unicodeFontBytes = await loadUnicodeFont(fontUrl);
      const pdfBytes = await buildVectorPdfBytes({
        note,
        blobs,
        includeBackground,
        pageIndices,
        unicodeFontBytes,
        onProgress: emitProgress,
      });
      self.postMessage({ id, ok: true, result: pdfBytes } satisfies ExportWorkerResponse, [
        pdfBytes.buffer,
      ]);
      return;
    }

    if (method === 'packArchive') {
      const manifest = params.manifest as Record<string, unknown>;
      const blobs = params.blobs as Record<string, Uint8Array>;
      const entries: Array<{ path: string; data: Uint8Array }> = [
        { path: 'manifest.json', data: strToU8(JSON.stringify(manifest, null, 2)) },
      ];
      for (const [key, data] of Object.entries(blobs)) {
        entries.push({ path: `blobs/${key}`, data });
      }
      const archiveBytes = await streamZipFiles(entries, emitProgress);
      self.postMessage({ id, ok: true, result: archiveBytes } satisfies ExportWorkerResponse, [
        archiveBytes.buffer,
      ]);
      return;
    }

    if (method === 'unpackArchive') {
      const bytes = params.bytes as Uint8Array;
      const entries = await streamUnzipBytes(bytes, emitProgress);
      const manifestBytes = entries['manifest.json'];
      if (!manifestBytes) {
        throw new Error('Invalid .quire archive: missing manifest.json');
      }
      const manifest = JSON.parse(strFromU8(manifestBytes)) as {
        formatVersion?: number;
        kind?: 'quire-note' | 'quire-library-backup';
        note?: NoteDocument;
        notes?: NoteDocument[];
        folders?: Folder[];
        settings?: AppSettings;
      };
      const blobs: Record<string, Uint8Array> = {};
      const transfer: Transferable[] = [];
      for (const [path, data] of Object.entries(entries)) {
        if (path.startsWith('blobs/')) {
          const key = path.slice('blobs/'.length);
          blobs[key] = data;
          if (data.byteLength > 0) transfer.push(data.buffer);
        }
      }
      self.postMessage(
        { id, ok: true, result: { manifest, blobs } } satisfies ExportWorkerResponse,
        transfer
      );
      return;
    }

    throw new Error(`Unknown ExportWorker method: ${method}`);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExportWorkerResponse);
  }
};
