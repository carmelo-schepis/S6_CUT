import { expect, test, type Page } from "@playwright/test";
import type { Job, Project, ProviderProfile } from "../../web/src/types";
import fs from "node:fs/promises";
import path from "node:path";

const artifacts = path.resolve(process.cwd(), "test-artifacts", "responsive-ui-loading-buttons");
const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1024, 768],
  ["tablet", 768, 1024],
  ["mobile-wide", 430, 932],
  ["mobile", 390, 844],
  ["mobile-small", 360, 800],
  ["mobile-tiny", 320, 568],
  ["zoom-200-equivalent", 720, 450],
] as const;

async function installFixtures(page: Page, profiles: ProviderProfile[] = []) {
  const [projectsResponse, jobsResponse] = await Promise.all([
    page.request.get("/api/v1/projects"),
    page.request.get("/api/v1/jobs"),
  ]);
  const projects = await projectsResponse.json() as Project[];
  const jobs = await jobsResponse.json() as Job[];
  const sourceProject = projects[0];
  const sourceJob = jobs.find((job) => job.id === sourceProject?.latestJobId) || jobs[0];
  if (!sourceProject || !sourceJob) throw new Error("Docker fixture data has no project/job");

  const project: Project = {
    ...sourceProject,
    id: "responsive-fixture-project",
    latestJobId: "responsive-fixture-job",
    name: "A deliberately long project name that must wrap without pushing any controls outside the creation panel",
    state: "active",
    sourceName: "A source with a deliberately long title that must wrap safely",
  };
  const job: Job = {
    ...sourceJob,
    id: "responsive-fixture-job",
    projectId: project.id,
    state: "active",
    stage: "transcribing",
    stageLabel: "Transcribing audio — an intentionally long backend status message that must wrap safely",
    progress: 18,
    currentItem: 0,
    totalItems: 0,
    createdAt: new Date(Date.now() - 80_000).toISOString(),
    updatedAt: new Date().toISOString(),
    clips: [],
    steps: sourceJob.steps.map((step) => {
      if (["source", "probe", "audio"].includes(step.id)) return step;
      if (step.id === "transcribe") return { ...step, status: "active" as const, completedAt: undefined, detail: "Transcribing audio" };
      return { ...step, status: "pending" as const, startedAt: undefined, completedAt: undefined, detail: undefined };
    }),
    downloadProgress: {
      downloadedBytes: 37 * 1024 * 1024,
      totalBytes: 37 * 1024 * 1024,
      percent: 100,
      phase: "complete",
      lastProgressAt: new Date().toISOString(),
      speedBytesPerSecond: null,
      etaSeconds: null,
      message: "Download complete — this deliberately long diagnostic message must wrap without colliding with the active transcription stage.",
      resumable: true,
    },
  };
  const response = (route: import("@playwright/test").Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/v1/projects", (route) => response(route, [project]));
  await page.route("**/api/v1/jobs", (route) => response(route, [job]));
  await page.route("**/api/v1/projects/responsive-fixture-project**", (route) => response(route, project));
  await page.route("**/api/v1/jobs/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/responsive-fixture-job/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" });
    if (url.endsWith("/responsive-fixture-job")) return response(route, job);
    return route.continue();
  });
  await page.route("**/api/v1/profiles", (route) => response(route, profiles));
}

async function assertNoOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > document.documentElement.clientWidth + 1 && rect.width > 0;
    }).slice(-8).map((element) => ({ tag: element.tagName, className: element.className, right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) })),
  }));
  expect(result.scrollWidth, `document horizontal overflow: ${JSON.stringify(result.offenders)}`).toBeLessThanOrEqual(result.clientWidth);
}

async function assertContained(page: Page, selector: string, container: string) {
  const result = await page.locator(selector).evaluate((element, containerSelector) => {
    const box = element.getBoundingClientRect();
    const parent = element.closest(containerSelector as string)?.getBoundingClientRect();
    if (!parent) throw new Error(`Missing container ${containerSelector}`);
    const style = getComputedStyle(element);
    return {
      contained: box.left >= parent.left - 1 && box.right <= parent.right + 1 && box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1,
      textFits: element.scrollWidth <= element.clientWidth + 1,
      visible: box.width > 0 && box.height > 0,
      outline: style.outlineStyle,
    };
  }, container);
  expect(result.contained, `${selector} escaped ${container}`).toBe(true);
  expect(result.textFits, `${selector} text overflows`).toBe(true);
  expect(result.visible, `${selector} is not visible`).toBe(true);
}

