/**
 * The Shorts Editor's output settings are job parameters, not preview
 * settings. A YouTube source has no local preview until it is imported, so
 * gating them behind the preview made aspect ratio, subtitles and project name
 * unreachable for exactly the source type the screen advertises.
 */
import { test, expect } from "@playwright/test";

test("Shorts Editor exposes output settings for a YouTube source", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(4_000);

  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await page.waitForTimeout(2_000);
  await page.getByRole("tab", { name: "YouTube", exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole("textbox", { name: /YouTube|URL/i }).first()
    .fill("https://www.youtube.com/watch?v=ZvSEsBpuP3c&pp=ugUHEgVlbi1BVQ%3D%3D");
  await page.waitForTimeout(1_200);

  // Trim is already reachable; the rest of the job settings must be too.
  await expect(page.getByRole("spinbutton", { name: "Start seconds" }).first()).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "End seconds" }).first()).toBeVisible();

  const aspect = page.getByLabel("Aspect ratio");
  await expect(aspect, "aspect ratio must be selectable for a YouTube source").toBeVisible();
  await aspect.selectOption("4:5");
  expect(await aspect.inputValue()).toBe("4:5");

  await expect(page.getByRole("checkbox", { name: /Subtitles/i }),
    "the subtitles toggle must be reachable for a YouTube source").toBeVisible();
});
