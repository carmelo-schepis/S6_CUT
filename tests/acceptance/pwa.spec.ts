import { expect, test } from "@playwright/test";

function pngDimensions(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("production PWA manifest, icons, and service worker are valid", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("S6_cut — Local video studio");
  expect(manifest.short_name).toBe("S6_cut");
  expect(manifest.lang).toBe("en");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.background_color).toBe("#010102");
  expect(manifest.theme_color).toBe("#0b0b0e");
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
    expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
    expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
  ]));

  const iconSizes = new Map([
    ["/icons/icon-192.png", { width: 192, height: 192 }],
    ["/icons/icon-512.png", { width: 512, height: 512 }],
    ["/icons/icon-maskable-512.png", { width: 512, height: 512 }],
    ["/icons/apple-touch-icon.png", { width: 180, height: 180 }],
    ["/favicon.png", { width: 64, height: 64 }],
  ]);
  for (const [icon, expected] of iconSizes) {
    const response = await request.get(icon);
    expect(response.ok(), icon).toBeTruthy();
    expect(response.headers()["content-type"], icon).toContain("image/png");
    expect(pngDimensions(await response.body()), icon).toEqual(expected);
  }

  const serviceWorkerResponse = await request.get("/sw.js");
  expect(serviceWorkerResponse.ok()).toBeTruthy();
  expect(serviceWorkerResponse.headers()["content-type"]).toContain("javascript");
  const serviceWorkerSource = await serviceWorkerResponse.text();
  expect(serviceWorkerSource).toContain('const CACHE = "s6-cut-shell-v5"');
  expect(serviceWorkerSource).toContain('fetch(request, { cache: "no-store" })');
  expect(serviceWorkerSource).toContain('event.data?.type === "SKIP_WAITING"');
  expect(serviceWorkerSource).toContain('request.headers.has("range")');
  expect(serviceWorkerSource).toContain('url.pathname.startsWith("/api/")');
  expect(serviceWorkerSource).not.toMatch(/install[\s\S]{0,500}skipWaiting\(\)/);
});

test("production PWA activates, works offline, and excludes API/media traffic from caches", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/direct-production-route", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL || ""), { timeout: 15_000 }).toContain("/sw.js");
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { active: registration.active?.state, scriptURL: registration.active?.scriptURL };
  });
  expect(worker).toEqual({ active: "activated", scriptURL: expect.stringContaining("/sw.js") });

  const initialCaches = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries = await Promise.all(names.map(async (name) => ({ name, urls: (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname) })));
    return entries;
  });
  expect(initialCaches.map((cache) => cache.name)).toContain("s6-cut-shell-v5");
  expect(initialCaches.map((cache) => cache.name)).not.toContain("s6-cut-shell-v4");
  expect(initialCaches.flatMap((cache) => cache.urls)).toContain("/");
  expect(initialCaches.flatMap((cache) => cache.urls).some((url) => url.startsWith("/assets/"))).toBe(true);

  const apiOnline = await page.evaluate(async () => (await fetch("/api/health")).ok);
  expect(apiOnline).toBe(true);
  const bundle = await page.locator('script[src*="/assets/"]').getAttribute("src");
  expect(bundle).toBeTruthy();
  await page.evaluate(async (asset) => {
    await fetch(`${asset}?pwa-range-test=1`, { headers: { Range: "bytes=0-31" } });
  }, bundle);

  const cachedUrls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))).flat());
  expect(cachedUrls.some((url) => url.includes("/api/") || url.includes("pwa-range-test"))).toBe(false);
  expect(cachedUrls.some((url) => /\/files\/|\/download|\/export|\.mp4(?:$|\?)/i.test(url))).toBe(false);

  // Network failures during the intentional offline phase are expected browser
  // diagnostics, not application errors. Start the final console assertion at
  // the online boundary.
  consoleErrors.length = 0;
  await page.context().setOffline(true);
  await expect(page.getByTestId("pwa-offline-status")).toBeVisible();
  await page.goto("/offline-production-route", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const apiOffline = await page.evaluate(async () => {
    try {
      await fetch("/api/health");
      return true;
    } catch {
      return false;
    }
  });
  expect(apiOffline).toBe(false);

  await page.context().setOffline(false);
  // Chromium may keep navigator.onLine unchanged while a service worker serves
  // the offline navigation; exercise the same browser event the app listens to
  // once the network is restored.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pwa-online-status")).toBeVisible();
  consoleErrors.length = 0;
  await expect.poll(() => page.evaluate(async () => (await fetch("/api/health")).ok), { timeout: 15_000 }).toBe(true);
  expect(consoleErrors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(overflow).toBe(true);
});

test("waiting PWA updates are user-controlled", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const serviceWorkerSource = await (await request.get("/sw.js")).text();
  expect(serviceWorkerSource).toContain("Do not skip waiting here");

  await page.evaluate(() => {
    const waiting = { postMessage: (message: { type: string }) => { Object.assign(window, { __pwaTestMessage: message.type }); } };
    window.dispatchEvent(new CustomEvent("s6-cut:pwa-update-ready", { detail: { waiting } }));
  });
  await expect(page.getByTestId("pwa-update-status")).toBeVisible();
  await page.getByRole("button", { name: "Update app" }).click();
  await expect(page.getByRole("button", { name: "Applying update…" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwaTestMessage?: string }).__pwaTestMessage)).toBe("SKIP_WAITING");
});
