import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPlayback, checkPlayback, openProjects, waitForProjectReady } from "./support/workspace";

/*
 * SEO titles acceptance. Runs ONLY against a disposable isolated stack whose
 * engine has S6_TEST_MODE=1 and S6_TEST_OPENROUTER_BASE_URL pointing at
 * tests/fixtures/mock-openrouter. Required environment:
 *   S6_RUN_SEO_TITLES=1, S6_ACCEPTANCE_URL, S6_DATA_PATH, S6_SEO_ENGINE_CONTAINER
 * Optional: S6_SEO_MOCK_URL (mock call log), S6_SEO_TITLES_YOUTUBE_URL.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const enabled = process.env.S6_RUN_SEO_TITLES === "1";
const gateway = (process.env.S6_ACCEPTANCE_URL || "").replace(/\/$/, "");
const dataPath = process.env.S6_DATA_PATH || "";
const engineContainer = process.env.S6_SEO_ENGINE_CONTAINER || "";
const mockUrl = process.env.S6_SEO_MOCK_URL || "";
// BuzzFeedVideo, "Americans Try Vietnamese Street Food", 2:44, speech-heavy.
const sourceUrl = process.env.S6_SEO_TITLES_YOUTUBE_URL || "https://www.youtube.com/watch?v=3CAHMoyOZEA";
const uploadFixture = path.join(root, "tests/fixtures/youtube-credit-known.mp4");
const MOCK_KEY = `sk-or-v1-mock${"0".repeat(52)}`;
const CUT_NUMBER = /\bcut\s*\d+\b/i;

function guardIsolatedStack() {
  expect(gateway, "S6_ACCEPTANCE_URL must point at the isolated stack").toBeTruthy();
  expect(gateway, "never run against the owner stack").not.toMatch(/:8080$/);
  expect(dataPath, "S6_DATA_PATH must be the isolated stack's data directory").toBeTruthy();
  const resolved = path.resolve(dataPath);
  expect(resolved, "never use the shared checkout data").not.toBe(path.resolve("/home/linuxpc/Git_projects/S6_CUT/data"));
  expect(resolved).not.toBe(path.resolve(root, "data"));
  expect(engineContainer, "S6_SEO_ENGINE_CONTAINER must name the isolated engine").toMatch(/seo-titles-test/);
}

async function api<T = any>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${gateway}${route}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${route} → ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function ensureMockProfile(): Promise<string> {
  const profiles = await api<any[]>("/api/v1/profiles");
  const existing = profiles.find((profile) => profile.name === "SEO mock provider");
  let id = existing?.id as string | undefined;
  if (!id) {
    const created = await api("/api/v1/profiles", { method: "POST", body: JSON.stringify({ name: "SEO mock provider", textModelId: "openai/gpt-4.1-mini", openrouterKey: MOCK_KEY, persistence: "encrypted", selected: true }) });
    id = created.id;
  } else if (!existing.selected) {
    await api(`/api/v1/profiles/${id}`, { method: "PUT", body: JSON.stringify({ name: existing.name, textModelId: existing.textModelId, persistence: existing.persistence, selected: true }) });
  }
  const tested = await api(`/api/v1/profiles/${id}/test`, { method: "POST" });
  expect(tested.textStatus, "the mock provider should connect").toBe("connected");
  expect(tested.autoSeoTitles).toBe(true);
  return id!;
}

async function waitForJob(jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(`/api/v1/jobs/${jobId}`);
    if (["complete", "partial", "failed", "cancelled", "cancelled_kept"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
}

async function newProjectAfter(before: Set<string>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projects = await api<any[]>("/api/v1/projects");
    const created = projects.find((project) => !before.has(project.id));
    if (created) return created;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no new project appeared");
}

async function projectIds() {
  return new Set((await api<any[]>("/api/v1/projects")).map((project) => project.id));
}

async function setCount(page: Page, count: number) {
  const countValue = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) > count; guard += 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) < count; guard += 1) await page.getByRole("button", { name: "More clips", exact: true }).click();
  await expect(countValue).toHaveText(String(count));
}

/** Projects → YouTube URL, blank name, Smart. Returns the SEO toggle locator state. */
async function createYouTubeSmartProject(page: Page, { count, seo }: { count: number; seo: "default-on" | "untick" }) {
  await openProjects(page);
  await page.getByRole("tab", { name: "YouTube" }).click();
  const field = page.locator("#source-youtube-url");
  await field.fill(sourceUrl);
  await expect(page.getByLabel("Project name")).toHaveValue("");
  await setCount(page, count);
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  const seoToggle = page.getByRole("checkbox", { name: /Write SEO titles with AI/ });
  await expect(seoToggle).toBeEnabled();
  await expect(seoToggle, "SEO titles default on when OpenRouter is connected").toBeChecked();
  if (seo === "untick") await seoToggle.uncheck();
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption("9:16");
  await page.getByLabel("Minimum seconds").fill("12");
  await page.getByLabel("Maximum seconds").fill("30");
  await page.getByRole("button", { name: new RegExp(`^Create ${count} short clips?$`) }).click();
}

