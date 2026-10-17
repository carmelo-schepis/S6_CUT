import { expect, test } from "@playwright/test";

test("wallpaper, tint, transparent cards, and slow scroll stay on Projects", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const main = page.locator(".app-main");
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();

  const projectsStyle = await main.evaluate((element) => {
    const style = getComputedStyle(element);
    const activeCard = element.querySelector<HTMLElement>(".projects-page .style-card.active");
    return {
      backgroundImage: style.backgroundImage,
      scrollOffset: style.getPropertyValue("--projects-scroll").trim(),
      cardBackground: activeCard ? getComputedStyle(activeCard).backgroundColor : null,
    };
  });
  expect(projectsStyle.backgroundImage).toContain("projects-wallpaper.jpg");
  expect(projectsStyle.backgroundImage).toContain("linear-gradient(rgba(0, 0, 0, 0.62)");
  expect(projectsStyle.cardBackground).toBe("rgba(0, 0, 0, 0)");

  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => main.evaluate((element) => getComputedStyle(element).getPropertyValue("--projects-scroll").trim())).toBe("280px");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible();
  await expect.poll(() => main.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe("none");
});
