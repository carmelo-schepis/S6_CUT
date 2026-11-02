import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("editorial style cards clearly mark exactly one selection by mouse and keyboard", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // The startup splash covers the cards until the app reveals; keys sent before that land on the splash.
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  const group = page.getByRole("region", { name: "Editorial style" });
  const cards = group.locator(".style-card");
  await expect(cards).toHaveCount(4);
  await group.scrollIntoViewIfNeeded();
  await expect(group.getByRole("button", { name: /Educational/, pressed: true })).toBeVisible();

  for (const title of ["Funny", "Serious", "Educational", "Hype"]) {
    const button = group.getByRole("button", { name: new RegExp(`^${title}`) });
    await button.focus();
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

test("Music mode swaps in music editorial styles and keeps Clip mode's choice", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  test.skip(await page.locator("#m-content").count() > 0, "The mobile shell has no Projects create form.");
  const group = page.getByRole("region", { name: "Editorial style" });
  const titles = group.locator(".style-card strong");
  await group.getByRole("button", { name: /^Serious/ }).click();

  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await expect(titles).toHaveText(["Chorus", "Energy", "Storytelling", "Clear lyrics"]);
  await expect(group.getByText(/Punchlines|Complete claims|Clear explanations|Hooks & high energy/)).toHaveCount(0);
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(group.getByRole("button", { name: /^Chorus/, pressed: true })).toBeVisible();
  await group.getByRole("button", { name: /^Clear lyrics/ }).click();
  await expect(group.getByRole("button", { name: /^Clear lyrics/, pressed: true })).toBeVisible();
  const overflow = await group.locator(".style-card").evaluateAll((cards) => cards.some((card) => card.scrollWidth > card.clientWidth));
  expect(overflow).toBe(false);

  await page.getByRole("button", { name: /Clip mode/ }).click();
  await expect(titles).toHaveText(["Funny", "Serious", "Educational", "Hype"]);
  await expect(group.getByRole("button", { name: /^Serious/, pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await expect(group.getByRole("button", { name: /^Clear lyrics/, pressed: true })).toBeVisible();
});
