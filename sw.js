const CACHE_NAME = "health-tracker-shell-v1";
const BASE_URL = new URL("./", self.location.href);
const SHELL_FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./src/main.mjs",
  "./src/domain.mjs", "./src/styles.css", "./src/data/repository.mjs",
  "./src/integrations/apple-health/parser.mjs", "./icons/app-icon.svg",
  "./icons/app-icon-192.png", "./icons/app-icon-512.png", "./icons/apple-touch-icon.png"
].map(path => new URL(path, BASE_URL).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("health-tracker-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== BASE_URL.origin || requestUrl.searchParams.has("healthData")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => response).catch(() => caches.match(new URL("./index.html", BASE_URL).href)));
    return;
  }
  if (!SHELL_FILES.includes(requestUrl.href)) return;
  event.respondWith(caches.match(requestUrl.href).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(requestUrl.href, response.clone()));
    return response;
  })));
});
