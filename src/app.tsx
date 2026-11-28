import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  FileText,
  FolderInput,
  Grid,
  List,
  Menu,
  Mic,
  RotateCcw,
  Square,
  Star,
  Trash2,
} from 'lucide-preact';
import type {
  AppSettings,
  Folder,
  NoteDocument,
  NoteSummary,
  PageDescriptor,
  PaperTemplate,
  PaperTheme,
  StorageHealth,
} from './types';
import {
  DEFAULT_SETTINGS,
  createBlankPage,
  createId,
  createNewNote,
  getDescendantFolderIds,
  noteToSummary,
  quireStorage,
  searchNotes,
} from './engine/storage';
import { generateOrderKey } from './engine/inkMath';
import { pdfEngine } from './engine/pdfEngine';
import { getPaperTemplateSvgDataUri } from './engine/paperTemplate';
import { tickHLC } from './engine/syncEngine';
import {
  applyDocumentTheme,
  getSystemPrefersDark,
  nextThemeMode,
  resolveEffectivePaperTheme,
  resolveThemeMode,
} from './engine/theme';
import { AudioSyncRecorder, formatDuration, type RecordingState } from './engine/audio';
import { WindowLockCoordinator } from './engine/windowLock';
import { getCachedThumbUrl, loadThumbUrl } from './engine/thumbnails';
import {
  attachOsFileHandlers,
  registerQuireServiceWorker,
  type PwaUpdateController,
} from './engine/pwa';
import { logDiagnostic } from './engine/diagnostics';
import { LibrarySidebar, type LibraryFilter } from './components/LibrarySidebar';
import { NoteEditor } from './components/NoteEditor';
import {
  ConfirmModal,
  ExportModal,
  PageManagerModal,
  PasswordModal,
  SettingsModal,
  WelcomeSheet,
} from './components/Modals';

type SortKey = 'updatedAt' | 'createdAt' | 'title';

function parseNoteIdFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#\/note\/([a-zA-Z0-9_-]+)$/);
  return match ? match[1] : null;
}

