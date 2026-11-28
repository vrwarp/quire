import type { DiagnosticEntry } from '../types';

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];
const listeners = new Set<() => void>();
let globalHooksInstalled = false;

export function logDiagnostic(
  level: DiagnosticEntry['level'],
  source: string,
  message: string,
  detail?: unknown
): void {
  let detailStr: string | undefined;
  if (detail instanceof Error) {
    detailStr = detail.stack ? `${detail.message}\n${detail.stack}` : detail.message;
  } else if (detail !== undefined) {
    try {
      detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch {
      detailStr = String(detail);
    }
  }
  entries.push({
    ts: Date.now(),
    level,
    source,
    message,
    detail: detailStr?.slice(0, 1200),
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  listeners.forEach((fn) => fn());
}

export function getDiagnostics(): DiagnosticEntry[] {
  return [...entries];
}

export function clearDiagnostics(): void {
  entries.length = 0;
  listeners.forEach((fn) => fn());
}

export function subscribeDiagnostics(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installGlobalDiagnostics(): void {
  if (globalHooksInstalled || typeof window === 'undefined') return;
  globalHooksInstalled = true;

  window.addEventListener('error', (ev) => {
    logDiagnostic(
      'error',
      'window.error',
      ev.message || 'Uncaught error',
      ev.error ?? `${ev.filename}:${ev.lineno}:${ev.colno}`
    );
  });

  window.addEventListener('unhandledrejection', (ev) => {
    logDiagnostic('error', 'unhandledrejection', 'Unhandled promise rejection', ev.reason);
  });
}

export function buildDiagnosticsReport(extra?: Record<string, unknown>): string {
  const payload = {
    app: 'Quire',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    standalone:
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone)),
    extra: extra ?? {},
    entries: getDiagnostics(),
  };
  return JSON.stringify(payload, null, 2);
}
