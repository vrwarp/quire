/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

const TIER2_CACHE = 'quire-tier2-assets-v1';
const SHARE_STAGING_CACHE = 'quire-share-staging-v1';

// Tier-1 eager precache (App Shell, InkWorker, StorageWorker, sqlite3.wasm, icons)
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
clientsClaim();

// Tier-2 runtime cache for PDFium-WASM and Unicode export fonts (warmed in requestIdleCallback)
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    (url.pathname.endsWith('.wasm') || url.pathname.includes('/fonts/')),
  new CacheFirst({ cacheName: TIER2_CACHE })
);

// Same-origin assets fallback (stale-while-revalidate)
registerRoute(
  ({ request, url }) =>
    request.method === 'GET' && url.origin === self.location.origin && !url.searchParams.has('share-target'),
  new StaleWhileRevalidate({ cacheName: 'quire-runtime-v1' })
);

// Intercept POST ?share-target=1 on static hosts (GitHub Pages) -> stage file & redirect
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.searchParams.get('share-target') === '1'
  ) {
    event.respondWith(
      (async () => {
        try {
          const formData = await request.formData();
          const file = formData.get('file');
          if (file instanceof File) {
            const cache = await caches.open(SHARE_STAGING_CACHE);
            const stagedUrl = new URL('./__shared_file__', self.registration.scope).href;
            const headers = new Headers({
              'Content-Type': file.type || 'application/octet-stream',
              'X-Quire-File-Name': encodeURIComponent(file.name || 'shared-file'),
            });
            await cache.put(stagedUrl, new Response(await file.arrayBuffer(), { headers }));
          }
        } catch {
          // Non-fatal; redirect back to app
        }
        return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
      })()
    );
  }
});

// Safe update lifecycle + Tier-2 idle asset warm-up
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; urls?: string[] } | null;
  if (!data?.type) return;

  if (data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
    return;
  }

  if (data.type === 'WARM_TIER2' && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(TIER2_CACHE);
        for (const u of data.urls!) {
          try {
            const existing = await cache.match(u);
            if (!existing) {
              const resp = await fetch(u);
              if (resp.ok) await cache.put(u, resp);
            }
          } catch {
            // Retry next online session
          }
        }
      })()
    );
  }
});
