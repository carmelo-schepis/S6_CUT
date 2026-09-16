import { test, expect, type Page } from "@playwright/test";
import type { LibraryAsset } from "../../web/src/types";

async function installLargeLibrary(page: Page) {
  const response = await page.request.get("/api/v1/library/assets");
  const assets = await response.json() as LibraryAsset[];
  const video = assets.find((asset) => asset.mediaType.startsWith("video/") && asset.previewUrl);
  test.skip(!video, "requires one local signed video preview");
  const seeded = Array.from({ length: 150 }, (_, index) => ({
    ...video!, id: `preview-load-${index}`, title: `Preview load asset ${String(index).padStart(3, "0")}`,
    filename: `preview-load-${index}.mp4`,
  }));
  let reads = 0;
  let renew = false;
  await page.route("**/api/v1/library/assets**", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/library/assets") return route.fallback();
    reads += 1;
    const signed = renew ? seeded.map((asset) => ({ ...asset, previewUrl: `${asset.previewUrl}${asset.previewUrl?.includes("?") ? "&" : "?"}renewed=${reads}` })) : seeded;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(signed) });
  });
  return { reads: () => reads, renew: () => { renew = true; } };
}

async function openLibrary(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Personal Media Library", exact: true })).toBeVisible();
}

test.describe("Library media loading", () => {
  test("keeps a 150-video library reachable without mounting a media request storm", async ({ page }) => {
    const fixture = await installLargeLibrary(page);
    const failures: string[] = [];
    const consoleErrors: string[] = [];
    page.on("requestfailed", (request) => failures.push(`${request.url()} ${request.failure()?.errorText || "failed"}`));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await openLibrary(page);

    await expect(page.locator(".asset-card")).toHaveCount(60);
    await expect(page.getByRole("button", { name: /Show 60 more of 150/ })).toBeVisible();
    await expect.poll(() => page.locator("video[src]").count()).toBeGreaterThan(0);
    expect(await page.locator("video[src]").count(), "only the viewport and its small margin may load media").toBeLessThanOrEqual(24);

    await page.getByRole("button", { name: /Show 60 more of 150/ }).click();
    await expect(page.locator(".asset-card")).toHaveCount(120);
    await page.getByText("Preview load asset 119").scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator("video[src]").count()).toBeGreaterThan(0);
    expect(await page.locator("video[src]").count()).toBeLessThanOrEqual(24);
    await page.getByRole("button", { name: /Show 30 more of 150/ }).click();
    await expect(page.locator(".asset-card")).toHaveCount(150);
    expect(fixture.reads()).toBeGreaterThanOrEqual(1);
    const avoidableFailures = failures.filter((failure) => !failure.includes("net::ERR_ABORTED"));
    expect(avoidableFailures, avoidableFailures.join("\n")).toEqual([]);
    expect(failures.length, "unmounting distant cards must not create an abort storm").toBeLessThanOrEqual(48);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("collapses revalidation signals and retains the working signed preview URL", async ({ page }) => {
    const fixture = await installLargeLibrary(page);
    await openLibrary(page);
    const video = page.locator(".asset-card video").first();
    await expect(video).toHaveAttribute("src", /./);
    const initialSrc = await video.getAttribute("src");
    const readsAfterInitialLoad = fixture.reads();

    fixture.renew();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new StorageEvent("storage", { key: "s6-cut.library-revision" }));
    });
    await expect.poll(fixture.reads, { timeout: 3_000 }).toBe(readsAfterInitialLoad + 1);
    await expect(video).toHaveAttribute("src", initialSrc!);
    await page.waitForTimeout(600);
    expect(fixture.reads(), "rapid focus, visibility and revision signals collapse to one reload").toBe(readsAfterInitialLoad + 1);
  });
});
