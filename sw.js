const NEVER_CACHE = ['/api/', '/login', 'google', 'oauth'];

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never intercept API calls, auth routes, or page navigations
  if (e.request.mode === 'navigate') return;
  if (NEVER_CACHE.some(p => url.includes(p))) return;
  // Pass everything else straight to the network with a safe catch
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});
