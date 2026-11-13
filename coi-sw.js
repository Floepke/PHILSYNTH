// Cross-origin isolation for hosts that can't send headers (GitHub Pages). The PATCH instance
// workers need SharedArrayBuffer (src/dsp/instancepool.js), which needs the page served with
// COOP same-origin + COEP require-corp. This service worker adds those headers to every
// same-origin response; the inline script in index.html registers it and reloads once so the
// page itself comes through it. server.mjs (and so the desktop app) sends the headers itself,
// so there the page is isolated already and this file is never registered.
// It lives at the site root: a service worker only controls pages at or below its own path.

const ISOLATED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // everything the app loads is same-origin; other requests go to the network untouched
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then((res) => {
    if (res.status === 0 || res.type === 'opaqueredirect') return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATED)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
