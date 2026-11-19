self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
  );
});

self.addEventListener('fetch', (event) => {
  // Пропускаем все запросы напрямую в сеть
});
