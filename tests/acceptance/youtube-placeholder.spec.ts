import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-artifacts/youtube-placeholder");

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`shows a muted YouTube URL example on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible({ timeout: 90_000 });

    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    const field = page.getByLabel("YouTube URL");
    await expect(field).toHaveAttribute("placeholder", "https://www.youtube.com/watch?v=...");
    await expect(field).toHaveValue("");
    await expect(field).toBeVisible();
    await expect(field).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect.poll(() => field.evaluate((element) => getComputedStyle(element, "::placeholder").color)).toBe("rgba(255, 255, 255, 0.45)");

    await page.screenshot({ path: path.join(artifacts, `${viewport.name}.png`), fullPage: true });
    await field.fill("https://www.youtube.com/watch?v=abc123");
    await expect(field).toHaveValue("https://www.youtube.com/watch?v=abc123");
    await expect.poll(() => field.evaluate((element) => getComputedStyle(element, "::placeholder").color)).toBe("rgba(255, 255, 255, 0.45)");
  });
}
