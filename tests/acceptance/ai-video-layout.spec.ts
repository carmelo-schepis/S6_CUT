import { expect, test } from "@playwright/test";

/**
 * The local-plan status is a single text node, not the icon + copy structure
 * used by Projects mode notes. It must therefore occupy one full grid track;
 * otherwise a short 20px icon column wraps each word vertically.
 */
test("AI Video local-plan status uses the full content width", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "AI Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Topic to Video", exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Topic or keyword" }).fill("QA disposable local plan");
  await page.getByRole("textbox", { name: "Custom script" }).fill("A clearly labelled local planning check that never calls a provider.");
  await page.getByRole("button", { name: "Create / refresh plan" }).click();
  await expect(page.getByText("Plan ready for review.", { exact: true })).toBeVisible();

  const layout = await page.locator(".topic-video-form > .mode-note").filter({ hasText: "Plan ready for review." }).evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    textWidth: (() => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().width;
    })(),
  }));
  expect(layout.columns, "a text-only status must not reserve an icon column").toHaveLength(1);
  expect(layout.textWidth, "the status text must not wrap to the icon column").toBeGreaterThan(100);
  expect(layout.height, "the status should remain a single readable line").toBeLessThan(32);
  expect(layout.width).toBeGreaterThan(500);
});
