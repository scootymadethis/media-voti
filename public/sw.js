// Service worker di Skoolio: tiene sul dispositivo i file statici versionati (app/*.js?v=, styles/*.css?v=,
// assets/) così le sezioni si aprono subito anche dopo aver chiuso l'app. Niente cache per le API e
// per le pagine HTML (sempre dalla rete: le versioni nuove arrivano subito).
const CACHE = "skoolio-static-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// La pagina comunica la versione in uso: i file di versioni vecchie vengono eliminati.
self.addEventListener("message", (event) => {
  const v = event.data?.type === "version" ? String(event.data.v) : null;
  if (!v) return;
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    for (const req of await cache.keys()) {
      const reqV = new URL(req.url).searchParams.get("v");
      if (reqV && reqV !== v) await cache.delete(req);
    }
  }));
});

// "versioned": file con ?v= (non cambiano mai: dalla cache). "asset": immagini e librerie senza
// versione (dalla cache, aggiornate in sottofondo per la volta dopo). Tutto il resto: rete normale.
function kind(url) {
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return null;
  if (url.searchParams.has("v") && /^\/(app|styles)\//.test(url.pathname)) return "versioned";
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vendor/")) return "asset";
  return null;
}

const store = (cache, req, res) => {
  if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
  return res;
};

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const k = kind(new URL(req.url));
  if (!k) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    if (hit && k === "versioned") return hit;
    const network = fetch(req).then((res) => store(cache, req, res));
    if (hit) { event.waitUntil(network.catch(() => {})); return hit; }
    return network;
  }));
});
