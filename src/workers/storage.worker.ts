/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import type {
  AppSettings,
  AudioSession,
  Folder,
  NoteDocument,
  NoteSummary,
  PageDescriptor,
  PagePayload,
} from '../types';
import { decodeLatestWalFrame, decodePageQbin, encodePageQbin, encodeWalFrame } from '../engine/qbin';

/**
 * Dedicated StorageSyncWorker (TDD §7.1):
 * - SQLite 3.54 WASM with `opfs-sahpool` VFS (zero COOP/COEP headers required on GitHub Pages)
 *   + FTS5 full-text search across titles, folder paths, tags, and typed text boxes.
 * - Synchronous OPFS `FileSystemSyncAccessHandle` for:
 *   • `pages/{pageId}.qbin` compact binary vector stroke snapshots
 *   • `wal/{pageId}.wal` append-only checksummed stroke WAL (<0.4ms flush)
 *   • `blobs/{key}` immutable PDFs, images, and O(1) 10-second appended audio chunks
 *   • `thumbs/{pageId}` cached WebP/PNG page thumbnails
 * - Deterministic reference-counted blob GC + `pauseVfs()`/`unpauseVfs()` for multi-tab handoff.
 */

type SyncHandle = {
  getSize: () => number;
  read: (buf: ArrayBufferView, opts?: { at?: number }) => number;
  write: (buf: ArrayBufferView, opts?: { at?: number }) => number;
  truncate: (newSize: number) => void;
  flush: () => void;
  close: () => void;
};

type FileHandleWithSync = FileSystemFileHandle & {
  createSyncAccessHandle: () => Promise<SyncHandle>;
};

export interface StorageRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface StorageRpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sahPool: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
let paused = false;

let quireRootDir: FileSystemDirectoryHandle | null = null;
let pagesDir: FileSystemDirectoryHandle | null = null;
let walDir: FileSystemDirectoryHandle | null = null;
let blobsDir: FileSystemDirectoryHandle | null = null;
let thumbsDir: FileSystemDirectoryHandle | null = null;

// Open SyncAccessHandles for active streaming audio appends (closed cleanly on pause/finalize)
const openAudioHandles = new Map<string, { handle: SyncHandle; offset: number }>();

async function ensureOpfsDirs(): Promise<void> {
  if (quireRootDir && pagesDir && walDir && blobsDir && thumbsDir) return;
  const root = await navigator.storage.getDirectory();
  quireRootDir = await root.getDirectoryHandle('quire-v2', { create: true });
  pagesDir = await quireRootDir.getDirectoryHandle('pages', { create: true });
  walDir = await quireRootDir.getDirectoryHandle('wal', { create: true });
  blobsDir = await quireRootDir.getDirectoryHandle('blobs', { create: true });
  thumbsDir = await quireRootDir.getDirectoryHandle('thumbs', { create: true });
}

function sanitizeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

async function writeOpfsSync(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array
): Promise<void> {
  const fh = (await dir.getFileHandle(sanitizeFileKey(fileName), {
    create: true,
  })) as FileHandleWithSync;
  const sah = await fh.createSyncAccessHandle();
  try {
    sah.truncate(0);
    sah.write(bytes, { at: 0 });
    sah.flush();
  } finally {
    sah.close();
  }
}

async function appendOpfsSync(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array
): Promise<number> {
  const fh = (await dir.getFileHandle(sanitizeFileKey(fileName), {
    create: true,
  })) as FileHandleWithSync;
  const sah = await fh.createSyncAccessHandle();
  try {
    const size = sah.getSize();
    sah.write(bytes, { at: size });
    sah.flush();
    return size + bytes.byteLength;
  } finally {
    sah.close();
  }
}

