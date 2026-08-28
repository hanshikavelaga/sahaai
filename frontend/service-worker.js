const CACHE_NAME = "sahaai-cache-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// Install Event: cache static resources
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => {
        console.warn("Service worker asset caching skipped during install:", err);
      });
    })
  );
  self.skipWaiting();
});

// Activate Event: clear old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event: network-first fallback to cache
self.addEventListener("fetch", (e) => {
  // Only handle GET requests and ignore WebSocket connections
  if (e.request.method !== "GET" || e.request.url.startsWith("ws")) {
    return;
  }
  
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Cache the fresh resource clone
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, resClone);
        });
        return res;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(e.request);
      })
  );
});
