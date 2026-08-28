import { test, expect } from "@playwright/test";

test.describe("responsive layout regressions", () => {
  test("keeps mobile navigation labels inside their cells", async ({ page }) => {
    for (const width of [320, 390, 400, 420, 440, 768, 820]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();
      const nav = page.locator(".app-rail nav");
      const measurement = await nav.evaluate((element) => {
        const items = [...element.querySelectorAll<HTMLElement>(".nav-item")];
        const labels = items.map((item) => item.querySelector<HTMLElement>("span")!.getBoundingClientRect());
        const icons = items.map((item) => item.querySelector<SVGElement>("svg")!.getBoundingClientRect());
        const itemRects = items.map((item) => item.getBoundingClientRect());
        const style = getComputedStyle(element);
        return {
          gap: style.columnGap,
          widths: itemRects.map((item) => item.width),
          labelsInside: labels.every((label, index) => label.left >= itemRects[index].left - 0.5 && label.right <= itemRects[index].right + 0.5),
          adjacentLabelsDoNotOverlap: labels.every((label, index) => index === 0 || label.left >= labels[index - 1].right - 0.5),
          iconsCentred: icons.every((icon, index) => Math.abs((icon.left + icon.width / 2) - (itemRects[index].left + itemRects[index].width / 2)) <= 0.5),
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(measurement.gap, `${width}px navigation gap`).toBe("0px");
      expect(measurement.widths.every((itemWidth) => itemWidth >= 44), `${width}px target width`).toBe(true);
      expect(Math.max(...measurement.widths) - Math.min(...measurement.widths), `${width}px equal widths`).toBeLessThanOrEqual(1);
      expect(measurement.pageOverflow, `${width}px page overflow`).toBe(false);
      expect(measurement.labelsInside, `${width}px label containment`).toBe(true);
      expect(measurement.adjacentLabelsDoNotOverlap, `${width}px adjacent label overlap`).toBe(true);
      expect(measurement.iconsCentred, `${width}px icon centring`).toBe(true);

      const items = nav.locator(".nav-item");
      for (const index of [0, 6]) {
        await items.nth(index).focus();
        const focusStyle = await items.nth(index).evaluate((item) => {
          const style = getComputedStyle(item);
          const rect = item.getBoundingClientRect();
          return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, viewport: { width: innerWidth, height: innerHeight } };
        });
        expect(focusStyle.outlineStyle, `${width}px focus style`).not.toBe("none");
        expect(Number.parseFloat(focusStyle.outlineWidth), `${width}px focus width`).toBeGreaterThanOrEqual(2);
        expect(Number.parseFloat(focusStyle.outlineOffset), `${width}px inward focus offset`).toBeLessThanOrEqual(0);
        expect(focusStyle.rect.left, `${width}px left focus edge`).toBeGreaterThanOrEqual(0);
        expect(focusStyle.rect.right, `${width}px right focus edge`).toBeLessThanOrEqual(focusStyle.viewport.width);
        expect(focusStyle.rect.top, `${width}px top focus edge`).toBeGreaterThanOrEqual(0);
        expect(focusStyle.rect.bottom, `${width}px bottom focus edge`).toBeLessThanOrEqual(focusStyle.viewport.height);
      }
      await items.nth(6).press("Enter");
      await expect(items.nth(6)).toHaveClass(/active/);
    }

    await page.setViewportSize({ width: 1440, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const desktop = await page.locator(".app-rail").evaluate((rail) => ({
      width: rail.getBoundingClientRect().width,
      navGap: getComputedStyle(rail.querySelector("nav")!).columnGap,
    }));
    expect(desktop.width, "desktop rail width").toBe(88);
    expect(desktop.navGap, "desktop navigation gap").toBe("5px");
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
