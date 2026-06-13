// Service Worker for Portfolio Analytics PWA
const CACHE_NAME = 'portfolio-analytics-v17';

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
  BASE_PATH + '/vendor/chart.umd.js',
  BASE_PATH + '/vendor/read-excel-file.min.js',
  BASE_PATH + '/manifest.json',
  BASE_PATH + '/icons/icon-192.png',
  BASE_PATH + '/icons/icon-512.png'
];

// Files that should use stale-while-revalidate (serve cached immediately,
// fetch latest in background). CSS and HTML are included so style/layout
// fixes reach devices without requiring a cache-version bump.
const JS_FILES = new Set([
  '/app.js',
  '/auth.js',
  '/js/crypto.js',
  '/js/api.js',
  '/style.css',
  '/index.html',
  '/'
]);

// Install event - cache assets
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

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Helper: determine the strategy for a given request URL
function getStrategy(url) {
  const path = url.pathname;

  // API requests → always network
  if (path.startsWith(BASE_PATH + '/api/')) {
    return 'network-only';
  }

  // Data requests → always network (stale data is worse than offline)
  if (path.startsWith(BASE_PATH + '/data/')) {
    return 'network-only';
  }

  // JS files → stale-while-revalidate (serve cached immediately, fetch latest in background)
  for (const jsFile of JS_FILES) {
    if (path === BASE_PATH + jsFile || path.endsWith(jsFile)) {
      return 'stale-while-revalidate';
    }
  }

  // All other assets → cache-first (offline-first for HTML, CSS, vendor, icons)
  return 'cache-first';
}

// Fetch event - handle requests based on strategy
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const strategy = getStrategy(url);

  switch (strategy) {
    case 'network-only':
      event.respondWith(fetch(event.request));
      break;

    case 'stale-while-revalidate':
      event.respondWith(
        caches.match(event.request)
          .then((cachedResponse) => {
            // Fetch the latest from network in the background (no await)
            const fetchPromise = fetch(event.request)
              .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                  const responseToCache = networkResponse.clone();
                  caches.open(CACHE_NAME)
                    .then((cache) => cache.put(event.request, responseToCache));
                }
                return networkResponse;
              })
              .catch(() => {
                // Network failed — that's ok, we'll fall back to cache below
                return null;
              });

            // Return cached immediately if available, otherwise wait for network
            if (cachedResponse) {
              return cachedResponse;
            }
            return fetchPromise.then(networkResponse => {
              if (networkResponse) return networkResponse;
              // Offline fallback for navigation requests
              if (event.request.mode === 'navigate') {
                return caches.match(BASE_PATH + '/index.html');
              }
              return new Response('Offline', { status: 503 });
            });
          })
      );
      break;

    case 'cache-first':
    default:
      event.respondWith(
        caches.match(event.request)
          .then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }

            // Not in cache - fetch from network
            return fetch(event.request)
              .then((response) => {
                if (!response || response.status !== 200 || response.type !== 'basic') {
                  return response;
                }
                const responseToCache = response.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => {
                    cache.put(event.request, responseToCache);
                  });
                return response;
              })
              .catch(() => {
                if (event.request.mode === 'navigate') {
                  return caches.match(BASE_PATH + '/index.html');
                }
              });
          })
      );
      break;
  }
});

// Listen for SKIP_WAITING message from the page to activate new SW immediately
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Background sync for when app comes back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    console.log('Background sync triggered');
  }
});

// Push notifications (for future use)
self.addEventListener('push', (event) => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body,
      icon: BASE_PATH + '/icons/icon-192.png',
      badge: BASE_PATH + '/icons/icon-192.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: data.primaryKey
      }
    };
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

// Listen for SKIP_WAITING message from the page to activate new SW immediately
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Background sync for when app comes back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    console.log('Background sync triggered');
  }
});

// Push notifications (for future use)
self.addEventListener('push', (event) => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body,
      icon: BASE_PATH + '/icons/icon-192.png',
      badge: BASE_PATH + '/icons/icon-192.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: data.primaryKey
      }
    };
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});
