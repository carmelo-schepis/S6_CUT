import { expect, test, type Page } from "@playwright/test";

// Workspace focus pass: a quiet header (one muted meta toggle with an inline
// details panel) and one progress dropdown whose closed summary is the
// one-line progress band. The whole API is mocked; no engine data is touched.

type Phase = "running" | "failed" | "paused" | "complete";

const STAGE_LABEL = "Transcribing isolated narration — 26s of 389s";
const PROJECT_NAME = "Cry - Cigarettes After Sex [ 500 days of Summer ]";
const SKIPPED_DETAIL = "Music profile stays local; provider planning skipped";
const FAILED_DETAIL = "Deterministic test failure: provider unavailable.";
const STEP_LABELS = [
  "Source received", "Video validated", "Background song prepared", "Audio prepared", "Narration words timed",
  "Provider bypassed for music profile", "Narration moments planned", "Narration moments selected",
  "Clip boundaries verified", "Clips rendered and saved", "Outputs verified", "Project ready",
];

const nowIso = () => new Date().toISOString();

/** How long the active step has been running. A test may raise it to check long elapsed text. */
let activeElapsedMs = 42_000;

function buildSteps(phase: Phase) {
  const stamp = nowIso();
  const steps = STEP_LABELS.map((label, index) => ({
    id: `s${index}`, label, status: "pending" as string, detail: null as string | null,
    startedAt: null as string | null, completedAt: null as string | null, currentItem: null as number | null, totalItems: null as number | null,
  }));
  for (let index = 0; index < 4; index++) Object.assign(steps[index], { status: "complete", completedAt: stamp });
  Object.assign(steps[5], { status: "skipped", completedAt: stamp, detail: SKIPPED_DETAIL });
  if (phase === "running" || phase === "paused") {
    Object.assign(steps[4], { status: "active", startedAt: new Date(Date.now() - activeElapsedMs).toISOString(), detail: STAGE_LABEL, currentItem: 26, totalItems: 389 });
  }
  if (phase === "failed") Object.assign(steps[4], { status: "failed", completedAt: stamp, detail: FAILED_DETAIL });
  if (phase === "complete") {
    // A finished run counts every step, including the one that was skipped while running.
    for (const step of steps) Object.assign(step, { status: "complete", completedAt: stamp });
  }
  return steps;
}

const MUSIC_TRACK = { assetId: "m1", title: "Sweet - Cigarettes After Sex", source: "youtube", speed: 1 };

function buildJob(phase: Phase) {
  const state = phase === "running" ? "active" : phase === "paused" ? "paused" : phase === "failed" ? "failed" : "complete";
  return {
    schemaVersion: 1, id: "job-focus", projectId: "proj-focus", mode: "clip", style: "educational", processingMode: "fast",
    state,
    stage: phase === "complete" ? "ready" : "transcribe",
    stageLabel: phase === "running" || phase === "paused" ? STAGE_LABEL : phase === "failed" ? "Failed" : "Project ready",
    progress: phase === "complete" ? 100 : 19,
    currentItem: phase === "running" || phase === "paused" ? 26 : 0,
    totalItems: phase === "running" || phase === "paused" ? 389 : 0,
    warnings: [], clips: [], beats: [], steps: buildSteps(phase),
    createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: nowIso(),
    error: phase === "failed" ? "Provider unavailable" : null,
    contentFormat: "short", sourceProfile: "music", musicAudioMode: "mix_original", musicSongGain: 0.25, musicTrack: MUSIC_TRACK,
  };
}

function buildProject(phase: Phase, libraryFolderId: string) {
  return {
    schemaVersion: 1, id: "proj-focus", name: PROJECT_NAME, mode: "clip", style: "educational",
    state: phase === "running" ? "active" : phase === "paused" ? "paused" : phase === "failed" ? "failed" : "complete",
    sourceName: "cry.mp4", sourceTitle: `${PROJECT_NAME} (official audio)`, sourceKind: "youtube", sourceProfile: "music",
    requestedCount: 5, latestJobId: "job-focus", createdAt: "2026-10-01T00:00:00Z", updatedAt: nowIso(),
    libraryFolderId, musicAudioMode: "mix_original", musicSongGain: 0.25, musicTrack: MUSIC_TRACK,
  };
}

