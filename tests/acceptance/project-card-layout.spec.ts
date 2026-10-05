import { expect, test } from "@playwright/test";

test("Projects stays free of removed Recent projects cards at desktop and mobile widths", async ({ page }) => {
  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveCount(0);
    await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}: page horizontal overflow`).toBe(true);
  }
});
