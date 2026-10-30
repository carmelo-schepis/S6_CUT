import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const artifacts = path.join(root, "test-artifacts", "ui-layout-regressions");
const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1024, 768],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;

async function measureViewport(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const measurement = await measureViewport(page);
  expect(measurement.scrollWidth, `${measurement.width}px document overflow`).toBeLessThanOrEqual(measurement.clientWidth);
}

test.describe("creation and Library layout regressions", () => {
  test("keeps mode states, provider callout, and creation workflow contained", async ({ page }) => {
    test.setTimeout(180_000);
    await fs.mkdir(artifacts, { recursive: true });

    for (const [name, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Create a project" })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const createPanel = page.locator(".create-panel");
      const createMeasure = await createPanel.evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        const steps = [...panel.querySelectorAll<HTMLElement>(".create-step")].map((step) => step.getBoundingClientRect());
        return { rect: { left: rect.left, right: rect.right }, steps };
      });
      expect(createMeasure.rect.left).toBeGreaterThanOrEqual(0);
      expect(createMeasure.rect.right).toBeLessThanOrEqual(width + 1);
      expect(createMeasure.steps.every((step) => step.left >= 0 && step.right <= width + 1)).toBe(true);

      const modes = ["Auto", "Fast", "Smart"] as const;
      for (const mode of modes) {
        const button = page.getByRole("button", { name: mode, exact: true });
        await button.click();
        await expect(button).toHaveClass(/active/);
        const modeMeasure = await page.locator(".processing-mode-tabs").evaluate((control) => {
          const buttons = [...control.querySelectorAll<HTMLElement>("button")];
          const rects = buttons.map((item) => item.getBoundingClientRect());
          const note = control.closest(".field-group")?.querySelector<HTMLElement>(".field-group-hint")?.getBoundingClientRect();
          const parent = control.closest(".create-step")?.getBoundingClientRect();
          return { rects, note, parent };
        });
        expect(modeMeasure.rects).toHaveLength(3);
        expect(Math.max(...modeMeasure.rects.map((rect) => rect.width)) - Math.min(...modeMeasure.rects.map((rect) => rect.width))).toBeLessThanOrEqual(1);
        expect(Math.max(...modeMeasure.rects.map((rect) => rect.height)) - Math.min(...modeMeasure.rects.map((rect) => rect.height))).toBeLessThanOrEqual(1);
        expect(modeMeasure.rects.every((rect) => rect.left >= (modeMeasure.parent?.left || 0) && rect.right <= (modeMeasure.parent?.right || width) + 1)).toBe(true);
        if (modeMeasure.note) expect(modeMeasure.note.right).toBeLessThanOrEqual((modeMeasure.parent?.right || width) + 1);
        await expectNoHorizontalOverflow(page);
        if (name === "desktop") await page.screenshot({ path: path.join(artifacts, `projects-${mode.toLowerCase()}.png`), fullPage: false });
      }

      const callout = page.locator(".provider-callout:not(.compact)");
      if (await callout.count()) {
        await expect(callout).toBeVisible();
        const calloutMeasure = await callout.evaluate((element) => {
          const parent = element.getBoundingClientRect();
          const buttons = [...element.querySelectorAll<HTMLElement>("button")].map((button) => button.getBoundingClientRect());
          return { parent, buttons };
        });
        expect(calloutMeasure.buttons.every((button) => button.left >= calloutMeasure.parent.left && button.right <= calloutMeasure.parent.right + 1)).toBe(true);
        await callout.getByRole("button", { name: "Continue locally" }).click();
        await expect(callout).toBeHidden();
      }

      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      await expect(focused).toBeVisible();
      const focusMeasure = await focused.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, outline: style.outlineStyle };
      });
      expect(focusMeasure.outline).not.toBe("none");
      expect(focusMeasure.left).toBeGreaterThanOrEqual(0);
      expect(focusMeasure.right).toBeLessThanOrEqual(width);
      expect(focusMeasure.top).toBeGreaterThanOrEqual(0);
      expect(focusMeasure.bottom).toBeLessThanOrEqual(height);

      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
      await expect(page.locator("button.asset-card-details").first()).toBeVisible({ timeout: 15_000 });
      await page.locator("button.asset-card-details").first().click();
      const inspector = page.locator(".asset-inspector");
      await expect(inspector).toBeVisible();
      await inspector.scrollIntoViewIfNeeded();
      const inspectorMeasure = await inspector.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll<HTMLElement>("input, select, button")].map((control) => {
          const box = control.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width };
        });
        const style = getComputedStyle(element);
        return { rect, controls, overflowY: style.overflowY, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      });
      expect(inspectorMeasure.rect.left).toBeGreaterThanOrEqual(0);
      expect(inspectorMeasure.rect.right).toBeLessThanOrEqual(width + 1);
      const dialogBox = await page.getByRole("dialog").boundingBox();
      expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(height + 1);
      expect(inspectorMeasure.scrollWidth).toBeLessThanOrEqual(inspectorMeasure.clientWidth);
      expect(await page.locator(".asset-preview-body").evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
      expect(inspectorMeasure.controls.every((control) => control.left >= inspectorMeasure.rect.left && control.right <= inspectorMeasure.rect.right + 1)).toBe(true);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: path.join(artifacts, `${name}-library-inspector.png`), fullPage: false });
    }
  });

  test("provider callout actions remain usable through both safe paths", async ({ page }) => {
    // This is a no-provider workflow test, so make that precondition explicit
    // instead of inheriting whichever profile happens to be selected in the
    // persistent acceptance data set.
    await page.route("**/api/v1/profiles", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const callout = page.locator(".provider-callout:not(.compact)");
    await expect(callout).toBeVisible();
    await expect(callout.getByRole("button", { name: "Configure providers" })).toBeVisible();
    await callout.getByRole("button", { name: "Configure providers" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const secondCallout = page.locator(".provider-callout:not(.compact)");
    await expect(secondCallout).toBeVisible();
    await secondCallout.getByRole("button", { name: "Continue locally" }).click();
    await expect(secondCallout).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
