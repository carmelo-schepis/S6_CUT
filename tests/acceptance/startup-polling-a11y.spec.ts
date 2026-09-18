import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Startup, polling and page-structure regressions.
 *
 * Engine latency is simulated with request interception rather than waited for,
 * so these run the same against a fast development engine and a loaded one.
 */

const HEALTH_READY = {
  status: "ready", version: "0.1.0", database: true, ffmpeg: true, ffprobe: true, whisper: true,
  ytdlp: true, localTts: true, dataPath: "/app/data", freeBytes: 2_000_000_000,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0,
  fallbacks: { transcription: "Local Whisper", planning: "Deterministic", voice: "espeak-ng", media: "Library" },
};

const CONNECTED_PROFILE = {
  id: "profile-1", name: "Studio", textModelId: "vendor/model", ttsModelId: "free/speech", ttsVoice: "alloy", ttsSpeed: 1, selected: true,
  persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "••••1234", textStatus: "connected",
  ttsStatus: "connected", textMessage: "Connected", textLastCheckedAt: null, ttsMessage: "Connected", ttsLastCheckedAt: null, status: "connected",
  capabilities: ["OpenRouter text generation", "OpenRouter TTS"], fallbacks: { planning: "Deterministic planner", voice: "Local espeak-ng" },
};
const DISCONNECTED_PROFILE = { ...CONNECTED_PROFILE, openrouterConfigured: false, textStatus: "not_configured", ttsStatus: "not_configured", textMessage: null };

const asset = (id: string, title: string, mediaType = "video/mp4") => ({
  id, title, description: "", mediaType, filename: `${id}.mp4`, tags: [], brands: [], people: [],
  triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false,
  minSpacingSeconds: 0, maxUsesPerProject: 3, licence: "User supplied", attribution: "",
  contentHash: id, folderId: "folder-1", origin: "manual-import", blobId: id, createdAt: "2026-01-01T00:00:00Z",
});
// The mocked profile reports OpenRouter as connected, so the AI Video screen
// will fetch the model list. Without this the request reaches the real engine,
// which answers 503 "OpenRouter is not configured" and logs a console error.
const OPENROUTER_MODELS = [{ id: "vendor/model", name: "Vendor Model", contextLength: 128000 }];
const FOLDERS = [{ id: "folder-1", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];

const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type EngineOptions = {
  healthDelayMs?: number;
  healthHangs?: boolean;
  projectsDelayMs?: number;
  jobsDelayMs?: number;
  profilesDelayMs?: number;
  profiles?: unknown[];
  assets?: unknown[];
  models?: unknown[];
};

/** Installs a fully mocked engine so latency and payloads are under test control. */
async function mockEngine(page: Page, options: EngineOptions = {}) {
  const counters = { health: 0, jobs: 0, projects: 0, profiles: 0 };
  const state = { healthHangs: options.healthHangs ?? false };

  await page.route("**/api/v1/health", async (route) => {
    counters.health += 1;
    if (state.healthHangs) { await wait(40_000); await route.abort(); return; }
    if (options.healthDelayMs) await wait(options.healthDelayMs);
    await json(route, HEALTH_READY);
  });
  await page.route("**/api/v1/projects", async (route) => {
    counters.projects += 1;
    if (options.projectsDelayMs) await wait(options.projectsDelayMs);
    await json(route, []);
  });
  await page.route("**/api/v1/jobs", async (route) => {
    counters.jobs += 1;
    if (options.jobsDelayMs) await wait(options.jobsDelayMs);
    await json(route, []);
  });
  await page.route("**/api/v1/profiles", async (route) => {
    counters.profiles += 1;
    if (options.profilesDelayMs) await wait(options.profilesDelayMs);
    await json(route, options.profiles ?? [CONNECTED_PROFILE]);
  });
  await page.route("**/api/v1/openrouter/models**", (route) => json(route, options.models ?? OPENROUTER_MODELS));
  await page.route("**/api/v1/library/folders**", (route) => json(route, FOLDERS));
  await page.route("**/api/v1/library/assets**", (route) => json(route, options.assets ?? []));
  return { counters, state };
}

/** Records request start/finish so concurrency can be asserted, not guessed. */
function trackRequests(page: Page) {
  const events: { path: string; phase: "start" | "end"; at: number }[] = [];
  const record = (phase: "start" | "end") => (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) events.push({ path, phase, at: Date.now() });
  };
  page.on("request", record("start"));
  page.on("requestfinished", record("end"));
  page.on("requestfailed", record("end"));
  return {
    maxConcurrent(path: string) {
      const ordered = events.filter((event) => event.path === path)
        .sort((left, right) => left.at - right.at || (left.phase === "end" ? -1 : 1));
      let current = 0;
      let max = 0;
      for (const event of ordered) { current += event.phase === "start" ? 1 : -1; max = Math.max(max, current); }
      return max;
    },
    starts: (path: string) => events.filter((event) => event.path === path && event.phase === "start").length,
  };
}

