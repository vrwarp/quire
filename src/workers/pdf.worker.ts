/// <reference lib="webworker" />
import { init as initPdfium, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';

/**
 * Dedicated PDFTileWorker (PDFium-WASM Pool — TDD §2 & §5.1).
 *
 * - Renders PDF pages & high-zoom viewport sub-tiles completely off the main thread
 *   into transferred `ImageBitmap`s using `FPDF_REVERSE_BYTE_ORDER` (native RGBA).
 * - Parses 200+ page dimensions via `FPDF_GetPageSizeByIndex` in milliseconds.
 * - Unlocks password-protected PDFs via `PDFiumExt_SaveAsCopy` so reloads & vector
 *   exports never lose access or store plaintext passwords.
 */

const FPDF_ERR_PASSWORD = 4;
const FPDFBitmap_BGRA = 4;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const PDFACTION_GOTO = 1;
const PDFACTION_URI = 3;

export interface PdfWorkerLink {
  rectPt: [number, number, number, number];
  destPageNumber?: number;
  url?: string;
}

export interface PdfWorkerSubRect {
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
}

export interface PdfWorkerRequest {
  id: number;
  method: 'inspectAndUnlock' | 'renderTile' | 'getPageLinks' | 'evictAll';
  params?: Record<string, unknown>;
}

export interface PdfWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface OpenDocEntry {
  docPtr: number;
  dataPtr: number;
  lastUsed: number;
}

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;
const openDocs = new Map<string, OpenDocEntry>();
const MAX_OPEN_DOCS = 2;

async function getPdfium(): Promise<WrappedPdfiumModule> {
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      const resp = await fetch(pdfiumWasmUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch PDFium WASM (${resp.status})`);
      }
      const wasmBinary = await resp.arrayBuffer();
      const mod = await initPdfium({ wasmBinary });
      mod.PDFiumExt_Init();
      return mod;
    })();
  }
  return pdfiumPromise;
}

function closeDocEntry(mod: WrappedPdfiumModule, entry: OpenDocEntry): void {
  try {
    mod.FPDF_CloseDocument(entry.docPtr);
  } catch {
    // ignore
  }
  try {
    mod.pdfium.wasmExports.free(entry.dataPtr);
  } catch {
    // ignore
  }
}

function evictDocsIfNeeded(mod: WrappedPdfiumModule, keepKey?: string): void {
  while (openDocs.size > MAX_OPEN_DOCS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of openDocs.entries()) {
      if (k === keepKey) continue;
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    const entry = openDocs.get(oldestKey);
    if (entry) closeDocEntry(mod, entry);
    openDocs.delete(oldestKey);
  }
}

function getHeapU8(mod: WrappedPdfiumModule): Uint8Array {
  const m = mod.pdfium as unknown as {
    HEAPU8?: Uint8Array;
    wasmExports?: { memory?: WebAssembly.Memory };
  };
  if (m.HEAPU8) return m.HEAPU8;
  if (m.wasmExports?.memory) return new Uint8Array(m.wasmExports.memory.buffer);
  throw new Error('PDFium WASM memory buffer unavailable');
}

function openMemDoc(
  mod: WrappedPdfiumModule,
  bytes: Uint8Array,
  password = ''
): { docPtr: number; dataPtr: number } {
  const dataPtr = mod.pdfium.wasmExports.malloc(bytes.byteLength);
  if (!dataPtr) {
    throw new Error('PDFium WASM out of memory while allocating PDF buffer');
  }
  getHeapU8(mod).set(bytes, dataPtr);
  const docPtr = mod.FPDF_LoadMemDocument(dataPtr, bytes.byteLength, password);
  if (!docPtr) {
    const errCode = mod.FPDF_GetLastError();
    mod.pdfium.wasmExports.free(dataPtr);
    if (errCode === FPDF_ERR_PASSWORD) {
      throw new Error('PDF is password-protected (invalid or missing password).');
    }
    throw new Error(`Failed to load PDF document (PDFium error ${errCode}).`);
  }
  return { docPtr, dataPtr };
}

function ensureOpenDoc(
  mod: WrappedPdfiumModule,
  blobKey: string,
  bytes?: Uint8Array
): OpenDocEntry | null {
  const existing = openDocs.get(blobKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (!bytes) return null;
  const opened = openMemDoc(mod, bytes, '');
  const entry: OpenDocEntry = { ...opened, lastUsed: Date.now() };
  openDocs.set(blobKey, entry);
  evictDocsIfNeeded(mod, blobKey);
  return entry;
}

function saveUnlockedCopy(mod: WrappedPdfiumModule, docPtr: number): Uint8Array | null {
  const writerPtr = mod.PDFiumExt_OpenFileWriter();
  if (!writerPtr) return null;
  try {
    const ok = mod.PDFiumExt_SaveAsCopy(docPtr, writerPtr);
    if (!ok) return null;
    const size = mod.PDFiumExt_GetFileWriterSize(writerPtr);
    if (size <= 0) return null;
    const outPtr = mod.pdfium.wasmExports.malloc(size);
    if (!outPtr) return null;
    try {
      mod.PDFiumExt_GetFileWriterData(writerPtr, outPtr, size);
      return new Uint8Array(getHeapU8(mod).subarray(outPtr, outPtr + size));
    } finally {
      mod.pdfium.wasmExports.free(outPtr);
    }
  } finally {
    mod.PDFiumExt_CloseFileWriter(writerPtr);
  }
}

async function handleRequest(
  method: PdfWorkerRequest['method'],
  params: Record<string, unknown> = {}
): Promise<{ result: unknown; transfer: Transferable[] }> {
  const mod = await getPdfium();

  if (method === 'evictAll') {
    for (const entry of openDocs.values()) {
      closeDocEntry(mod, entry);
    }
    openDocs.clear();
    return { result: true, transfer: [] };
  }

  if (method === 'inspectAndUnlock') {
    const bytes = params.bytes as Uint8Array;
    const password = typeof params.password === 'string' ? params.password : '';
    const { docPtr, dataPtr } = openMemDoc(mod, bytes, password);
    try {
      const pageCount = mod.FPDF_GetPageCount(docPtr);
      const dims: Array<{ widthPt: number; heightPt: number }> = [];
      const wPtr = mod.pdfium.wasmExports.malloc(8);
      const hPtr = mod.pdfium.wasmExports.malloc(8);
      try {
        for (let i = 0; i < pageCount; i++) {
          const ok = mod.FPDF_GetPageSizeByIndex(docPtr, i, wPtr, hPtr);
          if (ok) {
            const w = mod.pdfium.getValue(wPtr, 'double');
            const h = mod.pdfium.getValue(hPtr, 'double');
            dims.push({
              widthPt: Number((w > 0 ? w : 612).toFixed(2)),
              heightPt: Number((h > 0 ? h : 792).toFixed(2)),
            });
          } else {
            dims.push({ widthPt: 612, heightPt: 792 });
          }
        }
      } finally {
        mod.pdfium.wasmExports.free(wPtr);
        mod.pdfium.wasmExports.free(hPtr);
      }

      let unlockedBytes: Uint8Array | null = null;
      if (password) {
        unlockedBytes = saveUnlockedCopy(mod, docPtr);
      }

      const transfer: Transferable[] = [];
      if (unlockedBytes) transfer.push(unlockedBytes.buffer);
      return {
        result: { pageCount, dims, unlockedBytes },
        transfer,
      };
    } finally {
      closeDocEntry(mod, { docPtr, dataPtr, lastUsed: 0 });
    }
  }

  if (method === 'renderTile') {
    const blobKey = String(params.blobKey);
    const bytes = params.bytes as Uint8Array | undefined;
    const pageNumber = Number(params.pageNumber);
    const scale = Number(params.scale);
    const rotationDeg = Number(params.rotation ?? 0);
    const subRect = params.subRect as PdfWorkerSubRect | undefined;

    const entry = ensureOpenDoc(mod, blobKey, bytes);
    if (!entry) {
      return { result: { needsBytes: true }, transfer: [] };
    }

    const pagePtr = mod.FPDF_LoadPage(entry.docPtr, pageNumber - 1);
    if (!pagePtr) return { result: null, transfer: [] };

    try {
      const pageW = mod.FPDF_GetPageWidthF(pagePtr) || 612;
      const pageH = mod.FPDF_GetPageHeightF(pagePtr) || 792;
      const rotSteps = (((rotationDeg % 360) + 360) % 360) / 90; // 0, 1, 2, 3
      const swapped = rotSteps === 1 || rotSteps === 3;
      const fullW = Math.max(1, Math.round((swapped ? pageH : pageW) * scale));
      const fullH = Math.max(1, Math.round((swapped ? pageW : pageH) * scale));

      const outW = subRect ? Math.max(1, Math.round(subRect.wPx)) : fullW;
      const outH = subRect ? Math.max(1, Math.round(subRect.hPx)) : fullH;
      const startX = subRect ? -Math.round(subRect.xPx) : 0;
      const startY = subRect ? -Math.round(subRect.yPx) : 0;

      const stride = outW * 4;
      const bufSize = stride * outH;
      const bufPtr = mod.pdfium.wasmExports.malloc(bufSize);
      if (!bufPtr) {
        throw new Error('PDFium WASM out of memory allocating bitmap');
      }

      try {
        const bitmapPtr = mod.FPDFBitmap_CreateEx(outW, outH, FPDFBitmap_BGRA, bufPtr, stride);
        if (!bitmapPtr) {
          throw new Error('FPDFBitmap_CreateEx returned null');
        }
        try {
          mod.FPDFBitmap_FillRect(bitmapPtr, 0, 0, outW, outH, 0xffffffff);
          mod.FPDF_RenderPageBitmap(
            bitmapPtr,
            pagePtr,
            startX,
            startY,
            fullW,
            fullH,
            rotSteps,
            FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER
          );
          const rgbaCopy = new Uint8ClampedArray(bufSize);
          rgbaCopy.set(getHeapU8(mod).subarray(bufPtr, bufPtr + bufSize));
          const imageData = new ImageData(rgbaCopy, outW, outH);
          const bitmap = await createImageBitmap(imageData);
          return {
            result: { bitmap, width: outW, height: outH },
            transfer: [bitmap],
          };
        } finally {
          mod.FPDFBitmap_Destroy(bitmapPtr);
        }
      } finally {
        mod.pdfium.wasmExports.free(bufPtr);
      }
    } finally {
      mod.FPDF_ClosePage(pagePtr);
    }
  }

  if (method === 'getPageLinks') {
    const blobKey = String(params.blobKey);
    const bytes = params.bytes as Uint8Array | undefined;
    const pageNumber = Number(params.pageNumber);

    const entry = ensureOpenDoc(mod, blobKey, bytes);
    if (!entry) {
      return { result: { needsBytes: true }, transfer: [] };
    }

    const pagePtr = mod.FPDF_LoadPage(entry.docPtr, pageNumber - 1);
    if (!pagePtr) return { result: { links: [] }, transfer: [] };

    const links: PdfWorkerLink[] = [];
    const startPosPtr = mod.pdfium.wasmExports.malloc(4);
    const linkAnnotPtr = mod.pdfium.wasmExports.malloc(4);
    const rectPtr = mod.pdfium.wasmExports.malloc(16); // FS_RECTF: left, top, right, bottom (4 floats)

    try {
      const pageH = mod.FPDF_GetPageHeightF(pagePtr) || 792;
      mod.pdfium.setValue(startPosPtr, 0, 'i32');

      while (mod.FPDFLink_Enumerate(pagePtr, startPosPtr, linkAnnotPtr)) {
        const annot = mod.pdfium.getValue(linkAnnotPtr, 'i32');
        if (!annot) continue;
        if (!mod.FPDFLink_GetAnnotRect(annot, rectPtr)) continue;

        const left = mod.pdfium.getValue(rectPtr, 'float');
        const topPdf = mod.pdfium.getValue(rectPtr + 4, 'float');
        const right = mod.pdfium.getValue(rectPtr + 8, 'float');
        const bottomPdf = mod.pdfium.getValue(rectPtr + 12, 'float');

        // Convert PDF bottom-left coordinates to viewport top-left
        const x = Math.min(left, right);
        const yTop = pageH - Math.max(topPdf, bottomPdf);
        const w = Math.abs(right - left);
        const h = Math.abs(topPdf - bottomPdf);

        const destPtr = mod.FPDFLink_GetDest(entry.docPtr, annot);
        if (destPtr) {
          const destIdx = mod.FPDFDest_GetDestPageIndex(entry.docPtr, destPtr);
          if (destIdx >= 0) {
            links.push({ rectPt: [x, yTop, w, h], destPageNumber: destIdx + 1 });
            continue;
          }
        }

        const actionPtr = mod.FPDFLink_GetAction(annot);
        if (actionPtr) {
          const actionType = mod.FPDFAction_GetType(actionPtr);
          if (actionType === PDFACTION_GOTO) {
            const actDest = mod.FPDFAction_GetDest(entry.docPtr, actionPtr);
            if (actDest) {
              const destIdx = mod.FPDFDest_GetDestPageIndex(entry.docPtr, actDest);
              if (destIdx >= 0) {
                links.push({ rectPt: [x, yTop, w, h], destPageNumber: destIdx + 1 });
              }
            }
          } else if (actionType === PDFACTION_URI) {
            const uriLen = mod.FPDFAction_GetURIPath(entry.docPtr, actionPtr, 0, 0);
            if (uriLen > 1) {
              const uriBuf = mod.pdfium.wasmExports.malloc(uriLen);
              if (uriBuf) {
                try {
                  mod.FPDFAction_GetURIPath(entry.docPtr, actionPtr, uriBuf, uriLen);
                  const url = mod.pdfium.UTF8ToString(uriBuf);
                  if (url) {
                    links.push({ rectPt: [x, yTop, w, h], url });
                  }
                } finally {
                  mod.pdfium.wasmExports.free(uriBuf);
                }
              }
            }
          }
        }
      }
      return { result: { links }, transfer: [] };
    } finally {
      mod.pdfium.wasmExports.free(startPosPtr);
      mod.pdfium.wasmExports.free(linkAnnotPtr);
      mod.pdfium.wasmExports.free(rectPtr);
      mod.FPDF_ClosePage(pagePtr);
    }
  }

  throw new Error(`Unknown PDFTileWorker method: ${method}`);
}

self.onmessage = async (ev: MessageEvent<PdfWorkerRequest>) => {
  const { id, method, params } = ev.data;
  try {
    const { result, transfer } = await handleRequest(method, params);
    self.postMessage({ id, ok: true, result } satisfies PdfWorkerResponse, transfer);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies PdfWorkerResponse);
  }
};
