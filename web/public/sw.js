/* ClipWarp Service Worker
 * - navigation 请求：network-first（防止 index.html 被缓存导致升级失效）
 * - 静态资源：cache-first
 * - /api 与 /ws：永不缓存（不拦截）
 */
const CACHE = 'clipwarp-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add('/').catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // /api 与 /ws 永不缓存，直接走网络（不拦截）
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // 导航请求：network-first，离线时回退缓存的 '/'
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const cache = await caches.open(CACHE);
            cache.put('/', res.clone());
          }
          return res;
        } catch {
          const cached = await caches.match('/');
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：cache-first
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});
