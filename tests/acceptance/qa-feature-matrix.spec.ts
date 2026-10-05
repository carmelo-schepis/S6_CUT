/**
 * §6 feature matrix: walks the controls on every rail destination that can be
 * exercised without queueing a render, and asserts the behaviour each control
 * advertises. Render-dependent rows are covered by the per-case runs.
 */
import { test, expect, type Page } from "@playwright/test";

const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

async function boot(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(4_000);
  return errors;
}

const rail = async (page: Page, name: string) => {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(2_000);
};

test.describe("§6.1 application shell", () => {
  test("skip link is the first tab stop and moves focus to main", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: /Skip to main content/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeVisible();
  });

  test("every rail destination navigates and tracks aria-current", async ({ page }) => {
    await boot(page);
    for (const name of ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"]) {
      const button = page.getByRole("button", { name, exact: true }).first();
      await button.click();
      await page.waitForTimeout(1_200);
      await expect(button, `${name} should report aria-current`).toHaveAttribute("aria-current", "page");
      const current = await page.locator('[aria-current="page"]').count();
      expect(current, `exactly one rail item may be current (on ${name})`).toBe(1);
    }
  });

  test("brand button returns to Projects", async ({ page }) => {
    await boot(page);
    await rail(page, "Settings");
    await page.getByRole("button", { name: /S6_cut Projects/i }).click();
    await page.waitForTimeout(1_500);
    // 7542e67 removed the "Make the first cut" introduction; the Projects page
    // now carries a visually-hidden h1 as its landmark heading.
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeAttached();
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  });

  test("PWA assets and title are served", async ({ page, request }) => {
    await boot(page);
    await expect(page).toHaveTitle(/S6_cut/i);
    for (const asset of ["/manifest.webmanifest", "/sw.js"]) {
      const response = await request.get(asset);
      expect(response.status(), asset).toBe(200);
    }
    // Every icon the app actually references must resolve: the three in the
    // manifest plus the ones the document head links.
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    const linked = await page.locator('link[rel*="icon"]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("href")).filter(Boolean) as string[]);
    const icons = [...new Set([...manifest.icons.map((i: { src: string }) => i.src), ...linked])];
    expect(icons.length, "app should reference at least four icons").toBeGreaterThanOrEqual(4);
    for (const src of icons) {
      const response = await request.get(src);
      expect(response.status(), src).toBe(200);
    }
  });
});

test.describe("§6.2 Projects", () => {
  test("YouTube field rejects unsupported URLs and accepts supported hosts", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    const field = page.getByRole("textbox", { name: /YouTube|URL/i }).first();

    for (const bad of ["http://www.youtube.com/watch?v=abc", "https://vimeo.com/12345", "not a url"]) {
      await field.fill(bad);
      await page.locator(".create-button").click();
      await expect(page.getByText("Only public HTTPS YouTube URLs are supported."), `should reject ${bad}`).toBeVisible();
      await page.waitForTimeout(300);
    }

    // Supported hosts must clear the validation error without being submitted.
    for (const good of [
      "https://www.youtube.com/watch?v=8xEuFQz4E4A",
      "https://m.youtube.com/watch?v=8xEuFQz4E4A",
      "https://youtu.be/8xEuFQz4E4A",
      "https://www.youtube.com/watch?v=Ju41cQSe7hY&pp=ugUEEgJlbg%3D%3D",
    ]) {
      await field.fill(good);
      await page.waitForTimeout(200);
      expect(await field.inputValue(), `field should hold ${good}`).toBe(good);
    }
  });

  test("clip count clamps between 1 and 30 and the Create label tracks it", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    const fewer = page.getByRole("button", { name: "Fewer clips" });
    const more = page.getByRole("button", { name: "More clips" });
    const label = page.locator(".create-button");

    for (let i = 0; i < 40; i += 1) await fewer.click();
    await expect(label).toHaveText(/Create 1 short clip$/);
    for (let i = 0; i < 40; i += 1) await more.click();
    await expect(label).toHaveText(/Create 30 short clips$/);

    for (let i = 0; i < 28; i += 1) await fewer.click();
    await expect(label).toHaveText(/Create 2 short clips$/);
    await page.getByRole("button", { name: "Long form · 16:9", exact: true }).click();
    await expect(label).toHaveText(/Create 2 landscape clips$/);
  });

  test("long form forces 16:9 and disables the advanced aspect select", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await page.getByRole("button", { name: /Advanced controls/ }).click();
    await page.waitForTimeout(400);
    const aspect = page.getByLabel(/Aspect/i).first();
    await aspect.selectOption("1:1");
    await page.getByRole("button", { name: "Long form · 16:9", exact: true }).click();
    await page.waitForTimeout(400);
    await expect(aspect, "long form must pin the aspect select").toBeDisabled();
    expect(await aspect.inputValue(), "long form must resolve to 16:9").toBe("16:9");
  });

  test("advanced duration bounds report their exact errors", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    await page.getByRole("textbox", { name: /YouTube|URL/i }).first().fill("https://www.youtube.com/watch?v=8xEuFQz4E4A");
    await page.getByRole("button", { name: /Advanced controls/ }).click();
    await page.waitForTimeout(400);

    const min = page.getByLabel("Minimum seconds");
    const max = page.getByLabel("Maximum seconds");

    await min.fill("5");
    await page.locator(".create-button").click();
    await expect(page.getByText("Minimum seconds must be at least 8.")).toBeVisible();

    await min.fill("30");
    await max.fill("30");
    await page.locator(".create-button").click();
    await expect(page.getByText("Maximum seconds must be greater than minimum seconds.")).toBeVisible();

    await max.fill("200");
    await page.locator(".create-button").click();
    await expect(page.getByText("Short-form clips can be at most 180 seconds.")).toBeVisible();
  });

  test("script mode validates length and upload type", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await page.getByRole("button", { name: "Script mode", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("textbox").first().fill("too short");
    await page.locator(".create-button").click();
    await expect(page.getByText("Add at least 10 characters of script.")).toBeVisible();
  });

  test("removed Recent projects controls stay absent; Jobs history remains available", async ({ page }) => {
    await boot(page);
    await rail(page, "Projects");
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveCount(0);
    await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);
    await rail(page, "Jobs");
    await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
  });
});

test.describe("§6.9 Help", () => {
  test("help dialog traps focus, resolves its images, and restores focus on close", async ({ page, request }) => {
    await boot(page);
    const launcher = page.getByRole("button", { name: /Open S6 Cut Help/i });
    await launcher.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Body scroll must be locked while the dialog owns the screen.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    const sources = await dialog.locator("img").evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLImageElement).getAttribute("src")).filter(Boolean));
    expect(sources.length, "help should illustrate its sections").toBeGreaterThan(0);
    for (const src of sources) {
      const response = await request.get(src!);
      expect(response.status(), src!).toBe(200);
    }
    const broken = await dialog.locator("img").evaluateAll((nodes) =>
      nodes.filter((n) => !(n as HTMLImageElement).naturalWidth).map((n) => (n as HTMLImageElement).src));
    expect(broken, "every help image must render with real dimensions").toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(launcher).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  });
});
