import { expect, test, type Locator } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function expectTranslucent(locator: Locator) {
  const appearances = await locator.evaluateAll((elements) => {
    const context = document.createElement("canvas").getContext("2d")!;
    return elements.map((element) => {
      const style = getComputedStyle(element);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return { alpha: context.getImageData(0, 0, 1, 1).data[3], opacity: style.opacity };
    });
  });
  expect(appearances.length).toBeGreaterThan(0);
  for (const appearance of appearances) {
    expect(appearance.alpha).toBeGreaterThan(0);
    expect(appearance.alpha).toBeLessThan(255);
    // Only the background is translucent: labels, icons, and focus stay crisp.
    expect(appearance.opacity).toBe("1");
  }
}

test("Projects controls show the wallpaper and retain clear, working selections", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const project = page.locator(".projects-page");
  await expectTranslucent(project.locator(".source-tabs, .segmented, .mode-tabs, .style-card"));
  await expectTranslucent(project.locator(".source-tabs .active, .segmented .active, .mode-tabs .active"));

  await page.getByRole("tab", { name: "YouTube", exact: true }).click();
  await expect(page.getByRole("tab", { name: "YouTube", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("YouTube URL", { exact: true })).toBeVisible();
  await expectTranslucent(project.locator(".source-tabs .active"));
  await page.getByRole("tab", { name: "Local file", exact: true }).click();
  const browse = page.getByRole("button", { name: "Browse files", exact: true });
  await expectTranslucent(browse);
  const chooserEvent = page.waitForEvent("filechooser");
  await browse.click();
  await (await chooserEvent).setFiles([]);

  const styles = page.getByRole("region", { name: "Editorial style" });
  await styles.scrollIntoViewIfNeeded();
  for (const title of ["Funny", "Serious", "Educational", "Hype"]) {
    const button = styles.getByRole("button", { name: new RegExp(`^${title}`) });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button.locator(".style-card-check")).toBeVisible();
    await expectTranslucent(styles.locator(".style-card"));
  }
  const unselected = styles.getByRole("button", { name: /^Funny/ });
  await unselected.hover();
  await expectTranslucent(unselected);
  await unselected.focus();
  await expect(unselected).toBeFocused();

  await page.getByRole("button", { name: "Long form · 16:9", exact: true }).click();
  await expect(page.getByRole("button", { name: /Create 5 landscape clips/ })).toBeEnabled();
  await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
  for (const name of ["Fast", "Smart", "Auto"]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expectTranslucent(button);
  }
  await expectTranslucent(project.locator(".count-control button, .count-control strong"));
  await page.getByRole("button", { name: "More clips", exact: true }).click();
  await expect(project.locator(".count-control strong")).toHaveText("6");
  await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  await expect(project.locator(".count-control strong")).toHaveText("5");
  await page.getByRole("button", { name: "High-volume · up to 500", exact: true }).click();
  const count = page.getByRole("textbox", { name: "Clips requested", exact: true });
  await expectTranslucent(count);
  await count.fill("37");
  await expect(page.getByRole("button", { name: /Create 37 short clips/ })).toBeEnabled();
  await page.getByRole("button", { name: "Standard · up to 30", exact: true }).click();
  await expect(project.locator(".count-control strong")).toHaveText("30");
  await expectTranslucent(project.locator(".source-tabs, .segmented, .mode-tabs, .style-card"));
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", page.viewportSize()!.width);
});
