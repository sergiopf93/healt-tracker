const CACHE_NAME = "health-tracker-shell-v5";
const BASE_URL = new URL("./", self.location.href);
const SHELL_FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./src/main.mjs",
  "./src/domain.mjs", "./src/styles.css", "./src/data/repository.mjs", "./src/data/remote-repository.mjs",
  "./src/integrations/apple-health/parser.mjs", "./src/integrations/apple-health/shortcut.mjs", "./icons/app-icon.svg",
  "./icons/app-icon-192.png", "./icons/app-icon-512.png", "./icons/apple-touch-icon.png"
].map(path => new URL(path, BASE_URL).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES.map(url => new Request(url, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("health-tracker-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== BASE_URL.origin || requestUrl.searchParams.has("healthData")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-cache" }).catch(() => caches.match(new URL("./index.html", BASE_URL).href)));
    return;
  }
  if (!SHELL_FILES.includes(requestUrl.href)) return;
  const responsePromise = fetch(request, { cache: "no-cache" });
  event.waitUntil(responsePromise.then(async response => {
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(requestUrl.href, copy);
    }
  }).catch(() => {}));
  event.respondWith(responsePromise.catch(async error => {
    const cached = await caches.match(requestUrl.href);
    if (cached) return cached;
    throw error;
  }));
});
