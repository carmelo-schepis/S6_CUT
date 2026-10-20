import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { asset, overview } from "../../web/src/components/mobile/mobile-fixtures";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, browserName }, info) => {
  test.skip(browserName !== "webkit", "The changed view is the iPhone/iPad status app.");
  if (info.project.name === "iPad WebKit desktop mode") {
    await page.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }));
  }
  const thumbnail = await readFile("web/public/favicon.png");
  await page.route(/\/(?:home|library)-retained-thumb\.png$/, (route) =>
    route.fulfill({ contentType: "image/png", body: thumbnail }));
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const clip = asset({ id: "retained-clip", title: "Retained clip", thumbnailUrl: "/home-retained-thumb.png" });
    const body = path.endsWith("/mobile/overview") ? overview() :
      path.endsWith("/recent-clips") ? { items: [clip], page: 1, pageSize: 12, total: 1, hasMore: false } :
      path.endsWith("/assets/page") ? { items: [{ ...clip, thumbnailUrl: "/library-retained-thumb.png" }], page: 1, pageSize: 24, total: 1, hasMore: false } : [];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
});

test("prepared tabs retain their pages, decoded logos, filters and images on navigation and Back", async ({ page }) => {
  let assets = 0, recent = 0, documents = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/assets/page")) assets++;
    if (path.endsWith("/recent-clips")) recent++;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
  });
  await page.addInitScript(() => {
    (window as unknown as { __hashChanges: number }).__hashChanges = 0;
    window.addEventListener("hashchange", () => (window as unknown as { __hashChanges: number }).__hashChanges++);
  });
  await page.goto("/");
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/startup-/);
  expect(assets).toBe(1); // Library was prepared during the first entry.
  expect(recent).toBe(1);
  expect(await page.locator(".m-app img").evaluateAll((images) =>
    images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("searchbox").fill("retained");
  await expect.poll(() => assets).toBe(2);
  await expect(page.locator(".m-library .m-poster img")).toBeVisible();
  await expect(page.locator(".m-library")).not.toContainText("Loading Library");
  await page.evaluate(() => {
    (window as unknown as { __retained: Element[] }).__retained = [
      document.querySelector(".m-home")!, document.querySelector(".m-hero-mark")!,
      document.querySelector(".m-library")!, document.querySelector(".m-library .m-poster img")!,
      document.querySelector(".m-jobs")!, document.querySelector(".m-brand img")!,
    ];
  });
  for (const tab of ["Jobs", "Home", "Library", "Jobs", "Library"]) {
    await nav.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator(".m-app")).toHaveAttribute("data-tab", tab.toLowerCase());
    await expect(page.locator("#root")).toHaveCSS("opacity", "1");
    await expect(page.locator("body")).not.toHaveClass(/startup-/);
  }
  expect(await page.evaluate(() => {
    const old = (window as unknown as { __retained: Element[] }).__retained;
    return [".m-home", ".m-hero-mark", ".m-library", ".m-library .m-poster img", ".m-jobs", ".m-brand img"]
      .every((selector, index) => document.querySelector(selector) === old[index]);
  })).toBe(true);
  await expect(page.getByRole("searchbox")).toHaveValue("retained");
  expect(assets).toBe(2);
  expect(recent).toBe(1);
  expect(documents).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __hashChanges: number }).__hashChanges)).toBe(0);
  await expect(page.locator(".m-wallpaper")).toHaveCSS("transition-duration", "0s");
  await page.goBack();
  await expect(page.locator(".m-app")).toHaveAttribute("data-tab", "jobs");
  await page.goForward();
  await expect(page.getByRole("searchbox")).toHaveValue("retained");
});

test("the initial loading page covers preparation of the hidden Library and its thumbnails", async ({ page }) => {
  let releaseData!: () => void, releaseImage!: () => void;
  let dataRequested = false, imageRequested = false;
  const data = new Promise<void>((resolve) => { releaseData = resolve; });
  const image = new Promise<void>((resolve) => { releaseImage = resolve; });
  await page.route(/\/assets\/page(?:\?|$)/, async (route) => {
    dataRequested = true; await data; await route.fallback();
  });
  await page.route("**/library-retained-thumb.png", async (route) => {
    imageRequested = true; await image; await route.fallback();
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => dataRequested).toBe(true);
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    releaseData();
    await expect.poll(() => imageRequested).toBe(true);
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(page.locator("#startup-screen")).toBeAttached();
  } finally { releaseData(); releaseImage(); }
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".m-library .m-poster img")).toBeVisible();
  expect(await page.locator(".m-library .m-poster img").evaluate((image) => (image as HTMLImageElement).complete)).toBe(true);
});
