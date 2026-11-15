/* Archivio Scarpe - service worker v4 */
const CACHE = 'archivio-scarpe-shell-v22';
const SHELL = ['./', './index.html', './manifest.webmanifest', './privacy.html', './cookie.html',
  './assets/archivio-scarpe-logo.svg', './assets/app.css', './assets/icons.css', './assets/icons.ttf', './assets/catalogo.js'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('archivio-scarpe-shell-') && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
function isAppNavigation(request, url) {
  return request.mode === 'navigate' && url.origin === self.location.origin &&
    (url.pathname === new URL('./', self.registration.scope).pathname || url.pathname === new URL('./index.html', self.registration.scope).pathname);
}
function cacheable(request, url) {
  if (request.method !== 'GET' || url.protocol !== 'https:') return false;
  if (url.hostname === 'generativelanguage.googleapis.com') return false;
  if (url.searchParams.has('key') || url.searchParams.has('api_key')) return false;
  if (url.origin === self.location.origin) return url.pathname.startsWith(new URL(self.registration.scope).pathname);
  return ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com'].includes(url.hostname);
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const catalogUrl = new URL('./catalogo-awin.json', self.registration.scope);
  if (url.origin === catalogUrl.origin && (url.pathname === catalogUrl.pathname ||
      url.pathname === new URL('./catalogo-awin-indice.json', self.registration.scope).pathname)) return;
  const adminUrl = new URL('./admin/', self.registration.scope);
  if (request.method === 'GET' && url.origin === adminUrl.origin &&
      (url.pathname === adminUrl.pathname.slice(0, -1) || url.pathname.startsWith(adminUrl.pathname))) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (isAppNavigation(request, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh.ok) await cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return await cache.match('./index.html') || await cache.match('./') || Response.error();
      }
    })());
    return;
  }
  if (request.cache === 'no-store' || !cacheable(request, url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      try { await cache.put(request, response.clone()); } catch {}
    }
    return response;
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'PREPARE_OFFLINE') return;
  event.waitUntil((async () => {
    const port = event.ports[0];
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      port?.postMessage({ ok: true });
    } catch (error) { port?.postMessage({ ok: false, error: error.message }); }
  })());
});
