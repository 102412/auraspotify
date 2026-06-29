const CACHE_NAME = 'aura-shell-v1';
const SHELL_FILES = [
  '/app.html',
  '/index.html',
  '/callback.html',
  '/style.css',
  '/app.js',
  '/auth.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isSpotifyApi = url.includes('api.spotify.com') || url.includes('accounts.spotify.com');

  if (isSpotifyApi) {
    // Network-first: never cache live music/account data
    event.respondWith(
      fetch(event.request).catch(() => new Response(null, { status: 503 }))
    );
    return;
  }

  // Cache-first for the app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      });
    })
  );
});
