import { useEffect, useState } from 'preact/hooks';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FileArchive,
  FilePlus,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Lock,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-preact';
import type {
  AppSettings,
  NightCanvasMode,
  NoteDocument,
  PaperTemplate,
  PaperTheme,
  ScrollDirection,
  StorageHealth,
  ThemeMode,
  ToolbarDock,
} from '../types';
import { getPaperTemplateSvgDataUri } from '../engine/paperTemplate';
import { getCachedThumbUrl, loadThumbUrl } from '../engine/thumbnails';
import {
  buildDiagnosticsReport,
  clearDiagnostics,
  getDiagnostics,
} from '../engine/diagnostics';

/* ============================================================================
   1. Lightweight 1-Screen Welcome Sheet (CUJ 1 — Zero Mandatory Sign-up)
   ============================================================================ */
export function WelcomeSheet({
  settings,
  onStartWriting,
}: {
  settings: AppSettings;
  onStartWriting: (prefs: {
    template: PaperTemplate;
    theme: PaperTheme;
    scrollDirection: ScrollDirection;
  }) => void;
}) {
  const [template, setTemplate] = useState<PaperTemplate>(settings.defaultTemplate);
  const [theme, setTheme] = useState<PaperTheme>(settings.defaultPaperTheme);
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(
    settings.defaultScrollDirection
  );

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-heading">
      <div class="modal-sheet">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="./icon.svg" alt="" style={{ width: '40px', height: '40px', borderRadius: '10px' }} />
          <div>
            <h2 id="welcome-heading" style={{ margin: 0, fontSize: '21px' }}>
              Welcome to Quire
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              120 Hz local-first notes, PDF annotation &amp; audio-synced ink. Zero accounts, 100% private.
            </p>
          </div>
        </div>

        <div class="field-group">
          <label>Default Paper Template</label>
          <div class="option-grid">
            {(['blank', 'lined', 'grid', 'dotted'] as PaperTemplate[]).map((t) => (
              <button
                key={t}
                type="button"
                class={`option-card ${template === t ? 'selected' : ''}`}
                onClick={() => setTemplate(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div class="field-group">
          <label>Paper Surface</label>
          <div class="option-grid">
            {(['light', 'cream', 'dark'] as PaperTheme[]).map((th) => (
              <button
                key={th}
                type="button"
                class={`option-card ${theme === th ? 'selected' : ''}`}
                onClick={() => setTheme(th)}
              >
                {th === 'light' ? 'Crisp White' : th === 'cream' ? 'Warm Cream' : 'Dark Slate'}
              </button>
            ))}
          </div>
        </div>

        <div class="field-group">
          <label>Scroll Direction</label>
          <div class="option-grid">
            <button
              type="button"
              class={`option-card ${scrollDirection === 'vertical' ? 'selected' : ''}`}
              onClick={() => setScrollDirection('vertical')}
            >
              Vertical Seamless
            </button>
            <button
              type="button"
              class={`option-card ${scrollDirection === 'horizontal' ? 'selected' : ''}`}
              onClick={() => setScrollDirection('horizontal')}
            >
              Horizontal Pages
            </button>
          </div>
        </div>

        <button
          id="btn-start-writing"
          type="button"
          class="btn-primary"
          style={{ width: '100%', padding: '12px', fontSize: '15px' }}
          onClick={() => onStartWriting({ template, theme, scrollDirection })}
        >
          Start Writing
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   2. Page Manager Modal (CUJ 3 / FR-PDF-04 / FR-INK-07) with Cached Thumbnails
   ============================================================================ */
export function PageManagerModal({
  note,
  activePageIndex,
  onClose,
  onJumpToPage,
  onInsertPageAfter,
  onDuplicatePage,
  onMovePage,
  onDeletePage,
  onChangePageTemplate,
}: {
  note: NoteDocument;
  activePageIndex: number;
  onClose: () => void;
  onJumpToPage: (index: number) => void;
  onInsertPageAfter: (index: number, template: PaperTemplate, theme: PaperTheme) => void;
  onDuplicatePage: (index: number) => void;
  onMovePage: (fromIndex: number, toIndex: number) => void;
  onDeletePage: (index: number) => void;
  onChangePageTemplate: (
    index: number,
    template: PaperTemplate,
    theme: PaperTheme,
    applyToAll: boolean
  ) => void;
}) {
  const [newTpl, setNewTpl] = useState<PaperTemplate>('lined');
  const [newTheme, setNewTheme] = useState<PaperTheme>('cream');
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const p of note.pages.slice(0, 60)) {
        const url = getCachedThumbUrl(p.pageId) ?? (await loadThumbUrl(p.pageId));
        if (url) next[p.pageId] = url;
      }
      if (active) setThumbUrls(next);
    })();
    return () => {
      active = false;
    };
  }, [note.pages]);

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Page Manager">
      <div class="modal-sheet wide">
        <div class="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} />
            <h2>
              Page Manager ({note.pages.length} {note.pages.length === 1 ? 'page' : 'pages'})
            </h2>
          </div>
          <button type="button" class="btn-icon" onClick={onClose} aria-label="Close Page Manager">
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            borderRadius: '10px',
            background: 'var(--surface-2)',
          }}
        >
          <span style={{ fontSize: '12.5px', fontWeight: 600 }}>Insert / Template:</span>
          <select
            aria-label="Template style"
            value={newTpl}
            onChange={(e) => setNewTpl((e.target as HTMLSelectElement).value as PaperTemplate)}
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <option value="blank">Blank</option>
            <option value="lined">Lined</option>
            <option value="grid">Grid</option>
            <option value="dotted">Dotted</option>
          </select>
          <select
            aria-label="Paper theme"
            value={newTheme}
            onChange={(e) => setNewTheme((e.target as HTMLSelectElement).value as PaperTheme)}
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <option value="light">White</option>
            <option value="cream">Cream</option>
            <option value="dark">Dark</option>
          </select>
          <button
            id="btn-pm-insert-page"
            type="button"
            class="btn-primary"
            style={{ padding: '6px 11px', fontSize: '12.5px' }}
            onClick={() => onInsertPageAfter(activePageIndex, newTpl, newTheme)}
          >
            <FilePlus size={14} /> Insert After Page {activePageIndex + 1}
          </button>
          <button
            id="btn-pm-apply-current"
            type="button"
            class="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '12.5px' }}
            onClick={() => onChangePageTemplate(activePageIndex, newTpl, newTheme, false)}
          >
            Apply to Page {activePageIndex + 1} Only
          </button>
          <button
            type="button"
            class="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '12.5px' }}
            onClick={() => onChangePageTemplate(activePageIndex, newTpl, newTheme, true)}
          >
            Apply to All
          </button>
        </div>

        <div class="page-manager-grid">
          {note.pages.map((p, idx) => {
            const strokeCount = note.strokesByPage[p.pageId]?.length ?? 0;
            const thumbUrl = thumbUrls[p.pageId];
            const previewCls =
              p.source.kind === 'template'
                ? `paper-theme-${p.source.theme} paper-tpl-${p.source.template}`
                : 'paper-theme-light';
            const previewBg =
              !thumbUrl && p.source.kind === 'template' && p.source.template !== 'blank'
                ? getPaperTemplateSvgDataUri(p.source.template, p.source.theme, p.widthPt, p.heightPt)
                : undefined;
            return (
              <div
                key={p.pageId}
                class={`page-thumb-card ${idx === activePageIndex ? 'active' : ''}`}
              >
                <div
                  class={`page-thumb-preview ${previewCls}`}
                  style={{ cursor: 'pointer', backgroundImage: previewBg, position: 'relative', overflow: 'hidden' }}
                  onClick={() => {
                    onJumpToPage(idx);
                    onClose();
                  }}
                >
                  {thumbUrl && (
                    <img
                      src={thumbUrl}
                      alt={`Page ${idx + 1} preview`}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                  )}
                  <span style={{ position: 'relative', zIndex: 1 }}>
                    {p.source.kind === 'pdf'
                      ? `PDF p.${p.source.pdfPageNumber}`
                      : `${p.source.template}`}
                    {strokeCount > 0 ? ` · ${strokeCount} ink` : ''}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  <span>Page {idx + 1}</span>
                  <div style={{ display: 'flex', gap: '2px' }}>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px' }}
                      disabled={idx === 0}
                      title="Move earlier"
                      aria-label={`Move page ${idx + 1} earlier`}
                      onClick={() => onMovePage(idx, idx - 1)}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px' }}
                      disabled={idx === note.pages.length - 1}
                      title="Move later"
                      aria-label={`Move page ${idx + 1} later`}
                      onClick={() => onMovePage(idx, idx + 1)}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px' }}
                      title="Duplicate page"
                      aria-label={`Duplicate page ${idx + 1}`}
                      onClick={() => onDuplicatePage(idx)}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px', color: 'var(--danger)' }}
                      disabled={note.pages.length <= 1}
                      title="Delete page"
                      aria-label={`Delete page ${idx + 1}`}
                      onClick={() => onDeletePage(idx)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   3. Vector PDF / PNG / .quire Export Modal (ExportWorker + Progress + Share)
   ============================================================================ */
export function ExportModal({
  note,
  activePageIndex,
  onClose,
  onToast,
}: {
  note: NoteDocument;
  activePageIndex: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [includeBg, setIncludeBg] = useState(true);
  const [rangeMode, setRangeMode] = useState<'all' | 'current' | 'custom'>('all');
  const [customRange, setCustomRange] = useState(`1-${note.pages.length}`);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  const canShareFiles =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const parseRange = (): number[] => {
    if (rangeMode === 'all') return note.pages.map((_, i) => i);
    if (rangeMode === 'current') return [activePageIndex];
    const indices = new Set<number>();
    for (const part of customRange.split(',')) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [a, b] = trimmed.split('-').map((n) => parseInt(n.trim(), 10));
        if (!Number.isNaN(a) && !Number.isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (i >= 1 && i <= note.pages.length) indices.add(i - 1);
          }
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= note.pages.length) indices.add(n - 1);
      }
    }
    return indices.size > 0 ? [...indices].sort((a, b) => a - b) : [activePageIndex];
  };

  const safeName = note.title.replace(/[^a-z0-9\-_ ]/gi, '_').slice(0, 64) || 'Quire_Note';

  const handleVectorPdf = async (preferShare = false) => {
    setBusy(true);
    setProgress({ pct: 5, label: 'Starting ExportWorker…' });
    try {
      const { exportNoteToVectorPdf, shareOrDownloadFile } = await import('../engine/exportEngine');
      const bytes = await exportNoteToVectorPdf(note, {
        includeBackground: includeBg,
        pageIndices: parseRange(),
        onProgress: (pct, label) => setProgress({ pct, label }),
      });
      await shareOrDownloadFile(bytes, `${safeName}.pdf`, 'application/pdf', preferShare);
      onToast(`Exported crisp Vector PDF (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
      onClose();
    } catch (err) {
      onToast(`PDF export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handlePng = async (preferShare = false) => {
    setBusy(true);
    setProgress({ pct: 40, label: 'Rendering 2x Retina PNG…' });
    try {
      const { exportPageToPng, shareOrDownloadFile } = await import('../engine/exportEngine');
      const blob = await exportPageToPng(note, activePageIndex, includeBg);
      await shareOrDownloadFile(blob, `${safeName}_page_${activePageIndex + 1}.png`, 'image/png', preferShare);
      onToast(`Exported Page ${activePageIndex + 1} as 2x PNG`);
      onClose();
    } catch (err) {
      onToast(`PNG export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleQuireBundle = async (preferShare = false) => {
    setBusy(true);
    setProgress({ pct: 10, label: 'Streaming .quire package…' });
    try {
      const { exportNoteToQuireBundle, shareOrDownloadFile } = await import('../engine/exportEngine');
      const bytes = await exportNoteToQuireBundle(note, (pct, label) => setProgress({ pct, label }));
      await shareOrDownloadFile(bytes, `${safeName}.quire`, 'application/zip', preferShare);
      onToast(`Exported lossless .quire archive (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
      onClose();
    } catch (err) {
      onToast(`.quire export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Export Note">
      <div class="modal-sheet">
        <div class="modal-header">
          <h2>Export &amp; Share</h2>
          <button type="button" class="btn-icon" onClick={onClose} aria-label="Close Export">
            <X size={18} />
          </button>
        </div>

        <div class="field-group">
          <label>Page Range</label>
          <div class="option-grid">
            <button
              type="button"
              class={`option-card ${rangeMode === 'all' ? 'selected' : ''}`}
              onClick={() => setRangeMode('all')}
            >
              All ({note.pages.length})
            </button>
            <button
              type="button"
              class={`option-card ${rangeMode === 'current' ? 'selected' : ''}`}
              onClick={() => setRangeMode('current')}
            >
              Page {activePageIndex + 1}
            </button>
            <button
              type="button"
              class={`option-card ${rangeMode === 'custom' ? 'selected' : ''}`}
              onClick={() => setRangeMode('custom')}
            >
              Custom
            </button>
          </div>
          {rangeMode === 'custom' && (
            <input
              type="text"
              value={customRange}
              onInput={(e) => setCustomRange((e.target as HTMLInputElement).value)}
              placeholder="e.g. 1-3, 5"
            />
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px' }}>
          <input
            type="checkbox"
            checked={includeBg}
            onChange={(e) => setIncludeBg((e.target as HTMLInputElement).checked)}
          />
          Include paper background templates
        </label>

        {progress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {progress.label} ({progress.pct}%)
            </div>
            <div style={{ height: '6px', borderRadius: '99px', background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress.pct}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  transition: 'width 120ms ease',
                }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              id="btn-export-vector-pdf"
              type="button"
              class="btn-primary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void handleVectorPdf(false)}
            >
              <Download size={16} /> Export Vector PDF
            </button>
            {canShareFiles && (
              <button
                type="button"
                class="btn-secondary"
                disabled={busy}
                title="Share via System Sheet (iCloud / Files / AirDrop)"
                aria-label="Share Vector PDF"
                onClick={() => void handleVectorPdf(true)}
              >
                <Share2 size={16} />
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              id="btn-export-png"
              type="button"
              class="btn-secondary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void handlePng(false)}
            >
              <ImageIcon size={16} /> Export Current Page as 2x PNG
            </button>
            {canShareFiles && (
              <button
                type="button"
                class="btn-secondary"
                disabled={busy}
                aria-label="Share PNG"
                onClick={() => void handlePng(true)}
              >
                <Share2 size={16} />
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              id="btn-export-quire"
              type="button"
              class="btn-secondary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void handleQuireBundle(false)}
            >
              <FileArchive size={16} /> Export Lossless .quire Package
            </button>
            {canShareFiles && (
              <button
                type="button"
                class="btn-secondary"
                disabled={busy}
                aria-label="Share .quire package"
                onClick={() => void handleQuireBundle(true)}
              >
                <Share2 size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   4. Settings, Local Storage, Full-Library Backup & Diagnostics Modal
   ============================================================================ */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SettingsModal({
  settings,
  storageHealth,
  onUpdateSettings,
  onExportFullBackup,
  onImportFullBackup,
  onPickLocalBackupFolder,
  onClose,
}: {
  settings: AppSettings;
  storageHealth: StorageHealth | null;
  onUpdateSettings: (next: AppSettings) => void;
  onExportFullBackup: (preferShare: boolean) => Promise<void>;
  onImportFullBackup: (file: File) => Promise<void>;
  onPickLocalBackupFolder: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const diagEntries = showDiag ? getDiagnostics() : [];
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  const handleDownloadDiag = () => {
    const json = buildDiagnosticsReport({ storageHealth });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quire-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-sheet wide">
        <div class="modal-header">
          <h2>Settings, Local Storage &amp; Backup</h2>
          <button type="button" class="btn-icon" onClick={onClose} aria-label="Close Settings">
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '16px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Appearance &amp; Ergonomics</h3>
            <div class="field-group">
              <label>Appearance</label>
              <div class="option-grid">
                {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                  <button
                    key={mode}
                    id={`btn-theme-${mode}`}
                    type="button"
                    aria-pressed={settings.themeMode === mode}
                    class={`option-card ${settings.themeMode === mode ? 'selected' : ''}`}
                    onClick={() => onUpdateSettings({ ...settings, themeMode: mode })}
                  >
                    {mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </div>

            <div class="field-group">
              <label>Night Canvas (in Dark Mode)</label>
              <div class="option-grid">
                {(
                  [
                    { id: 'off', label: 'Off' },
                    { id: 'paper', label: 'Paper Only' },
                    { id: 'paper-and-pdf', label: 'Paper + PDFs' },
                  ] as Array<{ id: NightCanvasMode; label: string }>
                ).map((opt) => (
                  <button
                    key={opt.id}
                    id={`btn-night-canvas-${opt.id}`}
                    type="button"
                    aria-pressed={settings.nightCanvasMode === opt.id}
                    class={`option-card ${settings.nightCanvasMode === opt.id ? 'selected' : ''}`}
                    onClick={() => onUpdateSettings({ ...settings, nightCanvasMode: opt.id })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Non-destructive view override. Exports always preserve original paper and PDF colors.
              </span>
            </div>

            <div class="field-group">
              <label>Toolbar Dock Position (Left/Right-Handed)</label>
              <div class="option-grid">
                {(['top', 'left', 'right'] as ToolbarDock[]).map((dock) => (
                  <button
                    key={dock}
                    type="button"
                    class={`option-card ${settings.toolbarDock === dock ? 'selected' : ''}`}
                    onClick={() => onUpdateSettings({ ...settings, toolbarDock: dock })}
                  >
                    {dock.charAt(0).toUpperCase() + dock.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13.5px' }}>
              <span>Finger Drawing Mode (when no Pencil)</span>
              <input
                type="checkbox"
                checked={settings.fingerDrawMode}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    fingerDrawMode: (e.target as HTMLInputElement).checked,
                  })
                }
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13.5px' }}>
              <span>Auto-Return to Pen After Erasing</span>
              <input
                type="checkbox"
                checked={settings.eraserAutoReturn}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    eraserAutoReturn: (e.target as HTMLInputElement).checked,
                  })
                }
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13.5px' }}>
              <span>Show 120 Hz Performance HUD</span>
              <input
                id="chk-telemetry-hud"
                type="checkbox"
                checked={settings.showTelemetryHud}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    showTelemetryHud: (e.target as HTMLInputElement).checked,
                  })
                }
              />
            </label>

            <div class="field-group">
              <label>
                Apple Pencil Prediction Lookahead ({settings.predictionLookaheadMs ?? 10} ms)
              </label>
              <input
                type="range"
                min={0}
                max={24}
                step={2}
                value={settings.predictionLookaheadMs ?? 10}
                onInput={(e) =>
                  onUpdateSettings({
                    ...settings,
                    predictionLookaheadMs: parseInt((e.target as HTMLInputElement).value, 10),
                  })
                }
              />
            </div>

            <div class="field-group">
              <label>Audio Tap-to-Jump Pre-Roll</label>
              <select
                value={settings.audioPreRollMs}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    audioPreRollMs: parseInt((e.target as HTMLSelectElement).value, 10),
                  })
                }
              >
                <option value={0}>0 seconds (Exact stroke start)</option>
                <option value={2000}>2 seconds before stroke (Default)</option>
                <option value={5000}>5 seconds before stroke</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Local Storage, Backup &amp; Portability</h3>

            <div
              style={{
                padding: '12px',
                borderRadius: '10px',
                background: 'var(--surface-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '12.5px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <HardDrive size={15} /> Storage Engine
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                  {storageHealth?.backend === 'sqlite-opfs' ? 'SQLite + OPFS' : 'IndexedDB Fallback'}
                </span>
              </div>
              {storageHealth && (
                <div style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    Used: <strong>{formatBytes(storageHealth.usageBytes)}</strong>
                    {storageHealth.quotaBytes > 0 ? ` / ${formatBytes(storageHealth.quotaBytes)}` : ''}
                  </span>
                  <span>
                    {storageHealth.persisted ? 'Persistent' : 'Best-Effort'}
                  </span>
                </div>
              )}
              <div style={{ color: 'var(--text-muted)', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <ShieldCheck size={13} /> Zero cloud servers, zero telemetry — all data stays on your device.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  id="btn-export-full-backup"
                  type="button"
                  class="btn-primary"
                  style={{ flex: 1, fontSize: '12.5px' }}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onExportFullBackup(false).finally(() => setBusy(false));
                  }}
                >
                  <FileArchive size={15} /> Export Full-Library .quire Backup
                </button>
                {canShare && (
                  <button
                    type="button"
                    class="btn-secondary"
                    disabled={busy}
                    title="Share Full Backup to iCloud / Files / Drive"
                    aria-label="Share Full Library Backup"
                    onClick={() => {
                      setBusy(true);
                      void onExportFullBackup(true).finally(() => setBusy(false));
                    }}
                  >
                    <Share2 size={15} />
                  </button>
                )}
              </div>

              <label
                class="btn-secondary"
                style={{ cursor: 'pointer', fontSize: '12.5px', textAlign: 'center' }}
              >
                <Upload size={15} /> Restore / Merge .quire Backup (Conflict-Safe)
                <input
                  id="input-import-backup"
                  type="file"
                  accept=".quire,application/zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                      setBusy(true);
                      void onImportFullBackup(file).finally(() => setBusy(false));
                    }
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
              </label>

              {settings.backup.lastBackupAt && (
                <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  Last backup: {new Date(settings.backup.lastBackupAt).toLocaleString()}
                </div>
              )}
            </div>

            <div class="field-group">
              <label>Backup Reminder</label>
              <select
                value={settings.backup.reminderIntervalDays}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    backup: {
                      ...settings.backup,
                      reminderIntervalDays: parseInt((e.target as HTMLSelectElement).value, 10),
                    },
                  })
                }
              >
                <option value={0}>Off</option>
                <option value={7}>Every 7 days (Recommended)</option>
                <option value={30}>Every 30 days</option>
              </select>
            </div>

            {canPickFolder && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '12px',
                }}
              >
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FolderOpen size={14} /> Local Folder Auto-Backup (Desktop)
                </div>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {settings.backup.localFolderName
                    ? `Selected folder: ${settings.backup.localFolderName}`
                    : 'Choose a local folder (e.g. iCloud Drive / Dropbox / Drive sync folder) to write .quire backups directly.'}
                </span>
                <button
                  type="button"
                  class="btn-secondary"
                  style={{ fontSize: '12px', padding: '5px 10px' }}
                  onClick={() => void onPickLocalBackupFolder()}
                >
                  Choose Local Backup Folder…
                </button>
              </div>
            )}

            <div
              style={{
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid var(--border-subtle)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                lineHeight: 1.45,
              }}
            >
              <strong>Safari → Home Screen PWA Transfer:</strong> Adding Quire to your iPad Home
              Screen creates a fresh offline container with ~60% disk quota. Export a Full-Library{' '}
              <code>.quire</code> backup here before installing, then Restore it inside the Home
              Screen app.
            </div>

            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                type="button"
                class="btn-secondary"
                style={{ fontSize: '12px', padding: '5px 10px', flex: 1 }}
                onClick={() => setShowDiag((v) => !v)}
              >
                {showDiag ? 'Hide Diagnostics' : 'View Local Diagnostics'}
              </button>
              <button
                type="button"
                class="btn-secondary"
                style={{ fontSize: '12px', padding: '5px 10px' }}
                onClick={handleDownloadDiag}
              >
                Export Log
              </button>
            </div>

            {showDiag && (
              <div
                style={{
                  padding: '8px',
                  borderRadius: '8px',
                  background: 'var(--surface-2)',
                  maxHeight: '140px',
                  overflow: 'auto',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                }}
              >
                {diagEntries.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)' }}>No diagnostic events recorded.</div>
                ) : (
                  diagEntries.slice(-30).map((d, idx) => (
                    <div key={idx} style={{ marginBottom: '4px' }}>
                      [{new Date(d.ts).toLocaleTimeString()}] {d.level.toUpperCase()} {d.source}:{' '}
                      {d.message}
                    </div>
                  ))
                )}
                {diagEntries.length > 0 && (
                  <button
                    type="button"
                    class="btn-secondary"
                    style={{ marginTop: '6px', fontSize: '11px', padding: '3px 8px' }}
                    onClick={() => {
                      clearDiagnostics();
                      setShowDiag(false);
                    }}
                  >
                    Clear Log
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   5. Accessible Password Modal (Replaces window.prompt for Encrypted PDFs)
   ============================================================================ */
export function PasswordModal({
  fileName,
  errorMessage,
  onSubmit,
  onCancel,
}: {
  fileName: string;
  errorMessage?: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
      <div class="modal-sheet" style={{ maxWidth: '400px' }}>
        <div class="modal-header">
          <h2 id="pw-modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Lock size={17} /> Unlock Protected PDF
          </h2>
          <button type="button" class="btn-icon" onClick={onCancel} aria-label="Cancel">
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
          Enter the password for <strong>{fileName}</strong>. Quire unlocks a local copy inside
          PDFium so future reloads and exports work offline without storing your password.
        </p>
        {errorMessage && (
          <div style={{ fontSize: '12.5px', color: 'var(--danger)', fontWeight: 600 }}>
            {errorMessage}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(password);
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <input
            id="input-pdf-password"
            type="password"
            autoFocus
            placeholder="PDF Password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            style={{
              padding: '9px 11px',
              borderRadius: '8px',
              border: '1px solid var(--border-strong)',
              background: 'var(--surface-1)',
              fontSize: '14px',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" class="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button id="btn-submit-pdf-password" type="submit" class="btn-primary">
              Unlock &amp; Import
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================================================
   6. Accessible Confirmation Modal (Destructive Actions)
   ============================================================================ */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="modal-sheet" style={{ maxWidth: '400px' }}>
        <div class="modal-header">
          <h2 id="confirm-title">{title}</h2>
          <button type="button" class="btn-icon" onClick={onCancel} aria-label="Cancel">
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button type="button" class="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            id="btn-confirm-action"
            type="button"
            class="btn-primary"
            style={danger ? { background: 'var(--danger)', color: '#ffffff' } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
