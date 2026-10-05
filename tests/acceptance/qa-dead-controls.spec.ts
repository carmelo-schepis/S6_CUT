/**
 * Repro specs for controls that render but cannot be actuated, and for labels
 * that contradict the data behind them. Each test is written against the
 * behaviour the UI already advertises, so a failure here is a product defect
 * rather than a wrong expectation.
 */
import { test, expect, type Page } from "@playwright/test";
import { gateway, openWorkspaceForProject } from "./support/workspace";

const BENIGN_CONSOLE = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

async function boot(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  // The rail only settles once the async health + project fetches resolve.
  await page.waitForTimeout(4_000);
  return errors;
}

async function rail(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(2_500);
}

/**
 * Opens a Workspace that has at least one rendered clip tile on the board.
 *
 * The project is chosen from the job record rather than from whichever card the
 * shell happens to select or sort first: a stopped-but-kept import heads the
 * listing with an empty board, and a card can read "ready" while its clips have
 * since been removed. Every control under test needs real tiles.
 */
async function workspaceWithClips(page: Page) {
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json() as { id: string; name: string }[];
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json() as { projectId: string; state: string; clips?: { state: string }[] }[];
  const withClips = new Set(jobs
    .filter((job) => job.state === "complete" && (job.clips ?? []).some((clip) => clip.state === "complete"))
    .map((job) => job.projectId));
  const target = projects.find((project) => withClips.has(project.id));
  test.skip(!target, "no project with finished clips on this instance");

  await openWorkspaceForProject(page, target!.name);
  await expect(page.locator(".clip-board .clip-tile").first()).toBeVisible({ timeout: 30_000 });
}

test("Workspace board filters filter the clip board", async ({ page }) => {
  await boot(page);
  await workspaceWithClips(page);

  const filters = page.locator(".board-filters button");
  await expect(filters).toHaveCount(3);
  const all = filters.filter({ hasText: "All" });
  const failed = filters.filter({ hasText: "Failed" });

  const total = await page.locator(".clip-board .clip-tile").count();
  const failedTiles = await page.locator(".clip-board .clip-tile.failed").count();

  await failed.click();
  await page.waitForTimeout(500);

  // Selecting a filter must move the active state and actually narrow the board.
  await expect(failed).toHaveClass(/active/);
  await expect(all).not.toHaveClass(/active/);
  expect(await page.locator(".clip-board .clip-tile").count()).toBe(failedTiles);

  await all.click();
  await page.waitForTimeout(500);
  await expect(all).toHaveClass(/active/);
  expect(await page.locator(".clip-board .clip-tile").count()).toBe(total);
});

test("Workspace J/K/L shortcuts drive the preview transport", async ({ page }) => {
  await boot(page);
  await workspaceWithClips(page);
  await page.getByRole("button", { name: "Preview", exact: true }).first().click();
  await expect(page.locator(".viewer-frame video")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);

  const play = page.locator(".play-button");
  await expect(play).toHaveAttribute("aria-pressed", "false");

  // K is the transport's play/pause toggle; the legend in the transport bar
  // advertises J K L, so each key must reach the player. Focus is dropped
  // first because clicking the <video controls> element would toggle playback
  // on its own and mask whether the key binding exists.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("k");
  await page.waitForTimeout(1_200);
  await expect(play).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("k");
  await page.waitForTimeout(800);
  await expect(play).toHaveAttribute("aria-pressed", "false");

  const before = await page.locator(".viewer-frame video").evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.keyboard.press("l");
  await page.waitForTimeout(600);
  const afterL = await page.locator(".viewer-frame video").evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(afterL, "L must move the playhead forward").toBeGreaterThan(before);

  await page.keyboard.press("j");
  await page.waitForTimeout(600);
  const afterJ = await page.locator(".viewer-frame video").evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(afterJ, "J must move the playhead back").toBeLessThan(afterL);
});

