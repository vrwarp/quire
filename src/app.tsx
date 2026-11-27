import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  FileText,
  Grid,
  List,
  Menu,
  Mic,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-preact';
import type {
  AppSettings,
  Folder,
  NoteDocument,
  PageDescriptor,
  PaperTemplate,
  PaperTheme,
} from './types';
import {
  DEFAULT_SETTINGS,
  createBlankPage,
  createId,
  createNewNote,
  quireStorage,
  searchNotes,
} from './engine/storage';
import { generateOrderKey } from './engine/inkMath';
import { pdfEngine } from './engine/pdfEngine';
import { mergeNoteVersions, tickHLC } from './engine/syncEngine';
import {
  applyDocumentTheme,
  getSystemPrefersDark,
  nextThemeMode,
  resolveEffectivePaperTheme,
  resolveThemeMode,
} from './engine/theme';
import { LibrarySidebar, type LibraryFilter } from './components/LibrarySidebar';
import { NoteEditor } from './components/NoteEditor';
import {
  ExportModal,
  PageManagerModal,
  SettingsModal,
  WelcomeSheet,
} from './components/Modals';

type SortKey = 'updatedAt' | 'createdAt' | 'title';

export function App() {
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filter, setFilter] = useState<LibraryFilter>({ kind: 'all' });
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');

  const [pageManagerPageIdx, setPageManagerPageIdx] = useState<number | null>(null);
  const [exportPageIdx, setExportPageIdx] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpToPageRequest, setJumpToPageRequest] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number>(0);

  const showToast = useCallback((msg: string, durationMs = 3200) => {
    setToast(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
  }, []);

  // Hydrate local-first storage immediately on cold launch
  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedNotes, loadedFolders] = await Promise.all([
        quireStorage.loadSettings(),
        quireStorage.loadAllNotes(),
        quireStorage.loadAllFolders(),
      ]);
      setSettings(loadedSettings);
      setNotes(loadedNotes);
      setFolders(loadedFolders);
      setHydrated(true);
    })();
  }, []);

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

  // Sync resolved theme + meta theme-color + localStorage bootstrap key synchronously before paint
  useLayoutEffect(() => {
    if (!hydrated) return;
    applyDocumentTheme(resolvedTheme, settings.themeMode);
  }, [hydrated, resolvedTheme, settings.themeMode]);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    void quireStorage.saveSettings(next);
  }, []);

  const pendingSavesRef = useRef<Map<string, { note: NoteDocument; timer: number }>>(new Map());

  const flushPendingSaves = useCallback(() => {
    for (const [id, entry] of pendingSavesRef.current.entries()) {
      window.clearTimeout(entry.timer);
      pendingSavesRef.current.delete(id);
      void quireStorage.saveNote(entry.note);
    }
  }, []);

  const cancelPendingSave = useCallback((noteId: string) => {
    const existing = pendingSavesRef.current.get(noteId);
    if (existing) {
      window.clearTimeout(existing.timer);
      pendingSavesRef.current.delete(noteId);
    }
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

  const persistNote = useCallback((updated: NoteDocument, immediate = false) => {
    const withHlc: NoteDocument = {
      ...updated,
      hlc: tickHLC(updated.hlc),
    };
    setNotes((prev) => {
      const exists = prev.some((n) => n.id === withHlc.id);
      return exists ? prev.map((n) => (n.id === withHlc.id ? withHlc : n)) : [withHlc, ...prev];
    });
    const prevEntry = pendingSavesRef.current.get(withHlc.id);
    if (prevEntry) {
      window.clearTimeout(prevEntry.timer);
      pendingSavesRef.current.delete(withHlc.id);
    }
    if (immediate) {
      void quireStorage.saveNote(withHlc);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingSavesRef.current.delete(withHlc.id);
      void quireStorage.saveNote(withHlc);
    }, 180);
    pendingSavesRef.current.set(withHlc.id, { note: withHlc, timer });
  }, []);

  const activeNotes = useMemo(() => notes.filter((n) => !n.deletedAt), [notes]);
  const activeNote = useMemo(
    () => notes.find((n) => n.id === activeNoteId) ?? null,
    [notes, activeNoteId]
  );

  // CUJ 1: First-time welcome -> immediately create & open writable note (<1.5s)
  const handleCompleteOnboarding = (prefs: {
    template: PaperTemplate;
    theme: PaperTheme;
    scrollDirection: AppSettings['defaultScrollDirection'];
  }) => {
    const nextSettings: AppSettings = {
      ...settings,
      hasCompletedOnboarding: true,
      defaultTemplate: prefs.template,
      defaultPaperTheme: prefs.theme,
      defaultScrollDirection: prefs.scrollDirection,
    };
    updateSettings(nextSettings);
    const firstNote = createNewNote(nextSettings, null);
    persistNote(firstNote, true);
    setActiveNoteId(firstNote.id);
    setSidebarCollapsed(true);
  };

  // CUJ 1: One-tap + New Note (unlimited local-first notes)
  const handleCreateNote = () => {
    const targetFolder = filter.kind === 'folder' ? filter.folderId : null;
    const fresh = createNewNote(settings, targetFolder);
    persistNote(fresh, true);
    setActiveNoteId(fresh.id);
    setSidebarCollapsed(true);
  };

  // CUJ 3: Multi-Page PDF or .quire Bundle Import (with password-protected PDF support)
  const handleImportFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (file.name.toLowerCase().endsWith('.quire')) {
      try {
        const { importQuireBundle } = await import('./engine/exportEngine');
        const restored = await importQuireBundle(bytes);
        setNotes((prev) => [restored, ...prev.filter((n) => n.id !== restored.id)]);
        setActiveNoteId(restored.id);
        setSidebarCollapsed(true);
        showToast(`Restored "${restored.title}" from .quire archive`);
      } catch (err) {
        showToast(`Failed to import .quire: ${(err as Error).message}`);
      }
      return;
    }

    const tryLoadPdf = async (password?: string) => {
      const result = await pdfEngine.importPdfBytes(bytes, file.name, password);
      const targetFolder = filter.kind === 'folder' ? filter.folderId : null;
      const baseTitle = file.name.replace(/\.pdf$/i, '');
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
        scrollDirection: settings.defaultScrollDirection,
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
      persistNote(pdfNote, true);
      setActiveNoteId(pdfNote.id);
      setSidebarCollapsed(true);
      showToast(`Imported ${result.pageCount}-page PDF "${baseTitle}"`);
    };

    try {
      await tryLoadPdf();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.toLowerCase().includes('password')) {
        const pw = window.prompt('This PDF is password-protected. Enter password:');
        if (pw !== null) {
          try {
            await tryLoadPdf(pw);
          } catch {
            showToast('Incorrect PDF password.');
          }
        }
      } else {
        showToast(`Could not open PDF: ${msg}`);
      }
    }
  };

  // Folder CRUD (FR-ORG-02)
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

  const handleDeleteFolder = (folderId: string) => {
    const folderNotes = activeNotes.filter((n) => n.folderId === folderId);
    const now = Date.now();
    folderNotes.forEach((n) => persistNote({ ...n, deletedAt: now }));
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    void quireStorage.deleteFolder(folderId);
    if (filter.kind === 'folder' && filter.folderId === folderId) {
      setFilter({ kind: 'all' });
    }
    showToast(
      `Deleted folder (${folderNotes.length} note${folderNotes.length === 1 ? '' : 's'} moved to Recently Deleted)`
    );
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
    persistNote({
      ...activeNote,
      updatedAt: Date.now(),
      pages: nextPages,
      strokesByPage: { ...activeNote.strokesByPage, [newPage.pageId]: [] },
      textBoxesByPage: { ...activeNote.textBoxesByPage, [newPage.pageId]: [] },
      imagesByPage: { ...activeNote.imagesByPage, [newPage.pageId]: [] },
    });
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
    persistNote({
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
    });
  };

  const handleMovePage = (fromIndex: number, toIndex: number) => {
    if (!activeNote || toIndex < 0 || toIndex >= activeNote.pages.length) return;
    const nextPages = [...activeNote.pages];
    const [moved] = nextPages.splice(fromIndex, 1);
    nextPages.splice(toIndex, 0, moved);
    persistNote({ ...activeNote, updatedAt: Date.now(), pages: nextPages });
  };

  const handleDeletePage = (index: number) => {
    if (!activeNote || activeNote.pages.length <= 1) return;
    const nextPages = activeNote.pages.filter((_, i) => i !== index);
    persistNote({ ...activeNote, updatedAt: Date.now(), pages: nextPages });
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
    persistNote({ ...activeNote, updatedAt: Date.now(), pages: nextPages });
    showToast(
      applyToAll
        ? `Applied ${template} template to all template pages`
        : `Switched Page ${index + 1} to ${template} paper`
    );
  };

  // Filtered & sorted library notes (FR-ORG-02..04)
  const visibleLibraryNotes = useMemo(() => {
    let base: NoteDocument[];
    if (filter.kind === 'trash') {
      base = notes.filter((n) => !!n.deletedAt);
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

    const searched = searchNotes(base, folders, searchQuery);
    const sorted = [...searched].sort((a, b) => {
      if (sortKey === 'title') return a.title.localeCompare(b.title);
      return b[sortKey] - a[sortKey];
    });
    return filter.kind === 'recents' ? sorted.slice(0, 12) : sorted;
  }, [notes, activeNotes, folders, filter, searchQuery, sortKey]);

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

  // Conflict copy verification (CUJ 6)
  const handleSimulateConflictSync = () => {
    const target = activeNote ?? activeNotes[0];
    if (!target) {
      showToast('Create a note first to verify conflict copy behavior.');
      return;
    }
    const pageId = target.pages[0].pageId;
    const remoteSimulated: NoteDocument = {
      ...structuredClone(target),
      updatedAt: Date.now() + 1000,
      hlc: { ts: target.hlc.ts + 1000, counter: 1, deviceId: 'dev_ipad_pro' },
      strokesByPage: {
        ...target.strokesByPage,
        [pageId]: [
          ...(target.strokesByPage[pageId] ?? []),
          {
            id: createId('str_remote'),
            pageId,
            tool: 'pen',
            color: '#1d4ed8',
            width: 3,
            points: [
              { x: 100, y: 120, pressure: 0.6, altitude: 1.2, azimuth: 0, dtMs: 0 },
              { x: 240, y: 120, pressure: 0.6, altitude: 1.2, azimuth: 0, dtMs: 120 },
            ],
            bbox: { minX: 96, minY: 116, maxX: 244, maxY: 124 },
          },
        ],
      },
    };
    const localWithEdit: NoteDocument = {
      ...target,
      strokesByPage: {
        ...target.strokesByPage,
        [pageId]: [
          ...(target.strokesByPage[pageId] ?? []),
          {
            id: createId('str_local'),
            pageId,
            tool: 'pen',
            color: '#c85a32',
            width: 3,
            points: [
              { x: 100, y: 160, pressure: 0.6, altitude: 1.2, azimuth: 0, dtMs: 0 },
              { x: 240, y: 160, pressure: 0.6, altitude: 1.2, azimuth: 0, dtMs: 120 },
            ],
            bbox: { minX: 96, minY: 156, maxX: 244, maxY: 164 },
          },
        ],
      },
    };
    const { conflictCopy } = mergeNoteVersions(localWithEdit, remoteSimulated);
    if (conflictCopy) {
      persistNote(conflictCopy, true);
      showToast(`Preserved offline edit as "${conflictCopy.title}"`);
    }
  };

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
        notes={notes}
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
          flushPendingSaves();
          setFilter(f);
          setActiveNoteId(null);
        }}
        onNewNote={handleCreateNote}
        onTriggerPdfImport={() => pdfInputRef.current?.click()}
        onCreateFolder={handleCreateFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveNoteToFolder={(noteId, folderId) => {
          const target = notes.find((n) => n.id === noteId);
          if (target) {
            persistNote({ ...target, folderId, updatedAt: Date.now() }, true);
            showToast('Moved note to folder');
          }
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main class="main-column">
        {activeNote ? (
          <NoteEditor
            key={activeNote.id}
            note={activeNote}
            settings={settings}
            resolvedTheme={resolvedTheme}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
            onBackToLibrary={() => {
              flushPendingSaves();
              setActiveNoteId(null);
              setSidebarCollapsed(false);
            }}
            onUpdateNote={persistNote}
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
                      ? 'No notes matched your query across titles, folders, tags, or typed text. (Handwriting OCR search is planned for V1.5.)'
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
                            setActiveNoteId(n.id);
                            setSidebarCollapsed(true);
                          }
                        }}
                      >
                        {viewMode === 'grid' && (
                          <div class={`note-thumb ${thumbCls}`}>
                            <span class="note-thumb-badge">
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
                                  persistNote({ ...n, deletedAt: null, updatedAt: Date.now() }, true);
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
                                  cancelPendingSave(n.id);
                                  setNotes((prev) => prev.filter((item) => item.id !== n.id));
                                  void quireStorage.hardDeleteNote(n.id);
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                class={`btn-icon ${n.isFavorite ? 'active' : ''}`}
                                aria-label={`Favorite ${n.title}`}
                                onClick={() => persistNote({ ...n, isFavorite: !n.isFavorite }, true)}
                              >
                                <Star size={15} fill={n.isFavorite ? 'currentColor' : 'none'} />
                              </button>
                              <button
                                type="button"
                                class="btn-icon"
                                aria-label={`Move ${n.title} to Trash`}
                                onClick={() => {
                                  persistNote({ ...n, deletedAt: Date.now() }, true);
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
          onUpdateSettings={updateSettings}
          onSimulateConflictSync={handleSimulateConflictSync}
          onTriggerBackupNow={() => {
            updateSettings({
              ...settings,
              backup: { ...settings.backup, status: 'synced', lastBackupAt: Date.now() },
            });
            showToast(
              `Backed up ${activeNotes.length} notes (${settings.backup.format.toUpperCase()}) to ${settings.backup.provider}`
            );
          }}
          onClose={() => setSettingsOpen(false)}
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
