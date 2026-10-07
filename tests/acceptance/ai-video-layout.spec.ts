import { expect, test } from "@playwright/test";

test("retired AI Video destination and planning controls are absent", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.getByRole("button", { name: "AI Video", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Topic to Video", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Custom script" })).toHaveCount(0);
});
