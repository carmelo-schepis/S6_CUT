/**
 * Projects option menu acceptance.
 *
 * The create panel keeps the key choices visible and moves the heavier pickers
 * behind collapsible option rows. These checks measure what a customer sees:
 * rows start closed, a row shows its current value, a choice made inside a row
 * is still submitted after the row is collapsed, and the Workspace status bands
 * are boxes that never print a count larger than their total.
 *
 * Mobile WebKit and iPhone projects load the separate status app, which has no
 * create panel, so they are skipped here.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gateway, openProjects, openWorkspaceForProject, root } from "./support/workspace";

const SUPPORTED_PROJECTS = ["Desktop Chromium", "Android Chromium", "iPad WebKit desktop mode"];
const evidence = process.env.S6_EVIDENCE_DIR || path.join(os.homedir(), ".cache", "s6-acceptance", "projects-option-menu");
const videoFile = path.join(root, "test-video.mp4");

/** Console and page errors per page. Aborted stub streams are expected noise and are ignored. */
const consoleErrors = new WeakMap<Page, string[]>();
// Screenshots inject a stylesheet that the production CSP refuses; that message is tool noise.
const EXPECTED_NOISE = /Failed to load resource|ERR_FAILED|ERR_ABORTED|EventSource|\/events|Refused to apply a stylesheet/i;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!SUPPORTED_PROJECTS.includes(testInfo.project.name), "The create panel is not shown in the mobile status app.");
  await fs.mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on("console", (message) => { if (message.type() === "error" && !EXPECTED_NOISE.test(message.text())) errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page) ?? [], "no console or runtime errors").toEqual([]);
});

