/* Robbi — service worker: caché offline total */
const C = 'chispi-v2';
const CORE = ['./', 'index.html', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit =>
      hit ||
      fetch(e.request)
        .then(net => {
          const cp = net.clone();
          caches.open(C).then(c => c.put(e.request, cp)).catch(() => {});
          return net;
        })
        .catch(() => caches.match('index.html'))
    )
  );
});
