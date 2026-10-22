import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("editorial style cards clearly mark exactly one selection by mouse and keyboard", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // DOM visibility does not guarantee keyboard access during startup.
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  const group = page.getByRole("region", { name: "Editorial style" });
  const cards = group.locator(".style-card");
  await expect(cards).toHaveCount(4);
  await group.scrollIntoViewIfNeeded();
  await expect(group.getByRole("button", { name: /Educational/, pressed: true })).toBeVisible();

  for (const title of ["Funny", "Serious", "Educational", "Hype"]) {
    const button = group.getByRole("button", { name: new RegExp(`^${title}`) });
    await button.focus();
    await expect(button).toBeFocused();
    await button.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(button.locator(".style-card-check")).toBeVisible();
    const appearances = await cards.evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        selected: element.getAttribute("aria-pressed") === "true",
        border: style.borderColor,
        background: style.backgroundColor,
        overflow: element.scrollWidth > element.clientWidth,
      };
    }));
    const selected = appearances.find((item) => item.selected)!;
    const unselected = appearances.find((item) => !item.selected)!;
    expect(selected.border).not.toBe(unselected.border);
    expect(selected.background).not.toBe(unselected.background);
    expect(appearances.every((item) => !item.overflow)).toBe(true);
  }

  await group.getByRole("button", { name: /^Funny/ }).click();
  await expect(group.getByRole("button", { name: /^Funny/, pressed: true })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", page.viewportSize()!.width);
});