const FOLDERS = [
  { id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "content", name: "content exper", parentId: null, description: "", color: null, archived: false, system: false, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
];

type Harness = { setPhase(phase: Phase): void; folderPuts: unknown[]; errors: string[]; failedRequests: string[] };

async function setup(page: Page, initial: Phase): Promise<Harness> {
  let phase: Phase = initial;
  let folderId = "unsorted";
  const harness: Harness = { setPhase: (next) => { phase = next; }, folderPuts: [], errors: [], failedRequests: [] };
  page.on("pageerror", (error) => harness.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored/.test(message.text())) harness.errors.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    if (!/\/events(\?|$)/.test(request.url())) harness.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/health") {
      await route.fulfill({ json: { status: "ready", version: "0.1.0", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, dataPath: "/app/data", freeBytes: 1024, configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" } } });
    } else if (path === "/projects") {
      await route.fulfill({ json: [buildProject(phase, folderId)] });
    } else if (path === "/projects/proj-focus/folder" && request.method() === "PUT") {
      const body = request.postDataJSON() as { folderId: string };
      harness.folderPuts.push(body);
      folderId = body.folderId;
      await route.fulfill({ json: buildProject(phase, folderId) });
    } else if (path.startsWith("/projects/")) {
      await route.fulfill({ json: buildProject(phase, folderId) });
    } else if (path === "/jobs") {
      await route.fulfill({ json: [buildJob(phase)] });
    } else if (path.startsWith("/jobs/") && path.endsWith("/events")) {
      // Leave the event stream open and silent. Answering it would make the
      // EventSource error and flash the "Waiting for the local engine" banner,
      // which shifts the layout under test; the page polls /jobs/:id instead.
    } else if (path.startsWith("/jobs/")) {
      await route.fulfill({ json: buildJob(phase) });
    } else if (path.startsWith("/library/folders")) {
      await route.fulfill({ json: FOLDERS });
    } else if (path.startsWith("/library/assets") || path.startsWith("/library/recent")) {
      await route.fulfill({ json: [] });
    } else if (path === "/profiles") {
      await route.fulfill({ json: [] });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  return harness;
}

async function openWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace", exact: true }).first().click();
  await expect(page.locator(".workspace-page")).toBeVisible();
  await expect(page.locator(".workspace-project-name")).toHaveText(PROJECT_NAME);
}

const progressRegion = (page: Page) => page.getByRole("region", { name: "Short creation progress" });
const stepsToggle = (page: Page) => progressRegion(page).getByRole("button", { name: /^(Show|Hide) steps$/ });
const stepList = (page: Page) => page.locator("ol.process-checklist");

const box = (page: Page, selector: string) => page.evaluate((sel) => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top + window.scrollY), height: Math.round(rect.height), left: Math.round(rect.left), width: Math.round(rect.width) };
}, selector);

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Leaf elements in the Workspace page that print the text, outside the preview frame and screen-reader text. */
const visibleTextCount = (page: Page, text: string) => page.evaluate((needle) => {
  const page = document.querySelector(".workspace-page");
  if (!page) return -1;
  let count = 0;
  for (const element of Array.from(page.querySelectorAll("*"))) {
    if (element.closest(".viewer-frame") || element.closest(".sr-only")) continue;
    const own = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || "").join("");
    if (own.includes(needle)) count += 1;
  }
  return count;
}, text);

const ARTIFACTS = "test-artifacts/workspace-focus";
const shot = (page: Page, name: string) => page.screenshot({ path: `${ARTIFACTS}/${name}.png`, fullPage: false });

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

