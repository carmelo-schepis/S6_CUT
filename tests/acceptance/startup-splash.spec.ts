import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const health = {
  status: "ready", version: "0.1.0", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, dataPath: "Local data", freeBytes: 2_000_000_000,
  activeWorkers: 1, queuedJobs: 0, fallbacks: {},
};
const recent = (items: unknown[] = []) => ({ items, page: 1, pageSize: 12, hasMore: false, total: items.length });
const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

// Every API response is intercepted: these tests never change the engine dataset.
async function mockEngine(page: Page, items: unknown[] = []) {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/health")) return json(route, health);
    if (path.endsWith("/recent-clips")) return json(route, recent(items));
    return json(route, []);
  });
}

async function hold(page: Page, pattern: string | RegExp) {
  let release!: () => void;
  let requested = false;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    requested = true;
    await ready;
    await route.fallback();
  });
  return { release, requested: () => requested };
}

async function expectCovered(page: Page) {
  const splash = page.locator("#startup-screen");
  await expect(splash).toBeVisible();
  await expect(splash).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator("#root")).toHaveCSS("opacity", "0");
  const geometry = await splash.boundingBox();
  const viewport = page.viewportSize()!;
  expect(geometry).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
}

async function expectRevealed(page: Page) {
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("heading", { name: "Create a project", exact: true })).toBeVisible();
}

test("static black logo screen paints before application JavaScript arrives", async ({ page }) => {
  await mockEngine(page);
  const gate = await hold(page, /\/(?:src\/main\.tsx|assets\/[^/]+\.js)(?:\?.*)?$/);
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    const logo = page.getByRole("img", { name: "S6 Cut", exact: true });
    await expect(logo).toBeVisible();
    await expect(page.locator(".startup-wordmark")).toHaveText("s6_cut");
    const motion = () => page.locator("#startup-screen").evaluate((element) => getComputedStyle(element, "::before").animationName);
    await expect.poll(motion).toBe("startup-drift");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(motion).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("#root > *")).toHaveCount(0);
  } finally { gate.release(); }
  await expectRevealed(page);
});

test("wallpaper completes before revealing the page on initial load and reload", async ({ page }) => {
  await mockEngine(page);
  for (const reload of [false, true]) {
    const gate = await hold(page, "**/projects-wallpaper.jpg");
    try {
      if (reload) await page.reload({ waitUntil: "domcontentloaded" });
      else await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect.poll(gate.requested).toBe(true);
      await expectCovered(page);
      // Waiting for the API independently must not reveal an undecoded wallpaper.
      await expect(page.locator(".recent-clips-section")).toContainText("No clips in your Library yet.");
      await expectCovered(page);
    } finally { gate.release(); }
    await expectRevealed(page);
    await page.unroute("**/projects-wallpaper.jpg");
    await expect(page.locator(".app-wallpaper")).toHaveCSS("opacity", "1");
  }
});

test("initial Recent clips response gates reveal and keyboard access", async ({ page }) => {
  await mockEngine(page);
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getElementById("root")!.contains(document.activeElement))).toBe(false);
    await expectCovered(page);
  } finally { gate.release(); }
  await expectRevealed(page);
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
});

test("visible Recent clips have a decoded video frame before reveal", async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 3000 });
  await mockEngine(page, [{
    id: "startup-preview", title: "Startup preview", description: "", mediaType: "video/mp4",
    filename: "startup-preview.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [],
    policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 3,
    licence: "User supplied", attribution: "", contentHash: "startup-preview", origin: "generated-clip",
    createdAt: "2026-01-01T00:00:00Z", previewUrl: "/startup-preview.mp4", width: 320, height: 180,
  }]);
  const fixture = await readFile("test-video.mp4");
  await page.route("**/startup-preview.mp4", (route) => route.fulfill({ contentType: "video/mp4", body: fixture }));
  const gate = await hold(page, "**/startup-preview.mp4");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    expect(await page.locator(".recent-clip-card video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeLessThan(2);
  } finally { gate.release(); }
  await expectRevealed(page);
  const video = page.locator(".recent-clip-card video");
  expect(await video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && node.videoWidth > 0)).toBe(true);
  await expect(video).toHaveAttribute("preload", "metadata");
});

test("failed wallpaper and engine requests expose usable errors instead of trapping startup", async ({ page }) => {
  await mockEngine(page);
  await page.route("**/projects-wallpaper.jpg", (route) => route.abort());
  await page.route("**/api/v1/health", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Engine unavailable" }) }));
  await page.route("**/api/v1/library/recent-clips**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Recent clips unavailable" }) }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectRevealed(page);
  await expect(page.getByRole("alert").filter({ hasText: "Recent clips unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true }).first()).toBeEnabled();
});

test("a permanently stalled initial request cannot hide the app indefinitely", async ({ page }) => {
  await page.clock.install();
  await mockEngine(page);
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    await page.clock.fastForward(31_000);
    await expectRevealed(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled();
  } finally { gate.release(); }
});
