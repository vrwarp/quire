import type {
  AppSettings,
  AudioSession,
  Folder,
  NoteDocument,
  NoteSummary,
  PageDescriptor,
  PagePayload,
  StorageHealth,
} from '../types';
import { generateOrderKey } from './inkMath';
import { logDiagnostic } from './diagnostics';
import type { StorageRpcRequest, StorageRpcResponse } from '../workers/storage.worker';

/**
 * Local-First Storage Facade (SQLite WASM + OPFS SyncAccessHandle Worker, with
 * seamless v1 IndexedDB migration and Private-Browsing IndexedDB fallback).
 */

const LEGACY_DB_NAME = 'quire-local-v1';
const LEGACY_DB_VERSION = 1;
const STORE_NOTES = 'notes';
const STORE_FOLDERS = 'folders';
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';

export const DEFAULT_SETTINGS: AppSettings = {
  hasCompletedOnboarding: false,
  defaultTemplate: 'lined',
  defaultPaperTheme: 'cream',
  defaultScrollDirection: 'vertical',
  themeMode: 'system',
  nightCanvasMode: 'off',
  toolbarDock: 'top',
  fingerDrawMode: false,
  eraserSize: 'medium',
  eraserAutoReturn: false,
  predictionLookaheadMs: 10,
  audioPreRollMs: 2000,
  showTelemetryHud: false,
  lastOpenedNoteId: null,
  penColorPresets: ['#18181b', '#c85a32', '#1d4ed8', '#15803d', '#7c2d12', '#475569'],
  highlighterColorPresets: ['#facc15', '#4ade80', '#60a5fa', '#fb7185', '#f59e0b', '#a78bfa'],
  backup: {
    lastBackupAt: null,
    reminderIntervalDays: 7,
    localFolderName: null,
    autoBackupLocalFolder: false,
  },
};

