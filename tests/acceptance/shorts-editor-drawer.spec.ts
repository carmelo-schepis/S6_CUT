import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// WebKit skips page.route mocks while the service worker is active.
test.use({ serviceWorkers: "block" });

const root = process.cwd();
const now = "2026-10-15T00:00:00Z";
const asset = { id: "asset-short-a", title: "Copper sunrise", description: "", mediaType: "video/mp4", filename: "sunrise.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash-short-a", folderId: "folder", origin: "generated-clip", blobId: "blob-short-a", sourceProjectId: "project-a", sourceJobId: "job-a", sourceClipId: "clip-a", durationSeconds: 4, width: 1080, height: 1920, previewUrl: "/api/v1/library/assets/asset-short-a/preview?sig=fixture-a", aspectRatio: "9:16", publishedAt: now, brands: [], people: [], createdAt: now };
const job = { schemaVersion: 1, id: "job-a", projectId: "project-a", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100, currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: true, warnings: [], error: null, beats: [], steps: [], clips: [{ id: "clip-a", index: 1, state: "complete", start: 12, end: 16, duration: 4, openingLine: "Sunrise", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Copper sunrise", libraryAssetId: asset.id, width: 1080, height: 1920, previewUrl: asset.previewUrl }], createdAt: now, updatedAt: now };

const clipButton = (page: Page) => page.getByRole("button", { name: /Copper sunrise/ });
const toggleOf = (page: Page) => page.getByRole("button", { name: /^Clips & assistant/ });
const drawerOf = (page: Page) => page.locator("#shorts-clip-drawer");

async function openClips(page: Page) {
  const toggle = toggleOf(page);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: "Clips and editing assistant" })).toBeVisible();
}

async function openEditor(page: Page) {
  const preview = path.join(root, "tests/fixtures/openrouter-fallback.mp4");
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: [asset] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [job] }));
  await page.route("**/api/v1/library/assets/asset-short-*/preview**", (route) => route.fulfill({ path: preview, contentType: "video/mp4" }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
}

async function loadClip(page: Page) {
  await openClips(page);
  await clipButton(page).click();
  await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");
  await expect(page.getByRole("row", { name: "Audio" })).toBeVisible();
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("Shorts Editor workbench and Clips & assistant drawer", () => {
  test("the drawer is closed by default and adds no horizontal overflow", async ({ page }) => {
    await openEditor(page);
    await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
    await expect(clipButton(page)).toBeHidden();
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    test(`a loaded editor fills the ${viewport.width}x${viewport.height} page without scrolling`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "Desktop Chromium", "The workbench layout is measured on desktop Chromium only.");
      await page.setViewportSize(viewport);
      await openEditor(page);
      await loadClip(page);
      await expect(async () => {
        const panel = await page.locator(".shorts-editor-panel").boundingBox();
        const audio = await page.getByRole("row", { name: "Audio" }).boundingBox();
        const mute = await page.getByRole("button", { name: "Mute preview", exact: true }).boundingBox();
        const timecode = await page.locator(".shorts-bottom-controls > span").boundingBox();
        const frame = await page.locator(".video-editing-stage > .shorts-video-frame").boundingBox();
        const lane = await page.locator(".shorts-track-list .track-lane").first().boundingBox();
        const first = await page.locator(".timeline-scale span").first().boundingBox();
        const last = await page.locator(".timeline-scale span").last().boundingBox();
        if (!panel || !audio || !mute || !timecode || !frame || !lane || !first || !last) throw new Error("Workbench is not laid out yet");
        expect(viewport.width - (panel.x + panel.width)).toBeLessThanOrEqual(24);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
        expect(audio.y + audio.height).toBeLessThanOrEqual(viewport.height);
        expect(overlaps(mute, timecode)).toBe(false);
        expect(first.x).toBeGreaterThanOrEqual(lane.x - 1);
        expect(last.x + last.width).toBeLessThanOrEqual(lane.x + lane.width + 1);
        if (viewport.width === 1440) expect(frame.height).toBeGreaterThanOrEqual(440);
      }).toPass();
    });
  }

  test("the open drawer docks to the right edge, and Escape or the close button dismiss it", async ({ page }) => {
    await openEditor(page);
    await loadClip(page);
    const toggle = toggleOf(page);
    const drawer = drawerOf(page);
    const viewportWidth = await page.evaluate(() => innerWidth);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => {
      const box = await drawer.boundingBox();
      return box && [Math.round(box.x + box.width), Math.round(box.width)];
    }).toEqual([viewportWidth, Math.min(440, viewportWidth)]);

    await page.getByLabel("Filter clips").focus();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("region", { name: "Video properties" })).toBeVisible();

    await toggle.click();
    await expect(drawer).toBeVisible();
    await page.getByRole("button", { name: "Close clips and assistant" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).toBeHidden();
  });

  test("dragging a clip slides the drawer aside so the whole editor takes the drop", async ({ page }) => {
    await openEditor(page);
    await openClips(page);
    await drawerOf(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const handle = clipButton(page).locator(".clip-drag-hint");
    const box = await handle.boundingBox();
    const panel = await page.locator(".shorts-editor-panel").boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!box || !panel) throw new Error("Clip source or Editor drop target is not laid out");
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const pointer = { x: start.x + 28, y: start.y + 20 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(pointer.x, pointer.y, { steps: 5 });

    await expect(page.locator(".clip-drag-ghost")).toBeVisible();
    await expect.poll(async () => (await drawerOf(page).boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(viewport.width);
    const ghost = await page.locator(".clip-drag-ghost").boundingBox();
    expect(Math.abs((ghost?.x ?? Infinity) - pointer.x)).toBeLessThanOrEqual(40);
    expect(Math.abs((ghost?.y ?? Infinity) - pointer.y)).toBeLessThanOrEqual(40);

    await page.mouse.move(panel.x + panel.width / 2, Math.min(panel.y + Math.min(panel.height / 2, 180), viewport.height - 30), { steps: 12 });
    await page.mouse.up();
    await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");
    await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
    await expect(drawerOf(page)).toBeHidden();
    await expect(page.locator(".clip-drag-ghost")).toHaveCount(0);
  });

  test("on a phone-width screen the drawer fills the viewport and respects reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openEditor(page);
    await openClips(page);
    await expect.poll(async () => Math.round((await drawerOf(page).boundingBox())?.width ?? 0)).toBe(390);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const transition = await drawerOf(page).evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transition.split(",").every((duration) => Number.parseFloat(duration) <= 0.001)).toBeTruthy();
  });
});
