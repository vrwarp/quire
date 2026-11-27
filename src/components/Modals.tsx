import { useState } from 'preact/hooks';
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  Copy,
  Download,
  FileArchive,
  FilePlus,
  Image as ImageIcon,
  Layers,
  Trash2,
  X,
} from 'lucide-preact';
import type {
  AppSettings,
  NightCanvasMode,
  NoteDocument,
  PaperTemplate,
  PaperTheme,
  ScrollDirection,
  ThemeMode,
  ToolbarDock,
} from '../types';
import { getPaperTemplateSvgDataUri } from '../engine/paperTemplate';

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
              120 Hz local-first notes, PDF annotation &amp; audio-synced ink. No account required.
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
   2. Page Manager Modal (CUJ 3 / FR-PDF-04 / FR-INK-07)
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
            style={{ padding: '5px 8px', borderRadius: '6px', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}
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
            style={{ padding: '5px 8px', borderRadius: '6px', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}
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
            const previewCls =
              p.source.kind === 'template'
                ? `paper-theme-${p.source.theme} paper-tpl-${p.source.template}`
                : 'paper-theme-light';
            const previewBg =
              p.source.kind === 'template' && p.source.template !== 'blank'
                ? getPaperTemplateSvgDataUri(p.source.template, p.source.theme, p.widthPt, p.heightPt)
                : undefined;
            return (
              <div
                key={p.pageId}
                class={`page-thumb-card ${idx === activePageIndex ? 'active' : ''}`}
              >
                <div
                  class={`page-thumb-preview ${previewCls}`}
                  style={{ cursor: 'pointer', backgroundImage: previewBg }}
                  onClick={() => {
                    onJumpToPage(idx);
                    onClose();
                  }}
                >
                  <span>
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
   3. Vector PDF / PNG / .quire Export Modal (CUJ 6 / FR-SYN-03)
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

  const handleVectorPdf = async () => {
    setBusy(true);
    try {
      const { exportNoteToVectorPdf, triggerFileDownload } = await import('../engine/exportEngine');
      const bytes = await exportNoteToVectorPdf(note, {
        includeBackground: includeBg,
        pageIndices: parseRange(),
      });
      triggerFileDownload(bytes, `${safeName}.pdf`, 'application/pdf');
      onToast(`Exported crisp Vector PDF (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
      onClose();
    } catch (err) {
      onToast(`PDF export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePng = async () => {
    setBusy(true);
    try {
      const { exportPageToPng, triggerFileDownload } = await import('../engine/exportEngine');
      const blob = await exportPageToPng(note, activePageIndex, includeBg);
      triggerFileDownload(blob, `${safeName}_page_${activePageIndex + 1}.png`, 'image/png');
      onToast(`Exported Page ${activePageIndex + 1} as 2x PNG`);
      onClose();
    } catch (err) {
      onToast(`PNG export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleQuireBundle = async () => {
    setBusy(true);
    try {
      const { exportNoteToQuireBundle, triggerFileDownload } = await import('../engine/exportEngine');
      const bytes = await exportNoteToQuireBundle(note);
      triggerFileDownload(bytes, `${safeName}.quire`, 'application/zip');
      onToast(`Exported lossless .quire archive (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
      onClose();
    } catch (err) {
      onToast(`.quire export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            id="btn-export-vector-pdf"
            type="button"
            class="btn-primary"
            disabled={busy}
            onClick={handleVectorPdf}
          >
            <Download size={16} /> Export Vector PDF (Infinite Zoom Sharpness)
          </button>
          <button
            id="btn-export-png"
            type="button"
            class="btn-secondary"
            disabled={busy}
            onClick={handlePng}
          >
            <ImageIcon size={16} /> Export Current Page as 2x PNG
          </button>
          <button
            id="btn-export-quire"
            type="button"
            class="btn-secondary"
            disabled={busy}
            onClick={handleQuireBundle}
          >
            <FileArchive size={16} /> Export Lossless .quire Package (Ink + PDF + Audio)
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   4. Settings, Cloud Sync & Auto-Backup Modal (CUJ 6 / FR-SYN-01..02)
   ============================================================================ */
export function SettingsModal({
  settings,
  onUpdateSettings,
  onSimulateConflictSync,
  onTriggerBackupNow,
  onClose,
}: {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => void;
  onSimulateConflictSync: () => void;
  onTriggerBackupNow: () => void;
  onClose: () => void;
}) {
  const updateBackupProvider = (provider: AppSettings['backup']['provider']) => {
    onUpdateSettings({
      ...settings,
      backup: {
        ...settings.backup,
        provider,
        connectedAccount:
          provider === 'none'
            ? null
            : provider === 'google-drive'
            ? 'user@gmail.com (drive.file)'
            : 'user@dropbox.com (files.content.write)',
        status: provider === 'none' ? 'idle' : 'synced',
        lastBackupAt: provider === 'none' ? null : Date.now(),
      },
    });
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-sheet wide">
        <div class="modal-header">
          <h2>Settings, Sync &amp; Auto-Backup</h2>
          <button type="button" class="btn-icon" onClick={onClose} aria-label="Close Settings">
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
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
            <h3 style={{ margin: 0, fontSize: '14px' }}>Local-First Delta Sync &amp; Auto-Backup</h3>
            <div
              style={{
                padding: '12px',
                borderRadius: '10px',
                background: 'var(--surface-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                fontSize: '13px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Cloud size={15} /> Cross-Device Delta Sync
                </span>
                <input
                  type="checkbox"
                  checked={settings.sync.enabled}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...settings,
                      sync: {
                        ...settings.sync,
                        enabled: (e.target as HTMLInputElement).checked,
                        status: (e.target as HTMLInputElement).checked ? 'synced' : 'local-only',
                        lastSyncedAt: (e.target as HTMLInputElement).checked ? Date.now() : null,
                      },
                    })
                  }
                />
              </div>
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                Content-addressed blobs + HLC conflict copies ensure zero silent ink loss.
              </span>
              <button
                id="btn-test-conflict-sync"
                type="button"
                class="btn-secondary"
                style={{ fontSize: '12px', padding: '6px 10px' }}
                onClick={onSimulateConflictSync}
              >
                Verify Non-Destructive Conflict Copy
              </button>
            </div>

            <div class="field-group">
              <label>One-Way Auto-Backup</label>
              <div class="option-grid">
                {(['none', 'google-drive', 'dropbox'] as const).map((prov) => (
                  <button
                    key={prov}
                    type="button"
                    class={`option-card ${settings.backup.provider === prov ? 'selected' : ''}`}
                    onClick={() => updateBackupProvider(prov)}
                  >
                    {prov === 'none' ? 'Off' : prov === 'google-drive' ? 'Google Drive' : 'Dropbox'}
                  </button>
                ))}
              </div>
            </div>

            {settings.backup.provider !== 'none' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px' }}>
                <div>
                  Connected: <strong>{settings.backup.connectedAccount}</strong>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span>Format:</span>
                  <select
                    value={settings.backup.format}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        backup: {
                          ...settings.backup,
                          format: (e.target as HTMLSelectElement).value as 'pdf' | 'quire',
                        },
                      })
                    }
                  >
                    <option value="pdf">Vector PDF</option>
                    <option value="quire">Native .quire Archive</option>
                  </select>
                  <button
                    type="button"
                    class="btn-secondary"
                    style={{ padding: '5px 9px', fontSize: '12px' }}
                    onClick={onTriggerBackupNow}
                  >
                    Back Up Now
                  </button>
                </div>
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
              <strong>iPadOS PWA Tip:</strong> Tap Safari’s <em>Share → Add to Home Screen</em> for
              full-screen standalone canvas, ~60% disk OPFS quota, and Wake Lock audio continuity.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
