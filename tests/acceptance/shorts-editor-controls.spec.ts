import { expect, test } from "@playwright/test";

async function openShortsEditor(page) {
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
}

test("YouTube editor controls validate trims and retain output settings without contacting YouTube", async ({ page }) => {
  const sourceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/v1/jobs/shorts/source")) sourceRequests.push(request.url());
  });
  await openShortsEditor(page);

  await page.getByRole("tab", { name: "YouTube", exact: true }).click();
  await expect(page.getByLabel("YouTube URL")).toBeVisible();
  await expect(page.getByLabel("Start seconds")).toBeVisible();
  await expect(page.getByLabel("End seconds")).toBeVisible();
  await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=local-fixture-only");
  await page.getByLabel("Start seconds").fill("8");
  await page.getByLabel("End seconds").fill("8");
  await page.getByLabel("Aspect ratio").selectOption("4:5");
  await page.getByLabel("Project name").fill("Acceptance fixture");
  const subtitles = page.getByRole("checkbox", { name: "Subtitles" });
  await expect(subtitles).toBeChecked();
  await subtitles.uncheck();
  await page.getByRole("button", { name: "Queue short" }).click();

  await expect(page.getByRole("alert")).toContainText("End seconds must be blank or greater than start.");
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
  await expect(page.getByLabel("Project name")).toHaveValue("Acceptance fixture");
  await expect(subtitles).not.toBeChecked();
  expect(sourceRequests).toEqual([]);
});

test("Shorts Editor keeps its source and editing controls usable without horizontal overflow", async ({ page }) => {
  await openShortsEditor(page);
  await page.getByRole("tab", { name: "YouTube", exact: true }).click();
  await expect(page.getByLabel("YouTube URL")).toBeVisible();

  for (const viewport of [{ width: 810, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
    await expect(page.getByLabel("Start seconds")).toBeVisible();
    await expect(page.getByLabel("Aspect ratio")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