/** Console errors and React warnings raised while the page was open. */
function trackConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") problems.push(`[${message.type()}] ${message.text()}`); });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/**
 * Wait until the shell reports a settled, ready engine.
 *
 * This steady-state reading used to sit in the rail foot. The Help window
 * replaced that element with the Help launcher (see App.tsx) and moved the
 * reading to the topbar badge, which reads "Local engine" once health is ready.
 */
const expectEngineReady = (page: Page) =>
  expect(page.locator(".topbar-state")).toContainText("Local engine");

test.describe("engine startup", () => {
  test("a health read that never answers becomes an error with a working Retry", async ({ page }) => {
    const problems = trackConsole(page);
    const engine = await mockEngine(page, { healthHangs: true });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The startup indicator appears first…
    await expect(page.locator(".engine-startup")).toBeVisible();

    // …and must give way to the error state once the request times out,
    // instead of leaving the customer on an indefinite loader.
    const alert = page.locator(".global-alert");
    await expect(alert).toBeVisible({ timeout: 25_000 });
    await expect(alert).toContainText(/Engine unavailable/i);
    await expect(alert).toContainText(/did not respond within/i);
    await expect(page.locator(".engine-startup")).toHaveCount(0);
    await expect(page.getByText(/Connecting to the local engine/i)).toHaveCount(0);
    await expect(page.locator(".skeleton")).toHaveCount(0);

    const retry = alert.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();

    const before = engine.counters.health;
    engine.state.healthHangs = false;
    await retry.click();

    await expect(page.locator(".global-alert")).toHaveCount(0, { timeout: 25_000 });
    expect(engine.counters.health).toBeGreaterThan(before);
    await expectEngineReady(page);
    expect(problems, problems.join("\n")).toHaveLength(0);
  });

  test("a healthy engine still transitions to the ready state", async ({ page }) => {
    const problems = trackConsole(page);
    await mockEngine(page, { healthDelayMs: 400 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expectEngineReady(page);
    await expect(page.locator(".global-alert")).toHaveCount(0);
    await expect(page.locator(".engine-startup")).toHaveCount(0);
    await expect(page.locator(".engine-summary")).toContainText(/Local engine ready/i);
    expect(problems, problems.join("\n")).toHaveLength(0);
  });

  test("first paint shows a single engine startup message at desktop and mobile widths", async ({ page }) => {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await mockEngine(page, { healthDelayMs: 5_000, projectsDelayMs: 5_000, jobsDelayMs: 5_000, profilesDelayMs: 5_000 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".engine-startup")).toBeVisible();

      const messages = await page.evaluate(() => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        // Only the innermost element carrying each message counts, so wrappers
        // are not mistaken for separate indicators.
        const pattern = /(connecting|checking)[^.]{0,40}(engine|tools|local)/i;
        return [...document.querySelectorAll("body *")]
          .filter((element) => visible(element) && pattern.test(element.textContent || "")
            && ![...element.querySelectorAll("*")].some((child) => visible(child) && pattern.test(child.textContent || "")))
          .map((element) => `${element.tagName.toLowerCase()}.${(element.className || "").toString().split(" ")[0]}`);
      });
      expect(messages, `${width}px startup messages: ${messages.join(", ")}`).toHaveLength(1);
      expect(messages[0]).toContain("engine-startup");
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});

test.describe("polling", () => {
  test("never runs two reads of the same poll at once, even against a slow engine", async ({ page }) => {
    test.setTimeout(180_000);
    const problems = trackConsole(page);
    const requests = trackRequests(page);
    await mockEngine(page, { healthDelayMs: 6_000, jobsDelayMs: 9_000, projectsDelayMs: 3_000, profilesDelayMs: 4_000 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Long enough for several cadences to have elapsed inside each slow read.
    await page.waitForTimeout(45_000);
    expect(requests.maxConcurrent("/api/v1/health"), "concurrent health polls").toBe(1);
    expect(requests.maxConcurrent("/api/v1/jobs"), "concurrent jobs polls").toBe(1);
    // A 5s cadence around a 6s read cannot produce more than ~4 reads in 45s;
    // interval polling would have produced nine.
    expect(requests.starts("/api/v1/health")).toBeLessThanOrEqual(6);

    // Leaving Projects stops the jobs loop rather than orphaning it.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForTimeout(11_000);
    const afterNavigation = requests.starts("/api/v1/jobs");
    await page.waitForTimeout(30_000);
    expect(requests.starts("/api/v1/jobs") - afterNavigation, "orphaned jobs polls").toBe(0);
    expect(requests.maxConcurrent("/api/v1/health")).toBe(1);
    expect(problems, problems.join("\n")).toHaveLength(0);
  });
});

test.describe("provider availability", () => {
  test("does not claim a provider is missing while /profiles is still pending", async ({ page }) => {
    await mockEngine(page, { profilesDelayMs: 6_000, profiles: [DISCONNECTED_PROFILE] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByText(/Checking connected providers/i).first()).toBeVisible();
    await expect(page.getByText(/No provider is connected/i)).toHaveCount(0);
    await expect(page.getByText(/Add optional AI providers/i)).toHaveCount(0);

    // Once it resolves, the confirmed condition is stated.
    await expect(page.getByText(/No provider is connected, so Auto runs as a fast local cut/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Add optional AI providers/i)).toBeVisible();
  });

  test("reports a connected provider once /profiles confirms one", async ({ page }) => {
    await mockEngine(page, { profilesDelayMs: 3_000, profiles: [CONNECTED_PROFILE] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByText(/Checking connected providers/i).first()).toBeVisible();
    await expect(page.getByText(/Auto uses a connected provider, otherwise a fast local cut/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/No provider is connected/i)).toHaveCount(0);

    await page.getByRole("button", { name: "AI Video", exact: true }).click();
    await expect(page.locator(".provider-status")).toContainText(/OpenRouter connected/i);
  });
});

test.describe("Library empty states", () => {
  test("distinguishes a first-run Library from filters that match nothing", async ({ page }) => {
    await mockEngine(page, { assets: [] });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Library", exact: true }).click();

    const empty = page.locator(".empty-state");
    await expect(empty.getByRole("heading", { name: "Build your private resolver" })).toBeVisible();
    await expect(empty).toContainText(/no assets yet/i);
    await expect(empty).not.toContainText(/another folder/i);
    await expect(empty.getByRole("button", { name: /Import first asset/i })).toBeVisible();

    // Same screen, assets present, filters excluding all of them.
    await page.unroute("**/api/v1/library/assets**");
    await page.route("**/api/v1/library/assets**", (route) => json(route, [asset("a1", "Launch teaser"), asset("a2", "Interview b-roll")]));
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByText("Launch teaser")).toBeVisible();

    await page.getByLabel("Search media").fill("no-such-asset");
    await expect(empty.getByRole("heading", { name: "No media matches these filters" })).toBeVisible();
    await expect(empty).toContainText(/filters/i);
    await expect(empty).not.toContainText(/no assets yet/i);

    await empty.getByRole("button", { name: /Clear filters/i }).click();
    await expect(page.getByText("Launch teaser")).toBeVisible();
  });
});

test.describe("page structure", () => {
  const screens = ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"];

  test("every screen has one top-level main, one h1, and named complementary landmarks", async ({ page }) => {
    test.setTimeout(120_000);
    const problems = trackConsole(page);
    await mockEngine(page, { assets: [asset("a1", "Launch teaser")] });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectEngineReady(page);

    for (const screen of screens) {
      await page.getByRole("button", { name: screen, exact: true }).click();
      await page.waitForTimeout(600);
      const structure = await page.evaluate(() => ({
        mains: [...document.querySelectorAll("main, [role='main']")].map((element) => `${element.tagName.toLowerCase()}#${element.id}`),
        nestedMains: document.querySelectorAll("main main, main [role='main']").length,
        h1: [...document.querySelectorAll("h1")].map((element) => element.textContent?.trim() || ""),
        levels: [...document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6")]
          .filter((element) => (element as HTMLElement).offsetParent !== null || element.tagName === "H1")
          .map((element) => Number(element.tagName.slice(1))),
        complementaryNames: [...document.querySelectorAll("aside, [role='complementary']")].map((element) => {
          const labelledBy = element.getAttribute("aria-labelledby");
          return element.getAttribute("aria-label") || (labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null);
        }),
      }));

      expect(structure.mains, `${screen}: main landmarks`).toHaveLength(1);
      expect(structure.mains[0], `${screen}: main id`).toBe("main#main-content");
      expect(structure.nestedMains, `${screen}: nested mains`).toBe(0);
      expect(structure.h1, `${screen}: h1 count`).toHaveLength(1);
      expect(structure.complementaryNames.filter((name) => !name), `${screen}: unnamed complementary landmarks`).toHaveLength(0);
      expect(new Set(structure.complementaryNames).size, `${screen}: complementary names must be unique`).toBe(structure.complementaryNames.length);

      // No heading level may be skipped on the way down.
      const skips = structure.levels.filter((level, index) => index > 0 && level > structure.levels[index - 1] + 1);
      expect(skips, `${screen}: heading levels ${structure.levels.join(",")}`).toHaveLength(0);
    }
    expect(problems, problems.join("\n")).toHaveLength(0);
  });

  test("an empty Workspace still carries the page heading", async ({ page }) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "No project selected" })).toBeVisible();
    await expect(page.locator("main h1")).toHaveCount(1);
  });

  test("the skip link is the first tab stop and moves focus past the rail", async ({ page }) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectEngineReady(page);

    await page.keyboard.press("Tab");
    const skip = page.locator(".skip-link");
    await expect(skip).toBeFocused();
    // Off-screen until focused, on-screen once it is.
    const box = await skip.boundingBox();
    expect(box, "focused skip link geometry").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);

    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await page.keyboard.press("Tab");
    const bypassed = await page.evaluate(() => ({
      inMain: !!document.getElementById("main-content")?.contains(document.activeElement),
      inRail: !!document.querySelector(".app-rail")?.contains(document.activeElement),
    }));
    expect(bypassed.inMain, "focus after the skip link").toBe(true);
    expect(bypassed.inRail).toBe(false);
  });
});

test.describe("responsive controls", () => {
  test("every interactive target meets the 24x24 CSS px minimum", async ({ page }) => {
    test.setTimeout(180_000);
    await mockEngine(page, { assets: [asset("a1", "Launch teaser"), asset("a2", "Cover art", "image/png")] });
    for (const width of [1440, 375, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".engine-startup")).toHaveCount(0);

      for (const screen of ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"]) {
        await page.getByRole("button", { name: screen, exact: true }).click();
        await page.waitForTimeout(700);
        const undersized = await page.evaluate(() => {
          const selector = 'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="treeitem"], summary';
          return [...document.querySelectorAll(selector)].filter((element) => {
            if ((element as HTMLInputElement).disabled) return false;
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.display === "none") return false;
            const rect = element.getBoundingClientRect();
            if (!rect.width && !rect.height) return false;
            return rect.width < 24 || rect.height < 24;
          }).map((element) => {
            const rect = element.getBoundingClientRect();
            return `${element.tagName.toLowerCase()}.${(element.className || "").toString().split(" ")[0]} "${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 24)}" ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`;
          });
        });
        expect(undersized, `${screen} @${width}px: ${undersized.join(" | ")}`).toHaveLength(0);
      }
    }
  });

  test("no navigation label clips, including Workspace at 360px", async ({ page }) => {
    await mockEngine(page);
    for (const width of [360, 375, 414, 600, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();

      const measured = await page.evaluate(() => {
        const labels = [...document.querySelectorAll<HTMLElement>(".nav-item span")]
          .filter((label) => getComputedStyle(label).display !== "none")
          .map((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return { text: label.textContent || "", intrinsic: range.getBoundingClientRect().width, available: label.clientWidth, scroll: label.scrollWidth };
          });
        return { labels, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });

      // At ≤600px the rail deliberately drops its captions and each item becomes
      // the icon alone (styles.css), trading the visible caption for the button's
      // aria-label — so assert the accessible name at every width, and the caption
      // only where captions are actually shown.
      await expect(page.locator(".app-rail").getByRole("button", { name: "Workspace" })).toBeVisible();
      const captions = measured.labels.filter((label) => label.text.trim().length);
      if (captions.length) {
        const workspace = captions.find((label) => label.text === "Workspace");
        expect(workspace, `${width}px: Workspace caption rendered`).toBeTruthy();
      }
      if (measured.labels.length) {
        for (const label of measured.labels) {
          expect(label.scroll, `${width}px "${label.text}" scrollWidth`).toBeLessThanOrEqual(label.available + 0.5);
          expect(label.intrinsic, `${width}px "${label.text}" intrinsic width`).toBeLessThanOrEqual(label.available + 0.5);
        }
      }
      expect(measured.overflow, `${width}px horizontal overflow`).toBe(false);
    }
  });
});
