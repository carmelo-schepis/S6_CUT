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

// The splash waits 300ms before it appears, so an instant load never shows it. These tests choose the
// delay they need by rewriting the stylesheet response, which keeps them independent of how fast the
// machine happens to load the page.
async function withSplashDelay(page: Page, delay: string) {
  await page.route("**/startup.css*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const css = original.replace(/(startup-appear\s+(?:120ms\s+ease-out|1ms\s+linear))\s+300ms/g, `$1 ${delay}`);
    expect(css).not.toBe(original);
    await route.fulfill({ response, body: css });
  });
}

// Records when the splash first paints and when it leaves, frame by frame, from before the page runs.
async function watchSplash(page: Page) {
  await page.addInitScript(() => {
    const record = { firstVisible: null as number | null, removed: null as number | null, maxOpacity: 0 };
    (window as unknown as { __splash: typeof record }).__splash = record;
    const tick = () => {
      const screen = document.getElementById("startup-screen");
      if (screen) {
        const opacity = Number(getComputedStyle(screen).opacity);
        record.maxOpacity = Math.max(record.maxOpacity, opacity);
        if (opacity > 0.02 && record.firstVisible === null) record.firstVisible = performance.now();
      } else if (document.body && record.removed === null) record.removed = performance.now();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as unknown as { __splash: { firstVisible: number | null; removed: number | null; maxOpacity: number } }).__splash);
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

test("a quick load never shows the splash", async ({ page }) => {
  await mockEngine(page);
  // Longer than any load here, so the splash cannot appear: the delay is the only thing under test.
  await withSplashDelay(page, "60s");
  const read = await watchSplash(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectRevealed(page);
  expect((await read()).maxOpacity).toBe(0);
  await expect(page.locator("#root")).toHaveCSS("opacity", "1");
  // The loading state ends with the splash: it is what holds the wallpaper's transition off, so a
  // lingering class would silently disable the tab-change fade.
  await expect(page.locator("body")).not.toHaveClass(/startup-loading/);
  await expect(page.locator(".app-wallpaper")).toHaveCSS("transition-duration", "1s");
});

test("a slow load shows the splash only after the grace period, and removes it when ready", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "700ms");
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    // Measure the CSS grace period independently of script download/compilation:
    // on a busy machine it may already have elapsed before the API request starts.
    await page.locator("#startup-screen").evaluate((screen) => {
      const entry = screen.getAnimations().find((item) =>
        item instanceof CSSAnimation && item.animationName === "startup-appear")!;
      entry.pause();
      entry.currentTime = 0;
    });
    // Grace period: plain black, the app hidden and inert, but no splash yet.
    await expectCovered(page);
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "0");
    await page.locator("#startup-screen").evaluate((screen) => {
      screen.getAnimations().find((item) =>
        item instanceof CSSAnimation && item.animationName === "startup-appear")!.play();
    });
    // Still loading after it: now the splash appears.
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1", { timeout: 10_000 });
    await expectCovered(page);
  } finally { gate.release(); }
  await expectRevealed(page);
});

test("once the splash has appeared it stays long enough to read, never a flash", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "100ms");
  const read = await watchSplash(page);
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    await expect.poll(async () => (await read()).firstVisible).not.toBeNull();
    // Release only once it is clearly on screen. (One that has barely begun to fade in is discarded instead.)
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1");
  } finally { gate.release(); }
  await expectRevealed(page);
  await expect.poll(async () => (await read()).removed).not.toBeNull();
  const { firstVisible, removed } = await read();
  expect(removed! - firstVisible!).toBeGreaterThanOrEqual(230);
});

test("static black logo screen paints before application JavaScript arrives", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "200ms");
  const gate = await hold(page, /\/(?:src\/main\.tsx|assets\/[^/]+\.js)(?:\?.*)?$/);
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    // The grace period needs no JavaScript: the logo appears on its own if loading is slow. (WebKit does not
    // tick animations while the page script is still pending, so it may stop part-way through the fade.)
    await expect.poll(() => page.locator("#startup-screen").evaluate((screen) => Number.parseFloat(getComputedStyle(screen).opacity)), { timeout: 10_000 }).toBeGreaterThan(0.25);
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

test("entry and exit fade smoothly on load and reload without early interaction", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "50ms");
  for (const reload of [false, true]) {
    const gate = await hold(page, "**/api/v1/library/recent-clips**");
    if (reload) await page.reload({ waitUntil: "domcontentloaded" });
    else await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(gate.requested).toBe(true);
    await expectCovered(page);
    // Wait until the splash has fully appeared, so the exit has a full-opacity starting point.
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1", { timeout: 10_000 });
    const entry = await page.locator("#startup-screen").evaluate((screen) => {
      const animation = screen.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === "startup-appear")!;
      const delay = Number(animation.effect!.getComputedTiming().delay);
      animation.pause();
      animation.currentTime = delay + 90;
      const mid = Number(getComputedStyle(screen).opacity);
      animation.finish();
      return mid;
    });
    expect(entry).toBeGreaterThan(0);
    expect(entry).toBeLessThan(1);
    // Sample the exit synchronously: mobile polling can miss a short transition.
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.id === "startup-screen") {
          animation.pause();
          animation.currentTime = 110;
          const root = document.getElementById("root")!;
          root.querySelector<HTMLElement>("button")?.focus();
          document.body.dataset.startupFade = JSON.stringify({
            opacity: Number(getComputedStyle(this).opacity),
            rootOpacity: getComputedStyle(root).opacity,
            inert: root.hasAttribute("inert"),
            focused: root.contains(document.activeElement),
          });
          animation.play();
        }
        return animation;
      };
    });
    gate.release();
    await expect(page.locator("body")).toHaveAttribute("data-startup-fade", /opacity/);
    const exit = JSON.parse((await page.locator("body").getAttribute("data-startup-fade"))!);
    expect(exit.opacity).toBeGreaterThan(0);
    expect(exit.opacity).toBeLessThan(entry);
    expect(exit.rootOpacity).toBe("1");
    expect(exit.inert).toBe(true);
    expect(exit.focused).toBe(false);
    await expectRevealed(page);
    await page.unroute("**/api/v1/library/recent-clips**");
  }
});

test("reduced motion skips both fades but keeps the grace period", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockEngine(page);
  await withSplashDelay(page, "320ms");
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCovered(page);
  // No fade: the entrance is a 1ms step after the same grace period.
  expect(await page.locator("#startup-screen").evaluate((screen) => Number.parseFloat(getComputedStyle(screen).animationDuration))).toBeLessThanOrEqual(0.002);
  await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1", { timeout: 10_000 });
  await page.evaluate(() => {
    Element.prototype.animate = () => { throw new Error("Reduced motion must not animate"); };
  });
  gate.release();
  await expectRevealed(page);
});


test("an unavailable animation API cannot trap keyboard access", async ({ page }) => {
  await mockEngine(page);
  const gate = await hold(page, "**/api/v1/library/recent-clips**");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCovered(page);
  await page.evaluate(() => {
    Element.prototype.animate = () => { throw new Error("Animation unavailable"); };
  });
  gate.release();
  await expectRevealed(page);
});
