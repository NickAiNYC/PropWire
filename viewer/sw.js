// PropWire Service Worker (offline shell only; market data always fails closed)
const CACHE_NAME = 'propwire-v147-prod';
const STATIC_ASSETS = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/style.css?v=2026_v147',
  '/app.js?v=2026_v147',
  '/js/sports/registry.js?v=2026_v147',
  '/js/sports/nfl.js?v=2026_v147',
  '/js/sports/nba.js?v=2026_v147',
  '/propwire-logo.svg?v=2026_v147',
  '/propwire-logo-dark.svg?v=2026_v147',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache quotes, health state, picks, receipts, or other JSON/CSV data.
  // An offline research shell is useful; an offline price presented as current is not.
  if (/\.(?:json|csv)$/i.test(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match('/index.html'))
        .then((response) => response || new Response('PropWire is offline. Live market data is unavailable.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }))
    );
    return;
  }

  const isStaticAsset = ['script', 'style', 'image', 'font', 'manifest'].includes(event.request.destination);
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response && response.ok && response.type === 'basic') {
        const clone = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)));
      }
      return response;
    }))
  );
});
