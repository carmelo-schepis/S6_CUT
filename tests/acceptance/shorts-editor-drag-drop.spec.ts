import { expect, test } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

test.use({ serviceWorkers: "block" });

const root = process.cwd();
const artifacts = path.resolve(process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts/shorts-editor-drag-drop");
const now = "2026-10-14T00:00:00Z";
const assets = [
  { id: "asset-short-a", title: "Copper sunrise", description: "", mediaType: "video/mp4", filename: "sunrise.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash-short-a", folderId: "folder", origin: "generated-clip", blobId: "blob-short-a", sourceProjectId: "project-a", sourceJobId: "job-a", sourceClipId: "clip-a", durationSeconds: 4, width: 1080, height: 1920, previewUrl: "/api/v1/library/assets/asset-short-a/preview?sig=fixture-a", aspectRatio: "9:16", publishedAt: now, brands: [], people: [], createdAt: now },
  { id: "asset-short-b", title: "Blue city", description: "", mediaType: "video/mp4", filename: "city.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash-short-b", folderId: "folder", origin: "generated-clip", blobId: "blob-short-b", sourceProjectId: "project-b", sourceJobId: "job-b", sourceClipId: "clip-b", durationSeconds: 6, width: 1080, height: 1350, previewUrl: "/api/v1/library/assets/asset-short-b/preview?sig=fixture-b", aspectRatio: "4:5", publishedAt: now, brands: [], people: [], createdAt: now },
];
const jobs = [
  { schemaVersion: 1, id: "job-a", projectId: "project-a", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100, currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: true, warnings: [], error: null, beats: [], steps: [], clips: [{ id: "clip-a", index: 1, state: "complete", start: 12, end: 16, duration: 4, openingLine: "Sunrise", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Copper sunrise", libraryAssetId: "asset-short-a", width: 1080, height: 1920, previewUrl: assets[0].previewUrl }], createdAt: now, updatedAt: now },
  { schemaVersion: 1, id: "job-b", projectId: "project-b", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100, currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: false, warnings: [], error: null, beats: [], steps: [], clips: [{ id: "clip-b", index: 1, state: "complete", start: 3, end: 9, duration: 6, openingLine: "City", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Blue city", libraryAssetId: "asset-short-b", width: 1080, height: 1350, previewUrl: assets[1].previewUrl }], createdAt: now, updatedAt: now },
  { schemaVersion: 1, id: "job-pending", projectId: "project-pending", mode: "clip", state: "queued", stage: "queued", stageLabel: "Queued", progress: 0, currentItem: 0, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short", warnings: [], error: null, beats: [], steps: [], clips: [{ id: "clip-pending", index: 1, state: "queued", start: 0, end: 4, duration: 4, openingLine: "Pending", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Pending Preview" }], createdAt: now, updatedAt: now },
  { schemaVersion: 1, id: "job-failed", projectId: "project-failed", mode: "clip", state: "failed", stage: "failed", stageLabel: "Failed", progress: 0, currentItem: 0, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short", warnings: [], error: "fixture failure", beats: [], steps: [], clips: [{ id: "clip-failed", index: 1, state: "failed", start: 0, end: 4, duration: 4, openingLine: "Failed", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Failed Preview" }], createdAt: now, updatedAt: now },
];

async function openClips(page) {
  const toggle = page.getByRole("button", { name: /^Clips & assistant/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: "Clips and editing assistant" })).toBeVisible();
}

async function openEditor(page) {
  const preview = path.join(root, "tests/fixtures/openrouter-fallback.mp4");
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: assets }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: jobs }));
  await page.route("**/api/v1/library/assets/asset-short-*/preview**", (route) => route.fulfill({ path: preview, contentType: "video/mp4" }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
  await openClips(page);
  await expect(page.getByRole("button", { name: /Copper sunrise/ })).toBeVisible();
}

async function dragToEditor(page, clipName: string, target = ".shorts-editor-panel") {
  await openClips(page);
  const source = page.getByRole("button", { name: new RegExp(clipName) });
  const dragHandle = source.locator(".clip-drag-hint");
  await dragHandle.scrollIntoViewIfNeeded();
  const box = await dragHandle.boundingBox();
  const targetBox = await page.locator(target).boundingBox();
  const targetY = targetBox && await page.evaluate(({ top, height }) => Math.min(top + Math.min(height / 2, 180), innerHeight - 30), { top: targetBox.y, height: targetBox.height });
  if (!box || !targetBox || targetY === null) throw new Error("Clip source or Editor drop target is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetY, { steps: 12 });
  await expect(page.locator(".clip-drag-ghost")).toBeVisible();
  await expect(page.getByText("Drop to edit")).toBeVisible();
  await page.mouse.up();
}

test.describe("Shorts Editor drag-and-drop source loading", () => {

  test("real pointer drag loads the published asset with clip-relative bounds and creates no job", async ({ page }, testInfo) => {
    const jobsCreated: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/v1/jobs/shorts")) jobsCreated.push(request.url()); });
    await openEditor(page);
    await dragToEditor(page, "Copper sunrise");
    await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");
    await expect(page.locator(".clip-browser-item").filter({ hasText: "Copper sunrise" })).toHaveClass(/active/);
    await expect(page.getByLabel("Video trim start seconds")).toHaveValue("0");
    await expect(page.getByLabel("Video trim end seconds")).toHaveValue("4");
    await expect(page.getByRole("region", { name: "Media settings" }).getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(page.locator(".shorts-video-frame video")).toHaveAttribute("src", /asset-short-a\/preview/);
    await expect(page.locator(".shorts-inline-status")).toHaveText("Loaded Copper sunrise from Library.");
    await expect(page.locator(".clip-drag-ghost")).toHaveCount(0);
    expect(jobsCreated).toEqual([]);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, `drag-drop-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`), fullPage: true });
  });

  test("dropdown replaces the source, same-source drop preserves edits, cancel and outside/Escape keep state", async ({ page }) => {
    await openEditor(page);
    await dragToEditor(page, "Copper sunrise");
    await page.getByText("Choose another source").click();
    await page.getByLabel("Library video").selectOption("asset-short-b");
    await expect(page.locator("#editor-panel-title")).toHaveText("Blue city");
    await expect(page.getByLabel("Video trim end seconds")).toHaveValue("");
    await openClips(page);
    await page.getByRole("button", { name: /Blue city/ }).click();
    await expect(page.locator("#editor-panel-title")).toHaveText("Blue city");
    await expect(page.getByLabel("Video trim start seconds")).toHaveValue("0");
    await expect(page.getByLabel("Video trim end seconds")).toHaveValue("6");
    await page.getByLabel("Video trim start seconds").fill("1.5");
    await dragToEditor(page, "Blue city");
    await expect(page.getByLabel("Video trim start seconds")).toHaveValue("1.5");

    page.once("dialog", (dialog) => dialog.dismiss());
    await openClips(page);
    await page.getByRole("button", { name: /Copper sunrise/ }).click();
    await expect(page.getByLabel("Video trim start seconds")).toHaveValue("1.5");

    await openClips(page);
    const source = page.getByRole("button", { name: /Copper sunrise/ });
    const sourceBox = await source.boundingBox();
    const editorBox = await page.locator(".shorts-editor-panel").boundingBox();
    if (!sourceBox || !editorBox) throw new Error("Missing drag geometry");
    await page.mouse.move(sourceBox.x + 20, sourceBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 50, sourceBox.y + 50, { steps: 3 });
    await expect(page.locator(".clip-drag-ghost")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.move(editorBox.x + editorBox.width + 30, editorBox.y + editorBox.height + 30, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator(".clip-drag-ghost")).toHaveCount(0);
    await expect(page.locator(".clip-drop-overlay")).toHaveCount(0);
    await expect(page.locator("#editor-panel-title")).toHaveText("Blue city");
    await page.getByRole("button", { name: "Close clips and assistant" }).click();
    if (await page.getByRole("button", { name: "Show properties" }).count()) await page.getByRole("button", { name: "Show properties" }).click();
    await expect(page.getByLabel("Video trim start seconds")).toHaveValue("1.5");
    await openClips(page);
    await expect(page.getByRole("button", { name: /Unavailable Pending Preview/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: /Unavailable Failed Preview/ })).toHaveAttribute("aria-disabled", "true");
  });

  test("loads by keyboard, retains YouTube/local-file options, and avoids narrow overflow", async ({ page }, testInfo) => {
    await openEditor(page);
    await openClips(page);
    const first = page.getByRole("button", { name: /Copper sunrise/ });
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");
    await expect(page.getByText("Choose another source")).toBeVisible();
    await page.getByText("Choose another source").click();
    await expect(page.getByRole("tab", { name: "YouTube" })).toBeVisible();
    await page.getByRole("tab", { name: "Local file" }).click();
    await expect(page.getByLabel("Choose video file")).toBeAttached();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const transition = await page.locator(".shorts-editor-panel").evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transition.split(",").every((duration) => Number.parseFloat(duration) <= 0.001)).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, `drag-drop-compact-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`), fullPage: true });
  });
});
