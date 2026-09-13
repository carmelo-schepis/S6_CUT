import { expect, test } from "@playwright/test";

test("production PWA shell and navigation remain available", async ({ page, request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("S6_cut — Local video studio");
  expect(manifest.short_name).toBe("S6_cut");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.theme_color).toBe("#0b0b0e");
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
    expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
    expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
  ]));

  for (const icon of ["/favicon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]) {
    const response = await request.get(icon);
    expect(response.ok(), icon).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  const serviceWorkerResponse = await request.get("/sw.js");
  expect(serviceWorkerResponse.ok()).toBeTruthy();
  expect(serviceWorkerResponse.headers()["content-type"]).toContain("javascript");
  const serviceWorkerSource = await serviceWorkerResponse.text();
  expect(serviceWorkerSource).toContain('const CACHE = "s6-cut-shell-v3"');
  expect(serviceWorkerSource).toContain('fetch(request, { cache: "no-store" })');

  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto("/direct-production-route", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL || ""), { timeout: 15_000 }).toContain("/sw.js");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