test("Workspace transport offers a next-frame counterpart to previous frame", async ({ page }) => {
  await boot(page);
  await workspaceWithClips(page);
  await expect(page.getByRole("button", { name: "Previous frame" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next frame" })).toBeVisible();
});

test("Workspace inspector tabs are labelled in sentence case", async ({ page }) => {
  await boot(page);
  await workspaceWithClips(page);
  const labels = await page.locator(".inspector-tabs button").allTextContents();
  expect(labels).toEqual(["Score", "Captions", "Asset", "Info"]);
});

test("Shorts Editor clip rows report each clip's real aspect ratio", async ({ page }) => {
  await boot(page);
  await rail(page, "Shorts Editor");
  await expect(page.locator(".clip-browser-item").first()).toBeVisible({ timeout: 30_000 });

  // Page the browser in so non-9:16 renders from earlier runs are included.
  for (let i = 0; i < 4; i += 1) {
    const more = page.getByRole("button", { name: /Show \d+ more of \d+/ });
    if (!(await more.count())) break;
    await more.click();
    await page.waitForTimeout(400);
  }

  const rows = await page.locator(".clip-browser-info").allTextContents();
  const withDims = rows
    .map((text) => text.match(/(\d+:\d+)\s+·\s+(\d+)\s+×\s+(\d+)\s+px/))
    .filter((m): m is RegExpMatchArray => Boolean(m));
  expect(withDims.length, "expected at least one clip row with dimensions").toBeGreaterThan(0);

  // A row is self-contradictory if the ratio it prints disagrees with the
  // pixel size it prints on the same line.
  const wrong = withDims
    .map(([, ratio, w, h]) => ({ ratio, w: Number(w), h: Number(h) }))
    .filter(({ ratio, w, h }) => {
      const [rw, rh] = ratio.split(":").map(Number);
      return Math.abs(w / h - rw / rh) / (w / h) > 0.02;
    });
  expect(wrong, `rows whose printed ratio contradicts their pixel size: ${JSON.stringify(wrong)}`).toEqual([]);
});

test("Shorts Editor preview volume and expand controls are actuatable", async ({ page }) => {
  await boot(page);
  await rail(page, "Shorts Editor");

  // A source must be loaded before the video stage (and its controls) render.
  await page.getByRole("tab", { name: "Library" }).click();
  await page.waitForTimeout(800);
  const picker = page.locator("#shorts-source");
  await expect(picker).toBeEnabled();
  const value = await picker.locator("option").nth(1).getAttribute("value");
  await picker.selectOption(value!);
  await expect(page.locator(".shorts-video-frame video")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);

  // Instrument fullscreen before clicking: headless Chromium will not actually
  // enter fullscreen, but the request is the observable behaviour.
  await page.evaluate(() => {
    (window as unknown as { __fs: number }).__fs = 0;
    Element.prototype.requestFullscreen = function () {
      (window as unknown as { __fs: number }).__fs += 1;
      return Promise.resolve();
    };
  });

  const muted0 = await page.locator(".shorts-video-frame video").evaluate((v: HTMLVideoElement) => v.muted);
  await page.getByRole("button", { name: /Preview volume|Mute preview|Unmute preview/ }).click();
  await page.waitForTimeout(400);
  const muted1 = await page.locator(".shorts-video-frame video").evaluate((v: HTMLVideoElement) => v.muted);
  expect(muted1, "the volume control must toggle the preview's muted state").not.toBe(muted0);

  await page.getByRole("button", { name: "Expand preview" }).click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { __fs: number }).__fs), "expand must request fullscreen").toBeGreaterThan(0);
});

test("Enter in the Shorts Editor assistant sends a message and queues nothing", async ({ page }) => {
  await boot(page);

  // A real source must be selected, because that is the state in which the
  // stray submit would queue an actual render. The POST is blocked at the
  // network layer so reproducing the defect cannot create a job on the
  // owner's live deployment.
  const jobPosts: string[] = [];
  await page.route("**/api/v1/jobs**", async (route) => {
    if (route.request().method() === "POST") {
      jobPosts.push(route.request().url());
      return route.abort();
    }
    return route.fallback();
  });

  await rail(page, "Shorts Editor");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.waitForTimeout(800);
  const picker = page.locator("#shorts-source");
  await expect(picker).toBeEnabled();
  await picker.selectOption((await picker.locator("option").nth(1).getAttribute("value"))!);
  await page.waitForTimeout(1_000);

  const composer = page.getByRole("textbox", { name: "Editing request" });
  await expect(composer).toBeVisible();
  await composer.fill("make it 20 seconds");
  await composer.press("Enter");
  await page.waitForTimeout(2_500);

  expect(jobPosts, "pressing Enter in the chat composer must not queue a render").toEqual([]);
  await expect(page.locator(".assistant-message.user").last()).toContainText("make it 20 seconds");
});
