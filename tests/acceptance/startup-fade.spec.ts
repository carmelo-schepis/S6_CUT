import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "iPad WebKit desktop mode") {
    // Playwright reports one touch point; a real iPad advertises multi-touch
    // even when Safari sends a Macintosh user agent.
    await page.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }));
  }
});

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
    if (path.endsWith("/mobile/overview")) return json(route, { generatedAt: new Date().toISOString() });
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

async function expectRevealed(page: Page) {
  await expect(page.locator("#startup-screen")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#root main")).toBeVisible();
}

test("the splash fades over the ready screen before releasing interaction", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "50ms");
  const gate = await hold(page, /\/(?:src\/main\.tsx|assets\/[^/]+\.js)(?:\?.*)?$/);
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1");
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.id === "startup-screen") {
          animation.pause();
          const duration = Number(animation.effect!.getComputedTiming().duration);
          const opacities = [0, 0.25, 0.5, 0.75, 1].map((progress) => {
            animation.currentTime = duration * progress;
            return Number(getComputedStyle(this).opacity);
          });
          const root = document.getElementById("root")!;
          document.body.dataset.exitFade = JSON.stringify({
            duration, opacities, inert: root.hasAttribute("inert"),
            rootOpacity: Number(getComputedStyle(root).opacity),
          });
          animation.currentTime = 0;
          animation.play();
        }
        return animation;
      };
    });
  } finally { gate.release(); }
  await expectRevealed(page);
  const exit = JSON.parse((await page.locator("body").getAttribute("data-exit-fade"))!);
  expect(exit.duration).toBe(360);
  expect(exit.opacities[0]).toBe(1);
  expect(exit.opacities[4]).toBe(0);
  for (let i = 1; i < exit.opacities.length; i++) {
    expect(exit.opacities[i]).toBeLessThan(exit.opacities[i - 1]);
  }
  expect(exit.rootOpacity).toBe(1);
  expect(exit.inert).toBe(true);
});

test("quick loads use an explicit app fade even when styles change in one frame", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "60s");
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.body?.classList.contains("startup-quick")) return;
      const root = document.getElementById("root")!;
      const animation = root.getAnimations().find((item) =>
        item instanceof CSSAnimation && item.animationName === "startup-app-appear");
      if (!animation) return;
      animation.pause();
      animation.currentTime = 120;
      document.body.dataset.quickFadeOpacity = getComputedStyle(root).opacity;
      animation.play();
      observer.disconnect();
    });
    observer.observe(document, { attributes: true, subtree: true });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectRevealed(page);
  await expect(page.locator("body")).toHaveAttribute("data-quick-fade-opacity");
  const opacity = Number(await page.locator("body").getAttribute("data-quick-fade-opacity"));
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await expect(page.locator("body")).not.toHaveClass(/startup-quick/);
  await expect(page.locator("#root")).toHaveCSS("opacity", "1");
});

test("mobile waits for initial data and wallpaper before revealing", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "The iOS status view has its own startup data.");
  await mockEngine(page);
  const data = await hold(page, "**/api/v1/mobile/overview**");
  const wallpaper = await hold(page, "**/mobile-wallpaper.jpg");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(data.requested).toBe(true);
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(page.locator("#startup-screen")).toBeAttached();
    data.release();
    await expect.poll(wallpaper.requested).toBe(true);
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(page.locator("#startup-screen")).toBeAttached();
  } finally { data.release(); wallpaper.release(); }
  await expectRevealed(page);
});

test("mobile startup errors reveal usable retry controls", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "The iOS status view has its own startup data.");
  await mockEngine(page);
  await page.route("**/api/v1/mobile/overview**", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Engine unavailable" }),
  }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectRevealed(page);
  await expect(page.getByRole("alert")).toContainText("Engine unavailable");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
});

test("normal playback changes opacity progressively without seeking the animation", async ({ page }) => {
  await mockEngine(page);
  await withSplashDelay(page, "50ms");
  const data = await hold(page, /\/api\/v1\/(?:mobile\/overview|library\/recent-clips)(?:\?.*)?$/);
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(data.requested).toBe(true);
    await expect(page.locator("#startup-screen")).toHaveCSS("opacity", "1");
    // Keep entrance/script startup separate from exit playback, as in the
    // normal-load video review; headless WebKit can coalesce their first paints.
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const samples: { time: number; opacity: number }[] = [];
      (window as unknown as { __normalFade: typeof samples }).__normalFade = samples;
      // WebKit's compositor can paint while JavaScript animation-frame callbacks
      // are throttled. Sample the running animation without seeking or pausing it.
      const timer = window.setInterval(() => {
        const screen = document.getElementById("startup-screen");
        if (!screen) { window.clearInterval(timer); return; }
        if (document.body.classList.contains("startup-revealing")) {
          samples.push({ time: performance.now(), opacity: Number(getComputedStyle(screen).opacity) });
        }
      }, 20);
    });
  } finally { data.release(); }
  await expectRevealed(page);
  const samples = await page.evaluate(() =>
    (window as unknown as { __normalFade: { time: number; opacity: number }[] }).__normalFade);
  const intermediate = samples.filter(({ opacity }) => opacity > 0.02 && opacity < 0.98);
  expect(intermediate.length).toBeGreaterThanOrEqual(2);
  expect(intermediate.at(-1)!.time - intermediate[0].time).toBeGreaterThan(80);
  expect(intermediate[0].opacity).toBeGreaterThan(intermediate.at(-1)!.opacity);
});
