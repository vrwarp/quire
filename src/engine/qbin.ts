import type { ImageItem, PagePayload, ShapeKind, StrokePoint, TextBoxItem, VectorStroke } from '../types';

/**
 * Compact Binary `.qbin` Page Snapshot & `.wal` Frame Codec (TDD §4.1 & §7.1).
 *
 * Encodes stroke points into tightly packed binary typed arrays (Float32 x/y,
 * Uint16 pressure & dtMs, Int8 altitude/azimuth) instead of bloated JSON point objects,
 * reducing storage size and serialization CPU by ~5-7x for dense handwritten pages.
 *
 * Format v1:
 *   [4B magic 'QBIN'][4B version=1][4B metaJsonLen][metaJson UTF-8 bytes]
 *   [4B padding to 4B align][packed point streams for all strokes...]
 */

const MAGIC = 0x4e494251; // 'QBIN' little-endian
const VERSION = 1;
const POINT_STRIDE_BYTES = 16; // float32 x (4) + float32 y (4) + uint16 pressure (2) + uint16 dtMs (2) + int16 alt (2) + int16 az (2)

interface PackedStrokeMeta {
  id: string;
  pageId: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  pointCount: number;
  bbox: VectorStroke['bbox'];
  shapeKind?: ShapeKind;
  audioSessionId?: string;
  startAudioMs?: number;
  endAudioMs?: number;
}

interface QbinHeaderMeta {
  pageId: string;
  strokes: PackedStrokeMeta[];
  textBoxes: TextBoxItem[];
  images: ImageItem[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodePageQbin(payload: PagePayload): Uint8Array {
  let totalPoints = 0;
  const strokesMeta: PackedStrokeMeta[] = payload.strokes.map((s) => {
    totalPoints += s.points.length;
    return {
      id: s.id,
      pageId: s.pageId,
      tool: s.tool,
      color: s.color,
      width: s.width,
      pointCount: s.points.length,
      bbox: s.bbox,
      shapeKind: s.shapeKind,
      audioSessionId: s.audioSessionId,
      startAudioMs: s.startAudioMs,
      endAudioMs: s.endAudioMs,
    };
  });

  const meta: QbinHeaderMeta = {
    pageId: payload.pageId,
    strokes: strokesMeta,
    textBoxes: payload.textBoxes,
    images: payload.images,
  };

  const metaBytes = textEncoder.encode(JSON.stringify(meta));
  const headerLen = 12 + metaBytes.byteLength;
  const alignedPointsOffset = (headerLen + 3) & ~3;
  const totalBytes = alignedPointsOffset + totalPoints * POINT_STRIDE_BYTES;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, metaBytes.byteLength, true);
  out.set(metaBytes, 12);

  let offset = alignedPointsOffset;
  for (const stroke of payload.strokes) {
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      view.setFloat32(offset, p.x, true);
      view.setFloat32(offset + 4, p.y, true);
      view.setUint16(offset + 8, Math.max(0, Math.min(65535, Math.round(p.pressure * 65535))), true);
      view.setUint16(offset + 10, Math.max(0, Math.min(65535, Math.round(p.dtMs))), true);
      view.setInt16(offset + 12, Math.max(-32767, Math.min(32767, Math.round(p.altitude * 10000))), true);
      view.setInt16(offset + 14, Math.max(-32767, Math.min(32767, Math.round(p.azimuth * 5000))), true);
      offset += POINT_STRIDE_BYTES;
    }
  }

  return out;
}

export function decodePageQbin(bytes: Uint8Array): PagePayload {
  if (bytes.byteLength < 12) {
    throw new Error('Corrupt .qbin payload: too short');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error('Corrupt .qbin payload: invalid magic header');
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported .qbin version: ${version}`);
  }
  const metaLen = view.getUint32(8, true);
  const headerLen = 12 + metaLen;
  const alignedPointsOffset = (headerLen + 3) & ~3;
  if (alignedPointsOffset > bytes.byteLength) {
    throw new Error('Corrupt .qbin payload: metadata exceeds buffer');
  }

  const meta = JSON.parse(
    textDecoder.decode(bytes.subarray(12, 12 + metaLen))
  ) as QbinHeaderMeta;

  let offset = alignedPointsOffset;
  const strokes: VectorStroke[] = meta.strokes.map((sm) => {
    const points: StrokePoint[] = [];
    for (let i = 0; i < sm.pointCount; i++) {
      if (offset + POINT_STRIDE_BYTES > bytes.byteLength) {
        break;
      }
      points.push({
        x: view.getFloat32(offset, true),
        y: view.getFloat32(offset + 4, true),
        pressure: view.getUint16(offset + 8, true) / 65535,
        dtMs: view.getUint16(offset + 10, true),
        altitude: view.getInt16(offset + 12, true) / 10000,
        azimuth: view.getInt16(offset + 14, true) / 5000,
      });
      offset += POINT_STRIDE_BYTES;
    }
    return {
      id: sm.id,
      pageId: sm.pageId,
      tool: sm.tool,
      color: sm.color,
      width: sm.width,
      points,
      bbox: sm.bbox,
      shapeKind: sm.shapeKind,
      audioSessionId: sm.audioSessionId,
      startAudioMs: sm.startAudioMs,
      endAudioMs: sm.endAudioMs,
    };
  });

  return {
    pageId: meta.pageId,
    strokes,
    textBoxes: meta.textBoxes ?? [],
    images: meta.images ?? [],
  };
}

/**
 * Wraps a `.qbin` frame in a length-prefixed WAL record (`[4B length][4B checksum][payload]`)
 * so partial writes from a power loss are cleanly ignored during WAL replay.
 */
export function encodeWalFrame(qbinBytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + qbinBytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, qbinBytes.byteLength, true);
  view.setUint32(4, fnv1a32(qbinBytes), true);
  frame.set(qbinBytes, 8);
  return frame;
}

/**
 * Scans an append-only WAL buffer and returns the last complete, checksum-valid `.qbin` frame.
 */
export function decodeLatestWalFrame(walBytes: Uint8Array): PagePayload | null {
  let offset = 0;
  let latestSlice: Uint8Array | null = null;
  const view = new DataView(walBytes.buffer, walBytes.byteOffset, walBytes.byteLength);

  while (offset + 8 <= walBytes.byteLength) {
    const len = view.getUint32(offset, true);
    const expectedHash = view.getUint32(offset + 4, true);
    if (len === 0 || offset + 8 + len > walBytes.byteLength) {
      break; // Truncated tail frame from crash
    }
    const slice = walBytes.subarray(offset + 8, offset + 8 + len);
    if (fnv1a32(slice) === expectedHash) {
      latestSlice = slice;
    }
    offset += 8 + len;
  }

  return latestSlice ? decodePageQbin(latestSlice) : null;
}

function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
