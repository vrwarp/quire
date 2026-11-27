import type { NightCanvasMode, PageSource, PaperTheme, ResolvedTheme, ThemeMode } from '../types';

export const THEME_STORAGE_KEY = 'quire-theme-mode';

export const THEME_META_COLORS: Record<ResolvedTheme, string> = {
  light: '#ebe6dc',
  dark: '#121418',
};

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function nextThemeMode(current: ThemeMode): ThemeMode {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

export function applyDocumentTheme(resolved: ResolvedTheme, mode?: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const meta =
      document.getElementById('meta-theme-color') ??
      document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', THEME_META_COLORS[resolved]);
    }
  }
  if (mode !== undefined) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures in private browsing or restricted contexts
    }
  }
}

/**
 * Resolves the view-time PaperTheme for a page without mutating persisted document state.
 * Exports always use the canonical `source.theme` directly so Night Canvas remains non-destructive.
 */
export function resolveEffectivePaperTheme(
  source: PageSource,
  resolvedUiTheme: ResolvedTheme,
  nightCanvasMode: NightCanvasMode
): PaperTheme {
  if (source.kind === 'template') {
    if (resolvedUiTheme === 'dark' && nightCanvasMode !== 'off') {
      return 'dark';
    }
    return source.theme;
  }
  if (resolvedUiTheme === 'dark' && nightCanvasMode === 'paper-and-pdf') {
    return 'dark';
  }
  return 'light';
}

export function shouldInvertPdfCanvas(
  source: PageSource,
  resolvedUiTheme: ResolvedTheme,
  nightCanvasMode: NightCanvasMode
): boolean {
  return source.kind === 'pdf' && resolvedUiTheme === 'dark' && nightCanvasMode === 'paper-and-pdf';
}
