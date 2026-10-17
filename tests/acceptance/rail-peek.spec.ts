/**
 * The folded rail peeks open over the page, and must never be left covering it.
 *
 * Between 821 and 1180px (and on a desktop with the rail folded) the rail is
 * icon-only and widens to 224px over the page while the pointer rests on it.
 * As a plain :hover peek it stayed open after a destination was clicked: the
 * pointer was still inside the now-wide rail, so the controls at the left of
 * the new page sat underneath it and could not be clicked.
 */
import { expect, test, type Page } from "@playwright/test";

const railWidth = (page: Page) => page.locator(".app-rail").evaluate((rail) => rail.getBoundingClientRect().width);

test.describe("rail peek", () => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1180, height: 820 }]) {
    test(`at ${viewport.width}px a chosen page is never left under the peeking rail`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const rail = page.locator(".app-rail");
      await expect(rail).toBeVisible();
      // The pointer starts at (0, 0), which is on the rail; start from the page.
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
      await expect.poll(() => railWidth(page)).toBeLessThan(100);
      const folded = await railWidth(page);
      expect(folded, "the rail is folded to icons at this width").toBeLessThan(100);

      // Resting on the rail peeks it open…
      await page.getByRole("button", { name: "Library", exact: true }).hover();
      await expect.poll(() => railWidth(page)).toBeGreaterThan(200);
      await expect(rail).toHaveAttribute("data-peek", "open");

      // …and choosing a page folds it at once, with the pointer still inside.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(rail).not.toHaveAttribute("data-peek", "open");
      await expect.poll(() => railWidth(page)).toBeLessThan(100);

      // The control at the left of the page is reachable straight away.
      const auto = page.getByRole("button", { name: "Auto", exact: true });
      await auto.click({ timeout: 5_000 });
      await expect(auto).toHaveClass(/active/);
    });
  }

  test("crossing the rail without resting does not open it", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const rail = page.locator(".app-rail");
    await expect(rail).toBeVisible();
    await page.mouse.move(1000, 700);
    await expect.poll(() => railWidth(page)).toBeLessThan(100);
    const box = (await rail.boundingBox())!;
    await page.mouse.move(box.x + box.width + 300, box.y + 300);
    await page.mouse.move(box.x + 10, box.y + 300, { steps: 2 });
    await page.mouse.move(box.x + box.width + 300, box.y + 320, { steps: 2 });
    await page.waitForTimeout(300);
    await expect(rail).not.toHaveAttribute("data-peek", "open");
    expect(await railWidth(page)).toBeLessThan(100);
  });

  test("keyboard focus still opens the folded rail", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-rail")).toBeVisible();
    await page.mouse.move(1000, 700);
    await expect.poll(() => railWidth(page)).toBeLessThan(100);
    await page.getByRole("button", { name: "Library", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect.poll(() => railWidth(page)).toBeGreaterThan(200);
  });
});
