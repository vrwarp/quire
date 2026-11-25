import type { AppSettings, Folder, NoteDocument, PageDescriptor } from '../types';
import { generateOrderKey } from './inkMath';

/**
 * Local-First Storage Engine (OPFS + IndexedDB Dual-Backed Persistence).
 *
 * - Binary assets (imported PDFs, cropped images, 10s-flushed .m4a/.webm audio tracks)
 *   are stored in Origin Private File System (OPFS) under `/quire/blobs/{key}` when available,
 *   with automatic IndexedDB fallback for environments where OPFS is unavailable.
 * - Catalog metadata (folders, notes, tags, settings) persists in IndexedDB for instant
 *   atomic commits and <10ms full-text search across 500+ notes.
 * - Requests `navigator.storage.persist()` on first write to protect against Safari ITP eviction.
 */

const DB_NAME = 'quire-local-v1';
const DB_VERSION = 1;
const STORE_NOTES = 'notes';
const STORE_FOLDERS = 'folders';
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';

export const DEFAULT_SETTINGS: AppSettings = {
  hasCompletedOnboarding: false,
  defaultTemplate: 'lined',
  defaultPaperTheme: 'cream',
  defaultScrollDirection: 'vertical',
  darkMode: false,
  toolbarDock: 'top',
  fingerDrawMode: true,
  scribbleEraseEnabled: true,
  audioPreRollMs: 2000,
  penColorPresets: ['#18181b', '#c85a32', '#1d4ed8', '#15803d', '#7c2d12', '#475569'],
  highlighterColorPresets: ['#facc15', '#4ade80', '#60a5fa', '#fb7185', '#f59e0b', '#a78bfa'],
  backup: {
    provider: 'none',
    connectedAccount: null,
    destinationFolder: '/Quire Backups',
    format: 'pdf',
    wifiOnly: true,
    lastBackupAt: null,
    status: 'idle',
  },
  sync: {
    enabled: false,
    accountEmail: null,
    lastSyncedAt: null,
    status: 'local-only',
  },
  pro: {
    isPro: false,
    purchasedAt: null,
    receiptId: null,
    freeNoteLimit: 5,
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
    widthPt: 612, // Standard US Letter width in pt
    heightPt: 792, // Standard US Letter height in pt
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

class QuireStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private persistRequested = false;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    return this.dbPromise;
  }

  async ensurePersistentStorage(): Promise<boolean> {
    if (this.persistRequested) return true;
    this.persistRequested = true;
    try {
      if (navigator.storage?.persist) {
        return await navigator.storage.persist();
      }
    } catch {
      // Ignore in non-supporting browsers
    }
    return false;
  }

  private async getOpfsBlobDir(): Promise<FileSystemDirectoryHandle | null> {
    try {
      if (!navigator.storage?.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      const quireDir = await root.getDirectoryHandle('quire', { create: true });
      return await quireDir.getDirectoryHandle('blobs', { create: true });
    } catch {
      return null;
    }
  }

  async saveBlob(key: string, data: Uint8Array | Blob): Promise<void> {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    await this.ensurePersistentStorage();

    // Primary: OPFS
    const dir = await this.getOpfsBlobDir();
    if (dir) {
      try {
        const handle = await dir.getFileHandle(key, { create: true });
        if ('createWritable' in handle) {
          const writable = await handle.createWritable();
          await writable.write(new Uint8Array(bytes));
          await writable.close();
          return;
        }
      } catch {
        // Fallback to IndexedDB below
      }
    }

    // Fallback: IndexedDB
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      tx.objectStore(STORE_BLOBS).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadBlob(key: string): Promise<Uint8Array | null> {
    const dir = await this.getOpfsBlobDir();
    if (dir) {
      try {
        const handle = await dir.getFileHandle(key);
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        // Check IndexedDB fallback
      }
    }

    const db = await this.openDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const req = tx.objectStore(STORE_BLOBS).get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBlob(key: string): Promise<void> {
    const dir = await this.getOpfsBlobDir();
    if (dir) {
      try {
        await dir.removeEntry(key);
      } catch {
        // ignore
      }
    }
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      tx.objectStore(STORE_BLOBS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveNote(note: NoteDocument): Promise<void> {
    await this.ensurePersistentStorage();
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      tx.objectStore(STORE_NOTES).put(note);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadAllNotes(): Promise<NoteDocument[]> {
    const db = await this.openDB();
    const all = await new Promise<NoteDocument[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const req = tx.objectStore(STORE_NOTES).getAll();
      req.onsuccess = () => resolve((req.result as NoteDocument[]) ?? []);
      req.onerror = () => reject(req.error);
    });

    // Auto-purge notes in Recently Deleted older than 30 days (FR-ORG-02)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const expired = all.filter((n) => n.deletedAt && n.deletedAt < cutoff);
    for (const n of expired) {
      await this.hardDeleteNote(n.id);
    }
    return all.filter((n) => !n.deletedAt || n.deletedAt >= cutoff);
  }

  async hardDeleteNote(noteId: string): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      tx.objectStore(STORE_NOTES).delete(noteId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveFolder(folder: Folder): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).put(folder);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadAllFolders(): Promise<Folder[]> {
    const db = await this.openDB();
    return await new Promise<Folder[]>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readonly');
      const req = tx.objectStore(STORE_FOLDERS).getAll();
      req.onsuccess = () => resolve((req.result as Folder[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteFolder(folderId: string): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).delete(folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSettings(): Promise<AppSettings> {
    const db = await this.openDB();
    const stored = await new Promise<Partial<AppSettings> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get('settings');
      req.onsuccess = () => resolve(req.result as Partial<AppSettings> | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!stored) return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      backup: { ...DEFAULT_SETTINGS.backup, ...(stored.backup ?? {}) },
      sync: { ...DEFAULT_SETTINGS.sync, ...(stored.sync ?? {}) },
      pro: { ...DEFAULT_SETTINGS.pro, ...(stored.pro ?? {}) },
    };
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(settings, 'settings');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const quireStorage = new QuireStorage();

/**
 * Fast local search across note titles, folder names, tags, and typed text boxes (FR-ORG-04).
 * Designed to execute in <10ms across 500+ notes.
 */
export function searchNotes(
  notes: NoteDocument[],
  folders: Folder[],
  query: string
): NoteDocument[] {
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
    for (const boxes of Object.values(note.textBoxesByPage)) {
      if (boxes.some((b) => b.plainText.toLowerCase().includes(q))) return true;
    }
    return false;
  });
}

/**
 * Computes folder nesting depth (PRD allows up to 5 levels).
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
