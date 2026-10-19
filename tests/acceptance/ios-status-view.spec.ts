import { expect, test, type Page, type Route } from "@playwright/test";

const project = {
  schemaVersion: 1, id: "project-1", name: "Studio session", mode: "clip", style: "educational",
  state: "active", sourceName: "session.mp4", sourceKind: "upload", requestedCount: 2,
  latestJobId: "job-1", createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:01:00Z",
};
const job = (progress: number) => ({
  schemaVersion: 1, id: "job-1", projectId: "project-1", mode: "clip", state: "active",
  stage: "download", stageLabel: "Downloading source", progress, currentItem: 0, totalItems: 2,
  style: "educational", processingMode: "fast", warnings: [], beats: [], steps: [],
  downloadProgress: {
    downloadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, percent: progress,
    phase: "downloading", lastProgressAt: "2026-10-18T10:01:00Z", speedBytesPerSecond: 512 * 1024,
    etaSeconds: 6, resumable: true,
  },
  clips: [{
    id: "clip-1", index: 1, state: "complete", start: 0, end: 4, duration: 4,
    openingLine: "A good first clip", selected: true, outputName: "clip.mp4", blobId: "blob-1",
    previewUrl: "/api/v1/library/assets/asset-1/preview?expires=100&signature=old",
    downloadUrl: "/api/v1/files/jobs/clip.mp4?expires=100&signature=download",
  }],
  createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:01:00Z",
});
const health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true,
  dataPath: "/app/data", freeBytes: 1, configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0,
  fallbacks: { media: "text card" },
};

async function stubApi(page: Page) {
  const mutations: string[] = [];
  let jobReads = 0;
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 405, body: "Read-only test fixture" });
      return;
    }
    if (path.endsWith("/health")) return route.fulfill({ json: health });
    if (path.endsWith("/video-downloads")) return route.fulfill({ json: [] });
    if (path.endsWith("/jobs")) {
      jobReads += 1;
      return route.fulfill({ json: [job(jobReads > 1 ? 48 : 42)] });
    }
    if (path.endsWith("/projects")) return route.fulfill({ json: [project] });
    return route.fulfill({ json: [] });
  });
  return { mutations, jobReads: () => jobReads };
}

test("iOS devices get read-only status, live progress and stable inline previews", async ({ page }, testInfo) => {
  test.skip((!testInfo.project.name.startsWith("iPhone") && !testInfo.project.name.startsWith("iPad")) || testInfo.project.name === "iPad WebKit desktop mode", "iOS device routing is covered separately for desktop-mode iPad");
  const { mutations, jobReads } = await stubApi(page);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".ios-status-page")).toBeVisible();
  await expect(page.locator(".ios-status-brand")).toContainText("S6_cut status");
  await expect(page.getByRole("heading", { name: "Project work" })).toBeVisible();
  await expect(page.getByText("Studio session")).toBeVisible();
  await expect(page.getByText("Downloading source").first()).toBeVisible();
  await expect(page.getByText("42%", { exact: true })).toBeVisible();
  const video = page.locator(".ios-status-previews video");
  await expect(video).toHaveAttribute("controlslist", /nodownload/);
  await expect(video).toHaveAttribute("src", /signature=old/);
  await expect(page.getByRole("button", { name: /download|edit|create|pause|resume|retry|settings/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("48%", { exact: true })).toBeVisible();
  await expect(video).toHaveAttribute("src", /signature=old/);
  expect(jobReads()).toBeGreaterThanOrEqual(2);
  expect(mutations).toEqual([]);
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("desktop keeps the full studio at phone width and desktop width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("iPhone") || testInfo.project.name.startsWith("iPad"), "desktop routing");
  await stubApi(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".ios-status-page")).toHaveCount(0);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".ios-status-page")).toHaveCount(0);
  if (original) await page.setViewportSize(original);
});

test("iPad desktop browsing identity still routes to the status view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iPad WebKit desktop mode", "desktop-mode iPad identity");
  await page.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 }));
  await stubApi(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".ios-status-page")).toBeVisible();
  await expect(page.locator(".ios-status-brand")).toContainText("S6_cut status");
  await expect(page.getByRole("heading", { name: "Project work" })).toBeVisible();
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(1);
});
