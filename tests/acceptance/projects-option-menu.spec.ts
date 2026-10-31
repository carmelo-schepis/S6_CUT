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
  // Measured 1620px on the isolated stack (1544px on the owner stack) against the 2780px baseline. Create is on the first screen.
  expect(panel!.height, "create panel is much shorter than the 2780px baseline").toBeLessThanOrEqual(1650);
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

test("keyboard order reaches the option rows only after the main controls, as they appear", async ({ page }) => {
  await openCreatePanel(page);
  const order = await page.evaluate(() => {
    const step = document.querySelector(".style-step")!;
    const controls = [...step.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((el) => !el.closest(".create-option-list"));
    const rows = [...step.querySelectorAll<HTMLElement>(".create-option-toggle")];
    const lastControl = controls[controls.length - 1];
    return {
      rowsAfterInTabOrder: rows.every((row) => Boolean(lastControl.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rowsBelowControls: Math.min(...rows.map((row) => row.getBoundingClientRect().top)) >= Math.max(...controls.map((el) => el.getBoundingClientRect().bottom)) - 1,
      rowCount: rows.length,
    };
  });
  expect(order.rowCount).toBeGreaterThan(0);
  expect(order.rowsAfterInTabOrder, "rows come after the main controls in the Tab order").toBe(true);
  expect(order.rowsBelowControls, "rows sit below the main controls on screen").toBe(true);
});

test("Format and Processing mode share a row, and the step-2 sections read in DOM order", async ({ page }) => {
  await openCreatePanel(page);
  const layout = await page.evaluate(() => {
    const sections = [...document.querySelectorAll<HTMLElement>(".style-step > section.field-group")];
    const byLabel = (label: string) => sections.find((section) => section.getAttribute("aria-label") === label)!.getBoundingClientRect();
    const format = byLabel("Format");
    const processing = byLabel("Processing mode");
    return {
      domOrder: sections.map((section) => section.getAttribute("aria-label")),
      tops: sections.map((section) => Math.round(section.getBoundingClientRect().top)),
      format: { top: format.top, left: format.left },
      processing: { top: processing.top, left: processing.left },
      orders: [...document.querySelectorAll<HTMLElement>(".style-step > *")].map((child) => getComputedStyle(child).order),
    };
  });
  expect(layout.domOrder).toEqual(["Editorial style", "Format", "Processing mode", "Batch size", "Execution"]);
  expect(Math.abs(layout.format.top - layout.processing.top), "Format and Processing mode share a top edge").toBeLessThanOrEqual(1);
  expect(layout.processing.left, "Processing mode sits in the column after Format").toBeGreaterThan(layout.format.left);
  // Visual order equals DOM order: no section is placed above one that precedes it.
  for (let index = 1; index < layout.tops.length; index += 1) expect(layout.tops[index], `${layout.domOrder[index]} sits below ${layout.domOrder[index - 1]}`).toBeGreaterThanOrEqual(layout.tops[index - 1] - 1);
  expect(layout.orders.every((order) => order === "0"), "no step-2 child is reordered with CSS").toBe(true);
});

test("option row titles use the same size and weight as the field labels", async ({ page }) => {
  await openCreatePanel(page);
  const typography = await page.evaluate(() => {
    const title = getComputedStyle(document.querySelector(".create-option-title")!);
    const label = getComputedStyle(document.querySelector(".style-step .field-group-head h3")!);
    return { title: [title.fontSize, title.fontWeight], label: [label.fontSize, label.fontWeight] };
  });
  expect(typography.title).toEqual(typography.label);
});

test("the Heading and Emoji notes sit at least 8px below their cards", async ({ page }) => {
  await openCreatePanel(page);
  await openOption(page, "Heading appearance");
  await openOption(page, "Emoji reactions");
  for (const picker of [".heading-style-picker", ".emoji-mode-picker"]) {
    const gap = await page.locator(picker).evaluate((element) => {
      const cards = element.querySelector(".heading-style-options")!.getBoundingClientRect();
      const note = element.querySelector(".form-hint")!.getBoundingClientRect();
      return note.top - cards.bottom;
    });
    expect(gap, `${picker} note clears its cards`).toBeGreaterThanOrEqual(8);
  }
});

test("the open Subscribe row shows its value once and keeps the group name for screen readers", async ({ page }) => {
  await openCreatePanel(page);
  await openOption(page, "Subscribe animation");
  const group = page.getByRole("group", { name: "Automatic Subscribe animation" });
  await expect(group).toBeVisible();
  const legend = await group.locator("> legend").boundingBox();
  expect(legend, "legend is still in the accessibility tree").not.toBeNull();
  expect(legend!.width, "legend takes no visible width").toBeLessThanOrEqual(1);
  expect(legend!.height, "legend takes no visible height").toBeLessThanOrEqual(1);
  const enabled = group.getByRole("checkbox", { name: "Enable Subscribe animation" });
  await expect(enabled).toBeVisible();
  const toggle = await page.getByRole("button", { name: "Subscribe animation", exact: true }).boundingBox();
  const checkbox = await enabled.boundingBox();
  expect(checkbox!.y - (toggle!.y + toggle!.height), "first control sits directly under the row").toBeLessThanOrEqual(12);
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

    const callout = await page.locator(".workspace-page > .stalled-callout").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const text = element.querySelector(":scope > div:nth-child(2)")!.getBoundingClientRect();
      const buttons = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      return { box, text, buttons };
    });
    // Buttons always stay inside the callout, and the text keeps a readable column.
    for (const button of callout.buttons) expect(button.left >= callout.box.left - 1 && button.right <= callout.box.right + 1, "button inside the callout").toBe(true);
    expect(callout.text.width, "callout text column is readable").toBeGreaterThanOrEqual(200);
    const viewportWidth = page.viewportSize()?.width ?? 1440;
    if (viewportWidth <= 540) {
      expect(callout.box.height, "phone callout stays short").toBeLessThanOrEqual(220);
      for (const button of callout.buttons) expect(button.top, "phone buttons sit below the text").toBeGreaterThanOrEqual(callout.text.bottom - 1);
      const bar = await page.locator(".workspace-page > .job-strip .progress-wrap").evaluate((element) => element.getBoundingClientRect().width);
      const strip = await page.locator(".workspace-page > .job-strip").evaluate((element) => {
        const style = getComputedStyle(element);
        return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      expect(Math.abs(bar - strip), "phone progress bar spans the job strip").toBeLessThanOrEqual(2);
    } else if (viewportWidth >= 1024) {
      expect(callout.box.height, "desktop callout stays one row").toBeLessThanOrEqual(100);
      for (const button of callout.buttons) expect(button.top >= callout.text.top - 1 && button.bottom <= callout.text.bottom + 1, "desktop buttons align with the text").toBe(true);
    }
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
