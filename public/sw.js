const CACHE = "central-vault-v3";
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Nur eigene GET-Anfragen. Alles Fremde – insbesondere Supabase – geht
  // unangetastet ans Netz, damit kein Chiffrat im Cache landet.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const isShell = request.mode === "navigate"
    || url.pathname.endsWith("/")
    || url.pathname.endsWith("/index.html");

  if (isShell) {
    // index.html immer zuerst aus dem Netz: sonst verweist eine gecachte
    // Seite dauerhaft auf ein altes Bundle und die App aktualisiert sich nie.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Gebaute Dateien tragen einen Hash im Namen und sind damit unveränderlich –
  // die dürfen aus dem Cache kommen.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
