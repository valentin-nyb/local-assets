const CACHE = 'la-v2';
const NEVER_CACHE = ['/api/', '/login', 'google', 'oauth'];

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.delete('la-v1').then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never intercept API calls or auth
  if (NEVER_CACHE.some(p => url.includes(p))) return;
  // For everything else just fetch from network
  e.respondWith(fetch(e.request));
});
