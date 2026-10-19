import { expect, test, type Page, type Route } from "@playwright/test";

// The iPhone/iPad status view: Home, Library and Jobs. Read-only, and built from
// the desktop's own tokens. These specs stub the engine so they never touch data.

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zWQAAAAASUVORK5CYII=", "base64");
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const runningJob = (progress: number) => ({
  id: "job-running", projectId: "project-1", projectName: "Studio session", mode: "clip", state: "active",
  stage: "render", stageLabel: "Rendering clips", progress, currentItem: 5, totalItems: 8, style: "educational", contentFormat: "short",
  sourceTitle: "A long talk about editing", sourceThumbnailUrl: "/api/v1/library/assets/source-1/thumbnail?expires=1&signature=a",
  steps: [
    { id: "source", label: "Download source", status: "complete", completedAt: ago(60_000) },
    { id: "render", label: "Render clips", status: "active", startedAt: ago(20_000), currentItem: 5, totalItems: 8 },
  ],
  clipsReady: 1,
  clips: [{ id: "clip-a", index: 1, title: "Cold open", duration: 12, thumbnailUrl: "/api/v1/library/assets/a1/thumbnail?expires=1&signature=a", previewUrl: "/api/v1/library/assets/a1/preview?expires=1&signature=a" }],
  createdAt: ago(120_000), updatedAt: now(),
});
const finishedJob = {
  id: "job-done", projectId: "project-2", projectName: "Podcast ep 12", mode: "clip", state: "complete", stage: "complete", stageLabel: "8 clips ready",
  progress: 100, style: "serious", contentFormat: "short", clipsReady: 8, clips: [], createdAt: ago(7_200_000), updatedAt: ago(3_600_000),
};
const download = {
  id: "d".repeat(32), state: "active", phase: "downloading", downloadedBytes: 1_572_864, totalBytes: 4_194_304, percent: 38,
  message: "Downloading", title: "How I edit Shorts", thumbnailUrl: "/api/v1/video-downloads/dddd/thumbnail?expires=1&signature=a", createdAt: ago(30_000), updatedAt: now(),
};
const asset = (id: string, title: string) => ({
  id, title, description: "", mediaType: "video/mp4", filename: `${id}.mp4`, tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral",
  protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: id, folderId: "unsorted", origin: "generated-clip",
  blobId: id, brands: [], people: [], durationSeconds: 30, createdAt: now(), previewUrl: `/api/v1/library/assets/${id}/preview?expires=1&signature=a`,
  thumbnailUrl: `/api/v1/library/assets/${id}/thumbnail?expires=1&signature=a`,
});
const health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true,
  dataPath: "/app/data", freeBytes: 1, configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
};

async function stubApi(page: Page) {
  const mutations: string[] = [];
  const requests: string[] = [];
  let overviewReads = 0;
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url.pathname);
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 405, body: "Read-only test fixture" });
      return;
    }
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: health });
    if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG });
    if (url.pathname.endsWith("/preview")) return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
    if (url.pathname.endsWith("/mobile/overview")) {
      overviewReads += 1;
      return route.fulfill({ json: {
        generatedAt: now(), running: [runningJob(overviewReads > 1 ? 74 : 62)], recent: [finishedJob], recentTotal: 1, downloads: [download], clipsLastDay: 14, failedLastDay: 1,
      } });
    }
    if (url.pathname.endsWith("/library/recent-clips")) return route.fulfill({ json: { items: [asset("a1", "Scene 12 – Hal Jordan"), asset("a2", "Scene 11 – Hal Jordan")], page: 1, pageSize: 12, hasMore: false, total: 103 } });
    if (url.pathname.endsWith("/library/assets/page")) return route.fulfill({ json: { items: [asset("a1", "Scene 12 – Hal Jordan"), asset("a2", "Scene 11 – Hal Jordan"), asset("a3", "Scene 10 – Hal Jordan")], page: 1, pageSize: 24, hasMore: false } });
    if (url.pathname.endsWith("/library/folders")) return route.fulfill({ json: [{ id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: now(), updatedAt: now() }] });
    return route.fulfill({ json: [] });
  });
  return { mutations, requests, overviewReads: () => overviewReads };
}

const isIosDevice = (name: string) => name.startsWith("iPhone") || name.startsWith("iPad");
const isStatusViewProject = (name: string) => isIosDevice(name) && name !== "iPad WebKit desktop mode";

