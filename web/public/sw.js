const CACHE = "s6-cut-shell-v11";
const CACHE_PREFIX = "s6-cut-shell-";
const SHELL = [
  "/",
  "/index.html",
  "/startup.css?v=6",
  "/manifest.webmanifest",
  "/favicon.png",
  "/app-icon.png",
  "/brand-logo.png",
  "/legal-logo.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

async function precacheShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);

  // The production bundle is content-hashed, so discover the current JS/CSS
  // names from the shell instead of pinning an asset list in this worker.
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) return;
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  await Promise.all(assets.map(async (asset) => {
    const assetResponse = await fetch(asset, { cache: "no-store" });
    if (assetResponse.ok) await cache.put(asset, assetResponse);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  // Do not skip waiting here. The page owns the update decision so an active
  // render is never interrupted by a background deployment.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isShellAsset(url, request) {
  if (request.headers.has("range")) return false;
  if (["/manifest.webmanifest", "/startup.css"].includes(url.pathname)) return true;
  if (url.pathname.startsWith("/icons/")) return true;
  if (["/favicon.png", "/app-icon.png", "/brand-logo.png", "/legal-logo.png"].includes(url.pathname)) return true;
  return url.pathname.startsWith("/assets/") && ["script", "style"].includes(request.destination);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate" && request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(async () => {
        const fallback = await caches.match("/") || await caches.match("/index.html");
        return fallback || Response.error();
      }),
    );
    return;
  }

  if (!isShellAsset(url, request)) return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).then((response) => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    }).catch(() => caches.match(request)),
  );
});
