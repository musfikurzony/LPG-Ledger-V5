// LPG Ledger service worker — caches the app shell so the app can open,
// log in, and browse previously-loaded data with no internet connection.
// Live Supabase reads/writes still need a real connection; this only
// covers the static app shell + whatever data the app has already
// cached into localStorage after a successful online load.

const CACHE_VERSION = 'lpg-ledger-shell-v2';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tabler-icons/2.44.0/iconfont/tabler-icons.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try{ await cache.addAll(SHELL_URLS); }catch(e){ console.error('shell precache failed', e); }
    // CDN resources are cross-origin; cache them best-effort one at a time
    // so one failure doesn't block the rest (addAll fails all-or-nothing).
    await Promise.all(CDN_URLS.map(async (url) => {
      try{
        const res = await fetch(url, { mode:'cors' }).catch(() => fetch(url, { mode:'no-cors' }));
        await cache.put(url, res);
      }catch(e){ /* best effort — offline install, or CDN unreachable right now */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  // Never cache Supabase API/storage calls — those must always be live.
  if(req.url.indexOf('supabase.co') !== -1){
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell (HTML navigations): try the network first so users get the
  // latest version when online, but fall back to the cached shell instantly
  // when offline instead of showing a browser error page.
  if(req.mode === 'navigate' || req.destination === 'document'){
    event.respondWith((async () => {
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      }catch(e){
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./index.html')) || (await cache.match('./'));
      }
    })());
    return;
  }

  // Everything else (manifest, icons, CDN libs, css/js): cache-first for
  // instant offline use, refreshing the cache in the background when online.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const networkFetch = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await networkFetch) || new Response('', { status: 503 });
  })());
});