async function readOpfsSync(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<Uint8Array | null> {
  try {
    const fh = (await dir.getFileHandle(sanitizeFileKey(fileName))) as FileHandleWithSync;
    const sah = await fh.createSyncAccessHandle();
    try {
      const size = sah.getSize();
      if (size === 0) return new Uint8Array(0);
      const buf = new Uint8Array(size);
      sah.read(buf, { at: 0 });
      return buf;
    } finally {
      sah.close();
    }
  } catch {
    return null;
  }
}

async function deleteOpfsFile(dir: FileSystemDirectoryHandle, fileName: string): Promise<void> {
  try {
    await dir.removeEntry(sanitizeFileKey(fileName));
  } catch {
    // Already removed
  }
}

function initSchema(): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id TEXT,
      tags_json TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      scroll_direction TEXT NOT NULL DEFAULT 'vertical',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      pages_json TEXT NOT NULL,
      audio_sessions_json TEXT NOT NULL,
      hlc_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS page_index (
      page_id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      plain_text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_page_index_note ON page_index(note_id);

    CREATE TABLE IF NOT EXISTS blob_refs (
      blob_key TEXT PRIMARY KEY,
      ref_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED,
      title,
      folder_name,
      tags,
      body_text
    );
  `);
}

function openCatalogDb(): void {
  if (db) return;
  db = new sahPool.OpfsSAHPoolDb('/catalog.sqlite');
  initSchema();
}

function closeAllStreamingHandles(): void {
  for (const [, entry] of openAudioHandles) {
    try {
      entry.handle.flush();
      entry.handle.close();
    } catch {
      // ignore
    }
  }
  openAudioHandles.clear();
}

function rebuildNoteFts(noteId: string): void {
  const row = db.selectObject(
    `SELECT n.title, n.tags_json, n.folder_id, f.name AS folder_name
     FROM notes n
     LEFT JOIN folders f ON f.id = n.folder_id
     WHERE n.id = ?`,
    [noteId]
  );
  db.exec({ sql: 'DELETE FROM notes_fts WHERE note_id = ?', bind: [noteId] });
  if (!row) return;

  const textRows: Array<{ plain_text: string }> = db.selectObjects(
    'SELECT plain_text FROM page_index WHERE note_id = ?',
    [noteId]
  );
  const bodyText = textRows
    .map((r) => r.plain_text)
    .filter(Boolean)
    .join('\n');
  let tagsStr = '';
  try {
    tagsStr = (JSON.parse(row.tags_json) as string[]).join(' ');
  } catch {
    tagsStr = '';
  }

  db.exec({
    sql: 'INSERT INTO notes_fts(note_id, title, folder_name, tags, body_text) VALUES (?, ?, ?, ?, ?)',
    bind: [noteId, row.title ?? '', row.folder_name ?? '', tagsStr, bodyText],
  });
}

function rowToSummary(row: Record<string, unknown>): NoteSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    folderId: (row.folder_id as string | null) ?? null,
    tags: JSON.parse(String(row.tags_json || '[]')) as string[],
    isFavorite: Boolean(row.is_favorite),
    scrollDirection: (row.scroll_direction as NoteSummary['scrollDirection']) || 'vertical',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    pages: JSON.parse(String(row.pages_json || '[]')) as PageDescriptor[],
    audioSessions: JSON.parse(String(row.audio_sessions_json || '[]')) as AudioSession[],
    hlc: JSON.parse(String(row.hlc_json || '{"ts":0,"counter":0,"deviceId":"local"}')),
  };
}

function collectBlobKeysFromNote(
  pages: PageDescriptor[],
  audioSessions: AudioSession[],
  imagesByPage?: Record<string, Array<{ blobKey: string }>>
): Set<string> {
  const keys = new Set<string>();
  for (const p of pages) {
    if (p.source.kind === 'pdf') keys.add(p.source.blobKey);
  }
  for (const a of audioSessions) {
    keys.add(a.blobKey);
  }
  if (imagesByPage) {
    for (const imgs of Object.values(imagesByPage)) {
      for (const img of imgs) keys.add(img.blobKey);
    }
  }
  return keys;
}

async function loadPagePayload(pageId: string): Promise<PagePayload> {
  await ensureOpfsDirs();
  // Check WAL first for uncompacted latest frames
  const walBytes = await readOpfsSync(walDir!, `${pageId}.wal`);
  if (walBytes && walBytes.byteLength > 0) {
    const walDecoded = decodeLatestWalFrame(walBytes);
    if (walDecoded) return walDecoded;
  }
  const qbinBytes = await readOpfsSync(pagesDir!, `${pageId}.qbin`);
  if (qbinBytes && qbinBytes.byteLength > 0) {
    return decodePageQbin(qbinBytes);
  }
  return { pageId, strokes: [], textBoxes: [], images: [] };
}

async function savePagePayload(
  noteId: string,
  payload: PagePayload,
  compact = false,
  skipFts = false
): Promise<void> {
  await ensureOpfsDirs();
  const isEmpty =
    payload.strokes.length === 0 &&
    payload.textBoxes.length === 0 &&
    payload.images.length === 0;
  if (isEmpty && compact) {
    // Empty page has no ink/text/images: remove any stale files instead of writing empty .qbin
    await deleteOpfsFile(pagesDir!, `${payload.pageId}.qbin`);
    await deleteOpfsFile(walDir!, `${payload.pageId}.wal`);
  } else {
    const qbin = encodePageQbin(payload);
    if (compact) {
      await writeOpfsSync(pagesDir!, `${payload.pageId}.qbin`, qbin);
      await deleteOpfsFile(walDir!, `${payload.pageId}.wal`);
    } else {
      const frame = encodeWalFrame(qbin);
      const newSize = await appendOpfsSync(walDir!, `${payload.pageId}.wal`, frame);
      if (newSize > 32 * 1024) {
        await writeOpfsSync(pagesDir!, `${payload.pageId}.qbin`, qbin);
        await deleteOpfsFile(walDir!, `${payload.pageId}.wal`);
      }
    }
  }

  const plainText = payload.textBoxes.map((b) => b.plainText).filter(Boolean).join('\n');
  if (plainText || !isEmpty) {
    db.exec({
      sql: `INSERT INTO page_index(page_id, note_id, plain_text)
            VALUES (?, ?, ?)
            ON CONFLICT(page_id) DO UPDATE SET note_id = excluded.note_id, plain_text = excluded.plain_text`,
      bind: [payload.pageId, noteId, plainText],
    });
  } else {
    db.exec({
      sql: 'DELETE FROM page_index WHERE page_id = ?',
      bind: [payload.pageId],
    });
  }
  if (!skipFts) {
    rebuildNoteFts(noteId);
  }
}

async function runBlobGc(): Promise<number> {
  await ensureOpfsDirs();
  const allNoteRows: Array<Record<string, unknown>> = db.selectObjects(
    'SELECT id, pages_json, audio_sessions_json FROM notes'
  );
  const liveKeys = new Set<string>();
  for (const row of allNoteRows) {
    const pages = JSON.parse(String(row.pages_json || '[]')) as PageDescriptor[];
    const audioSessions = JSON.parse(String(row.audio_sessions_json || '[]')) as AudioSession[];
    for (const k of collectBlobKeysFromNote(pages, audioSessions)) {
      liveKeys.add(k);
    }
    for (const p of pages) {
      const payload = await loadPagePayload(p.pageId);
      for (const img of payload.images) {
        liveKeys.add(img.blobKey);
      }
    }
  }

  const tracked: Array<{ blob_key: string }> = db.selectObjects('SELECT blob_key FROM blob_refs');
  let purged = 0;
  for (const row of tracked) {
    if (!liveKeys.has(row.blob_key)) {
      await deleteOpfsFile(blobsDir!, row.blob_key);
      db.exec({ sql: 'DELETE FROM blob_refs WHERE blob_key = ?', bind: [row.blob_key] });
      purged++;
    }
  }
  return purged;
}

async function handleRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (method === 'init') {
    await ensureOpfsDirs();
    if (!sahPool) {
      const initFn = sqlite3InitModule as unknown as (opts?: {
        locateFile?: (file: string) => string;
      }) => ReturnType<typeof sqlite3InitModule>;
      const sqlite3 = await initFn({
        locateFile: (file: string) => (file.endsWith('.wasm') ? sqliteWasmUrl : file),
      });
      sahPool = await sqlite3.installOpfsSAHPoolVfs({
        name: 'quire-sahpool',
        directory: '/quire-sqlite-v2',
        initialCapacity: 8,
        preserveOnInitFailure: true,
      });
    }
    openCatalogDb();
    paused = false;
    return { backend: 'sqlite-opfs' };
  }

  if (method === 'pause') {
    if (!paused) {
      closeAllStreamingHandles();
      if (db) {
        db.close();
        db = null;
      }
      if (sahPool) {
        sahPool.pauseVfs();
      }
      paused = true;
    }
    return { paused: true };
  }

  if (method === 'resume') {
    if (paused && sahPool) {
      await sahPool.unpauseVfs();
      openCatalogDb();
      paused = false;
    }
    return { paused: false };
  }

  if (paused || !db) {
    throw new Error('StorageSyncWorker is paused while another tab owns the OPFS lock');
  }

  switch (method) {
    case 'getMeta': {
      const key = String(params.key);
      const row = db.selectObject('SELECT value_json FROM meta WHERE key = ?', [key]);
      return row ? JSON.parse(String(row.value_json)) : null;
    }

    case 'setMeta': {
      const key = String(params.key);
      const valueJson = JSON.stringify(params.value ?? null);
      db.exec({
        sql: `INSERT INTO meta(key, value_json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        bind: [key, valueJson],
      });
      return true;
    }

    case 'loadSettings': {
      const row = db.selectObject('SELECT value_json FROM meta WHERE key = ?', ['settings']);
      return row ? JSON.parse(String(row.value_json)) : null;
    }

    case 'saveSettings': {
      const settings = params.settings as AppSettings;
      db.exec({
        sql: `INSERT INTO meta(key, value_json) VALUES ('settings', ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        bind: [JSON.stringify({ ...settings, settingsVersion: 4 })],
      });
      return true;
    }

    case 'loadAllFolders': {
      const rows: Array<Record<string, unknown>> = db.selectObjects(
        'SELECT id, name, parent_id, color, created_at, deleted_at FROM folders ORDER BY created_at ASC'
      );
      return rows.map(
        (r): Folder => ({
          id: String(r.id),
          name: String(r.name),
          parentId: (r.parent_id as string | null) ?? null,
          color: String(r.color),
          createdAt: Number(r.created_at),
          deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
        })
      );
    }

    case 'saveFolder': {
      const f = params.folder as Folder;
      db.exec({
        sql: `INSERT INTO folders(id, name, parent_id, color, created_at, deleted_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                parent_id = excluded.parent_id,
                color = excluded.color,
                deleted_at = excluded.deleted_at`,
        bind: [f.id, f.name, f.parentId, f.color, f.createdAt, f.deletedAt ?? null],
      });
      // Re-index notes in this folder so FTS5 reflects folder renames
      const affected: Array<{ id: string }> = db.selectObjects(
        'SELECT id FROM notes WHERE folder_id = ?',
        [f.id]
      );
      for (const n of affected) rebuildNoteFts(n.id);
      return true;
    }

    case 'deleteFolder': {
      const folderId = String(params.folderId);
      db.exec({ sql: 'DELETE FROM folders WHERE id = ?', bind: [folderId] });
      return true;
    }

    case 'loadNoteSummaries': {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const expired: Array<{ id: string }> = db.selectObjects(
        'SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?',
        [cutoff]
      );
      for (const ex of expired) {
        await handleRpc('hardDeleteNote', { noteId: ex.id, skipGc: true });
      }
      if (expired.length > 0) {
        await runBlobGc();
      }
      const rows: Array<Record<string, unknown>> = db.selectObjects(
        'SELECT * FROM notes ORDER BY updated_at DESC'
      );
      return rows.map(rowToSummary);
    }

    case 'loadNote': {
      const noteId = String(params.noteId);
      const row = db.selectObject('SELECT * FROM notes WHERE id = ?', [noteId]);
      if (!row) return null;
      const summary = rowToSummary(row);
      const strokesByPage: NoteDocument['strokesByPage'] = {};
      const textBoxesByPage: NoteDocument['textBoxesByPage'] = {};
      const imagesByPage: NoteDocument['imagesByPage'] = {};
      for (const p of summary.pages) {
        const payload = await loadPagePayload(p.pageId);
        strokesByPage[p.pageId] = payload.strokes;
        textBoxesByPage[p.pageId] = payload.textBoxes;
        imagesByPage[p.pageId] = payload.images;
      }
      return {
        ...summary,
        strokesByPage,
        textBoxesByPage,
        imagesByPage,
      } satisfies NoteDocument;
    }

    case 'loadAllNotes': {
      const summaries = (await handleRpc('loadNoteSummaries')) as NoteSummary[];
      const docs: NoteDocument[] = [];
      for (const s of summaries) {
        const doc = (await handleRpc('loadNote', { noteId: s.id })) as NoteDocument | null;
        if (doc) docs.push(doc);
      }
      return docs;
    }

    case 'saveNoteMetadata': {
      const summary = params.summary as NoteSummary;
      db.exec({
        sql: `INSERT INTO notes(
                id, title, folder_id, tags_json, is_favorite, scroll_direction,
                created_at, updated_at, deleted_at, pages_json, audio_sessions_json, hlc_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                folder_id = excluded.folder_id,
                tags_json = excluded.tags_json,
                is_favorite = excluded.is_favorite,
                scroll_direction = excluded.scroll_direction,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at,
                pages_json = excluded.pages_json,
                audio_sessions_json = excluded.audio_sessions_json,
                hlc_json = excluded.hlc_json`,
        bind: [
          summary.id,
          summary.title,
          summary.folderId,
          JSON.stringify(summary.tags),
          summary.isFavorite ? 1 : 0,
          summary.scrollDirection,
          summary.createdAt,
          summary.updatedAt,
          summary.deletedAt ?? null,
          JSON.stringify(summary.pages),
          JSON.stringify(summary.audioSessions),
          JSON.stringify(summary.hlc),
        ],
      });
      rebuildNoteFts(summary.id);
      return true;
    }

    case 'savePage': {
      const noteId = String(params.noteId);
      const payload = params.payload as PagePayload;
      const compact = Boolean(params.compact);
      await savePagePayload(noteId, payload, compact);
      return true;
    }

    case 'saveNote': {
      const note = params.note as NoteDocument;
      const dirtyPageIds = params.dirtyPageIds as string[] | undefined;
      await handleRpc('saveNoteMetadata', { summary: note });
      const targetPages =
        dirtyPageIds && dirtyPageIds.length > 0
          ? note.pages.filter((p) => dirtyPageIds.includes(p.pageId))
          : note.pages.filter(
              (p) =>
                (note.strokesByPage[p.pageId]?.length ?? 0) > 0 ||
                (note.textBoxesByPage[p.pageId]?.length ?? 0) > 0 ||
                (note.imagesByPage[p.pageId]?.length ?? 0) > 0
            );
      for (const p of targetPages) {
        await savePagePayload(
          note.id,
          {
            pageId: p.pageId,
            strokes: note.strokesByPage[p.pageId] ?? [],
            textBoxes: note.textBoxesByPage[p.pageId] ?? [],
            images: note.imagesByPage[p.pageId] ?? [],
          },
          !dirtyPageIds,
          true
        );
      }
      rebuildNoteFts(note.id);
      return true;
    }

    case 'updateAudioSessionCheckpoint': {
      const noteId = String(params.noteId);
      const sessionId = String(params.sessionId);
      const durationMs = Number(params.durationMs);
      const segments = params.segments as AudioSession['segments'];
      const row = db.selectObject('SELECT audio_sessions_json FROM notes WHERE id = ?', [noteId]);
      if (!row) return false;
      const sessions = JSON.parse(String(row.audio_sessions_json || '[]')) as AudioSession[];
      const updated = sessions.map((s) =>
        s.id === sessionId ? { ...s, durationMs, segments } : s
      );
      db.exec({
        sql: 'UPDATE notes SET audio_sessions_json = ?, updated_at = ? WHERE id = ?',
        bind: [JSON.stringify(updated), Date.now(), noteId],
      });
      return true;
    }

    case 'hardDeleteNote': {
      const noteId = String(params.noteId);
      const skipGc = Boolean(params.skipGc);
      const pageRows: Array<{ page_id: string }> = db.selectObjects(
        'SELECT page_id FROM page_index WHERE note_id = ?',
        [noteId]
      );
      await ensureOpfsDirs();
      for (const p of pageRows) {
        await deleteOpfsFile(pagesDir!, `${p.page_id}.qbin`);
        await deleteOpfsFile(walDir!, `${p.page_id}.wal`);
        await deleteOpfsFile(thumbsDir!, `${p.page_id}.webp`);
      }
      db.exec({ sql: 'DELETE FROM page_index WHERE note_id = ?', bind: [noteId] });
      db.exec({ sql: 'DELETE FROM notes_fts WHERE note_id = ?', bind: [noteId] });
      db.exec({ sql: 'DELETE FROM notes WHERE id = ?', bind: [noteId] });
      if (!skipGc) {
        await runBlobGc();
      }
      return true;
    }

    case 'searchNoteIds': {
      const rawQuery = String(params.query ?? '').trim();
      if (!rawQuery) return null;
      // Tokenize for prefix FTS5 match (safe against FTS5 syntax chars)
      const tokens = rawQuery
        .replace(/["'()*^:]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '')}"*`);
      if (tokens.length === 0) return null;
      const ftsQuery = tokens.join(' AND ');
      try {
        const rows: Array<{ note_id: string }> = db.selectObjects(
          'SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?',
          [ftsQuery]
        );
        return rows.map((r) => r.note_id);
      } catch {
        // Fallback LIKE scan if FTS query fails
        const like = `%${rawQuery.toLowerCase()}%`;
        const rows: Array<{ id: string }> = db.selectObjects(
          `SELECT id FROM notes WHERE lower(title) LIKE ? OR lower(tags_json) LIKE ?`,
          [like, like]
        );
        return rows.map((r) => r.id);
      }
    }

    case 'saveBlob': {
      await ensureOpfsDirs();
      const key = String(params.key);
      const data = params.data as Uint8Array;
      await writeOpfsSync(blobsDir!, key, data);
      db.exec({
        sql: `INSERT INTO blob_refs(blob_key, ref_count, byte_size)
              VALUES (?, 1, ?)
              ON CONFLICT(blob_key) DO UPDATE SET byte_size = excluded.byte_size`,
        bind: [key, data.byteLength],
      });
      return true;
    }

    case 'appendBlobChunk': {
      await ensureOpfsDirs();
      const key = String(params.key);
      const chunk = params.data as Uint8Array;
      let entry = openAudioHandles.get(key);
      if (!entry) {
        const fh = (await blobsDir!.getFileHandle(sanitizeFileKey(key), {
          create: true,
        })) as FileHandleWithSync;
        const handle = await fh.createSyncAccessHandle();
        entry = { handle, offset: handle.getSize() };
        openAudioHandles.set(key, entry);
      }
      entry.handle.write(chunk, { at: entry.offset });
      entry.offset += chunk.byteLength;
      entry.handle.flush();
      db.exec({
        sql: `INSERT INTO blob_refs(blob_key, ref_count, byte_size)
              VALUES (?, 1, ?)
              ON CONFLICT(blob_key) DO UPDATE SET byte_size = excluded.byte_size`,
        bind: [key, entry.offset],
      });
      return entry.offset;
    }

    case 'finalizeBlobStream': {
      const key = String(params.key);
      const entry = openAudioHandles.get(key);
      if (entry) {
        entry.handle.flush();
        entry.handle.close();
        openAudioHandles.delete(key);
      }
      return true;
    }

    case 'loadBlob': {
      await ensureOpfsDirs();
      const key = String(params.key);
      // If currently open for streaming, flush and read from its handle
      const open = openAudioHandles.get(key);
      if (open) {
        open.handle.flush();
        const size = open.handle.getSize();
        const buf = new Uint8Array(size);
        open.handle.read(buf, { at: 0 });
        return buf;
      }
      return await readOpfsSync(blobsDir!, key);
    }

    case 'deleteBlob': {
      await ensureOpfsDirs();
      const key = String(params.key);
      const open = openAudioHandles.get(key);
      if (open) {
        open.handle.close();
        openAudioHandles.delete(key);
      }
      await deleteOpfsFile(blobsDir!, key);
      db.exec({ sql: 'DELETE FROM blob_refs WHERE blob_key = ?', bind: [key] });
      return true;
    }

    case 'saveThumbnail': {
      await ensureOpfsDirs();
      const pageId = String(params.pageId);
      const data = params.data as Uint8Array;
      await writeOpfsSync(thumbsDir!, `${pageId}.webp`, data);
      return true;
    }

    case 'loadThumbnail': {
      await ensureOpfsDirs();
      const pageId = String(params.pageId);
      return await readOpfsSync(thumbsDir!, `${pageId}.webp`);
    }

    case 'runBlobGc': {
      return await runBlobGc();
    }

    case 'getStats': {
      const noteRow = db.selectObject('SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL');
      const blobRow = db.selectObject('SELECT COUNT(*) AS c FROM blob_refs');
      return {
        noteCount: Number(noteRow?.c ?? 0),
        blobCount: Number(blobRow?.c ?? 0),
      };
    }

    default:
      throw new Error(`Unknown storage RPC method: ${method}`);
  }
}

let rpcQueue: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<StorageRpcRequest>) => {
  const { id, method, params } = ev.data;
  rpcQueue = rpcQueue.then(async () => {
    try {
      const result = await handleRpc(method, params);
      const transfer: Transferable[] = [];
      if (result instanceof Uint8Array && result.byteLength > 0) {
        transfer.push(result.buffer);
      }
      self.postMessage({ id, ok: true, result } satisfies StorageRpcResponse, transfer);
    } catch (err) {
      self.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies StorageRpcResponse);
    }
  });
};
