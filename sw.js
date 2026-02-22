const CACHE_NAME = 'cyclonesync-tracker-20260222T115200';

const LOCAL_ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './img/bg.webp',
    './img/CycloneSync.svg',
    './img/CycloneSync-192.png',
    './img/CycloneSync-512.png',
    './font/Beleren2016-Bold.woff'
];

const EXTERNAL_ASSETS = [
    'https://cdn.jsdelivr.net/npm/keyrune@latest/css/keyrune.css',
    'https://cdn.jsdelivr.net/npm/mana-font@latest/css/mana.css',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://unpkg.com/html5-qrcode',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-check.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching App Shell');

            return cache.addAll(LOCAL_ASSETS).then(() => {
                console.log('[Service Worker] Caching External Assets');
                return cache.addAll(EXTERNAL_ASSETS).catch(err => {
                    console.warn('[Service Worker] Failed to cache external assets:', err);
                });
            });
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());

    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('[Service Worker] Removing old cache', key);
                    return caches.delete(key);
                }
            }));
        })
    );
});

self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    if (event.request.method !== 'GET' ||
        requestUrl.hostname.includes('firebaseio.com') ||
        requestUrl.hostname.includes('googleapis.com')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || (networkResponse.type !== 'basic' && networkResponse.type !== 'cors')) {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return networkResponse;
            }).catch((err) => {
                console.warn('[Service Worker] Fetch failed, offline mode:', err);
            });
        })
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});