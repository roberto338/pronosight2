// ══════════════════════════════════════════════
// PronoSight — Service Worker (PWA cache)
// ══════════════════════════════════════════════

const CACHE = 'pronosight-v4.1';
const STATIC = [
  '/',
  '/css/main.css',
  '/js/app.js',
  '/js/modules/config.js',
  '/js/modules/state.js',
  '/js/modules/api.js'
];

// Installation : mise en cache des assets statiques
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// Activation : suppression des anciens caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch : cache-first pour les assets, réseau pour les API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Toujours réseau pour les appels API et les requêtes non-GET
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    })
  );
});