test.describe("responsive loading and creation controls", () => {
  test("keeps creation states and controls clean at every required viewport", async ({ page }) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
    test.setTimeout(180_000);
    await fs.mkdir(artifacts, { recursive: true });
    for (const [name, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
      await assertNoOverflow(page);
      const panel = page.locator(".create-panel");
      await expect(panel).toBeVisible();
      for (const mode of ["Auto", "Fast", "Smart"]) {
        const button = page.getByRole("button", { name: mode, exact: true });
        await button.click();
        await expect(button).toHaveClass(/active/);
        await assertContained(page, `.processing-mode-tabs button:has-text("${mode}")`, ".create-step");
      }
      for (const format of ["Short form · 9:16", "Long form · 16:9"]) {
        const button = page.getByRole("button", { name: format, exact: true });
        await button.click();
        await expect(button).toHaveClass(/active/);
        await assertContained(page, `.format-tabs button:has-text("${format.split(" · ")[0]}")`, ".create-step");
      }
      await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
      for (let index = 0; index < 7; index += 1) await page.getByRole("button", { name: "More clips", exact: true }).click();
      await expect(page.getByRole("button", { name: "Create 12 short clips", exact: true })).toBeVisible();
      await page.getByLabel("Project name").fill("A project name long enough to verify that the creation form wraps and remains contained at every responsive breakpoint without clipping");
      const folder = page.locator(".folder-picker select");
      await folder.selectOption({ index: 0 });
      const subtitles = page.getByRole("checkbox", { name: /Burn in subtitles/i });
      await subtitles.click();
      await page.getByRole("button", { name: /Advanced controls/i }).click();
      await expect(page.getByLabel("Minimum seconds")).toBeVisible();
      await assertContained(page, ".create-button", ".create-panel");
      await page.getByRole("button", { name: /Advanced controls/i }).click();
      await expect(page.getByLabel("Minimum seconds")).toBeHidden();
      // Segmented controls must be operable from the keyboard with a visible
      // focus ring. Target each control by name rather than by tab position so
      // the check does not depend on the order of neighbouring controls.
      const auto = page.getByRole("button", { name: "Auto", exact: true });
      await auto.focus();
      await page.keyboard.press("Space");
      await expect(auto).toHaveClass(/active/);
      expect(await auto.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      const fast = page.getByRole("button", { name: "Fast", exact: true });
      await fast.focus();
      await page.keyboard.press("Enter");
      await expect(fast).toHaveClass(/active/);
      await auto.focus();
      await page.keyboard.press("Enter");
      await expect(auto).toHaveClass(/active/);
      await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
      const create = page.getByRole("button", { name: "Create 12 short clips", exact: true });
      await expect(create).toBeVisible();
      await assertNoOverflow(page);
      if (name === "desktop") await page.screenshot({ path: path.join(artifacts, `creation-${name}.png`), fullPage: false });
      if (name === "mobile-tiny") {
        await create.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, "creation-mobile-tiny-form.png"), fullPage: false });
      }
    }
    expect(consoleErrors, "browser console errors").toEqual([]);
    expect(failedRequests, "failed application requests").toEqual([]);
  });

  test("renders the representative processing fixture without concatenation or overlap", async ({ page }) => {
    test.setTimeout(60_000);
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
    await installFixtures(page);
    for (const [name, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: /deliberately long project name/i })).toBeVisible();
      await page.getByRole("button", { name: /deliberately long project name/i }).click();
      await expect(page.locator(".processing-state")).toBeVisible();
      await expect(page.locator(".processing-state")).toContainText("Transcribing audio");
      await expect(page.locator(".processing-state")).toContainText("18%");
      await expect(page.locator(".processing-state")).toContainText("37.0 MB of 37.0 MB");
      await assertNoOverflow(page);
      const processing = page.locator(".processing-state");
      await processing.scrollIntoViewIfNeeded();
      const measure = await processing.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const blocks = [...element.querySelectorAll<HTMLElement>(".processing-heading, .processing-filmstrip, .processing-meta, .download-progress-detail, p")].map((item) => item.getBoundingClientRect());
        return { rect, blocks, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      });
      expect(measure.rect.left).toBeGreaterThanOrEqual(-1);
      expect(measure.rect.right).toBeLessThanOrEqual(width + 1);
      expect(measure.rect.top).toBeGreaterThanOrEqual(-1);
      expect(measure.rect.bottom).toBeLessThanOrEqual(height + 1);
      expect(measure.scrollHeight).toBeLessThanOrEqual(measure.clientHeight + 1);
      for (let index = 1; index < measure.blocks.length; index += 1) expect(measure.blocks[index].top).toBeGreaterThanOrEqual(measure.blocks[index - 1].bottom - 1);
      if (name === "desktop" || name === "mobile-tiny") await processing.screenshot({ path: path.join(artifacts, `loading-${name}.png`) });
    }
    expect(consoleErrors, "browser console errors").toEqual([]);
    expect(failedRequests, "failed application requests").toEqual([]);
  });

  test("shows connected-provider mode copy without breaking the control row", async ({ page }) => {
    const connected: ProviderProfile = {
      id: "safe-connected-profile",
      name: "Connected OpenRouter",
      modelId: "openai/gpt-4.1-mini",
      voiceId: null,
      selected: true,
      persistence: "encrypted",
      openrouterConfigured: true,
      elevenlabsConfigured: false,
      openrouterMasked: "sk-or-v1-••••••••",
      elevenlabsMasked: null,
      openrouterStatus: "connected",
      elevenlabsStatus: "not_configured",
      openrouterMessage: "Connected",
      openrouterLastCheckedAt: new Date().toISOString(),
      elevenlabsMessage: null,
      elevenlabsLastCheckedAt: null,
      status: "connected",
      capabilities: ["planning"],
      fallbacks: { planning: "Deterministic local planning" },
    };
    await installFixtures(page, [connected]);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".provider-callout:not(.compact)")).toHaveCount(0);
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    await expect(page.locator(".field-group-hint").filter({ hasText: "selected provider" })).toBeVisible();
    await assertNoOverflow(page);
    await page.screenshot({ path: path.join(artifacts, "creation-connected-smart.png"), fullPage: false });
  });

  test("keeps provider-unavailable callout actions contained", async ({ page }) => {
    await installFixtures(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const callout = page.locator(".provider-callout:not(.compact)");
    await expect(callout).toBeVisible();
    for (const name of ["Configure providers", "Continue locally"]) await assertContained(page, `.provider-callout button:has-text("${name}")`, ".provider-callout");
    await callout.getByRole("button", { name: "Configure providers" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, "provider-callout-mobile-tiny.png"), fullPage: false });
    await callout.getByRole("button", { name: "Continue locally" }).click();
    await expect(callout).toBeHidden();
  });
});
