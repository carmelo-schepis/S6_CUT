import { test, expect, type BrowserContext, type Locator } from "@playwright/test";

const baseURL = process.env.S6_PLAYWRIGHT_BASE_URL || process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

test.use({
  baseURL,
  screenshot: "only-on-failure",
  trace: "on-first-retry",
  video: "retain-on-failure",
});
test.describe.configure({ mode: "serial", retries: 1 });

test("Personal Media Library keyboard and pointer regression", async ({ browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let detailsButton: Locator;
  let previewButton: Locator;
  let titleA: string;
  let detailsB: Locator;
  let titleB: string;

  const inspectorTitle = () => page.locator(".asset-inspector input").first();
  const noDialog = async () => expect(page.getByRole("dialog")).toHaveCount(0);
  const closePreview = async () => {
    const close = page.getByRole("button", { name: "Close video preview", exact: true });
    if (await close.count()) await close.click();
    await noDialog();
  };
  const selectB = async () => {
    await detailsB.click();
    await expect(inspectorTitle()).toHaveValue(titleB);
  };
  const openWithKey = async (key: "Enter" | "Space") => {
    await previewButton.focus();
    await expect(previewButton).toBeFocused();
    await page.keyboard.press(key);
  };

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Personal Media Library", exact: true })).toBeVisible();

    const scripts = await page.locator("script[src]").evaluateAll((elements) => elements.map((element) => new URL(element.getAttribute("src")!, location.href).pathname));
    const stylesheets = await page.locator('link[rel="stylesheet"][href]').evaluateAll((elements) => elements.map((element) => new URL(element.getAttribute("href")!, location.href).pathname));
    expect(scripts.length, "current document has application scripts").toBeGreaterThan(0);
    expect(scripts.every((url) => url.startsWith("/assets/")), "scripts belong to the current deployment").toBeTruthy();
    expect(stylesheets.length, "current document has application styles").toBeGreaterThan(0);
    expect(stylesheets.every((url) => url.startsWith("/assets/")), "styles belong to the current deployment").toBeTruthy();

    previewButton = page.locator("button.asset-preview-trigger").first();
    await expect(previewButton).toHaveCount(1);
    const previewLabel = await previewButton.getAttribute("aria-label");
    expect(previewLabel).toMatch(/^Preview .+/);
    titleA = previewLabel!.replace(/^Preview /, "");
    // Titles need not be unique in a real Library. Keep every assertion scoped
    // to the card containing the opener rather than relying on a global name.
    detailsButton = previewButton.locator("xpath=ancestor::article").locator("button.asset-card-details");
    await expect(detailsButton).toHaveCount(1);

    const allDetails = page.locator("button.asset-card-details");
    const detailLabels = await allDetails.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") || ""));
    const detailBIndex = detailLabels.findIndex((label) => label !== `Select ${titleA} for Rule Inspector`);
    expect(detailBIndex).toBeGreaterThanOrEqual(0);
    detailsB = allDetails.nth(detailBIndex);
    titleB = (await detailsB.getAttribute("aria-label"))!.replace(/^Select /, "").replace(/ for Rule Inspector$/, "");
    expect(titleB).not.toBe(titleA);

    // Native structure and separate hit regions.
    const card = detailsButton.locator("xpath=ancestor::article");
    await expect(card).toHaveCount(1);
    await expect(card.locator("button")).toHaveCount(2);
    await expect(card.locator('input[type="checkbox"]')).toHaveCount(1);
    await expect(card.locator("button.asset-preview-trigger")).toHaveAttribute("type", "button");
    await expect(card.locator("button.asset-card-details")).toHaveAttribute("type", "button");
    expect(await card.getAttribute("role")).toBeNull();
    expect(await card.locator("button").evaluateAll((buttons) => buttons.every((button) => !button.hasAttribute("tabindex") || Number(button.getAttribute("tabindex")) <= 0))).toBeTruthy();
    await expect(card.locator("button.asset-preview-trigger button")).toHaveCount(0);
    await expect(card.locator("button.asset-card-details button")).toHaveCount(0);

    // Details Enter: the keyboard input itself must perform the action.
    await selectB();
    await detailsButton.focus();
    await expect(detailsButton).toBeFocused();
    const urlBeforeDetails = page.url();
    await page.keyboard.press("Enter");
    await expect(inspectorTitle()).toHaveValue(titleA);
    await noDialog();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    expect(page.url()).toBe(urlBeforeDetails);

    // Details Space, including page-scroll protection.
    await selectB();
    await detailsButton.focus();
    const scrollBeforeDetailsSpace = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Space");
    await expect(inspectorTitle()).toHaveValue(titleA);
    await noDialog();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeDetailsSpace);

    // Preview Enter: Inspector remains B, one dialog opens, and focus is restored.
    await selectB();
    await openWithKey("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toContainText(`${titleA} video preview`);
    await expect(inspectorTitle()).toHaveValue(titleB);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await closePreview();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(`Preview ${titleA}`);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await expect(inspectorTitle()).toHaveValue(titleB);

    // Preview Space and one-dialog protection.
    await selectB();
    const scrollBeforePreviewSpace = await page.evaluate(() => window.scrollY);
    await openWithKey("Space");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(inspectorTitle()).toHaveValue(titleB);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforePreviewSpace);
    await closePreview();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(`Preview ${titleA}`);

    // Pointer details and pointer preview regressions.
    await detailsButton.click();
    await expect(inspectorTitle()).toHaveValue(titleA);
    await noDialog();
    await selectB();
    await previewButton.click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(inspectorTitle()).toHaveValue(titleB);
    await closePreview();

    // Checkbox changes only bulk selection.
    await selectB();
    const checkbox = card.locator('input[type="checkbox"]');
    const checkedBefore = await checkbox.isChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !checkedBefore });
    await noDialog();
    await expect(inspectorTitle()).toHaveValue(titleB);
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: checkedBefore });

    // Open, close, and immediately inspect by keyboard.
    await selectB();
    await openWithKey("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await closePreview();
    await detailsButton.focus();
    await page.keyboard.press("Enter");
    await expect(inspectorTitle()).toHaveValue(titleA);
    await noDialog();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

    // Unrelated keys and repeat/key-up-only behavior are no-ops.
    await selectB();
    await detailsButton.focus();
    await page.keyboard.press("ArrowDown");
    await expect(inspectorTitle()).toHaveValue(titleB);
    await noDialog();
    await previewButton.focus();
    await page.keyboard.press("ArrowDown");
    await noDialog();
    await expect(inspectorTitle()).toHaveValue(titleB);

    // Real signed-media playback: metadata, dimensions, playback progression,
    // and absence of a media error are required rather than mocked.
    await selectB();
    await openWithKey("Enter");
    const previewVideo = page.locator("video.video-preview-video");
    await expect(previewVideo).toBeVisible();
    await expect.poll(() => previewVideo.evaluate((video) => video.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const media = await previewVideo.evaluate((video) => ({ width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null }));
    expect(media.width).toBeGreaterThan(0);
    expect(media.height).toBeGreaterThan(0);
    expect(media.error).toBeNull();
    await page.getByRole("button", { name: "Play video", exact: true }).click();
    await expect.poll(() => previewVideo.evaluate((video) => video.currentTime), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await previewVideo.evaluate((video) => video.error)).toBeNull();
    await closePreview();

    // Cleanup also verifies the preview remains closed.
    await closePreview();
  } finally {
    await closePreview();
    await context.close();
  }
});
