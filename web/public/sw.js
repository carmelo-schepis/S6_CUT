const CACHE = "s6-cut-shell-v3";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.png",
  "/app-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

function isShellAsset(url, request) {
  return url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    ["/favicon.png", "/app-icon.png"].includes(url.pathname) ||
    request.destination === "font";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() => caches.match("/")),
    );
    return;
  }

  if (!isShellAsset(url, request)) return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    }).catch(() => caches.match(request)),
  );
});
