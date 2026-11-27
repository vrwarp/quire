import { useState } from 'preact/hooks';
import {
  Clock,
  FilePlus2,
  FileUp,
  Folder as FolderIcon,
  FolderPlus,
  Hash,
  Inbox,
  Monitor,
  Moon,
  Search,
  Settings,
  Star,
  Sun,
  Trash2,
} from 'lucide-preact';
import type { Folder, NoteDocument, ThemeMode } from '../types';
import { getFolderDepth } from '../engine/storage';

export type LibraryFilter =
  | { kind: 'all' }
  | { kind: 'recents' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'tag'; tag: string };

interface LibrarySidebarProps {
  collapsed: boolean;
  notes: NoteDocument[];
  folders: Folder[];
  filter: LibraryFilter;
  searchQuery: string;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onSearchChange: (q: string) => void;
  onSelectFilter: (f: LibraryFilter) => void;
  onNewNote: () => void;
  onTriggerPdfImport: () => void;
  onCreateFolder: (name: string, parentId: string | null, color: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onMoveNoteToFolder: (noteId: string, folderId: string | null) => void;
  onOpenSettings: () => void;
}

const FOLDER_COLORS = ['#c85a32', '#2563eb', '#15803d', '#b45309', '#475569'];

export function LibrarySidebar({
  collapsed,
  notes,
  folders,
  filter,
  searchQuery,
  themeMode,
  onCycleTheme,
  onSearchChange,
  onSelectFilter,
  onNewNote,
  onTriggerPdfImport,
  onCreateFolder,
  onDeleteFolder,
  onMoveNoteToFolder,
  onOpenSettings,
}: LibrarySidebarProps) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderParentId, setFolderParentId] = useState<string | null>(null);
  const [folderColor, setFolderColor] = useState(FOLDER_COLORS[0]);

  const activeNotes = notes.filter((n) => !n.deletedAt);
  const trashNotes = notes.filter((n) => !!n.deletedAt);
  const favoriteNotes = activeNotes.filter((n) => n.isFavorite);

  const allTags = Array.from(new Set(activeNotes.flatMap((n) => n.tags))).sort();

  const submitFolder = (e: Event) => {
    e.preventDefault();
    const trimmed = folderName.trim();
    if (!trimmed) return;
    if (getFolderDepth(folderParentId, folders) >= 5) return;
    onCreateFolder(trimmed, folderParentId, folderColor);
    setFolderName('');
    setCreatingFolder(false);
  };

  const renderFolderTree = (parentId: string | null, depth: number) => {
    const children = folders.filter((f) => !f.deletedAt && f.parentId === parentId);
    return children.map((folder) => {
      const count = activeNotes.filter((n) => n.folderId === folder.id).length;
      const isActive = filter.kind === 'folder' && filter.folderId === folder.id;
      return (
        <div key={folder.id}>
          <div
            class={`nav-item ${isActive ? 'active' : ''}`}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            onClick={() => onSelectFilter({ kind: 'folder', folderId: folder.id })}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const noteId = e.dataTransfer?.getData('text/quire-note-id');
              if (noteId) onMoveNoteToFolder(noteId, folder.id);
            }}
            role="button"
            tabIndex={0}
          >
            <span class="folder-dot" style={{ background: folder.color }} />
            <FolderIcon size={15} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {folder.name}
            </span>
            <span class="nav-count">{count}</span>
            <button
              type="button"
              class="btn-icon"
              style={{ width: '22px', height: '22px' }}
              title="Delete folder"
              aria-label={`Delete folder ${folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(folder.id);
              }}
            >
              ×
            </button>
          </div>
          {depth < 4 && renderFolderTree(folder.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <aside class={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Library Navigation">
      <div class="sidebar-header">
        <div class="brand-mark">
          <img src="./icon.svg" alt="" />
          <span>Quire</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <button
            id="btn-quick-theme"
            type="button"
            class="btn-icon"
            title={`Theme: ${themeMode.charAt(0).toUpperCase() + themeMode.slice(1)} (click to cycle)`}
            aria-label={`Theme mode: ${themeMode}`}
            onClick={onCycleTheme}
          >
            {themeMode === 'dark' ? (
              <Moon size={16} />
            ) : themeMode === 'light' ? (
              <Sun size={16} />
            ) : (
              <Monitor size={16} />
            )}
          </button>
          <button
            id="btn-open-settings"
            type="button"
            class="btn-icon"
            title="Settings, Sync & Auto-Backup"
            aria-label="Open Settings"
            onClick={onOpenSettings}
          >
            <Settings size={17} />
          </button>
        </div>
      </div>

      <div class="sidebar-actions">
        <button
          id="btn-new-note"
          type="button"
          class="btn-primary"
          style={{ flex: 1 }}
          onClick={onNewNote}
        >
          <FilePlus2 size={16} />
          New Note
        </button>
        <button
          id="btn-import-pdf"
          type="button"
          class="btn-secondary"
          title="Import PDF or .quire bundle"
          aria-label="Import PDF"
          onClick={onTriggerPdfImport}
        >
          <FileUp size={16} />
          Import
        </button>
      </div>

      <div class="sidebar-search">
        <Search size={14} class="search-icon" />
        <input
          id="input-library-search"
          type="search"
          placeholder="Search titles, folders, tags, text..."
          aria-label="Search notes"
          value={searchQuery}
          onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="sidebar-scroll">
        <button
          type="button"
          class={`nav-item ${filter.kind === 'all' ? 'active' : ''}`}
          onClick={() => onSelectFilter({ kind: 'all' })}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const noteId = e.dataTransfer?.getData('text/quire-note-id');
            if (noteId) onMoveNoteToFolder(noteId, null);
          }}
        >
          <Inbox size={16} />
          <span>All Notes</span>
          <span class="nav-count">{activeNotes.length}</span>
        </button>
        <button
          type="button"
          class={`nav-item ${filter.kind === 'recents' ? 'active' : ''}`}
          onClick={() => onSelectFilter({ kind: 'recents' })}
        >
          <Clock size={16} />
          <span>Recents</span>
          <span class="nav-count">{Math.min(12, activeNotes.length)}</span>
        </button>
        <button
          type="button"
          class={`nav-item ${filter.kind === 'favorites' ? 'active' : ''}`}
          onClick={() => onSelectFilter({ kind: 'favorites' })}
        >
          <Star size={16} />
          <span>Favorites</span>
          <span class="nav-count">{favoriteNotes.length}</span>
        </button>
        <button
          id="btn-filter-trash"
          type="button"
          class={`nav-item ${filter.kind === 'trash' ? 'active' : ''}`}
          onClick={() => onSelectFilter({ kind: 'trash' })}
        >
          <Trash2 size={16} />
          <span>Recently Deleted</span>
          <span class="nav-count">{trashNotes.length}</span>
        </button>

        <div class="nav-section-label">
          <span>Folders (up to 5 levels)</span>
          <button
            id="btn-add-folder"
            type="button"
            class="btn-icon"
            style={{ width: '24px', height: '24px' }}
            title="New Folder"
            aria-label="Create Folder"
            onClick={() => setCreatingFolder((v) => !v)}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {creatingFolder && (
          <form
            onSubmit={submitFolder}
            style={{
              padding: '8px',
              margin: '0 4px 8px',
              borderRadius: '10px',
              background: 'var(--surface-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <input
              id="input-new-folder-name"
              type="text"
              placeholder="Folder name (e.g. Fall 2026)"
              value={folderName}
              onInput={(e) => setFolderName((e.target as HTMLInputElement).value)}
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-strong)',
                background: 'var(--surface-1)',
                fontSize: '12.5px',
              }}
            />
            <select
              aria-label="Parent folder"
              value={folderParentId ?? ''}
              onChange={(e) =>
                setFolderParentId((e.target as HTMLSelectElement).value || null)
              }
              style={{
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-1)',
                fontSize: '12px',
              }}
            >
              <option value="">Top-level folder</option>
              {folders
                .filter((f) => !f.deletedAt && getFolderDepth(f.id, folders) < 5)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    Inside: {f.name}
                  </option>
                ))}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '5px' }}>
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    class={`color-swatch ${folderColor === c ? 'active' : ''}`}
                    style={{ background: c, width: '16px', height: '16px' }}
                    onClick={() => setFolderColor(c)}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
              <button
                id="btn-confirm-folder"
                type="submit"
                class="btn-primary"
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Add
              </button>
            </div>
          </form>
        )}

        {renderFolderTree(null, 0)}

        {allTags.length > 0 && (
          <>
            <div class="nav-section-label">
              <span>Tags</span>
            </div>
            <div class="tag-cloud">
              {allTags.map((tag) => {
                const isActive = filter.kind === 'tag' && filter.tag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    class={`tag-chip ${isActive ? 'active' : ''}`}
                    onClick={() =>
                      onSelectFilter(isActive ? { kind: 'all' } : { kind: 'tag', tag })
                    }
                  >
                    <Hash size={11} />
                    {tag}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div class="sidebar-footer">
        <span>
          {activeNotes.length} {activeNotes.length === 1 ? 'Note' : 'Notes'} · Local-First
        </span>
      </div>
    </aside>
  );
}