test.describe("workspace focus pass", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium" && testInfo.project.name !== "Android Chromium", "Chromium layouts only");
  });

  test("running: quiet header, one collapsed progress dropdown, details panel and steps list", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const harness = await setup(page, "running");
    await openWorkspace(page);

    // 1. Header: one-line title, short command bar, no duplicated status.
    const lineHeight = await page.locator(".workspace-project-name").evaluate((element) => {
      const style = getComputedStyle(element);
      const parsed = parseFloat(style.lineHeight);
      return Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.5;
    });
    const title = await box(page, ".workspace-project-name");
    expect(title!.height).toBeLessThanOrEqual(Math.ceil(lineHeight) + 1);
    const commandbar = await box(page, ".workspace-commandbar");
    expect(commandbar!.height).toBeLessThanOrEqual(96);
    await expect(page.locator(".workspace-controls .status")).toHaveCount(0);
    await expect(page.locator(".workspace-offline")).toHaveCount(0);
    expect(await visibleTextCount(page, STAGE_LABEL)).toBe(1);
    await expect(page.locator(".job-strip")).toContainText(STAGE_LABEL);

    // 2. Progress box: collapsed, one line, band inside as the summary.
    const region = progressRegion(page);
    await expect(region).toBeVisible();
    await expect(region.locator(".job-strip")).toContainText(STAGE_LABEL);
    await expect(region).toContainText("19%");
    await expect(region).toContainText("Step 5 of 12");
    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(stepList(page)).toBeHidden();
    const panel = await box(page, ".checklist-panel");
    expect(panel!.height).toBeLessThanOrEqual(64);

    // 3. The workbench starts high.
    const grid = await box(page, ".workspace-grid");
    expect(grid!.top).toBeLessThanOrEqual(260);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, "running-1440-closed");

    // 4. Steps list: open, dense rows, active and skipped rows.
    await stepsToggle(page).click();
    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(stepsToggle(page)).toHaveAccessibleName("Hide steps");
    const rows = stepList(page).locator("li");
    await expect(rows).toHaveCount(12);
    const geometry = await rows.evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: Math.round(rect.left), height: Math.round(rect.height), visible: rect.height > 0 && rect.width > 0 };
    }));
    for (const row of geometry) {
      expect(row.visible).toBe(true);
      expect(row.height).toBeLessThanOrEqual(28);
      expect(row.left).toBe(geometry[0].left);
    }
    const active = page.locator("[data-testid='progress-step-s4']");
    await expect(active).toContainText("Elapsed");
    await expect(active).toContainText("In progress");
    await expect(active).not.toContainText("Transcribing isolated narration");
    await expect(active).not.toContainText("26 of 389");
    await expect(page.locator("[data-testid='progress-step-s5']")).toContainText("Music profile stays local");
    expect(await visibleTextCount(page, STAGE_LABEL)).toBe(1);
    await shot(page, "running-1440-steps-open");
    await stepsToggle(page).click();
    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(stepList(page)).toBeHidden();

    // Keyboard: Tab reaches the chevron, Enter opens, Space closes.
    await page.locator(".workspace-meta-toggle").focus();
    let reached = false;
    for (let index = 0; index < 12 && !reached; index++) {
      await page.keyboard.press("Tab");
      reached = await stepsToggle(page).evaluate((element) => element === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(stepList(page)).toBeVisible();
    await page.keyboard.press("Space");
    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(stepList(page)).toBeHidden();

    // 5. Header details: one toggle reveals source, song, audio and the folder picker.
    const meta = page.locator(".workspace-meta-toggle");
    await expect(meta).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#workspace-business-folder")).toBeHidden();
    await meta.click();
    await expect(meta).toHaveAttribute("aria-expanded", "true");
    const details = page.locator("#workspace-project-details");
    await expect(details).toBeVisible();
    await expect(details).toContainText("Source");
    await expect(details).toContainText("Song");
    await expect(details).toContainText("Sweet - Cigarettes After Sex");
    await expect(details).toContainText("Audio");
    await expect(details).toContainText("song at 25%");
    await expect(page.getByLabel("Business folder")).toBeVisible();
    await shot(page, "running-1440-details-open");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("#workspace-business-folder").selectOption("content");
    await expect.poll(() => harness.folderPuts.length).toBe(1);
    expect(harness.folderPuts[0]).toEqual({ folderId: "content", moveExistingAssets: true });
    await expect(page.locator("#workspace-business-folder")).toHaveValue("content");
    await expect(meta).toContainText("content exper");

    await meta.click();
    await expect(meta).toHaveAttribute("aria-expanded", "false");
    await expect(details).toBeHidden();

    expect(harness.errors).toEqual([]);
    expect(harness.failedRequests).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`layout at ${viewport.width}x${viewport.height} across running, failed, paused and complete`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      const harness = await setup(page, "running");
      for (const phase of ["running", "failed", "paused", "complete"] as const) {
        harness.setPhase(phase);
        await openWorkspace(page);
        await expect(page.locator(".workspace-grid")).toBeVisible();
        if (phase === "complete") await expect(progressRegion(page)).toContainText("12 of 12 complete");
        expect(await horizontalOverflow(page), `${phase} horizontal overflow`).toBeLessThanOrEqual(0);
        const grid = await box(page, ".workspace-grid");
        if (phase === "running" && viewport.width === 1440) expect(grid!.top).toBeLessThanOrEqual(260);
        if (phase === "running" && viewport.width === 390) expect(grid!.top).toBeLessThanOrEqual(480);
        if (phase === "running") expect(await visibleTextCount(page, STAGE_LABEL)).toBe(1);
        await shot(page, `${phase}-${viewport.width}`);
      }
      expect(harness.errors).toEqual([]);
      expect(harness.failedRequests).toEqual([]);
    });
  }

  test("failed: the list opens by itself and the retry strip stays", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const harness = await setup(page, "failed");
    await openWorkspace(page);

    await expect(stepsToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(stepList(page)).toBeVisible();
    await expect(page.locator("[data-testid='progress-step-s4']")).toContainText(FAILED_DETAIL);
    await expect(page.locator(".job-strip")).toHaveCount(0);
    await expect(page.locator(".failure-strip").getByRole("button", { name: "Retry failed work" })).toBeVisible();
    await expect(page.locator(".workspace-commandbar .status")).toBeVisible();
    await shot(page, "failed-1440-open");

    expect(harness.errors).toEqual([]);
    expect(harness.failedRequests).toEqual([]);
  });

  test("complete: no band, folded line with Show steps, header status chip", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const harness = await setup(page, "complete");
    await openWorkspace(page);

    await expect(page.locator(".job-strip")).toHaveCount(0);
    await expect(progressRegion(page)).toContainText("12 of 12 complete");
    await expect(page.getByRole("button", { name: "Show steps" })).toBeVisible();
    await expect(stepList(page)).toBeHidden();
    await expect(page.locator(".workspace-commandbar .status")).toBeVisible();
    await expect(page.locator(".workspace-commandbar .status")).toContainText("Project ready");
    await page.getByRole("button", { name: "Show steps" }).click();
    await expect(stepList(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide steps" })).toHaveAttribute("aria-expanded", "true");
    await shot(page, "complete-1440-open");

    expect(harness.errors).toEqual([]);
    expect(harness.failedRequests).toEqual([]);
  });

  test("paused: band still shows, active row says Paused, Resume is offered", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const harness = await setup(page, "paused");
    await openWorkspace(page);

    await expect(progressRegion(page).locator(".job-strip")).toContainText(STAGE_LABEL);
    await expect(page.locator(".workspace-controls .status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await stepsToggle(page).click();
    await expect(page.locator("[data-testid='progress-step-s4']")).toContainText("Paused");
    await shot(page, "paused-1440-open");

    expect(harness.errors).toEqual([]);
    expect(harness.failedRequests).toEqual([]);
  });

  test("long elapsed: step icons clear the edge, elapsed reads in full, the bar is the logo gradient", async ({ page }) => {
    test.setTimeout(120_000);
    activeElapsedMs = 42 * 60_000 + 10_000;
    try {
      await setup(page, "running");
      for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
        await page.setViewportSize({ width, height });
        await openWorkspace(page);
        if ((await stepsToggle(page).getAttribute("aria-expanded")) !== "true") await stepsToggle(page).click();
        const row = page.locator(".checklist-step.status-active");
        const rowBox = await row.boundingBox();
        const iconBox = await row.locator(".checklist-icon").boundingBox();
        expect(iconBox!.x - rowBox!.x, `${width}px icon inset`).toBeGreaterThanOrEqual(8);
        const elapsed = row.locator(".checklist-elapsed");
        await expect(elapsed).toHaveText(/^Elapsed 42:\d\d$/);
        expect(await elapsed.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${width}px elapsed clipped`).toBe(true);
        const e = await elapsed.boundingBox();
        const status = await row.locator(".checklist-status-text").boundingBox();
        expect(status!.x - (e!.x + e!.width), `${width}px gap before status`).toBeGreaterThanOrEqual(8);
      }
      const fill = page.locator(".checklist-heading > .job-strip .progress-track span");
      const read = () => fill.evaluate((el) => { const s = getComputedStyle(el); return { image: s.backgroundImage, anim: s.animationName }; });
      const moving = await read();
      expect(moving.image).toContain("linear-gradient");
      expect(moving.anim).toContain("logo-flow");
      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await read();
      expect(still.anim).toBe("none");
      expect(still.image).toContain("linear-gradient");
    } finally {
      activeElapsedMs = 42_000;
    }
  });
});
