import { test, expect } from "@playwright/test";

test.describe("responsive layout regressions", () => {
  test("keeps mobile navigation labels inside their cells", async ({ page }) => {
    for (const width of [320, 390, 400, 420, 440, 768, 820]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();
      const measurement = await page.locator(".app-rail nav").evaluate((nav) => {
        const items = [...nav.querySelectorAll<HTMLElement>(".nav-item")];
        const labels = items.map((item) => item.querySelector<HTMLElement>("span")!.getBoundingClientRect());
        const itemRects = items.map((item) => item.getBoundingClientRect());
        return {
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          labelsInside: labels.every((label, index) => label.left >= itemRects[index].left - 0.5 && label.right <= itemRects[index].right + 0.5),
          adjacentLabelsDoNotOverlap: labels.every((label, index) => index === 0 || label.left >= labels[index - 1].right - 0.5),
        };
      });
      expect(measurement.pageOverflow, `${width}px page overflow`).toBe(false);
      expect(measurement.labelsInside, `${width}px label containment`).toBe(true);
      expect(measurement.adjacentLabelsDoNotOverlap, `${width}px adjacent label overlap`).toBe(true);
    }
  });

  test("keeps library controls visible without a horizontal strip", async ({ page }) => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const sidebar = page.locator(".library-sidebar");
      await expect(sidebar).toBeVisible();
      for (const label of ["Required", "Preferred", "Neutral", "Never", "Show archived"]) {
        const control = label === "Show archived"
          ? page.getByLabel(label)
          : sidebar.locator(":scope > button").filter({ hasText: label });
        await expect(control).toBeVisible();
        const withinSidebar = await control.first().evaluate((element) => {
          const controlRect = element.getBoundingClientRect();
          const sidebarRect = element.closest(".library-sidebar")!.getBoundingClientRect();
          return controlRect.left >= sidebarRect.left - 0.5 && controlRect.right <= sidebarRect.right + 0.5 && controlRect.top >= sidebarRect.top - 0.5 && controlRect.bottom <= sidebarRect.bottom + 0.5;
        });
        expect(withinSidebar, `${width}px ${label} containment`).toBe(true);
      }
      const layout = await sidebar.evaluate((element) => ({
        overflowX: getComputedStyle(element).overflowX,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      expect(layout.overflowX, `${width}px sidebar overflow mode`).not.toMatch(/auto|scroll/);
      expect(layout.scrollWidth, `${width}px sidebar scroll width`).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.pageOverflow, `${width}px page overflow`).toBe(false);
    }
  });
});
