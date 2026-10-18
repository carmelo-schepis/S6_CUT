import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("Projects wallpaper keeps its tint and parallax and fades on tab changes", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  const main = page.locator(".app-main");
  const wallpaper = page.locator(".app-wallpaper");
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();

  const projectsStyle = await wallpaper.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return {
      backgroundImage: style.backgroundImage,
      transitionDuration: getComputedStyle(element).transitionDuration,
    };
  });
  expect(projectsStyle.backgroundImage).toContain("projects-wallpaper.jpg");
  expect(projectsStyle.backgroundImage).toContain("linear-gradient(rgba(0, 0, 0, 0.62)");
  expect(projectsStyle.transitionDuration).toBe("1s");
  await expect.poll(() => wallpaper.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => main.evaluate((element) => getComputedStyle(element).getPropertyValue("--projects-scroll").trim())).toBe("280px");
  const geometry = () => wallpaper.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { height: style.height, transform: style.transform, position: style.backgroundPosition };
  });
  const projectsGeometry = await geometry();

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect.poll(() => wallpaper.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  expect(await geometry()).toEqual(projectsGeometry);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect.poll(() => wallpaper.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
});

test("wallpaper fades in both directions for every tab", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  const wallpaper = page.locator(".app-wallpaper");
  const opacity = () => wallpaper.evaluate((element) => Number(getComputedStyle(element).opacity));
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect.poll(opacity).toBe(1);

  for (const destination of ["Library", "Workspace", "Shorts Editor", "Jobs", "Settings"]) {
    await page.getByRole("button", { name: destination, exact: true }).click();
    await expect.poll(async () => { const value = await opacity(); return value > 0 && value < 1; }, { intervals: [20, 50, 100], timeout: 1000 }).toBe(true);
    await expect.poll(opacity).toBe(0);
    // A page-level black fill would obscure the wallpaper before its fade ends.
    await expect(page.locator("#main-content")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect.poll(async () => { const value = await opacity(); return value > 0 && value < 1; }, { intervals: [20, 50, 100], timeout: 1000 }).toBe(true);
    await expect.poll(opacity).toBe(1);
  }
});

test("quick tab reversals settle correctly and reduced motion skips the fade", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  const wallpaper = page.locator(".app-wallpaper");
  const opacity = () => wallpaper.evaluate((element) => Number(getComputedStyle(element).opacity));
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect.poll(opacity, { intervals: [20, 50] }).toBeLessThan(1);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect.poll(opacity).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect.poll(opacity).toBe(0);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect.poll(opacity).toBe(1);
  const duration = await wallpaper.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration));
  expect(duration).toBeLessThan(0.01);
});
