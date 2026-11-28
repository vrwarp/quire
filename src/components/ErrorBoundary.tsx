import { Component, type ComponentChildren } from 'preact';
import { buildDiagnosticsReport, logDiagnostic } from '../engine/diagnostics';

interface ErrorBoundaryState {
  error: Error | null;
  exporting: boolean;
  statusMsg: string | null;
}

export class ErrorBoundary extends Component<{ children: ComponentChildren }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    exporting: false,
    statusMsg: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    logDiagnostic('error', 'ErrorBoundary', error.message || 'Unhandled UI crash', error);
  }

  private handleEmergencyBackup = async () => {
    this.setState({ exporting: true, statusMsg: 'Packing emergency .quire backup…' });
    try {
      const { exportFullLibraryBackup, triggerFileDownload } = await import('../engine/exportEngine');
      const bytes = await exportFullLibraryBackup();
      const stamp = new Date().toISOString().slice(0, 10);
      triggerFileDownload(bytes, `Quire_Emergency_Backup_${stamp}.quire`, 'application/zip');
      this.setState({ exporting: false, statusMsg: 'Emergency backup downloaded safely.' });
    } catch (err) {
      this.setState({
        exporting: false,
        statusMsg: `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  private handleDownloadDiagnostics = () => {
    const json = buildDiagnosticsReport({ crashMessage: this.state.error?.message });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quire-diagnostics-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        class="app-shell"
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}
      >
        <div
          class="modal-sheet"
          role="alertdialog"
          aria-labelledby="crash-heading"
          style={{ maxWidth: '480px', width: '100%' }}
        >
          <h2 id="crash-heading" style={{ margin: 0, fontSize: '20px' }}>
            Quire encountered an unexpected error
          </h2>
          <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Your notes remain safely stored in local OPFS/SQLite storage. You can export an
            emergency full-library <code>.quire</code> backup below before reloading.
          </p>
          <pre
            style={{
              margin: 0,
              padding: '10px',
              borderRadius: '8px',
              background: 'var(--surface-2)',
              fontSize: '11.5px',
              overflow: 'auto',
              maxHeight: '120px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {this.state.error.message}
          </pre>
          {this.state.statusMsg && (
            <div style={{ fontSize: '12.5px', color: 'var(--accent)', fontWeight: 600 }}>
              {this.state.statusMsg}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button
              type="button"
              class="btn-primary"
              disabled={this.state.exporting}
              onClick={this.handleEmergencyBackup}
            >
              Export Emergency .quire Library Backup
            </button>
            <button type="button" class="btn-secondary" onClick={this.handleDownloadDiagnostics}>
              Download Diagnostics Log (.json)
            </button>
            <button
              type="button"
              class="btn-secondary"
              onClick={() => window.location.reload()}
            >
              Reload Quire
            </button>
          </div>
        </div>
      </div>
    );
  }
}
