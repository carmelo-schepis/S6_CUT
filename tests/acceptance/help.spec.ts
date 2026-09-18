import { test, expect } from "@playwright/test";

test.describe("S6 Cut Help", () => {
  test("opens, documents the application, traps focus, and restores focus", async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText || "failed";
      // Navigating away can abort an in-flight video preview request; it is not
      // an application failure. Every other failed request remains actionable.
      if (errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()} ${errorText}`);
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText("Local engine ready")).toBeVisible();
    const launcher = page.getByRole("button", { name: "Open S6 Cut Help" });
    await expect(launcher).toBeVisible();
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "S6 Cut Help" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Close S6 Cut Help" })).toBeFocused();

    for (const section of ["Getting started", "Fast, Auto & Smart", "Editorial modes", "Subtitle styles", "Video layouts", "Troubleshooting"]) {
      await page.getByRole("button", { name: section, exact: true }).click();
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    }
    for (const label of ["Fast", "Auto", "Smart", "Funny", "Serious", "Educational", "Hype", "9:16 vertical", "16:9 landscape", "1:1 square", "4:5 portrait"]) await expect(dialog.getByText(label, { exact: true }).first()).toBeVisible();
    // Subtitle-style references render as <video> (covered by
    // help-subtitle-previews.spec.ts); only the four layout references are <img>.
    const images = dialog.locator("img");
    expect(await images.count()).toBe(4);
    for (let index = 0; index < await images.count(); index += 1) {
      await expect(images.nth(index)).toHaveJSProperty("complete", true);
      expect(await images.nth(index).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));

    const focusables = dialog.locator("button, a[href]");
    await focusables.last().focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close S6 Cut Help" })).toBeFocused();
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    const desktopPath = testInfo.outputPath("help-desktop.png");
    await page.screenshot({ path: desktopPath, fullPage: false });
    testInfo.attachments.push({ name: "desktop-help", contentType: "image/png", path: desktopPath });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  });

  test("stays readable and contained at a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    const launcher = page.getByRole("button", { name: "Open S6 Cut Help" });
    await expect(launcher).toBeVisible();
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "S6 Cut Help" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    // The backdrop insets the dialog by the same guide the page uses, so the
    // dialog's edges line up with the content behind it at every width.
    const inset = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-inset")));
    expect(await dialog.boundingBox()).toMatchObject({ width: 390 - inset * 2 });
    await page.getByRole("button", { name: "Video layouts", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Video layouts", exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const mobilePath = testInfo.outputPath("help-mobile.png");
    await page.screenshot({ path: mobilePath, fullPage: false });
    testInfo.attachments.push({ name: "mobile-help", contentType: "image/png", path: mobilePath });
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
  });
});