/** Opens one option row unless it is already open, the way a customer would. */
async function openOption(page: Page, title: string) {
  const toggle = page.getByRole("button", { name: title, exact: true });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function openCreatePanel(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjects(page);
}

async function chooseVideo(page: Page) {
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(videoFile);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
}

/** The project created by the real-flow test, read back from the durable API record. */
async function findJob(request: APIRequestContext, projectName: string) {
  const projects = await (await request.get(`${gateway}/api/v1/projects`)).json() as { name: string; latestJobId?: string | null }[];
  const project = projects.find((item) => item.name === projectName);
  if (!project?.latestJobId) return null;
  return await (await request.get(`${gateway}/api/v1/jobs/${project.latestJobId}`)).json() as Record<string, unknown> & { id: string };
}

test("rows start closed, show their values, and the create action sits in the first screen", async ({ page }) => {
  await openCreatePanel(page);
  const toggles = page.locator(".create-option-toggle");
  await expect(toggles).toHaveCount(6);
  for (const toggle of await toggles.all()) await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Subtitle style", exact: true })).toHaveAccessibleDescription("Editorial default");
  await expect(page.getByRole("button", { name: "Advanced controls", exact: true })).toHaveAccessibleDescription("9:16 · 20–60 s");

  const create = await page.getByRole("button", { name: /Create 5 short clips/ }).boundingBox();
  expect(create, "create button is rendered").not.toBeNull();
  expect(create!.y + create!.height, "create button is inside the first 900px screen").toBeLessThanOrEqual(900);
  const panel = await page.locator(".create-panel").boundingBox();
  // Measured 1756px against the 2780px baseline (-37%). Create is on the first screen.
  expect(panel!.height, "create panel is much shorter than the 2780px baseline").toBeLessThanOrEqual(1800);
  await page.screenshot({ path: path.join(evidence, "clip-rows-closed-1440.png") });
});

test("a row opens and closes from the keyboard and keeps its value", async ({ page }) => {
  await openCreatePanel(page);
  const subtitle = page.getByRole("button", { name: "Subtitle style", exact: true });
  await subtitle.focus();
  await expect(subtitle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(subtitle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("group", { name: "Subtitle style" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(subtitle).toHaveAttribute("aria-expanded", "false");
  await expect(subtitle).toHaveAccessibleDescription("Editorial default");
});

test("Music mode swaps the rows and shows the lyric and song values", async ({ page }) => {
  await openCreatePanel(page);
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await expect(page.getByRole("button", { name: "Subtitle style", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Lyrics presentation", exact: true })).toHaveAccessibleDescription("Clean sans · EN");
  await expect(page.getByRole("button", { name: "Background song", exact: true })).toHaveAccessibleDescription("None");
  await openOption(page, "Background song");
  await expect(page.getByLabel("Background song MP3")).toBeAttached();
});

test.describe.serial("a choice made in a collapsed row reaches the job", () => {
  // The stalled-job stub needs the page's own requests, not a service worker's cache.
  test.use({ serviceWorkers: "block" });
  const projectName = `Option menu ${Date.now()}`;
  let jobId = "";

  test("the chosen subtitle style is submitted after its row is collapsed", async ({ page, request }) => {
    test.setTimeout(180_000);
    await openCreatePanel(page);
    await chooseVideo(page);
    await page.getByLabel("Project name").fill(projectName);

    await openOption(page, "Subtitle style");
    await page.getByRole("button", { name: "Word pop", exact: true }).click();
    await page.getByRole("button", { name: "Subtitle style", exact: true }).click();
    await expect(page.getByRole("button", { name: "Subtitle style", exact: true })).toHaveAccessibleDescription("Word pop");
    await page.screenshot({ path: path.join(evidence, "clip-row-collapsed-with-value.png") });

    await page.getByRole("button", { name: /Create 5 short clips/ }).click();
    await expect.poll(async () => (await findJob(request, projectName))?.id ?? "", { timeout: 60_000 }).not.toBe("");
    const job = await findJob(request, projectName);
    jobId = job!.id;
    expect(job!.editingPresentation).toMatchObject({ captionPreset: "word_pop" });
  });

  test("a stalled Smart job shows boxed status bands with a valid count", async ({ page, request }) => {
    test.setTimeout(120_000);
    expect(jobId, "the real-flow test created a job").not.toBe("");
    const job = await findJob(request, projectName);
    const stale = {
      ...job,
      state: "active",
      processingMode: "smart",
      stage: "hook_text",
      stageLabel: "Writing hook text",
      currentItem: 263,
      totalItems: 9,
      progress: 38,
      downloadProgress: null,
      clips: [],
      steps: [],
      warnings: ["Found 9 valid clips instead of 15; complete boundaries were prioritised over filler."],
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    await page.route(`**/api/v1/jobs/${jobId}/events`, (route) => route.abort());
    await page.route(`**/api/v1/jobs/${jobId}`, (route) => route.fulfill({ json: stale }));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.locator(".workspace-page > .stalled-callout")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-page > .job-strip")).toContainText("Writing hook text");
    await expect(page.locator(".workspace-page > .job-strip")).toContainText("38%");
    await expect(page.locator(".workspace-page > .notice-panel")).toBeVisible();

    const bands = await page.evaluate(() => ["stalled-callout", "job-strip", "notice-panel"].map((name) => {
      const element = document.querySelector<HTMLElement>(`.workspace-page > .${name}`)!;
      const rect = element.getBoundingClientRect();
      return { name, top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, radius: getComputedStyle(element).borderTopLeftRadius };
    }));
    // The corner tightens to 16px on phones (--box-radius in styles.css).
    const radius = `${(page.viewportSize()?.width ?? 1440) <= 600 ? 16 : 20}px`;
    for (const band of bands) expect(band.radius, `${band.name} corner`).toBe(radius);
    expect(Math.abs(bands[0].left - bands[1].left) + Math.abs(bands[1].left - bands[2].left), "bands start on one column").toBeLessThanOrEqual(1);
    expect(Math.abs(bands[0].width - bands[1].width) + Math.abs(bands[1].width - bands[2].width), "bands share one width").toBeLessThanOrEqual(1);
    expect(bands[1].top - bands[0].bottom, "callout to job strip").toBeCloseTo(16, 0);
    expect(bands[2].top - bands[1].bottom, "job strip to notes").toBeCloseTo(16, 0);

    await expect(page.locator("body")).not.toContainText("263 of 9");
    await expect(page.locator(".workspace-page > .stalled-callout")).not.toContainText("—");
    await page.screenshot({ path: path.join(evidence, "workspace-status-bands.png") });

    await page.getByRole("button", { name: "Keep waiting", exact: true }).click();
    await expect(page.locator(".workspace-page > .stalled-callout")).toHaveCount(0);
  });
});

test("the create panel has no horizontal overflow at phone, tablet and laptop widths", async ({ page }) => {
  for (const [width, height] of [[412, 915], [820, 1180], [1024, 768]] as const) {
    await openCreatePanel(page, width, height);
    await page.getByRole("button", { name: "Subtitle style", exact: true }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    const create = await page.getByRole("button", { name: /Create 5 short clips/ }).boundingBox();
    expect(create!.x + create!.width, `create button fits ${width}px`).toBeLessThanOrEqual(width + 1);
  }
});
