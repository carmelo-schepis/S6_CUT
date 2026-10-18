import { expect, test } from "@playwright/test";

test("Library and Editor use the simplified headings without helper copy", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing leaves this machine unless you use a URL or an enabled provider.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Organise reusable and project media in local business folders. Folders group content; they are not access boundaries.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Editor", exact: true })).toBeVisible();
  await expect(page.locator(".topbar-context strong")).toHaveCount(0);
});
