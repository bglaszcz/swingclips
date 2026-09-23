const CACHE_NAME = 'swingclips-cache-v19';
const PRE_CACHE = [
  '/',
  '/manifest.json',
  '/favicon.png',
  '/gg-logo-square.png',
  '/ffmpeg/ffmpeg-core.js',
  '/ffmpeg/ffmpeg-core.wasm'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRE_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // COMPLETELY IGNORE Next.js internal resources and HMR in development
  if (url.pathname.startsWith('/_next/') || url.pathname.includes('webpack-hmr')) {
    return;
  }

  // Custom caching for FFMPEG and MediaPipe (pose) assets
  if (url.pathname.includes('/ffmpeg/') || url.pathname.includes('/mediapipe/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return response;
        });
      })
    );
    return;
  }
  
  // Generic response to satisfy Chrome's PWA install criteria
  // We don't necessarily cache everything else to avoid breaking Next.js hot-reloading
  // but we MUST provide a response for the fetch event.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match('/');
      })
    );
  } else {
    // For other assets, we can just let them pass through, 
    // but some versions of Chrome require respondWith to be called.
    // If it's already in the cache (like our pre-cached icons), serve it.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request);
      })
    );
  }
});
