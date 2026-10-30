import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

for (const width of [390, 1024, 1440]) {
  test(`header stays solid at the scroll boundary at ${width}px`, async ({ page, browserName, isMobile }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project", exact: true })).toBeVisible();

    const header = page.locator(".topbar");
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior-y", "none");
    await expect(header).toHaveCSS("background-color", "rgb(0, 0, 0)");

    // Scroll content underneath the sticky bar, then pull past the page top.
    // Sample throughout the gesture so a transient gap fails the check too.
    await page.evaluate(() => {
      window.scrollTo(0, 500);
      const samples: number[] = [];
      Object.assign(window, { headerTopSamples: samples });
      Object.assign(window, { sampleHeaderTop: true });
      const sample = () => {
        samples.push(document.querySelector(".topbar")!.getBoundingClientRect().top);
        if ((window as unknown as { sampleHeaderTop: boolean }).sampleHeaderTop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    if (!(browserName === "webkit" && isMobile)) {
      const headerBox = await header.boundingBox();
      expect(headerBox).not.toBeNull();
      await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2);
    }
    for (let i = 0; i < 4; i++) {
      // Playwright cannot send wheel input to mobile WebKit. Exercise its
      // scroll boundary directly; desktop browsers use actual wheel input.
      if (browserName === "webkit" && isMobile) {
        await page.evaluate(() => window.scrollBy({ top: -700, behavior: "smooth" }));
      } else {
        await page.mouse.wheel(0, -700);
      }
      await page.waitForTimeout(400);
    }
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const positions = await page.evaluate(() => {
      Object.assign(window, { sampleHeaderTop: false });
      return (window as unknown as { headerTopSamples: number[] }).headerTopSamples;
    });
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((top) => Math.abs(top) < 0.5)).toBe(true);
    await expect(header).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
}
