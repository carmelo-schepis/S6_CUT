import { test, expect } from "@playwright/test";

test("Library uses the full media area and opens details only with preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Rule Inspector" });
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await expect(inspector).toHaveCount(0);
  const thumbnail = page.locator(".asset-card img").first();
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const preview = page.locator(".asset-preview-trigger").first();
  const card = preview.locator("xpath=ancestor::article");
  const title = (await preview.getAttribute("aria-label"))!.replace(/^Preview /, "");
  const checkbox = card.getByRole("checkbox");
  await checkbox.check();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await checkbox.uncheck();

  for (const opener of [preview, card.locator(".asset-card-details")]) {
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(inspector.getByLabel("Title", { exact: true })).toHaveValue(title);
    await inspector.getByLabel("Licence", { exact: true }).scrollIntoViewIfNeeded();
    await expect(inspector.getByLabel("Licence", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(opener).toBeFocused();
  }

  await preview.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(preview).toBeFocused();

  // Check several real assets, including decoded frames and time progression.
  const count = Math.min(3, await page.locator(".asset-preview-trigger").count());
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    await page.locator(".asset-preview-trigger").nth(index).click();
    const video = page.locator("video.video-preview-video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; });
    await page.getByRole("button", { name: "Play video", exact: true }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
    const media = await video.evaluate((v: HTMLVideoElement) => ({ width: v.videoWidth, height: v.videoHeight, error: v.error?.code, frames: v.getVideoPlaybackQuality?.().totalVideoFrames }));
    expect(media.width).toBeGreaterThan(0);
    expect(media.height).toBeGreaterThan(0);
    expect(media.error).toBeUndefined();
    expect(media.frames).toBeGreaterThan(0);
    await page.screenshot({ path: `test-artifacts/library-preview-${test.info().project.name}-${index}.png` });
    await page.getByRole("button", { name: "Close video preview" }).click();
    await expect(inspector).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `test-artifacts/library-layout-${test.info().project.name}.png`, fullPage: false });
});
