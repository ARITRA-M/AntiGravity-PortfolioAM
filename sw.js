// Service Worker for Portfolio Analytics PWA
const CACHE_NAME = 'portfolio-analytics-v147';

// Determine the base path - works on both local server (/) and GitHub Pages subpath
const BASE_PATH = self.location.pathname.replace(/\/sw\.js$/, '') || '';

const ASSETS_TO_CACHE = [
  BASE_PATH + '/',
  BASE_PATH + '/index.html',
  BASE_PATH + '/style.css',
  BASE_PATH + '/app.js',
  BASE_PATH + '/auth.js',
  BASE_PATH + '/js/crypto.js',
  BASE_PATH + '/js/api.js',
  BASE_PATH + '/js/ledger.js',
  BASE_PATH + '/js/export.js',
  BASE_PATH + '/vendor/chart.umd.js',
  BASE_PATH + '/vendor/xlsx.core.min.js',
  BASE_PATH + '/manifest.json',
  BASE_PATH + '/icons/icon-192.png',
  BASE_PATH + '/icons/icon-512.png'
];

// Core app files use network-first so users always run the latest code/markup
// after a deploy — never one visit behind due to stale-while-revalidate.
// index.html and '/' are included so DOM changes (e.g. new table columns)
// never lag a reload behind the JS that renders into them.
const NETWORK_FIRST_FILES = new Set([
  '/app.js',
  '/auth.js',
  '/js/api.js',
  '/js/crypto.js',
  '/js/ledger.js',
  '/js/export.js',
  '/index.html',
  '/',
]);

// Other assets use stale-while-revalidate — serve cached immediately,
// fetch latest in background (fine for stylesheets and vendor bundles).
const STALE_WHILE_REVALIDATE_FILES = new Set([
  '/style.css',
]);

// Install event — cache all assets fresh from network
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching app assets with base path:', BASE_PATH);
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event — delete old caches, claim all clients, force-reload on update
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        const oldCaches = cacheNames.filter((name) => name !== CACHE_NAME);
        const isUpdate = oldCaches.length > 0;
        return Promise.all(oldCaches.map((name) => caches.delete(name)))
          .then(() => self.clients.claim())
          .then(() => {
            if (!isUpdate) return; // first install — page already has fresh code
            return self.clients.matchAll({ type: 'window' }).then((clients) => {
              clients.forEach((client) => client.postMessage({ type: 'RELOAD_APP' }));
            });
          });
      })
  );
});

// Helper: classify a request into a fetch strategy
function getStrategy(url) {
  const path = url.pathname;

  // API requests → always network
  if (path.startsWith(BASE_PATH + '/api/')) return 'network-only';

  // Data JSON files → always network (stale data is worse than offline)
  if (path.startsWith(BASE_PATH + '/data/')) return 'network-only';

  // Core JS files → network-first (always latest after a deploy)
  for (const f of NETWORK_FIRST_FILES) {
    if (path === BASE_PATH + f || path.endsWith(f)) return 'network-first';
  }

  // Style/HTML → stale-while-revalidate
  for (const f of STALE_WHILE_REVALIDATE_FILES) {
    if (path === BASE_PATH + f || path.endsWith(f)) return 'stale-while-revalidate';
  }

  // Vendor bundles, icons, manifest → cache-first (rarely changes)
  return 'cache-first';
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const strategy = getStrategy(url);

  switch (strategy) {

    case 'network-only':
      event.respondWith(fetch(event.request));
      break;

    case 'network-first':
      event.respondWith(
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return networkResponse;
          })
          .catch(() =>
            caches.match(event.request).then((cached) => {
              if (cached) return cached;
              // Offline navigation with no exact cache hit → serve app shell.
              if (event.request.mode === 'navigate') return caches.match(BASE_PATH + '/index.html');
              return new Response('Offline', { status: 503 });
            })
          )
      );
      break;

    case 'stale-while-revalidate':
      event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                const clone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
              }
              return networkResponse;
            })
            .catch(() => null);

          return cachedResponse || fetchPromise.then((r) => {
            if (r) return r;
            if (event.request.mode === 'navigate') return caches.match(BASE_PATH + '/index.html');
            return new Response('Offline', { status: 503 });
          });
        })
      );
      break;

    case 'cache-first':
    default:
      event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          return fetch(event.request).then((response) => {
            if (!response || response.status !== 200 || response.type !== 'basic') return response;
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          }).catch(() => {
            if (event.request.mode === 'navigate') return caches.match(BASE_PATH + '/index.html');
          });
        })
      );
      break;
  }
});

// Allow the page to force-activate a waiting SW (used by some update prompts)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
