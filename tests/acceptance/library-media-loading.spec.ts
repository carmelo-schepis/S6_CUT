import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryAsset } from "../../web/src/types";

const fixtureRoot = process.env.S6_THUMBNAIL_FIXTURES;

test.use({ serviceWorkers: "block" });

async function installLargeLibrary(page: Page) {
  expect(process.env.S6_ACCEPTANCE_ISOLATED, "150-asset setup mutates the Library and requires a dedicated disposable app").toBe("1");
  expect(process.env.S6_ACCEPTANCE_URL, "set an isolated acceptance URL explicitly").toBeTruthy();
  expect(fixtureRoot, "set S6_THUMBNAIL_FIXTURES to generated local media").toBeTruthy();
  const response = await page.request.get("/api/v1/library/assets");
  const existing = await response.json() as LibraryAsset[];
  const targetCount = Math.max(150, existing.length);
  if (existing.length < targetCount) {
    const source = await readFile(path.join(fixtureRoot!, "portrait-source.mp4"));
    for (let index = existing.length; index < targetCount; index += 1) {
      // An MP4 `free` box after the final top-level box is ignored by decoders,
      // while making each local clip a unique immutable blob/asset identity.
      const payload = Buffer.from(`s6-library-still-${String(index).padStart(3, "0")}`);
      const freeBox = Buffer.alloc(8 + payload.length);
      freeBox.writeUInt32BE(freeBox.length, 0);
      freeBox.write("free", 4, "ascii");
      payload.copy(freeBox, 8);
      const uploaded = await page.request.post("/api/v1/library/assets", { multipart: {
        file: { name: `load-test-${String(index).padStart(3, "0")}.mp4`, mimeType: "video/mp4", buffer: Buffer.concat([source, freeBox]) },
        title: `Preview load asset ${String(index).padStart(3, "0")}`, licence: "QA disposable", policy: "neutral",
      } });
      expect(uploaded.status(), `upload local video ${index}`).toBe(200);
    }
  }

  let reads = 0;
  let refreshUrls = false;
  await page.route("**/api/v1/library/assets**", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/library/assets") return route.fallback();
    reads += 1;
    const response = await route.fetch();
    const assets = await response.json() as LibraryAsset[];
    expect(assets.length, "the isolated backend Library must contain at least 150 real assets").toBeGreaterThanOrEqual(150);
    const refreshed = refreshUrls ? assets.map((asset) => {
      if (!asset.thumbnailUrl) return asset;
      const signed = new URL(asset.thumbnailUrl, new URL(route.request().url()).origin);
      signed.searchParams.set("revalidation", String(reads));
      return { ...asset, thumbnailUrl: `${signed.pathname}${signed.search}` };
    }) : assets;
    await route.fulfill({ response, json: refreshed });
  });
  return { reads: () => reads, refreshUrls: () => { refreshUrls = true; } };
}

async function openLibrary(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
}

test.describe("Library media loading", () => {
  test("keeps a real 150-video library reachable without mounting a media request storm", async ({ page }) => {
    const fixture = await installLargeLibrary(page);
    const failures: string[] = [];
    const consoleErrors: string[] = [];
    const mediaRequests: Array<{ url: string; resourceType: string }> = [];
    const thumbnailStatuses: number[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/thumbnail?")) mediaRequests.push({ url: request.url(), resourceType: request.resourceType() });
      if (/\.mp4(?:\?|$)/i.test(request.url())) mediaRequests.push({ url: request.url(), resourceType: request.resourceType() });
    });
    page.on("response", (response) => { if (response.url().includes("/thumbnail?")) thumbnailStatuses.push(response.status()); });
    page.on("requestfailed", (request) => failures.push(`${request.url()} ${request.failure()?.errorText || "failed"}`));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await openLibrary(page);

    await expect(page.locator(".asset-card")).toHaveCount(60);
    await expect(page.getByRole("button", { name: /Show 60 more of 150/ })).toBeVisible();
    await expect.poll(() => page.locator("img[src]").count()).toBeGreaterThan(0);
    expect(await page.locator("img[src]").count(), "only the viewport and its small margin may load stills").toBeLessThanOrEqual(24);
    expect(await page.locator("video[src]").count(), "cards must not mount source videos").toBe(0);

    await page.getByRole("button", { name: /Show 60 more of 150/ }).click();
    await expect(page.locator(".asset-card")).toHaveCount(120);
    await page.getByText("Preview load asset 119").scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator("img[src]").count()).toBeGreaterThan(0);
    expect(await page.locator("img[src]").count(), "thumbnail assignments remain bounded after scrolling").toBeLessThanOrEqual(32);
    expect(await page.locator("video[src]").count()).toBe(0);
    await page.getByRole("button", { name: /Show 30 more of 150/ }).click();
    await expect(page.locator(".asset-card")).toHaveCount(150);
    expect(fixture.reads()).toBeGreaterThanOrEqual(1);
    const avoidableFailures = failures.filter((failure) => !failure.includes("net::ERR_ABORTED"));
    expect(avoidableFailures, avoidableFailures.join("\n")).toEqual([]);
    expect(failures.length, "unmounting distant cards must not create an abort storm").toBeLessThanOrEqual(48);
    expect(mediaRequests.filter((request) => request.url.includes(".mp4")), "browsing does not request full source videos").toEqual([]);
    expect(mediaRequests.filter((request) => request.url.includes("/thumbnail?")).length, "thumbnail requests remain bounded across the initial view, one distant scroll, and one show-more scroll").toBeLessThanOrEqual(96);
    expect(mediaRequests.filter((request) => request.url.includes("/thumbnail?")).every((request) => request.resourceType === "image")).toBe(true);
    expect(thumbnailStatuses.every((status) => status === 200), JSON.stringify(thumbnailStatuses)).toBe(true);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("collapses revalidation signals and accepts freshly signed thumbnail URLs", async ({ page }) => {
    const fixture = await installLargeLibrary(page);
    await openLibrary(page);
    const image = page.locator(".asset-card img").first();
    await expect(image).toHaveAttribute("src", /./);
    const initialSrc = await image.getAttribute("src");
    const readsAfterInitialLoad = fixture.reads();

    fixture.refreshUrls();
    await page.clock.install();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new StorageEvent("storage", { key: "s6-cut.library-revision" }));
    });
    await page.clock.runFor(1_000);
    await expect.poll(fixture.reads, { timeout: 3_000 }).toBe(readsAfterInitialLoad + 1);
    await expect(image).not.toHaveAttribute("src", initialSrc!);
    await expect(image).toHaveAttribute("src", /revalidation=/);
    expect(fixture.reads(), "rapid focus, visibility and revision signals collapse to one reload").toBe(readsAfterInitialLoad + 1);
  });
});
