import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const fixture = path.resolve("tests/fixtures/openrouter-fallback.mp4");

async function openEditor(page) {
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
}

async function loadLocalVideo(page) {
  await page.getByRole("tab", { name: "Local file", exact: true }).click();
  await page.getByLabel("Choose video file").setInputFiles(fixture);
  const player = page.locator(".shorts-video-frame video");
  await expect(player).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();
  const hasMetadata = () => player.evaluate((video) => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0);
  if (!(await hasMetadata())) {
    await page.getByRole("button", { name: "Play preview" }).click();
    await expect.poll(hasMetadata).toBe(true);
    if (await page.getByRole("button", { name: "Pause preview" }).count()) await page.getByRole("button", { name: "Pause preview" }).click();
  }
}

test.describe("Shorts Editor reference-inspired editing controls", () => {
  test("selects linked tracks, separates preview/export audio, and edits timed text with delete/undo", async ({ page }, testInfo) => {
    await openEditor(page);
    await loadLocalVideo(page);

    const tools = page.getByRole("tablist", { name: "Editor tools" });
    await expect(tools).toBeVisible();
    const mediaTool = tools.getByRole("tab", { name: "Media", exact: true });
    const filtersTool = tools.getByRole("tab", { name: "Filters", exact: true });
    const textTool = tools.getByRole("tab", { name: "Text", exact: true });
    await expect(mediaTool).toHaveAttribute("aria-selected", "true");

    await page.getByRole("row", { name: "Audio" }).getByRole("button", { name: "Audio", exact: true }).click();
    const volume = page.getByRole("slider", { name: "Audio volume" });
    await expect(volume).toBeVisible();
    await volume.focus();
    await volume.press("ArrowLeft");
    await expect(volume).not.toHaveValue("1");
    const exportMute = page.getByRole("checkbox", { name: "Mute export" });
    await expect(exportMute).toBeVisible();
    await expect(exportMute).not.toBeChecked();
    await page.getByRole("button", { name: "Mute preview" }).click();
    await expect(page.getByRole("button", { name: "Unmute preview" })).toHaveAttribute("aria-pressed", "true");
    await expect(exportMute).not.toBeChecked();
    await page.getByRole("button", { name: "Unmute preview" }).click();

    await mediaTool.click();
    const mediaSettings = page.getByRole("region", { name: "Media settings" });
    await mediaSettings.getByLabel("Aspect ratio").selectOption("4:5");
    await expect(page.getByRole("group", { name: "Video preview" })).toHaveClass(/aspect-4-5/);
    await mediaSettings.getByLabel("Aspect ratio").selectOption("9:16");

    await filtersTool.click();
    await expect(filtersTool).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("row", { name: /Video/ })).toBeVisible();
    const videoSettings = page.getByRole("region", { name: "Filters settings" });
    await expect(videoSettings.getByLabel("Filter preset")).toBeVisible();
    await videoSettings.getByLabel("Filter preset").selectOption("tint");
    await expect(videoSettings.getByLabel("Filter intensity")).toBeVisible();
    await videoSettings.getByLabel("Filter intensity").fill("0.4");
    await expect(videoSettings.getByLabel("Tint color")).toBeVisible();
    await videoSettings.getByLabel("Tint color").fill("#2962a8");
    await videoSettings.getByLabel("Tint opacity").fill("36");
    await expect(videoSettings.getByLabel("Tint opacity")).toHaveValue("36");

    await textTool.click();
    await page.getByRole("button", { name: "Add text overlay" }).click();
    await expect(page.getByRole("row", { name: /Text/ })).toBeVisible();
    const overlay = page.getByRole("group", { name: "Text overlay 1" });
    await expect(overlay).toBeVisible();
    await overlay.getByLabel("Overlay text").fill("Local fixture title");
    await overlay.getByLabel("Horizontal position").fill("0.3");
    await overlay.getByLabel("Vertical position").fill("0.7");
    const currentPreviewTime = await page.locator(".shorts-video-frame video").evaluate((video) => video.currentTime);
    const overlayStart = Math.ceil((currentPreviewTime + 0.5) * 10) / 10;
    await overlay.getByLabel("Overlay start seconds").fill(String(overlayStart));
    await overlay.getByLabel("Overlay duration seconds").fill("2.4");
    await expect(overlay.getByLabel("Horizontal position")).toHaveValue("0.3");
    await expect(overlay.getByLabel("Overlay start seconds")).toHaveValue(String(overlayStart));
    const previewOverlay = page.getByRole("button", { name: "Text overlay: Local fixture title" });
    await expect(previewOverlay).toHaveCount(0);
    const previewPosition = page.getByRole("slider", { name: "Preview position" });
    await previewPosition.scrollIntoViewIfNeeded();
    const positionBox = await previewPosition.boundingBox();
    if (!positionBox) throw new Error("Preview position should have visible dimensions.");
    const scrubX = positionBox.x + positionBox.width * 0.15;
    const scrubY = positionBox.y + positionBox.height / 2;
    if (testInfo.project.name === "Desktop Chromium") await page.mouse.click(scrubX, scrubY);
    else await page.touchscreen.tap(scrubX, scrubY);
    await expect(previewOverlay).toBeVisible();
    await previewOverlay.scrollIntoViewIfNeeded();
    const overlayBox = await previewOverlay.boundingBox();
    if (!overlayBox) throw new Error("Text overlay preview should have visible dimensions.");
    await page.mouse.move(overlayBox.x + overlayBox.width / 2, overlayBox.y + overlayBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(overlayBox.x + overlayBox.width / 2 + 35, overlayBox.y + overlayBox.height / 2 + 12);
    await page.mouse.up();
    await expect(overlay.getByLabel("Horizontal position")).not.toHaveValue("0.3");
    await previewPosition.press("End");
    await expect(previewOverlay).toHaveCount(0);

    await textTool.click();
    await page.getByRole("button", { name: "Add text overlay" }).click();
    await page.getByRole("group", { name: "Text overlay 2" }).getByLabel("Overlay text").fill("Outro card");
    await expect(page.getByRole("row", { name: "Text" }).getByRole("button", { name: "Select text overlay 2" })).toBeVisible();
    await page.getByRole("button", { name: "Delete text overlay 2" }).click();
    await expect(page.getByRole("group", { name: "Text overlay 2" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("group", { name: "Text overlay 2" })).toBeVisible();
    await page.getByRole("region", { name: "Text settings" }).getByRole("button", { name: "Select text overlay 1" }).click();
    await expect(page.getByRole("group", { name: "Text overlay 1" }).getByLabel("Overlay text")).toHaveValue("Local fixture title");
    await expect(page.getByText("Unsaved edits")).toBeVisible();
  });

  test("keeps source tools and editor controls within the viewport on Chromium and WebKit sizes", async ({ page }, testInfo) => {
    const artifacts = path.resolve(process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts/shorts-editor-layout");
    await fs.mkdir(artifacts, { recursive: true });
    await openEditor(page);
    await loadLocalVideo(page);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 810, height: 1080 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("tablist", { name: "Editor tools" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Media", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Filters", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Text", exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `shorts-editor-${viewport.width}x${viewport.height}-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`) });
    }
  });
});
