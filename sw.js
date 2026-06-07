// Service Worker for Portfolio Analytics PWA
const CACHE_NAME = 'portfolio-analytics-v8';

// Determine the base path - works on both local server (/) and GitHub Pages subpath
const BASE_PATH = self.location.pathname.replace(/\/sw\.js$/, '') || '';

const ASSETS_TO_CACHE = [
  BASE_PATH + '/',
  BASE_PATH + '/index.html',
  BASE_PATH + '/style.css',
  BASE_PATH + '/app.js',
  BASE_PATH + '/auth.js',
  BASE_PATH + '/js/api.js',
  BASE_PATH + '/vendor/chart.umd.js',
  BASE_PATH + '/vendor/read-excel-file.min.js',
  BASE_PATH + '/manifest.json',
  BASE_PATH + '/icons/icon-192.png',
  BASE_PATH + '/icons/icon-512.png'
];

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

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip API requests - always go to network
  if (url.pathname.startsWith(BASE_PATH + '/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-First strategy for data directory to support offline mode
  if (url.pathname.startsWith(BASE_PATH + '/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Not in cache - fetch from network
        return fetch(event.request)
          .then((response) => {
            // Don't cache non-successful responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response
            const responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });

            return response;
          })
          .catch(() => {
            // Return offline page for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match(BASE_PATH + '/index.html');
            }
          });
      })
  );
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
