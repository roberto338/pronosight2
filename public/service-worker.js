// ══════════════════════════════════════════════
// PronoSight — Service Worker (PWA cache)
// ══════════════════════════════════════════════

const CACHE = 'pronosight-v5.5';

// Assets statiques mis en cache (JS/CSS uniquement — PAS index.html)
const STATIC_ASSETS = [
  '/css/main.css',
  '/js/modules/config.js',
  '/js/modules/state.js',
  '/js/modules/api.js'
];

// Installation
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activation : supprime tous les anciens caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Toujours réseau : API + non-GET
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  // index.html → TOUJOURS réseau (évite de servir une vieille UI depuis le cache)
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
    return;
  }

  // app.js → network-first (met à jour le cache à chaque visite)
  if (url.pathname === '/js/app.js') {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Autres assets (CSS, modules) → cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      });
    })
  );
});
