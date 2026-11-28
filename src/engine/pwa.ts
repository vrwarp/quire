import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { logDiagnostic } from './diagnostics';

const SHARE_STAGING_CACHE = 'quire-share-staging-v1';

export interface PwaUpdateController {
  applyUpdate: () => void;
}

/**
 * Registers the Workbox Service Worker with a safe update prompt lifecycle (never forces
 * reload mid-session/mid-recording) and warms Tier-2 offline assets (`pdfium.wasm` +
 * Unicode export font) during browser idle time.
 */
export function registerQuireServiceWorker(
  onUpdateReady: (controller: PwaUpdateController) => void
): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !import.meta.env.PROD) {
    return;
  }

  const warmTier2 = (reg: ServiceWorkerRegistration) => {
    const sw = reg.active ?? navigator.serviceWorker.controller;
    if (!sw) return;
    const base = import.meta.env.BASE_URL || '/';
    const fontUrl = new URL(`${base}fonts/DejaVuSans.ttf`, window.location.origin).href;
    const pdfiumUrl = new URL(pdfiumWasmUrl, window.location.origin).href;
    sw.postMessage({ type: 'WARM_TIER2', urls: [pdfiumUrl, fontUrl] });
  };

  window.addEventListener('load', () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    void navigator.serviceWorker
      .register(swUrl)
      .then((reg) => {
        const notifyWaiting = (waiting: ServiceWorker) => {
          onUpdateReady({
            applyUpdate: () => {
              waiting.postMessage({ type: 'SKIP_WAITING' });
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => window.location.reload(),
                { once: true }
              );
            },
          });
        };

        if (reg.waiting) {
          notifyWaiting(reg.waiting);
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              notifyWaiting(installing);
            }
          });
        });

        // Schedule Tier-2 offline warm-up during idle time after initial <1.5s paint
        const scheduleIdle =
          typeof requestIdleCallback === 'function'
            ? requestIdleCallback
            : (cb: () => void) => window.setTimeout(cb, 2500);
        scheduleIdle(() => warmTier2(reg));
      })
      .catch((err) => {
        logDiagnostic('warn', 'pwa', 'Service worker registration skipped', err);
      });
  });
}

/**
 * Consumes OS `file_handlers` (`window.launchQueue`) and Service Worker `POST ?share-target=1`
 * staged files so opening/sharing PDFs or `.quire` archives imports them directly.
 */
export function attachOsFileHandlers(onFileReceived: (file: File) => void): void {
  if (typeof window === 'undefined') return;

  // 1. Desktop / ChromeOS / Android PWA `launchQueue` (`file_handlers`)
  const win = window as Window & {
    launchQueue?: {
      setConsumer: (cb: (launchParams: { files?: Array<{ getFile: () => Promise<File> }> }) => void) => void;
    };
  };
  if (win.launchQueue?.setConsumer) {
    win.launchQueue.setConsumer((launchParams) => {
      if (!launchParams.files?.length) return;
      for (const handle of launchParams.files) {
        void handle
          .getFile()
          .then((file) => onFileReceived(file))
          .catch((err) => logDiagnostic('warn', 'pwa.launchQueue', 'Failed to read launched file', err));
      }
    });
  }

  // 2. Service Worker `POST ?share-target=1` staged file (`/?shared=1`)
  const params = new URLSearchParams(window.location.search);
  if (params.get('shared') === '1' && typeof caches !== 'undefined') {
    void (async () => {
      try {
        const cache = await caches.open(SHARE_STAGING_CACHE);
        const stagedUrl = new URL('./__shared_file__', window.location.href).href;
        const resp = await cache.match(stagedUrl);
        if (resp) {
          const rawName = resp.headers.get('X-Quire-File-Name');
          const fileName = rawName ? decodeURIComponent(rawName) : 'shared-file.pdf';
          const mime = resp.headers.get('Content-Type') || 'application/octet-stream';
          const blob = await resp.blob();
          const file = new File([blob], fileName, { type: mime });
          await cache.delete(stagedUrl);
          onFileReceived(file);
        }
      } catch (err) {
        logDiagnostic('warn', 'pwa.shareTarget', 'Failed to consume shared file', err);
      } finally {
        // Clean `?shared=1` query param without reloading
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('shared');
        window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
    })();
  }
}