test("iOS devices get Home, Library and Jobs: live progress, still previews, one player, nothing writable", async ({ page }, testInfo) => {
  test.skip(!isStatusViewProject(testInfo.project.name), "iOS device routing is covered separately for desktop-mode iPad");
  const { mutations, overviewReads } = await stubApi(page);
  const downloads: string[] = [];
  page.on("download", (item) => downloads.push(item.suggestedFilename()));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveCount(0);

  // Home: the wallpaper, a live headline and quick links. No search field.
  await expect(page.getByRole("heading", { level: 1, name: "2 jobs running" })).toBeVisible();
  await expect(page.locator(".m-wallpaper")).toHaveCSS("opacity", "1");
  // The wallpaper sits behind an 86% black overlay: dark enough to be atmosphere, not a bright backdrop.
  expect(await page.locator(".m-wallpaper").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("rgba(0, 0, 0, 0.86)");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /14 new clips/ })).toBeVisible();
  await expect(page.getByText("Studio session").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Scene 12 – Hal Jordan" })).toBeVisible();
  // A phone never opens a media connection just to draw a list.
  await expect(page.locator("video")).toHaveCount(0);

  // Jobs: live progress that refreshes on its own, steps, byte detail, finished clips.
  await page.getByRole("navigation").getByRole("button", { name: /Jobs/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect(page.locator(".m-wallpaper")).toHaveCSS("opacity", "0", { timeout: 5_000 });
  await expect(page.getByText("Render clips", { exact: true })).toBeVisible();
  await expect(page.getByText(/1\.5 MB of 4\.0 MB/)).toBeVisible();
  await expect(page.getByLabel("Rendering clips: 74%")).toBeVisible({ timeout: 20_000 });
  expect(overviewReads()).toBeGreaterThanOrEqual(2);
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview Cold open" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("video")).toHaveCount(1);
  await page.getByRole("button", { name: "Close video preview" }).click();
  await expect(page.locator("video")).toHaveCount(0);

  // Library: the desktop's filters and wording, a still grid.
  await page.getByRole("navigation").getByRole("button", { name: /Library/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(page.getByPlaceholder("Search titles, tags, people, brands…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Scene 10 – Hal Jordan" })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);

  // Back to Home brings the wallpaper back; the address held the tab all along.
  await page.getByRole("navigation").getByRole("button", { name: /Home/ }).click();
  await expect(page.locator(".m-wallpaper")).toHaveCSS("opacity", "1", { timeout: 5_000 });
  await expect(page).toHaveURL(/#\/$/);

  // No control that changes anything. (A row may legitimately be *about* a download, so match controls by their verb.)
  await expect(page.getByRole("button", { name: /^(pause|resume|retry|delete|remove|stop|cancel|download|save|settings)\b/i })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("navigation follows the desktop's breakpoints: top bar on phones, the sidebar on tablets", async ({ page }, testInfo) => {
  test.skip(!isStatusViewProject(testInfo.project.name), "iOS only");
  await stubApi(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const rail = page.locator(".m-rail");
  await expect(rail).toBeVisible();
  const box = await rail.boundingBox();
  const viewport = page.viewportSize()!;
  if (viewport.width < 744) {
    // A top bar: full width, tabs are text, and every tab is at least 44px tall.
    expect(box!.x).toBe(0);
    expect(box!.y).toBe(0);
    expect(box!.width).toBe(viewport.width);
    expect(box!.height).toBeLessThanOrEqual(64);
    for (const name of ["Home", "Library", "Jobs"]) {
      const tab = await page.getByRole("navigation").getByRole("button", { name: new RegExp(name) }).boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
    }
  } else {
    // The desktop sidebar: icons only up to 1180px, labelled from 1181px.
    expect(box!.x).toBe(0);
    expect(box!.height).toBe(viewport.height);
    expect(Math.round(box!.width)).toBe(viewport.width >= 1181 ? 224 : 68);
    await expect(page.locator(".m-topbar-title")).toBeVisible();
    for (const name of ["Home", "Library", "Jobs"]) {
      const tab = await page.getByRole("navigation").getByRole("button", { name: new RegExp(name) }).boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test("the status view is built from the desktop's tokens, not its own", async ({ page }, testInfo) => {
  test.skip(!isStatusViewProject(testInfo.project.name), "iOS only");
  await stubApi(page);
  await page.goto("/#/jobs", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  const result = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = (selector: string, property: string) => getComputedStyle(document.querySelector(selector)!).getPropertyValue(property);
    const resolve = (token: string, property: string) => {
      const element = document.createElement("span");
      element.style.setProperty(property, `var(${token})`);
      document.body.appendChild(element);
      const value = getComputedStyle(element).getPropertyValue(property);
      element.remove();
      return value;
    };
    return {
      titleSize: probe(".m-page h1", "font-size"), titleSizeToken: resolve("--type-title-size", "font-size"),
      sectionSize: probe(".m-section-head h2", "font-size"), sectionSizeToken: resolve("--type-section-size", "font-size"),
      bodySize: probe(".m-app", "font-size"), bodySizeToken: resolve("--type-text-size", "font-size"),
      font: probe(".m-app", "font-family"), fontToken: root.getPropertyValue("--font-sans").trim(),
      progress: getComputedStyle(document.querySelector(".m-work .progress-track span")!).backgroundColor, progressToken: resolve("--theme-primary", "background-color"),
      canvas: getComputedStyle(document.querySelector(".m-app")!).backgroundColor, canvasToken: resolve("--canvas", "background-color"),
    };
  });
  expect(result.titleSize).toBe(result.titleSizeToken);
  expect(result.sectionSize).toBe(result.sectionSizeToken);
  expect(result.bodySize).toBe(result.bodySizeToken);
  expect(result.font.replace(/["\s]/g, "")).toBe(result.fontToken.replace(/["\s]/g, ""));
  expect(result.progress).toBe(result.progressToken);
  expect(result.canvas).toBe(result.canvasToken);
});

test("desktop keeps the full studio at phone width and never downloads the status view", async ({ page }, testInfo) => {
  test.skip(isIosDevice(testInfo.project.name), "desktop routing");
  const { requests } = await stubApi(page);
  const assets: string[] = [];
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.startsWith("/assets/")) assets.push(path); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".m-app")).toHaveCount(0);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".m-app")).toHaveCount(0);
  expect(assets.filter((path) => path.includes("mobile-app"))).toEqual([]);
  expect(requests.filter((path) => path.endsWith("/mobile/overview"))).toEqual([]);
  if (original) await page.setViewportSize(original);
});

test("iPad desktop browsing identity still routes to the status view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iPad WebKit desktop mode", "desktop-mode iPad identity");
  await page.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 }));
  await stubApi(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator(".m-app")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "2 jobs running" })).toBeVisible();
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(1);
});