export function App() {
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [noteSummaries, setNoteSummaries] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<NoteDocument | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filter, setFilter] = useState<LibraryFilter>({ kind: 'all' });
  const [searchQuery, setSearchQuery] = useState('');
  const [ftsMatchedIds, setFtsMatchedIds] = useState<Set<string> | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');

  const [pageManagerPageIdx, setPageManagerPageIdx] = useState<number | null>(null);
  const [exportPageIdx, setExportPageIdx] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpToPageRequest, setJumpToPageRequest] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [moveMenuNoteId, setMoveMenuNoteId] = useState<string | null>(null);

  // Single-active-window OPFS lock overlay
  const [pausedByOtherTab, setPausedByOtherTab] = useState(false);
  const lockCoordinatorRef = useRef<WindowLockCoordinator | null>(null);

  // PWA safe update prompt
  const [pwaUpdate, setPwaUpdate] = useState<PwaUpdateController | null>(null);

  // Accessible Password & Confirm modals
  const [passwordPrompt, setPasswordPrompt] = useState<{
    file: File;
    bytes: Uint8Array;
    errorMessage: string | null;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  // App-level persistent audio recorder (never drops mic when navigating to Library / other notes)
  const audioRecorderRef = useRef<AudioSyncRecorder | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [recordingNoteId, setRecordingNoteId] = useState<string | null>(null);
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);

  // Optional Chromium local backup folder handle (in-memory for current session)
  const localBackupDirRef = useRef<FileSystemDirectoryHandle | null>(null);

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number>(0);
  const activeNoteRef = useRef<NoteDocument | null>(null);
  activeNoteRef.current = activeNote;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const noteSummariesRef = useRef<NoteSummary[]>(noteSummaries);
  noteSummariesRef.current = noteSummaries;

  const showToast = useCallback((msg: string, durationMs = 3200) => {
    setToast(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
  }, []);

  const refreshStorageHealth = useCallback(async () => {
    try {
      const h = await quireStorage.getStorageHealth();
      setStorageHealth(h);
    } catch {
      // ignore
    }
  }, []);

  const pendingSavesRef = useRef<
    Map<string, { note: NoteDocument; dirtyPageIds?: Set<string>; timer: number }>
  >(new Map());

  const flushPendingSaves = useCallback(() => {
    for (const [id, entry] of pendingSavesRef.current.entries()) {
      window.clearTimeout(entry.timer);
      pendingSavesRef.current.delete(id);
      const dirty = entry.dirtyPageIds ? [...entry.dirtyPageIds] : undefined;
      void quireStorage.saveNote(entry.note, dirty);
    }
  }, []);

  const cancelPendingSave = useCallback((noteId: string) => {
    const existing = pendingSavesRef.current.get(noteId);
    if (existing) {
      window.clearTimeout(existing.timer);
      pendingSavesRef.current.delete(noteId);
    }
  }, []);

  const openNoteById = useCallback(
    async (noteId: string | null, pushHistory = true) => {
      flushPendingSaves();
      if (!noteId) {
        setActiveNoteId(null);
        setActiveNote(null);
        setSidebarCollapsed(false);
        if (pushHistory && typeof window !== 'undefined' && window.location.hash.startsWith('#/note/')) {
          window.history.pushState(null, '', window.location.pathname + window.location.search);
        }
        if (settingsRef.current.lastOpenedNoteId !== null) {
          const nextSettings = { ...settingsRef.current, lastOpenedNoteId: null };
          setSettings(nextSettings);
          void quireStorage.saveSettings(nextSettings);
        }
        return;
      }

      const loaded = await quireStorage.loadNote(noteId);
      if (!loaded || loaded.deletedAt) {
        setActiveNoteId(null);
        setActiveNote(null);
        return;
      }
      setActiveNoteId(loaded.id);
      setActiveNote(loaded);
      setSidebarCollapsed(true);
      if (pushHistory && typeof window !== 'undefined') {
        const nextHash = `#/note/${loaded.id}`;
        if (window.location.hash !== nextHash) {
          window.history.pushState({ noteId: loaded.id }, '', nextHash);
        }
      }
      if (settingsRef.current.lastOpenedNoteId !== loaded.id) {
        const nextSettings = { ...settingsRef.current, lastOpenedNoteId: loaded.id };
        setSettings(nextSettings);
        void quireStorage.saveSettings(nextSettings);
      }
    },
    [flushPendingSaves]
  );

  // Hydrate SQLite/OPFS StorageSyncWorker + WindowLockCoordinator on cold launch
  useEffect(() => {
    let mounted = true;
    const coordinator = new WindowLockCoordinator({
      onYieldLock: async () => {
        if (mounted) setPausedByOtherTab(true);
        flushPendingSaves();
        await quireStorage.pauseForLockHandoff();
      },
      onResumeLock: async () => {
        await quireStorage.resumeAfterLockHandoff();
        const [loadedSettings, loadedSummaries, loadedFolders] = await Promise.all([
          quireStorage.loadSettings(),
          quireStorage.loadNoteSummaries(),
          quireStorage.loadAllFolders(),
        ]);
        if (!mounted) return;
        setSettings(loadedSettings);
        setNoteSummaries(loadedSummaries);
        setFolders(loadedFolders);
        if (activeNoteRef.current) {
          const refreshed = await quireStorage.loadNote(activeNoteRef.current.id);
          if (mounted) setActiveNote(refreshed);
        }
        setPausedByOtherTab(false);
      },
    });
    lockCoordinatorRef.current = coordinator;

    void (async () => {
      await coordinator.claimOwnership();
      await quireStorage.init();
      const [loadedSettings, loadedSummaries, loadedFolders, health] = await Promise.all([
        quireStorage.loadSettings(),
        quireStorage.loadNoteSummaries(),
        quireStorage.loadAllFolders(),
        quireStorage.getStorageHealth(),
      ]);
      if (!mounted) return;
      setSettings(loadedSettings);
      setNoteSummaries(loadedSummaries);
      setFolders(loadedFolders);
      setStorageHealth(health);
      setHydrated(true);

      // Restore note from URL hash or lastOpenedNoteId
      const hashNoteId = parseNoteIdFromHash();
      const targetId = hashNoteId ?? (loadedSettings.hasCompletedOnboarding ? loadedSettings.lastOpenedNoteId : null);
      if (targetId && loadedSummaries.some((n) => n.id === targetId && !n.deletedAt)) {
        const doc = await quireStorage.loadNote(targetId);
        if (mounted && doc && !doc.deletedAt) {
          setActiveNoteId(doc.id);
          setActiveNote(doc);
          setSidebarCollapsed(true);
        }
      }
    })();

    return () => {
      mounted = false;
      coordinator.dispose();
    };
  }, [flushPendingSaves]);

  // History popstate listener (supports iPadOS swipe-back & browser Back/Forward)
  useEffect(() => {
    const onPopState = () => {
      const id = parseNoteIdFromHash();
      void openNoteById(id, false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openNoteById]);

  // Register Workbox Service Worker with safe update prompt
  useEffect(() => {
    registerQuireServiceWorker((controller) => {
      setPwaUpdate(controller);
    });
  }, []);

  // Load cached thumbnails for visible library notes
  useEffect(() => {
    if (!hydrated || activeNoteId) return;
    let active = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const n of noteSummaries.slice(0, 48)) {
        const firstPageId = n.pages[0]?.pageId;
        if (!firstPageId) continue;
        const url = getCachedThumbUrl(firstPageId) ?? (await loadThumbUrl(firstPageId));
        if (url) next[firstPageId] = url;
      }
      if (active && Object.keys(next).length > 0) {
        setThumbUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      active = false;
    };
  }, [hydrated, activeNoteId, noteSummaries]);

  // SQLite FTS5 async search across titles, folders, tags, and typed text boxes (<5ms)
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setFtsMatchedIds(null);
      return;
    }
    let cancelled = false;
    void quireStorage.searchNoteIds(q).then((ids) => {
      if (!cancelled) {
        setFtsMatchedIds(ids ? new Set(ids) : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [searchQuery]);

  // App-level recording elapsed timer
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = window.setInterval(() => {
      if (audioRecorderRef.current) {
        setRecordingElapsedMs(audioRecorderRef.current.getElapsedMs());
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [recordingState]);

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    setSystemPrefersDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = resolveThemeMode(settings.themeMode, systemPrefersDark);

  useLayoutEffect(() => {
    if (!hydrated) return;
    applyDocumentTheme(resolvedTheme, settings.themeMode);
  }, [hydrated, resolvedTheme, settings.themeMode]);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    void quireStorage.saveSettings(next);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPendingSaves();
    };
    window.addEventListener('pagehide', flushPendingSaves);
    window.addEventListener('beforeunload', flushPendingSaves);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      flushPendingSaves();
      window.removeEventListener('pagehide', flushPendingSaves);
      window.removeEventListener('beforeunload', flushPendingSaves);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPendingSaves]);

  const persistNote = useCallback(
    (updated: NoteDocument, dirtyPageIds?: string[], immediate = false) => {
      const withHlc: NoteDocument = {
        ...updated,
        hlc: tickHLC(updated.hlc),
      };
      const summary = noteToSummary(withHlc);
      setNoteSummaries((prev) => {
        const exists = prev.some((n) => n.id === summary.id);
        return exists ? prev.map((n) => (n.id === summary.id ? summary : n)) : [summary, ...prev];
      });
      if (activeNoteRef.current?.id === withHlc.id) {
        setActiveNote(withHlc);
      }

      const prevEntry = pendingSavesRef.current.get(withHlc.id);
      const mergedDirty = prevEntry?.dirtyPageIds ? new Set(prevEntry.dirtyPageIds) : new Set<string>();
      if (dirtyPageIds && dirtyPageIds.length > 0) {
        dirtyPageIds.forEach((pid) => mergedDirty.add(pid));
      } else {
        mergedDirty.clear();
      }
      if (prevEntry) {
        window.clearTimeout(prevEntry.timer);
        pendingSavesRef.current.delete(withHlc.id);
      }

      if (immediate) {
        void quireStorage.saveNote(withHlc, mergedDirty.size > 0 ? [...mergedDirty] : undefined);
        return;
      }

      const timer = window.setTimeout(() => {
        pendingSavesRef.current.delete(withHlc.id);
        void quireStorage.saveNote(withHlc, mergedDirty.size > 0 ? [...mergedDirty] : undefined);
      }, 180);
      pendingSavesRef.current.set(withHlc.id, {
        note: withHlc,
        dirtyPageIds: mergedDirty.size > 0 ? mergedDirty : undefined,
        timer,
      });
    },
    []
  );

  const persistSummaryOnly = useCallback((summary: NoteSummary) => {
    const withHlc: NoteSummary = { ...summary, hlc: tickHLC(summary.hlc) };
    setNoteSummaries((prev) => prev.map((n) => (n.id === withHlc.id ? withHlc : n)));
    if (activeNoteRef.current?.id === withHlc.id) {
      setActiveNote((prev) => (prev ? { ...prev, ...withHlc } : prev));
    }
    void quireStorage.saveNoteMetadata(withHlc);
  }, []);

  // App-level Audio Recording handlers (survive navigation across Library & other notes)
  const handleToggleRecording = useCallback(
    async (noteId: string): Promise<string | null> => {
      if (recordingState === 'idle') {
        const target =
          activeNoteRef.current?.id === noteId
            ? activeNoteRef.current
            : await quireStorage.loadNote(noteId);
        if (!target) return null;
        try {
          const rec = new AudioSyncRecorder({
            onInterruption: (reason) => {
              setRecordingState('paused');
              showToast(reason);
            },
            onCheckpoint: (durationMs, segments) => {
              setNoteSummaries((prev) =>
                prev.map((n) =>
                  n.id === noteId
                    ? {
                        ...n,
                        audioSessions: n.audioSessions.map((s) =>
                          s.id === rec.activeSessionId ? { ...s, durationMs, segments } : s
                        ),
                      }
                    : n
                )
              );
              if (activeNoteRef.current?.id === noteId) {
                setActiveNote((prev) =>
                  prev
                    ? {
                        ...prev,
                        audioSessions: prev.audioSessions.map((s) =>
                          s.id === rec.activeSessionId ? { ...s, durationMs, segments } : s
                        ),
                      }
                    : prev
                );
              }
            },
          });
          const session = await rec.start(target.audioSessions.length, noteId);
          audioRecorderRef.current = rec;
          setRecordingState('recording');
          setRecordingNoteId(noteId);
          setRecordingSessionId(session.id);
          setRecordingElapsedMs(0);
          persistNote(
            {
              ...target,
              updatedAt: Date.now(),
              audioSessions: [...target.audioSessions, session],
            },
            undefined,
            true
          );
          return session.id;
        } catch (err) {
          showToast(`Microphone unavailable: ${(err as Error).message}`);
          return null;
        }
      } else if (recordingState === 'recording') {
        audioRecorderRef.current?.pause();
        setRecordingState('paused');
        return null;
      } else {
        audioRecorderRef.current?.resume();
        setRecordingState('recording');
        return null;
      }
    },
    [recordingState, persistNote, showToast]
  );

  const handleStopRecording = useCallback(async () => {
    const rec = audioRecorderRef.current;
    if (!rec) return;
    const sid = rec.activeSessionId;
    const nid = rec.activeNoteId;
    const { durationMs, segments } = await rec.stop();
    audioRecorderRef.current = null;
    setRecordingState('idle');
    setRecordingNoteId(null);
    setRecordingSessionId(null);
    setRecordingElapsedMs(0);

    if (sid && nid) {
      const target =
        activeNoteRef.current?.id === nid
          ? activeNoteRef.current
          : await quireStorage.loadNote(nid);
      if (target) {
        persistNote(
          {
            ...target,
            updatedAt: Date.now(),
            audioSessions: target.audioSessions.map((s) =>
              s.id === sid ? { ...s, durationMs, segments } : s
            ),
          },
          undefined,
          true
        );
      }
    }
    showToast(`Saved audio recording (${formatDuration(durationMs)})`);
  }, [persistNote, showToast]);

  const activeNotes = useMemo(() => noteSummaries.filter((n) => !n.deletedAt), [noteSummaries]);

  const handleCompleteOnboarding = (prefs: {
    template: PaperTemplate;
    theme: PaperTheme;
    scrollDirection: AppSettings['defaultScrollDirection'];
  }) => {
    const firstNote = createNewNote(
      {
        ...settings,
        defaultTemplate: prefs.template,
        defaultPaperTheme: prefs.theme,
        defaultScrollDirection: prefs.scrollDirection,
      },
      null
    );
    const nextSettings: AppSettings = {
      ...settings,
      hasCompletedOnboarding: true,
      defaultTemplate: prefs.template,
      defaultPaperTheme: prefs.theme,
      defaultScrollDirection: prefs.scrollDirection,
      lastOpenedNoteId: firstNote.id,
    };
    updateSettings(nextSettings);
    persistNote(firstNote, undefined, true);
    setActiveNoteId(firstNote.id);
    setActiveNote(firstNote);
    setSidebarCollapsed(true);
    window.history.replaceState({ noteId: firstNote.id }, '', `#/note/${firstNote.id}`);
  };

  const handleCreateNote = () => {
    const targetFolder = filter.kind === 'folder' ? filter.folderId : null;
    const fresh = createNewNote(settings, targetFolder);
    persistNote(fresh, undefined, true);
    setActiveNoteId(fresh.id);
    setActiveNote(fresh);
    setSidebarCollapsed(true);
    window.history.pushState({ noteId: fresh.id }, '', `#/note/${fresh.id}`);
    updateSettings({ ...settings, lastOpenedNoteId: fresh.id });
  };

  const finalizePdfImport = useCallback(
    async (bytes: Uint8Array, fileName: string, password?: string) => {
      const result = await pdfEngine.importPdfBytes(bytes, fileName, password);
      const targetFolder = filter.kind === 'folder' ? filter.folderId : null;
      const baseTitle = fileName.replace(/\.pdf$/i, '');
      const now = Date.now();
      const strokesByPage: NoteDocument['strokesByPage'] = {};
      const textBoxesByPage: NoteDocument['textBoxesByPage'] = {};
      const imagesByPage: NoteDocument['imagesByPage'] = {};
      for (const p of result.pages) {
        strokesByPage[p.pageId] = [];
        textBoxesByPage[p.pageId] = [];
        imagesByPage[p.pageId] = [];
      }
      const pdfNote: NoteDocument = {
        id: createId('note'),
        title: baseTitle,
        folderId: targetFolder,
        tags: ['pdf'],
        isFavorite: false,
        scrollDirection: settingsRef.current.defaultScrollDirection,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        pages: result.pages,
        strokesByPage,
        textBoxesByPage,
        imagesByPage,
        audioSessions: [],
        hlc: { ts: now, counter: 0, deviceId: 'local' },
      };
      persistNote(pdfNote, undefined, true);
      setActiveNoteId(pdfNote.id);
      setActiveNote(pdfNote);
      setSidebarCollapsed(true);
      window.history.pushState({ noteId: pdfNote.id }, '', `#/note/${pdfNote.id}`);
      showToast(
        `Imported ${result.pageCount}-page PDF "${baseTitle}"${
          result.wasEncryptedUnlocked ? ' (unlocked locally)' : ''
        }`
      );
      void refreshStorageHealth();
    },
    [filter, persistNote, showToast, refreshStorageHealth]
  );

  const handleImportFile = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith('.quire')) {
        try {
          const { importQuireArchive } = await import('./engine/exportEngine');
          const summary = await importQuireArchive(bytes);
          const [loadedSummaries, loadedFolders] = await Promise.all([
            quireStorage.loadNoteSummaries(),
            quireStorage.loadAllFolders(),
          ]);
          setNoteSummaries(loadedSummaries);
          setFolders(loadedFolders);
          const first = summary.importedNotes[0];
          if (summary.kind === 'single-note' && first) {
            setActiveNoteId(first.id);
            setActiveNote(first);
            setSidebarCollapsed(true);
          }
          const conflictMsg =
            summary.conflictCopies.length > 0
              ? ` (${summary.conflictCopies.length} conflict ${
                  summary.conflictCopies.length === 1 ? 'copy' : 'copies'
                } preserved)`
              : '';
          showToast(
            summary.kind === 'full-library'
              ? `Restored ${summary.importedNotes.length} notes & ${summary.importedFolders.length} folders${conflictMsg}`
              : `Restored "${first?.title ?? 'Note'}"${conflictMsg}`
          );
          void refreshStorageHealth();
        } catch (err) {
          logDiagnostic('error', 'import', 'Failed to import .quire archive', err);
          showToast(`Failed to import .quire: ${(err as Error).message}`);
        }
        return;
      }

      try {
        await finalizePdfImport(bytes, file.name);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.toLowerCase().includes('password')) {
          setPasswordPrompt({ file, bytes, errorMessage: null });
        } else {
          logDiagnostic('error', 'import', `Failed to open PDF ${file.name}`, err);
          showToast(`Could not open PDF: ${msg}`);
        }
      }
    },
    [finalizePdfImport, showToast, refreshStorageHealth]
  );

  // Attach OS `launchQueue` (`file_handlers`) & SW `POST ?share-target=1` handlers once hydrated
  useEffect(() => {
    if (!hydrated) return;
    attachOsFileHandlers((file) => {
      void handleImportFile(file);
    });
  }, [hydrated, handleImportFile]);

  // Folder CRUD (FR-ORG-02) with recursive subfolder deletion
  const handleCreateFolder = (name: string, parentId: string | null, color: string) => {
    const folder: Folder = {
      id: createId('fld'),
      name,
      parentId,
      color,
      createdAt: Date.now(),
      deletedAt: null,
    };
    setFolders((prev) => [...prev, folder]);
    void quireStorage.saveFolder(folder);
    showToast(`Created folder "${name}"`);
  };

  const handleRenameFolder = (folderId: string, newName: string) => {
    const target = folders.find((f) => f.id === folderId);
    if (!target) return;
    const updated = { ...target, name: newName };
    setFolders((prev) => prev.map((f) => (f.id === folderId ? updated : f)));
    void quireStorage.saveFolder(updated);
    showToast(`Renamed folder to "${newName}"`);
  };

  const handleDeleteFolder = (folderId: string) => {
    const target = folders.find((f) => f.id === folderId);
    if (!target) return;
    const allIds = new Set(getDescendantFolderIds(folderId, folders));
    const affectedNotes = activeNotes.filter((n) => n.folderId && allIds.has(n.folderId));
    const subCount = allIds.size - 1;

    setConfirmDialog({
      title: `Delete folder "${target.name}"?`,
      message: `This will remove ${
        subCount > 0 ? `this folder, ${subCount} subfolder${subCount === 1 ? '' : 's'}, ` : 'this folder '
      }and move ${affectedNotes.length} note${affectedNotes.length === 1 ? '' : 's'} to Recently Deleted (30-day retention).`,
      confirmLabel: 'Delete Folder',
      onConfirm: () => {
        const now = Date.now();
        affectedNotes.forEach((n) => persistSummaryOnly({ ...n, deletedAt: now }));
        setFolders((prev) => prev.filter((f) => !allIds.has(f.id)));
        allIds.forEach((fid) => void quireStorage.deleteFolder(fid));
        if (filter.kind === 'folder' && allIds.has(filter.folderId)) {
          setFilter({ kind: 'all' });
        }
        setConfirmDialog(null);
        showToast(
          `Deleted folder (${affectedNotes.length} note${affectedNotes.length === 1 ? '' : 's'} moved to Recently Deleted)`
        );
      },
    });
  };

  // Page Manager actions (FR-PDF-04, FR-INK-07)
  const handleInsertPageAfter = (
    index: number,
    template: PaperTemplate,
    theme: PaperTheme
  ) => {
    if (!activeNote) return;
    const prevKey = activeNote.pages[index]?.orderKey ?? null;
    const nextKey = activeNote.pages[index + 1]?.orderKey ?? null;
    const newPage = createBlankPage(template, theme, generateOrderKey(prevKey, nextKey));
    const nextPages = [...activeNote.pages];
    nextPages.splice(index + 1, 0, newPage);
    persistNote(
      {
        ...activeNote,
        updatedAt: Date.now(),
        pages: nextPages,
        strokesByPage: { ...activeNote.strokesByPage, [newPage.pageId]: [] },
        textBoxesByPage: { ...activeNote.textBoxesByPage, [newPage.pageId]: [] },
        imagesByPage: { ...activeNote.imagesByPage, [newPage.pageId]: [] },
      },
      [newPage.pageId],
      true
    );
    showToast(`Inserted ${template} page after Page ${index + 1}`);
  };

  const handleDuplicatePage = (index: number) => {
    if (!activeNote) return;
    const src = activeNote.pages[index];
    if (!src) return;
    const copyId = createId('pg');
    const copyPage: PageDescriptor = {
      ...structuredClone(src),
      pageId: copyId,
      orderKey: generateOrderKey(src.orderKey, activeNote.pages[index + 1]?.orderKey ?? null),
    };
    const nextPages = [...activeNote.pages];
    nextPages.splice(index + 1, 0, copyPage);
    persistNote(
      {
        ...activeNote,
        updatedAt: Date.now(),
        pages: nextPages,
        strokesByPage: {
          ...activeNote.strokesByPage,
          [copyId]: structuredClone(activeNote.strokesByPage[src.pageId] ?? []).map((s) => ({
            ...s,
            id: createId('str'),
            pageId: copyId,
          })),
        },
        textBoxesByPage: {
          ...activeNote.textBoxesByPage,
          [copyId]: structuredClone(activeNote.textBoxesByPage[src.pageId] ?? []).map((b) => ({
            ...b,
            id: createId('txt'),
            pageId: copyId,
          })),
        },
        imagesByPage: {
          ...activeNote.imagesByPage,
          [copyId]: structuredClone(activeNote.imagesByPage[src.pageId] ?? []).map((i) => ({
            ...i,
            id: createId('img'),
            pageId: copyId,
          })),
        },
      },
      [copyId],
      true
    );
  };

  const handleMovePage = (fromIndex: number, toIndex: number) => {
    if (!activeNote || toIndex < 0 || toIndex >= activeNote.pages.length) return;
    const nextPages = [...activeNote.pages];
    const [moved] = nextPages.splice(fromIndex, 1);
    nextPages.splice(toIndex, 0, moved);
    persistNote({ ...activeNote, updatedAt: Date.now(), pages: nextPages }, undefined, true);
  };

  const handleDeletePage = (index: number) => {
    if (!activeNote || activeNote.pages.length <= 1) return;
    setConfirmDialog({
      title: `Delete Page ${index + 1}?`,
      message: 'This removes the page and any ink or text boxes drawn on it.',
      confirmLabel: 'Delete Page',
      onConfirm: () => {
        const cur = activeNoteRef.current;
        if (!cur || cur.pages.length <= 1) return;
        const nextPages = cur.pages.filter((_, i) => i !== index);
        persistNote({ ...cur, updatedAt: Date.now(), pages: nextPages }, undefined, true);
        setConfirmDialog(null);
      },
    });
  };

  const handleChangePageTemplate = (
    index: number,
    template: PaperTemplate,
    theme: PaperTheme,
    applyToAll: boolean
  ) => {
    if (!activeNote) return;
    const nextPages = activeNote.pages.map((p, i) => {
      if (!applyToAll && i !== index) return p;
      if (p.source.kind === 'pdf') return p;
      return {
        ...p,
        source: { kind: 'template' as const, template, theme },
      };
    });
    persistNote({ ...activeNote, updatedAt: Date.now(), pages: nextPages }, undefined, true);
    showToast(
      applyToAll
        ? `Applied ${template} template to all template pages`
        : `Switched Page ${index + 1} to ${template} paper`
    );
  };

  // Full-Library Backup / Restore & Chromium local-folder auto-backup
  const handleExportFullBackup = async (preferShare: boolean) => {
    try {
      flushPendingSaves();
      const {
        exportFullLibraryBackup,
        shareOrDownloadFile,
        writeBytesToDirectoryHandle,
      } = await import('./engine/exportEngine');
      const bytes = await exportFullLibraryBackup();
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `Quire_Library_Backup_${stamp}.quire`;

      if (localBackupDirRef.current && !preferShare) {
        try {
          await writeBytesToDirectoryHandle(localBackupDirRef.current, fileName, bytes);
          updateSettings({
            ...settingsRef.current,
            backup: { ...settingsRef.current.backup, lastBackupAt: Date.now() },
          });
          showToast(`Saved full backup to ${settingsRef.current.backup.localFolderName}/${fileName}`);
          return;
        } catch {
          // Fall back to regular download if permission expired
        }
      }

      await shareOrDownloadFile(bytes, fileName, 'application/zip', preferShare);
      updateSettings({
        ...settingsRef.current,
        backup: { ...settingsRef.current.backup, lastBackupAt: Date.now() },
      });
      showToast(`Exported Full-Library Backup (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      logDiagnostic('error', 'backup', 'Full-library backup failed', err);
      showToast(`Backup failed: ${(err as Error).message}`);
    }
  };

  const handlePickLocalBackupFolder = async () => {
    try {
      const picker = (
        window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker;
      if (!picker) return;
      const handle = await picker();
      localBackupDirRef.current = handle;
      updateSettings({
        ...settingsRef.current,
        backup: {
          ...settingsRef.current.backup,
          localFolderName: handle.name,
          autoBackupLocalFolder: true,
        },
      });
      showToast(`Local backup folder set to "${handle.name}"`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        showToast(`Could not select folder: ${(err as Error).message}`);
      }
    }
  };

  const backupOverdue = useMemo(() => {
    const days = settings.backup.reminderIntervalDays;
    if (!days || activeNotes.length === 0) return false;
    const last = settings.backup.lastBackupAt;
    if (!last) return activeNotes.length >= 3;
    return Date.now() - last > days * 24 * 60 * 60 * 1000;
  }, [settings.backup.reminderIntervalDays, settings.backup.lastBackupAt, activeNotes.length]);

  const visibleLibraryNotes = useMemo(() => {
    let base: NoteSummary[];
    if (filter.kind === 'trash') {
      base = noteSummaries.filter((n) => !!n.deletedAt);
    } else {
      base = activeNotes;
      if (filter.kind === 'favorites') {
        base = base.filter((n) => n.isFavorite);
      } else if (filter.kind === 'folder') {
        base = base.filter((n) => n.folderId === filter.folderId);
      } else if (filter.kind === 'tag') {
        base = base.filter((n) => n.tags.includes(filter.tag));
      }
    }

    const searched =
      searchQuery.trim() && ftsMatchedIds
        ? base.filter((n) => ftsMatchedIds.has(n.id))
        : searchNotes(base, folders, searchQuery);

    const sorted = [...searched].sort((a, b) => {
      if (sortKey === 'title') return a.title.localeCompare(b.title);
      return b[sortKey] - a[sortKey];
    });
    return filter.kind === 'recents' ? sorted.slice(0, 12) : sorted;
  }, [noteSummaries, activeNotes, folders, filter, searchQuery, ftsMatchedIds, sortKey]);

  const filterTitle = useMemo(() => {
    switch (filter.kind) {
      case 'all':
        return 'All Notes';
      case 'recents':
        return 'Recents';
      case 'favorites':
        return 'Favorites';
      case 'trash':
        return 'Recently Deleted (30-Day Retention)';
      case 'tag':
        return `#${filter.tag}`;
      case 'folder':
        return folders.find((f) => f.id === filter.folderId)?.name ?? 'Folder';
    }
  }, [filter, folders]);

  const recordingNoteTitle = useMemo(
    () => noteSummaries.find((n) => n.id === recordingNoteId)?.title ?? 'Note',
    [noteSummaries, recordingNoteId]
  );

  if (!hydrated) {
    return (
      <div class="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading Quire…</span>
      </div>
    );
  }

  return (
    <div class="app-shell">
      <input
        ref={pdfInputRef}
        id="input-import-pdf"
        type="file"
        accept="application/pdf,.quire"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void handleImportFile(file);
          (e.target as HTMLInputElement).value = '';
        }}
      />

      <LibrarySidebar
        collapsed={sidebarCollapsed}
        notes={noteSummaries}
        folders={folders}
        filter={filter}
        searchQuery={searchQuery}
        themeMode={settings.themeMode}
        onCycleTheme={() => {
          const next = nextThemeMode(settings.themeMode);
          updateSettings({ ...settings, themeMode: next });
          showToast(
            `Appearance: ${next === 'system' ? 'System' : next === 'light' ? 'Light' : 'Dark'}`
          );
        }}
        onSearchChange={setSearchQuery}
        onSelectFilter={(f) => {
          setFilter(f);
          void openNoteById(null);
        }}
        onNewNote={handleCreateNote}
        onTriggerPdfImport={() => pdfInputRef.current?.click()}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveNoteToFolder={(noteId, folderId) => {
          const target = noteSummariesRef.current.find((n) => n.id === noteId);
          if (target) {
            persistSummaryOnly({ ...target, folderId, updatedAt: Date.now() });
            showToast(folderId ? 'Moved note to folder' : 'Moved note to All Notes');
          }
        }}
        onOpenSettings={() => {
          void refreshStorageHealth();
          setSettingsOpen(true);
        }}
      />

      <main class="main-column">
        {storageHealth?.privateModeWarning && (
          <div
            role="status"
            style={{
              padding: '7px 14px',
              background: 'rgba(200, 90, 50, 0.14)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <span>
              <strong>Private Browsing detected:</strong> Browser storage may be cleared on exit.
              Export a <code>.quire</code> backup before closing.
            </span>
            <button
              type="button"
              class="btn-secondary"
              style={{ padding: '3px 8px', fontSize: '11.5px' }}
              onClick={() => void handleExportFullBackup(false)}
            >
              Export Backup
            </button>
          </div>
        )}

        {pwaUpdate && (
          <div
            role="status"
            style={{
              padding: '7px 14px',
              background: 'var(--surface-2)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: '12.5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <span>A new version of Quire is ready offline.</span>
            <button
              id="btn-apply-pwa-update"
              type="button"
              class="btn-primary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
              onClick={() => {
                if (recordingState !== 'idle') {
                  showToast('Stop audio recording before updating Quire.');
                  return;
                }
                flushPendingSaves();
                pwaUpdate.applyUpdate();
              }}
            >
              Update Now
            </button>
          </div>
        )}

        {activeNote ? (
          <NoteEditor
            key={activeNote.id}
            note={activeNote}
            settings={settings}
            resolvedTheme={resolvedTheme}
            sidebarCollapsed={sidebarCollapsed}
            recordingState={recordingState}
            recordingNoteId={recordingNoteId}
            recordingSessionId={recordingSessionId}
            recordingElapsedMs={recordingElapsedMs}
            getRecordingElapsedMs={() => audioRecorderRef.current?.getElapsedMs() ?? 0}
            onToggleRecording={handleToggleRecording}
            onStopRecording={handleStopRecording}
            onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
            onBackToLibrary={() => void openNoteById(null)}
            onUpdateNote={(updated, dirtyPageIds) => persistNote(updated, dirtyPageIds)}
            onUpdateSettings={updateSettings}
            onOpenPageManager={(idx) => setPageManagerPageIdx(idx)}
            onOpenExport={(idx) => setExportPageIdx(idx)}
            onToast={showToast}
            jumpToPageRequest={jumpToPageRequest}
            onClearJumpRequest={() => setJumpToPageRequest(null)}
          />
        ) : (
          <div class="library-view">
            <header class="library-topbar">
              <div class="library-title-row">
                <button
                  type="button"
                  class="btn-icon"
                  aria-label="Toggle Sidebar"
                  onClick={() => setSidebarCollapsed((c) => !c)}
                >
                  <Menu size={19} />
                </button>
                <h1>{filterTitle}</h1>
              </div>

              <div class="library-controls">
                {backupOverdue && (
                  <button
                    type="button"
                    class="btn-secondary"
                    style={{ padding: '5px 9px', fontSize: '12px' }}
                    onClick={() => void handleExportFullBackup(false)}
                  >
                    Backup Recommended
                  </button>
                )}
                <select
                  aria-label="Sort notes"
                  value={sortKey}
                  onChange={(e) => setSortKey((e.target as HTMLSelectElement).value as SortKey)}
                >
                  <option value="updatedAt">Modified Date</option>
                  <option value="createdAt">Created Date</option>
                  <option value="title">Name (A–Z)</option>
                </select>
                <button
                  type="button"
                  class={`btn-icon ${viewMode === 'grid' ? 'active' : ''}`}
                  aria-label="Grid View"
                  onClick={() => setViewMode('grid')}
                >
                  <Grid size={16} />
                </button>
                <button
                  type="button"
                  class={`btn-icon ${viewMode === 'list' ? 'active' : ''}`}
                  aria-label="List View"
                  onClick={() => setViewMode('list')}
                >
                  <List size={16} />
                </button>
              </div>
            </header>

            <div class="library-body">
              {visibleLibraryNotes.length === 0 ? (
                <div class="empty-state">
                  <h2>{searchQuery ? 'No matching notes' : 'Ready to capture'}</h2>
                  <p>
                    {searchQuery
                      ? 'No notes matched your query across titles, folders, tags, or typed text.'
                      : 'Create a fresh handwritten note in one tap or import a multi-page PDF slide deck.'}
                  </p>
                  {!searchQuery && filter.kind !== 'trash' && (
                    <button type="button" class="btn-primary" onClick={handleCreateNote}>
                      + New Note
                    </button>
                  )}
                </div>
              ) : (
                <div class={viewMode === 'grid' ? 'notes-grid' : 'notes-list'}>
                  {visibleLibraryNotes.map((n) => {
                    const firstPage = n.pages[0];
                    const thumbUrl = firstPage ? thumbUrls[firstPage.pageId] : undefined;
                    const effectiveThumbTheme = firstPage
                      ? resolveEffectivePaperTheme(
                          firstPage.source,
                          resolvedTheme,
                          settings.nightCanvasMode
                        )
                      : 'light';
                    const thumbCls =
                      firstPage?.source.kind === 'template'
                        ? `paper-theme-${effectiveThumbTheme} paper-tpl-${firstPage.source.template}`
                        : `paper-theme-${effectiveThumbTheme}`;
                    const thumbBg =
                      !thumbUrl && firstPage?.source.kind === 'template' && firstPage.source.template !== 'blank'
                        ? getPaperTemplateSvgDataUri(
                            firstPage.source.template,
                            effectiveThumbTheme,
                            firstPage.widthPt,
                            firstPage.heightPt
                          )
                        : undefined;
                    const isTrash = !!n.deletedAt;

                    return (
                      <article
                        key={n.id}
                        class={`note-card ${viewMode === 'list' ? 'list-row' : ''}`}
                        draggable={!isTrash}
                        onDragStart={(e) => {
                          e.dataTransfer?.setData('text/quire-note-id', n.id);
                        }}
                        onClick={() => {
                          if (!isTrash) {
                            void openNoteById(n.id);
                          }
                        }}
                      >
                        {viewMode === 'grid' && (
                          <div
                            class={`note-thumb ${thumbCls}`}
                            style={{
                              ...(thumbBg ? { backgroundImage: thumbBg } : {}),
                              position: 'relative',
                              overflow: 'hidden',
                            }}
                          >
                            {thumbUrl && (
                              <img
                                src={thumbUrl}
                                alt=""
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                }}
                              />
                            )}
                            <span class="note-thumb-badge" style={{ position: 'relative', zIndex: 1 }}>
                              {firstPage?.source.kind === 'pdf' ? 'PDF · ' : ''}
                              {n.pages.length} {n.pages.length === 1 ? 'page' : 'pages'}
                              {n.audioSessions.length > 0 ? ' · Audio' : ''}
                            </span>
                          </div>
                        )}

                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div class="note-meta-title">{n.title}</div>
                          <div class="note-meta-sub">
                            <span>{new Date(n.updatedAt).toLocaleDateString()}</span>
                            {n.audioSessions.length > 0 && <Mic size={12} />}
                            {firstPage?.source.kind === 'pdf' && <FileText size={12} />}
                            {n.tags.slice(0, 2).map((t) => (
                              <span key={t}>#{t}</span>
                            ))}
                          </div>
                        </div>

                        <div class="note-card-actions" onClick={(e) => e.stopPropagation()}>
                          {isTrash ? (
                            <>
                              <button
                                type="button"
                                class="btn-secondary"
                                style={{ padding: '4px 8px', fontSize: '12px' }}
                                onClick={() => {
                                  persistSummaryOnly({ ...n, deletedAt: null, updatedAt: Date.now() });
                                  showToast(`Restored "${n.title}"`);
                                }}
                              >
                                <RotateCcw size={13} /> Restore
                              </button>
                              <button
                                type="button"
                                class="btn-icon"
                                style={{ color: 'var(--danger)' }}
                                aria-label={`Permanently delete ${n.title}`}
                                onClick={() => {
                                  setConfirmDialog({
                                    title: `Permanently delete "${n.title}"?`,
                                    message:
                                      'This note and any unreferenced PDF, image, or audio attachments will be permanently removed from local storage.',
                                    confirmLabel: 'Delete Forever',
                                    onConfirm: () => {
                                      cancelPendingSave(n.id);
                                      setNoteSummaries((prev) => prev.filter((item) => item.id !== n.id));
                                      void quireStorage.hardDeleteNote(n.id).then(() => {
                                        void refreshStorageHealth();
                                      });
                                      setConfirmDialog(null);
                                      showToast(`Permanently deleted "${n.title}"`);
                                    },
                                  });
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          ) : (
                            <>
                              {folders.length > 0 && (
                                <button
                                  type="button"
                                  class="btn-icon"
                                  title="Move to Folder"
                                  aria-label={`Move ${n.title} to folder`}
                                  onClick={() =>
                                    setMoveMenuNoteId((prev) => (prev === n.id ? null : n.id))
                                  }
                                >
                                  <FolderInput size={15} />
                                </button>
                              )}
                              {moveMenuNoteId === n.id && (
                                <select
                                  aria-label={`Choose folder for ${n.title}`}
                                  value={n.folderId ?? ''}
                                  onChange={(e) => {
                                    const fid = (e.target as HTMLSelectElement).value || null;
                                    persistSummaryOnly({
                                      ...n,
                                      folderId: fid,
                                      updatedAt: Date.now(),
                                    });
                                    setMoveMenuNoteId(null);
                                    showToast(fid ? 'Moved note to folder' : 'Moved note to All Notes');
                                  }}
                                  style={{
                                    padding: '3px 6px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--border-strong)',
                                    background: 'var(--surface-1)',
                                    fontSize: '11.5px',
                                  }}
                                >
                                  <option value="">All Notes (Root)</option>
                                  {folders
                                    .filter((f) => !f.deletedAt)
                                    .map((f) => (
                                      <option key={f.id} value={f.id}>
                                        {f.name}
                                      </option>
                                    ))}
                                </select>
                              )}
                              <button
                                type="button"
                                class={`btn-icon ${n.isFavorite ? 'active' : ''}`}
                                aria-label={`Favorite ${n.title}`}
                                onClick={() => persistSummaryOnly({ ...n, isFavorite: !n.isFavorite })}
                              >
                                <Star size={15} fill={n.isFavorite ? 'currentColor' : 'none'} />
                              </button>
                              <button
                                type="button"
                                class="btn-icon"
                                aria-label={`Move ${n.title} to Trash`}
                                onClick={() => {
                                  persistSummaryOnly({ ...n, deletedAt: Date.now() });
                                  showToast(`Moved "${n.title}" to Recently Deleted`);
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Persistent App-Level Recording Mini-Bar (when recording on another note or in Library) */}
      {recordingState !== 'idle' && recordingNoteId && recordingNoteId !== activeNoteId && (
        <div
          id="floating-recording-bar"
          class="audio-bar"
          role="region"
          aria-label="Active Background Recording"
          style={{ bottom: '18px', zIndex: 60 }}
        >
          <span class="rec-dot" />
          <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>
            {formatDuration(recordingElapsedMs)}
          </strong>
          <button
            type="button"
            class="btn-secondary"
            style={{ padding: '4px 8px', fontSize: '12px' }}
            onClick={() => void openNoteById(recordingNoteId)}
          >
            Return to {recordingNoteTitle}
          </button>
          <button
            type="button"
            class="btn-primary"
            style={{ padding: '4px 9px', fontSize: '12px' }}
            onClick={() => void handleStopRecording()}
          >
            <Square size={12} /> Stop
          </button>
        </div>
      )}

      {/* Single-Active-Window OPFS Lock Overlay */}
      {pausedByOtherTab && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Paused in another tab">
          <div class="modal-sheet" style={{ maxWidth: '400px', textAlign: 'center' }}>
            <h2 style={{ margin: 0 }}>Quire is open in another tab</h2>
            <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              To protect your local SQLite &amp; OPFS storage from concurrent writes, this tab has
              paused cleanly.
            </p>
            <button
              id="btn-resume-tab-lock"
              type="button"
              class="btn-primary"
              onClick={() => void lockCoordinatorRef.current?.claimOwnership()}
            >
              Resume Here
            </button>
          </div>
        </div>
      )}

      {/* Modals & Sheets */}
      {!settings.hasCompletedOnboarding && (
        <WelcomeSheet settings={settings} onStartWriting={handleCompleteOnboarding} />
      )}

      {activeNote && pageManagerPageIdx !== null && (
        <PageManagerModal
          note={activeNote}
          activePageIndex={pageManagerPageIdx}
          onClose={() => setPageManagerPageIdx(null)}
          onJumpToPage={(idx) => setJumpToPageRequest(idx)}
          onInsertPageAfter={handleInsertPageAfter}
          onDuplicatePage={handleDuplicatePage}
          onMovePage={handleMovePage}
          onDeletePage={handleDeletePage}
          onChangePageTemplate={handleChangePageTemplate}
        />
      )}

      {activeNote && exportPageIdx !== null && (
        <ExportModal
          note={activeNote}
          activePageIndex={exportPageIdx}
          onClose={() => setExportPageIdx(null)}
          onToast={showToast}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          storageHealth={storageHealth}
          onUpdateSettings={updateSettings}
          onExportFullBackup={handleExportFullBackup}
          onImportFullBackup={handleImportFile}
          onPickLocalBackupFolder={handlePickLocalBackupFolder}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {passwordPrompt && (
        <PasswordModal
          fileName={passwordPrompt.file.name}
          errorMessage={passwordPrompt.errorMessage}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={async (pw) => {
            try {
              await finalizePdfImport(passwordPrompt.bytes, passwordPrompt.file.name, pw);
              setPasswordPrompt(null);
            } catch {
              setPasswordPrompt((prev) =>
                prev ? { ...prev, errorMessage: 'Incorrect PDF password. Please try again.' } : null
              );
            }
          }}
        />
      )}

      {confirmDialog && (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {toast && (
        <div class="toast-banner" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
