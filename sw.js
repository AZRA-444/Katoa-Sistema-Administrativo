/* Service worker de Katoa.
 *
 * Reglas de seguridad:
 *  - /api/* NUNCA pasa por aquí: sesión, facturas y datos van siempre directo a la red.
 *  - Las páginas HTML no se guardan (cada una ejecuta auth-guard y consulta /api/sesion);
 *    si no hay conexión se muestra /offline.html.
 *  - Solo se guardan estáticos del mismo origen: CSS, JS, fuentes, íconos.
 *
 * Para publicar una versión nueva de los estáticos, sube VERSION.
 */
'use strict';

const VERSION = 'katoa-v1';
const CACHE_ESTATICO = VERSION + '-estatico'; // vendor, íconos, offline (cache-first)
const CACHE_APP = VERSION + '-app';           // js y css propios (red primero)
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  OFFLINE_URL,
  '/assets/css/global.css',
  '/assets/vendor/fonts-5.3.0/fonts.css',
  '/assets/vendor/fonts-5.3.0/inter-latin-400-normal.woff2',
  '/assets/vendor/fonts-5.3.0/inter-latin-500-normal.woff2',
  '/assets/vendor/fonts-5.3.0/inter-latin-600-normal.woff2',
  '/assets/vendor/fonts-5.3.0/cormorant-garamond-latin-500-normal.woff2',
  '/assets/vendor/fontawesome-6.5.1/css/all.min.css',
  '/assets/vendor/fontawesome-6.5.1/webfonts/fa-solid-900.woff2',
  '/assets/img/icons/icon-192.png',
  '/assets/img/icons/icon-512.png',
  '/assets/img/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_ESTATICO).then((cache) =>
      // Un archivo que falle no debe impedir instalar el resto
      Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
    )
  );
  // NO se llama skipWaiting() aquí: la nueva versión espera a que el usuario toque
  // «Actualizar» (evita cambiar de versión a mitad de una venta).
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const vigentes = [CACHE_ESTATICO, CACHE_APP];
      const nombres = await caches.keys();
      await Promise.all(nombres.filter((n) => !vigentes.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const esCacheable = (res) => res && res.ok && res.type === 'basic';

async function cacheFirst(req, nombre) {
  const cache = await caches.open(nombre);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (esCacheable(res)) cache.put(req, res.clone());
  return res;
}

async function redPrimero(req, nombre) {
  const cache = await caches.open(nombre);
  try {
    const res = await fetch(req);
    if (esCacheable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function navegacion(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cache = await caches.open(CACHE_ESTATICO);
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, etc.: sin intervenir
  if (url.pathname.startsWith('/api/')) return;    // datos y sesión: siempre red

  if (req.mode === 'navigate') {
    event.respondWith(navegacion(req));
    return;
  }
  if (/^\/assets\/(vendor|img)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(req, CACHE_ESTATICO));
    return;
  }
  if (/^\/(js|assets\/css)\//.test(url.pathname)) {
    event.respondWith(redPrimero(req, CACHE_APP));
  }
});