export function createId(prefix = 'q'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}`;
}

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem('quire-device-id');
    if (existing) return existing;
    const id = createId('dev');
    localStorage.setItem('quire-device-id', id);
    return id;
  } catch {
    return 'dev_local';
  }
}

export function formatDefaultNoteTitle(date = new Date()): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function createBlankPage(
  template: AppSettings['defaultTemplate'],
  theme: AppSettings['defaultPaperTheme'],
  orderKey = '1000'
): PageDescriptor {
  return {
    pageId: createId('pg'),
    orderKey,
    widthPt: 612,
    heightPt: 792,
    source: { kind: 'template', template, theme },
  };
}

export function createNewNote(
  settings: AppSettings,
  folderId: string | null = null,
  title?: string
): NoteDocument {
  const now = Date.now();
  const page = createBlankPage(settings.defaultTemplate, settings.defaultPaperTheme, generateOrderKey());
  return {
    id: createId('note'),
    title: title ?? formatDefaultNoteTitle(new Date(now)),
    folderId,
    tags: [],
    isFavorite: false,
    scrollDirection: settings.defaultScrollDirection,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    pages: [page],
    strokesByPage: { [page.pageId]: [] },
    textBoxesByPage: { [page.pageId]: [] },
    imagesByPage: { [page.pageId]: [] },
    audioSessions: [],
    hlc: { ts: now, counter: 0, deviceId: getDeviceId() },
  };
}

export function noteToSummary(note: NoteDocument): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    tags: note.tags,
    isFavorite: note.isFavorite,
    scrollDirection: note.scrollDirection,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt ?? null,
    pages: note.pages,
    audioSessions: note.audioSessions,
    hlc: note.hlc,
  };
}

function normalizeLoadedSettings(stored: Record<string, unknown> | null | undefined): AppSettings {
  if (!stored) return { ...DEFAULT_SETTINGS, backup: { ...DEFAULT_SETTINGS.backup } };
  const cleanStored = { ...stored };
  delete cleanStored.pro;
  delete cleanStored.sync;
  delete cleanStored.scribbleEraseEnabled;
  const legacyDarkMode = typeof cleanStored.darkMode === 'boolean' ? cleanStored.darkMode : undefined;
  delete cleanStored.darkMode;
  const schemaVer = typeof cleanStored.settingsVersion === 'number' ? cleanStored.settingsVersion : 1;
  delete cleanStored.settingsVersion;

  const migratedTheme =
    cleanStored.themeMode === 'system' ||
    cleanStored.themeMode === 'light' ||
    cleanStored.themeMode === 'dark'
      ? cleanStored.themeMode
      : legacyDarkMode === true
      ? 'dark'
      : DEFAULT_SETTINGS.themeMode;

  const rawBackup = (stored.backup as Record<string, unknown> | undefined) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...(cleanStored as Partial<AppSettings>),
    themeMode: migratedTheme,
    ...(schemaVer < 2 ? { fingerDrawMode: false } : {}),
    showTelemetryHud:
      typeof cleanStored.showTelemetryHud === 'boolean' ? cleanStored.showTelemetryHud : false,
    lastOpenedNoteId:
      typeof cleanStored.lastOpenedNoteId === 'string' ? cleanStored.lastOpenedNoteId : null,
    backup: {
      lastBackupAt: typeof rawBackup.lastBackupAt === 'number' ? rawBackup.lastBackupAt : null,
      reminderIntervalDays:
        typeof rawBackup.reminderIntervalDays === 'number'
          ? rawBackup.reminderIntervalDays
          : DEFAULT_SETTINGS.backup.reminderIntervalDays,
      localFolderName:
        typeof rawBackup.localFolderName === 'string' ? rawBackup.localFolderName : null,
      autoBackupLocalFolder: Boolean(rawBackup.autoBackupLocalFolder),
    },
  };
}

class QuireStorage {
  private worker: Worker | null = null;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private initPromise: Promise<void> | null = null;
  private backend: 'sqlite-opfs' | 'indexeddb-fallback' = 'indexeddb-fallback';
  private privateModeWarning = false;
  private migratedFromV1 = false;
  private persistGranted = false;
  private persistRequested = false;

  // Fallback IndexedDB handle (used in Private Browsing or Vitest/jsdom, and for v1 migration reads)
  private legacyDbPromise: Promise<IDBDatabase> | null = null;
  // In-memory streaming audio buffer for IndexedDB fallback only
  private fallbackAudioStreams = new Map<string, Uint8Array[]>();
  private fallbackThumbs = new Map<string, Uint8Array>();

  private openLegacyDB(): Promise<IDBDatabase> {
    if (this.legacyDbPromise) return this.legacyDbPromise;
    this.legacyDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.legacyDbPromise;
  }

  private callWorker<T>(
    method: string,
    params?: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('StorageSyncWorker not initialized'));
    }
    const id = ++this.rpcId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRpc.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      const req: StorageRpcRequest = { id, method, params };
      this.worker!.postMessage(req, transfer);
    });
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await this.ensurePersistentStorage();

    const canUseWorkerOpfs =
      typeof Worker !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      Boolean(navigator.storage?.getDirectory);

    if (canUseWorkerOpfs) {
      try {
        const worker = new Worker(new URL('../workers/storage.worker.ts', import.meta.url), {
          type: 'module',
          name: 'quire-storage-worker',
        });
        worker.onmessage = (ev: MessageEvent<StorageRpcResponse>) => {
          const { id, ok, result, error } = ev.data;
          const entry = this.pendingRpc.get(id);
          if (!entry) return;
          this.pendingRpc.delete(id);
          if (ok) entry.resolve(result);
          else entry.reject(new Error(error || 'Storage worker RPC error'));
        };
        worker.onerror = (ev) => {
          logDiagnostic('error', 'storage.worker', 'Worker runtime error', ev.message);
        };
        this.worker = worker;
        await this.callWorker('init');
        this.backend = 'sqlite-opfs';
        this.privateModeWarning = false;
        logDiagnostic('info', 'storage', 'Initialized SQLite WASM (opfs-sahpool) + OPFS worker');
        await this.migrateFromLegacyV1IfNeeded();
        return;
      } catch (err) {
        logDiagnostic(
          'warn',
          'storage',
          'OPFS SQLite unavailable (Private Browsing or restricted context); using IndexedDB fallback',
          err
        );
        this.worker?.terminate();
        this.worker = null;
        this.backend = 'indexeddb-fallback';
        this.privateModeWarning = true;
      }
    } else {
      this.backend = 'indexeddb-fallback';
      this.privateModeWarning = false;
    }
  }

  private async migrateFromLegacyV1IfNeeded(): Promise<void> {
    if (this.backend !== 'sqlite-opfs' || typeof indexedDB === 'undefined') return;
    try {
      const alreadyDone = await this.callWorker<boolean>('getMeta', { key: 'migrated_v1' });
      if (alreadyDone) return;

      const db = await this.openLegacyDB();
      const readAll = <T>(storeName: string): Promise<T[]> =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve((req.result as T[]) ?? []);
          req.onerror = () => reject(req.error);
        });

      const readAllWithKeys = <T>(storeName: string): Promise<Array<{ key: string; value: T }>> =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const keysReq = store.getAllKeys();
          const valsReq = store.getAll();
          tx.oncomplete = () => {
            const keys = (keysReq.result ?? []) as string[];
            const vals = (valsReq.result ?? []) as T[];
            const pairs: Array<{ key: string; value: T }> = [];
            for (let i = 0; i < keys.length; i++) {
              pairs.push({ key: String(keys[i]), value: vals[i] });
            }
            resolve(pairs);
          };
          tx.onerror = () => reject(tx.error);
        });

      const [legacyNotes, legacyFolders, legacyBlobs, legacySettings] = await Promise.all([
        readAll<NoteDocument>(STORE_NOTES),
        readAll<Folder>(STORE_FOLDERS),
        readAllWithKeys<Uint8Array>(STORE_BLOBS),
        new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_META, 'readonly');
          const req = tx.objectStore(STORE_META).get('settings');
          req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
          req.onerror = () => reject(req.error);
        }),
      ]);

      // Also check legacy OPFS `/quire/blobs` directory
      try {
        const root = await navigator.storage.getDirectory();
        const oldQuire = await root.getDirectoryHandle('quire');
        const oldBlobs = await oldQuire.getDirectoryHandle('blobs');
        const iter = (
          oldBlobs as FileSystemDirectoryHandle & {
            entries: () => AsyncIterable<[string, FileSystemHandle]>;
          }
        ).entries();
        for await (const [name, handle] of iter) {
          if (handle.kind === 'file') {
            const file = await (handle as FileSystemFileHandle).getFile();
            const bytes = new Uint8Array(await file.arrayBuffer());
            await this.callWorker('saveBlob', { key: name, data: bytes }, [bytes.buffer]);
          }
        }
      } catch {
        // No legacy OPFS blobs directory
      }

      if (legacyNotes.length > 0 || legacyFolders.length > 0 || legacySettings) {
        for (const pair of legacyBlobs) {
          if (pair.value instanceof Uint8Array) {
            const copy = new Uint8Array(pair.value);
            await this.callWorker('saveBlob', { key: pair.key, data: copy }, [copy.buffer]);
          }
        }
        for (const folder of legacyFolders) {
          await this.callWorker('saveFolder', { folder });
        }
        for (const note of legacyNotes) {
          await this.callWorker('saveNote', { note });
        }
        if (legacySettings) {
          await this.callWorker('saveSettings', {
            settings: normalizeLoadedSettings(legacySettings),
          });
        }
        this.migratedFromV1 = true;
        logDiagnostic(
          'info',
          'storage.migration',
          `Migrated ${legacyNotes.length} notes and ${legacyFolders.length} folders from quire-local-v1 to SQLite OPFS`
        );
      }

      await this.callWorker('setMeta', { key: 'migrated_v1', value: true });
    } catch (err) {
      logDiagnostic('warn', 'storage.migration', 'Legacy v1 migration skipped/failed', err);
    }
  }

  async pauseForLockHandoff(): Promise<void> {
    if (this.backend === 'sqlite-opfs' && this.worker) {
      await this.callWorker('pause');
    }
  }

  async resumeAfterLockHandoff(): Promise<void> {
    if (this.backend === 'sqlite-opfs' && this.worker) {
      await this.callWorker('resume');
    }
  }

  async ensurePersistentStorage(): Promise<boolean> {
    if (this.persistRequested) return this.persistGranted;
    this.persistRequested = true;
    try {
      if (navigator.storage?.persist) {
        this.persistGranted = await navigator.storage.persist();
        return this.persistGranted;
      }
    } catch {
      // Ignore in non-supporting browsers
    }
    return false;
  }

  async getStorageHealth(): Promise<StorageHealth> {
    await this.init();
    let usageBytes = 0;
    let quotaBytes = 0;
    let persisted = this.persistGranted;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        usageBytes = est.usage ?? 0;
        quotaBytes = est.quota ?? 0;
      }
      if (navigator.storage?.persisted) {
        persisted = await navigator.storage.persisted();
      }
    } catch {
      // ignore
    }

    let noteCount = 0;
    let blobCount = 0;
    if (this.backend === 'sqlite-opfs') {
      const stats = await this.callWorker<{ noteCount: number; blobCount: number }>('getStats');
      noteCount = stats.noteCount;
      blobCount = stats.blobCount;
    } else {
      const all = await this.loadNoteSummaries();
      noteCount = all.filter((n) => !n.deletedAt).length;
    }

    return {
      backend: this.backend,
      privateModeWarning: this.privateModeWarning,
      persisted,
      usageBytes,
      quotaBytes,
      noteCount,
      blobCount,
      migratedFromV1: this.migratedFromV1,
    };
  }

  async saveBlob(key: string, data: Uint8Array | Blob): Promise<void> {
    await this.init();
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('saveBlob', { key, data: bytes }, [bytes.buffer]);
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      tx.objectStore(STORE_BLOBS).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async appendBlobChunk(key: string, chunk: Uint8Array | Blob): Promise<number> {
    await this.init();
    const bytes = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : new Uint8Array(chunk);
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<number>('appendBlobChunk', { key, data: bytes }, [bytes.buffer]);
    }
    const existing = this.fallbackAudioStreams.get(key) ?? [];
    existing.push(bytes);
    this.fallbackAudioStreams.set(key, existing);
    const totalLen = existing.reduce((sum, b) => sum + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of existing) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    await this.saveBlob(key, merged);
    return totalLen;
  }

  async finalizeBlobStream(key: string): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('finalizeBlobStream', { key });
      return;
    }
    this.fallbackAudioStreams.delete(key);
  }

  async loadBlob(key: string): Promise<Uint8Array | null> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<Uint8Array | null>('loadBlob', { key });
    }
    const db = await this.openLegacyDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const req = tx.objectStore(STORE_BLOBS).get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBlob(key: string): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('deleteBlob', { key });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      tx.objectStore(STORE_BLOBS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveThumbnail(pageId: string, bytes: Uint8Array): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      const copy = new Uint8Array(bytes);
      await this.callWorker('saveThumbnail', { pageId, data: copy }, [copy.buffer]);
      return;
    }
    this.fallbackThumbs.set(pageId, bytes);
  }

  async loadThumbnail(pageId: string): Promise<Uint8Array | null> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<Uint8Array | null>('loadThumbnail', { pageId });
    }
    return this.fallbackThumbs.get(pageId) ?? null;
  }

  async saveNote(note: NoteDocument, dirtyPageIds?: string[]): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('saveNote', { note, dirtyPageIds });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      tx.objectStore(STORE_NOTES).put(note);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveNoteMetadata(summary: NoteSummary): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('saveNoteMetadata', { summary });
      return;
    }
    const existing = await this.loadNote(summary.id);
    if (existing) {
      await this.saveNote({ ...existing, ...summary });
    }
  }

  async savePage(noteId: string, payload: PagePayload, compact = false): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('savePage', { noteId, payload, compact });
      return;
    }
    const existing = await this.loadNote(noteId);
    if (existing) {
      await this.saveNote({
        ...existing,
        strokesByPage: { ...existing.strokesByPage, [payload.pageId]: payload.strokes },
        textBoxesByPage: { ...existing.textBoxesByPage, [payload.pageId]: payload.textBoxes },
        imagesByPage: { ...existing.imagesByPage, [payload.pageId]: payload.images },
      });
    }
  }

  async updateAudioSessionCheckpoint(
    noteId: string,
    sessionId: string,
    durationMs: number,
    segments: AudioSession['segments']
  ): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('updateAudioSessionCheckpoint', {
        noteId,
        sessionId,
        durationMs,
        segments,
      });
      return;
    }
    const existing = await this.loadNote(noteId);
    if (existing) {
      await this.saveNote({
        ...existing,
        updatedAt: Date.now(),
        audioSessions: existing.audioSessions.map((s) =>
          s.id === sessionId ? { ...s, durationMs, segments } : s
        ),
      });
    }
  }

  async loadNoteSummaries(): Promise<NoteSummary[]> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<NoteSummary[]>('loadNoteSummaries');
    }
    const all = await this.loadAllNotes();
    return all.map(noteToSummary);
  }

  async loadNote(noteId: string): Promise<NoteDocument | null> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<NoteDocument | null>('loadNote', { noteId });
    }
    const db = await this.openLegacyDB();
    return await new Promise<NoteDocument | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const req = tx.objectStore(STORE_NOTES).get(noteId);
      req.onsuccess = () => resolve((req.result as NoteDocument) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async loadAllNotes(): Promise<NoteDocument[]> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<NoteDocument[]>('loadAllNotes');
    }
    const db = await this.openLegacyDB();
    const all = await new Promise<NoteDocument[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const req = tx.objectStore(STORE_NOTES).getAll();
      req.onsuccess = () => resolve((req.result as NoteDocument[]) ?? []);
      req.onerror = () => reject(req.error);
    });

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const expired = all.filter((n) => n.deletedAt && n.deletedAt < cutoff);
    for (const n of expired) {
      await this.hardDeleteNote(n.id);
    }
    return all.filter((n) => !n.deletedAt || n.deletedAt >= cutoff);
  }

  async hardDeleteNote(noteId: string): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('hardDeleteNote', { noteId });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      tx.objectStore(STORE_NOTES).delete(noteId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async searchNoteIds(query: string): Promise<string[] | null> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<string[] | null>('searchNoteIds', { query });
    }
    const [allNotes, allFolders] = await Promise.all([
      this.loadAllNotes(),
      this.loadAllFolders(),
    ]);
    return searchNotes(allNotes, allFolders, query).map((n) => n.id);
  }

  async runBlobGc(): Promise<number> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<number>('runBlobGc');
    }
    return 0;
  }

  async saveFolder(folder: Folder): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('saveFolder', { folder });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).put(folder);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadAllFolders(): Promise<Folder[]> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      return await this.callWorker<Folder[]>('loadAllFolders');
    }
    const db = await this.openLegacyDB();
    return await new Promise<Folder[]>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readonly');
      const req = tx.objectStore(STORE_FOLDERS).getAll();
      req.onsuccess = () => resolve((req.result as Folder[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('deleteFolder', { folderId });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).delete(folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSettings(): Promise<AppSettings> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      const stored = await this.callWorker<Record<string, unknown> | null>('loadSettings');
      return normalizeLoadedSettings(stored);
    }
    const db = await this.openLegacyDB();
    const stored = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get('settings');
      req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
      req.onerror = () => reject(req.error);
    });
    return normalizeLoadedSettings(stored);
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.init();
    if (this.backend === 'sqlite-opfs') {
      await this.callWorker('saveSettings', { settings });
      return;
    }
    const db = await this.openLegacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put({ ...settings, settingsVersion: 4 }, 'settings');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const quireStorage = new QuireStorage();

/**
 * Synchronous in-memory search helper (used when filtering hydrated notes or in unit tests).
 */
export function searchNotes<T extends NoteSummary & Partial<Pick<NoteDocument, 'textBoxesByPage'>>>(
  notes: T[],
  folders: Folder[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;

  const folderMap = new Map<string, string>();
  for (const f of folders) {
    folderMap.set(f.id, f.name.toLowerCase());
  }

  return notes.filter((note) => {
    if (note.title.toLowerCase().includes(q)) return true;
    if (note.tags.some((t) => t.toLowerCase().includes(q))) return true;
    if (note.folderId && folderMap.get(note.folderId)?.includes(q)) return true;
    if (note.textBoxesByPage) {
      for (const boxes of Object.values(note.textBoxesByPage)) {
        if (boxes.some((b) => b.plainText.toLowerCase().includes(q))) return true;
      }
    }
    return false;
  });
}

/**
 * Computes folder nesting depth (up to 5 levels).
 */
export function getFolderDepth(folderId: string | null, folders: Folder[]): number {
  let depth = 0;
  let curr = folderId;
  const seen = new Set<string>();
  while (curr && !seen.has(curr)) {
    seen.add(curr);
    const f = folders.find((item) => item.id === curr);
    if (!f) break;
    depth++;
    curr = f.parentId;
  }
  return depth;
}

/**
 * Returns a folder and all of its nested descendant folder IDs.
 */
export function getDescendantFolderIds(rootFolderId: string, folders: Folder[]): string[] {
  const result: string[] = [rootFolderId];
  const queue: string[] = [rootFolderId];
  const seen = new Set<string>([rootFolderId]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const f of folders) {
      if (f.parentId === parent && !seen.has(f.id)) {
        seen.add(f.id);
        result.push(f.id);
        queue.push(f.id);
      }
    }
  }
  return result;
}
