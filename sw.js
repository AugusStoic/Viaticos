/* Service worker: guarda la app en el teléfono para que abra sin internet.
   - config.json y datos.cifrado: primero intenta bajar la versión nueva; si no hay señal, usa la guardada.
   - El resto de los archivos: abre lo guardado al instante y se actualiza por detrás.
   Si se cambia el código de la app, subir el número de VERSION. */
const VERSION = 'viaticos-v5';
const ARCHIVOS = [
  './', 'index.html', 'styles.css', 'app.js', 'datos.js', 'xlsx-mini.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'config.json', 'datos.cifrado', 'guia-personal.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const esDato = /\/(config\.json|datos\.cifrado)$/.test(url.pathname);
  if (esDato) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copia = r.clone();
        if (r.ok) caches.open(VERSION).then(c => c.put(url.pathname, copia));
        return r;
      }).catch(() => caches.match(url.pathname, { ignoreSearch: true }))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(guardado => {
      const deRed = fetch(e.request).then(r => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); }
        return r;
      }).catch(() => guardado);
      return guardado || deRed;
    })
  );
});