function checkSeoTitle(title: string, label: string) {
  expect(title, `${label}: title`).toBeTruthy();
  expect(title, `${label}: no placeholder`).not.toMatch(/YouTube import/i);
  expect(title, `${label}: no cut number`).not.toMatch(CUT_NUMBER);
  expect(title.length, `${label}: ≤70 characters (${title})`).toBeLessThanOrEqual(70);
  expect(title, `${label}: no hashtags`).not.toMatch(/#\w/);
}

async function openWorkspace(page: Page, jobId: string) {
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  const jobCard = page.locator(`.job-card[data-job-id="${jobId}"]`);
  const showAll = page.getByRole("button", { name: /^Show all \d+ jobs$/ });
  await expect.poll(async () => (await jobCard.count()) > 0 || (await showAll.count()) > 0, { timeout: 30_000 }).toBe(true);
  if (await jobCard.count() === 0) await showAll.click();
  await jobCard.getByRole("button", { name: "Open", exact: true }).click();
}

async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByTestId("suggest-seo-titles")).toBeVisible({ timeout: 30_000 });
}

test.describe("SEO titles", () => {
  test.beforeEach(() => {
    test.skip(!enabled, "Set S6_RUN_SEO_TITLES=1 on an isolated stack");
    guardIsolatedStack();
  });

  test("a new YouTube project takes the video title and gets AI SEO titles on playable clips", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium", "one live job per disposable stack");
    test.setTimeout(30 * 60_000);
    await ensureMockProfile();
    const before = await projectIds();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("auto-seo-titles")).toBeChecked();
    await createYouTubeSmartProject(page, { count: 3, seo: "default-on" });
    const created = await newProjectAfter(before);
    expect(created.nameIsAuto).toBe(true);
    await waitForProjectReady(page, new Set(), 25 * 60_000);

    const project = await api(`/api/v1/projects/${created.id}`);
    const job = await api(`/api/v1/jobs/${project.latestJobId}`);
    expect(project.sourceTitle, "YouTube title captured").toMatch(/Vietnamese/i);
    expect(project.name, "auto-named project takes the YouTube title").toBe(project.sourceTitle);
    await expect(page.locator(".workspace-project-name")).toHaveText(project.sourceTitle, { timeout: 30_000 });
    expect(job.youtubeMetadataEnabled).toBe(true);
    const complete = job.clips.filter((clip: any) => clip.state === "complete");
    expect(complete.length).toBeGreaterThanOrEqual(2);
    const titles = complete.map((clip: any) => clip.title as string);
    expect(new Set(titles.map((title: string) => title.toLowerCase())).size, "titles are unique").toBe(titles.length);
    for (const clip of complete) {
      checkSeoTitle(clip.title, `clip ${clip.index}`);
      expect(clip.titleSource).toBe("ai");
      expect(clip.title, "title leads with the source entity, proving source context reached the model").toMatch(/^Americans Try Vietnamese/);
      expect(clip.youtubeDescription).toContain("#Shorts");
      const asset = (await api<any[]>("/api/v1/library/assets")).find((item) => item.id === clip.libraryAssetId);
      expect(asset, "clip has its Library asset").toBeTruthy();
      expect(asset.title).toBe(clip.title);
      expect(asset.titleSource).toBe("ai");
      expect(asset.tags).toEqual([]);
    }
    if (mockUrl) {
      const calls = await (await fetch(`${mockUrl}/__calls`)).json();
      const seoCalls = calls.filter((call: any) => call.schema_keys.includes("clips"));
      expect(seoCalls.length, "one batched SEO request covers all clips").toBe(1);
      expect(seoCalls[0].max_tokens).toBeGreaterThan(400);
    }

    // Workspace shows the same titles, and every clip actually plays.
    const tileTitles = await page.locator(".clip-tile.complete .clip-title").allTextContents();
    expect(tileTitles.sort()).toEqual([...titles].sort());
    const tiles = page.locator(".clip-tile.complete");
    for (let index = 0; index < await tiles.count(); index += 1) {
      await tiles.nth(index).getByRole("button", { name: /Preview/ }).click();
      const playback = await assertPlayback(page);
      checkPlayback(playback, `clip tile ${index + 1}`);
      expect(playback.videoWidth).toBe(1080);
      expect(playback.videoHeight).toBe(1920);
      const player = page.locator(".viewer-frame video");
      for (const fraction of [0.15, 0.5, 0.85]) {
        await player.evaluate((node: HTMLVideoElement, f: number) => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
          node.currentTime = node.duration * f;
        }), fraction);
        await page.locator(".viewer-stage").screenshot({ path: testInfo.outputPath(`clip-${index + 1}-at-${Math.round(fraction * 100)}.png`) });
      }
    }
    await page.screenshot({ path: testInfo.outputPath("workspace-ai-titles.png"), fullPage: true });

    await openLibrary(page);
    for (const clip of complete) {
      const card = page.locator(`.asset-card[data-asset-id="${clip.libraryAssetId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.locator(".asset-card-details-content strong")).toHaveText(clip.title);
    }
    await page.screenshot({ path: testInfo.outputPath("library-ai-titles.png"), fullPage: true });
    fs.writeFileSync(testInfo.outputPath("ai-titles.json"), JSON.stringify({ project: project.name, titles, descriptions: complete.map((clip: any) => clip.youtubeDescription) }, null, 2));
  });

  test("Fast clips without AI get clean rule-based titles", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium", "one live job per disposable stack");
    test.setTimeout(10 * 60_000);
    const before = await projectIds();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await openProjects(page);
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(uploadFixture);
    await expect(page.locator(".drop-zone.has-file")).toBeVisible();
    await setCount(page, 2);
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /Write SEO titles with AI/ })).not.toBeChecked();
    await page.getByRole("button", { name: /^Create 2 short clips?$/ }).click();
    const created = await newProjectAfter(before);
    const job = await waitForJob(created.latestJobId, 8 * 60_000);
    expect(job.youtubeMetadataEnabled).toBe(false);
    const complete = job.clips.filter((clip: any) => clip.state === "complete");
    expect(complete.length).toBeGreaterThanOrEqual(1);
    for (const clip of complete) {
      checkSeoTitle(clip.title, `fast clip ${clip.index}`);
      expect(clip.titleSource).toBe("auto");
    }
  });

  test("Suggest SEO titles retitles legacy clips after review and never touches hand-edited titles", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium", "one live job per disposable stack");
    test.setTimeout(30 * 60_000);
    await ensureMockProfile();
    const before = await projectIds();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await createYouTubeSmartProject(page, { count: 3, seo: "untick" });
    const created = await newProjectAfter(before);
    const finished = await waitForJob(created.latestJobId, 25 * 60_000);
    expect(finished.youtubeMetadataEnabled, "unticking the toggle reaches the engine").toBe(false);
    for (const clip of finished.clips.filter((item: any) => item.state === "complete")) {
      checkSeoTitle(clip.title, `rule-based clip ${clip.index}`);
      expect(clip.titleSource).toBe("auto");
    }

    // Rewrite this job into pre-upgrade data (titles only) inside the isolated engine.
    const seed = JSON.parse(execFileSync("docker", ["exec", "-i", engineContainer, "python", "-", finished.id], {
      input: fs.readFileSync(path.join(root, "tests/acceptance/support/seed_legacy_titles.py")), encoding: "utf8",
    }).trim().split("\n").pop()!);
    const handEdited = seed.assets.find((item: any) => item.handEdited);
    const legacy = seed.assets.filter((item: any) => !item.handEdited);
    expect(legacy.length).toBeGreaterThanOrEqual(2);
    const assetsBefore = new Map<string, any>();
    for (const item of seed.assets) assetsBefore.set(item.assetId, (await api<any[]>("/api/v1/library/assets")).find((asset) => asset.id === item.assetId));

    await page.reload();
    await openLibrary(page);
    const legacyCard = page.locator(`.asset-card[data-asset-id="${legacy[0].assetId}"]`);
    await expect(legacyCard.locator(".asset-card-details-content strong")).toHaveText(legacy[0].title, { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("library-before-backfill.png"), fullPage: true });
    await page.getByTestId("suggest-seo-titles").click();
    const dialog = page.getByTestId("seo-title-review");
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await expect(dialog.getByRole("heading", { name: "Review SEO titles" })).toBeVisible();
    for (const item of legacy) await expect(dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${item.assetId}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="seo-title-row"][data-project-id="${seed.projectId}"]`).first()).toBeVisible();
    await expect(dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${handEdited.assetId}"]`)).toHaveCount(0);
    await expect(dialog.getByTestId("seo-title-skipped")).toContainText(handEdited.title);
    await expect(dialog.getByTestId("seo-title-skipped")).toContainText("Title was edited by hand");
    await dialog.screenshot({ path: testInfo.outputPath("review-dialog.png") });

    const skipRow = dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${legacy[0].assetId}"]`);
    await skipRow.getByRole("checkbox").uncheck();
    const editRow = dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${legacy[1].assetId}"]`);
    const editedTitle = "Vietnamese Street Food Banh Mi First Bite Reaction";
    await editRow.getByRole("textbox", { name: /^New title for/ }).fill(editedTitle);
    const suggestedOthers = new Map<string, string>();
    for (const item of legacy.slice(2)) suggestedOthers.set(item.assetId, await dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${item.assetId}"]`).getByRole("textbox", { name: /^New title for/ }).inputValue());
    await dialog.getByRole("button", { name: /^Apply selected \(\d+\)$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("seo-title-feedback")).toContainText(/Updated \d+ titles/);

    const assets = await api<any[]>("/api/v1/library/assets");
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    expect(byId.get(legacy[0].assetId).title, "unticked row is unchanged").toBe(legacy[0].title);
    expect(byId.get(legacy[1].assetId).title).toBe(editedTitle);
    expect(byId.get(legacy[1].assetId).titleSource).toBe("user");
    for (const [assetId, title] of suggestedOthers) {
      expect(byId.get(assetId).title).toBe(title);
      expect(byId.get(assetId).titleSource).toBe("ai");
      checkSeoTitle(title, `applied ${assetId}`);
    }
    expect(byId.get(handEdited.assetId).title, "hand-edited title untouched").toBe(handEdited.title);
    for (const item of seed.assets) {
      const now = byId.get(item.assetId);
      const was = assetsBefore.get(item.assetId);
      expect({ tags: now.tags, triggers: now.triggers, policy: now.policy, filename: now.filename, blobId: now.blobId }).toEqual({ tags: was.tags, triggers: was.triggers, policy: was.policy, filename: was.filename, blobId: was.blobId });
    }
    const renamed = await api(`/api/v1/projects/${seed.projectId}`);
    expect(renamed.name).toBe(renamed.sourceTitle);

    await expect(page.locator(`.asset-card[data-asset-id="${legacy[1].assetId}"] .asset-card-details-content strong`)).toHaveText(editedTitle);
    await page.screenshot({ path: testInfo.outputPath("library-after-backfill.png"), fullPage: true });
    const job = await api(`/api/v1/jobs/${finished.id}`);
    await openWorkspace(page, finished.id);
    for (const clip of job.clips.filter((item: any) => item.state === "complete")) {
      if (clip.libraryAssetId === handEdited.assetId) continue; // legacy data: only the Library copy was hand-edited
      expect(clip.title, "Workspace clip and Library asset share the title").toBe(byId.get(clip.libraryAssetId).title);
    }
    const tileTitles = await page.locator(".clip-tile.complete .clip-title").allTextContents();
    expect(tileTitles).toContain(editedTitle);

    // Running it again offers nothing new for the applied rows.
    await openLibrary(page);
    await page.getByTestId("suggest-seo-titles").click();
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await expect(dialog.locator(`[data-testid="seo-title-row"][data-asset-id="${legacy[1].assetId}"]`)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("without a connected profile the review explains that AI titles need OpenRouter", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium", "mutates the selected profile");
    const mockId = await ensureMockProfile();
    const offline = await api("/api/v1/profiles", { method: "POST", body: JSON.stringify({ name: "Local only", textModelId: "openai/gpt-4.1-mini", persistence: "encrypted", selected: true }) });
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await openLibrary(page);
      await page.getByTestId("suggest-seo-titles").click();
      const dialog = page.getByTestId("seo-title-review");
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(dialog).toContainText("Connect an OpenRouter profile in Settings to write AI titles");
      await dialog.screenshot({ path: testInfo.outputPath("review-no-profile.png") });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await fetch(`${gateway}/api/v1/profiles/${offline.id}`, { method: "DELETE" });
      await ensureMockProfile();
      expect(mockId).toBeTruthy();
    }
  });

  test("Library cards and the review dialog fit this viewport", async ({ page }, testInfo) => {
    await ensureMockProfile();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await openLibrary(page);
    const cards = page.locator(".asset-card");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow").toBeLessThanOrEqual(1);
    const titleBoxes = await page.locator(".asset-card-details-content strong").evaluateAll((nodes) => nodes.slice(0, 8).map((node) => {
      const style = getComputedStyle(node);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
      return { height: node.getBoundingClientRect().height, line, text: node.textContent };
    }));
    for (const box of titleBoxes) expect(box.height, `title clamps to two lines: ${box.text}`).toBeLessThanOrEqual(box.line * 2 + 2);
    await page.screenshot({ path: testInfo.outputPath("library-cards.png"), fullPage: true });

    // Select the still-legacy clip (left unticked in the backfill test) plus an
    // AI-titled one; the legacy row must appear. Cancel writes nothing.
    const legacyCard = page.locator(".asset-card").filter({ has: page.locator(".asset-card-details-content strong", { hasText: /^YouTube import — / }) }).first();
    const aiCard = page.locator(".asset-card").filter({ has: page.locator(".asset-card-details-content strong", { hasText: /^Americans Try Vietnamese Street:/ }) }).first();
    await expect(legacyCard).toBeVisible();
    await expect(aiCard).toBeVisible();
    const before = await api<any[]>("/api/v1/library/assets");
    await legacyCard.locator(".asset-select input").check();
    await aiCard.locator(".asset-select input").check();
    const button = page.getByTestId("suggest-seo-titles");
    await expect(button).toContainText("(2)");
    await button.click();
    const dialog = page.getByTestId("seo-title-review");
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    const rows = dialog.getByTestId("seo-title-row");
    await expect(rows.first()).toBeVisible();
    const input = rows.first().getByRole("textbox", { name: /^New title for/ });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(viewport.width + 1);
    await dialog.screenshot({ path: testInfo.outputPath("review-dialog-viewport.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const after = await api<any[]>("/api/v1/library/assets");
    expect(after.map((asset) => [asset.id, asset.title]).sort()).toEqual(before.map((asset) => [asset.id, asset.title]).sort());
  });
});
