const CACHE = 'la-v1';

const STATIC = [
    '/dashboard.html',
    '/camera.html',
    '/assets.html',
    '/nav-component.js',
    '/styles/tailwind.css',
    '/styles/theme.css',
    '/favicon/site.webmanifest',
    '/favicon/apple-touch-icon.png',
    '/favicon/favicon.ico',
    '/favicon/favicon.svg',
    '/favicon/web-app-manifest-192x192.png',
    '/favicon/web-app-manifest-512x512.png',
    '/logos/White@2x.png',
    '/logos/Green@2x.png',
    '/logos/Black@2x.png',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const { request } = e;
    const url = new URL(request.url);

    // Never intercept API calls — always hit the network
    if (url.pathname.startsWith('/api/')) return;

    // HTML navigation: network-first so updates land immediately; fall back to cache
    if (request.mode === 'navigate') {
        e.respondWith(
            fetch(request)
                .then(res => {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(request, clone));
                    return res;
                })
                .catch(() => caches.match(request).then(cached => cached || caches.match('/dashboard.html')))
        );
        return;
    }

    // Static assets: cache-first, update in background
    e.respondWith(
        caches.match(request).then(cached => {
            const network = fetch(request).then(res => {
                if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
                return res;
            });
            return cached || network;
        })
    );
});
