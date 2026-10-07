import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertZipIntact, checkPlayback, createClipProject, extractZip, waitForProjectReady, assertPlayback } from "./support/workspace";
import { assertPreviewAdvances } from "./support/recent-clips";

const base = process.env.S6_SCRIPT_REMOVAL_ACCEPTANCE_URL || "";
const isolated = process.env.S6_SCRIPT_REMOVAL_ISOLATED === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiBase = () => `${requireIsolatedTarget().origin}/api/v1`;
const suppliedYoutube = JSON.parse(await fs.readFile(path.join(root, "tests/fixtures/youtube-live-sources.json"), "utf8"));

function requireIsolatedTarget() {
  if (!isolated || !base) throw new Error("Set S6_SCRIPT_REMOVAL_ISOLATED=1 and S6_SCRIPT_REMOVAL_ACCEPTANCE_URL for a disposable deployment.");
  const target = new URL(base);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || port < 20_000 || port > 65_535) {
    throw new Error("Script-removal acceptance requires an explicitly isolated loopback URL on port 20000–65535.");
  }
  const dataPath = process.env.S6_DATA_PATH && path.resolve(process.env.S6_DATA_PATH);
  if (!dataPath || path.dirname(dataPath) !== "/tmp" || !/^s6-(script-removal|recent-clips)-[a-zA-Z0-9-]{8,}$/.test(path.basename(dataPath))) {
    throw new Error("S6_DATA_PATH must be a uniquely named disposable /tmp/s6-script-removal-* or /tmp/s6-recent-clips-* dataset; owner data/settings are forbidden.");
  }
  return { origin: target.origin, dataPath };
}

test.beforeEach(() => { requireIsolatedTarget(); });

test("desktop UI removes retired Script creation and AI Video destinations without promoting them", async ({ page }) => {
  await page.goto(`${requireIsolatedTarget().origin}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByRole("button", { name: /script mode|ai video/i })).toHaveCount(0);
  await expect(page.locator(".script-input-wrap, textarea[aria-label*='script' i], input[type=file][accept*='text']")).toHaveCount(0);
  await expect(page.getByLabel("Narration source")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /upload.*script|script.*upload|narrat/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Music / sung vocals" })).toBeVisible();
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Shorts Editor", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Jobs", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: /AI Video|Topic to Video/i })).toHaveCount(0);
  await expect(page.getByText(/AI Video|Topic to Video|Create a video from a script/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /AI Video|Topic to Video/i })).toHaveCount(0);
  const api = apiBase();
  const openapi = await page.request.get(`${requireIsolatedTarget().origin}/api/openapi.json`).then((response) => response.json()) as { paths: Record<string, unknown> };
  expect(openapi.paths).not.toHaveProperty("/api/v1/jobs/script");
  expect(openapi.paths).not.toHaveProperty("/api/v1/ai/topic-plan");
  expect((await page.request.post(`${api}/jobs/script`, { data: { script: "historical input must not start a job" } })).status()).toBe(405);
  expect((await page.request.post(`${api}/ai/topic-plan`, { data: { topic: "historical topic" } })).status()).toBe(404);
});

test("remaining navigation is available at phone and tablet widths", async ({ page }) => {
  await page.goto(`${requireIsolatedTarget().origin}/`, { waitUntil: "domcontentloaded" });
  for (const viewport of [{ width: 390, height: 844 }, { width: 810, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const nav = page.getByRole("navigation");
    for (const name of ["Projects", "Library", "Workspace", "Shorts Editor", "Jobs", "Settings"]) {
      const button = nav.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await expect(button).toHaveAttribute("aria-current", "page");
    }
    await expect(nav.getByRole("button", { name: /AI Video/i })).toHaveCount(0);
  }
});

test("uploaded MP4 clip completes, plays, publishes to Library, and exports", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chromium", "real rendering/export evidence runs once on desktop");
  test.setTimeout(20 * 60_000);
  const source = process.env.S6_SCRIPT_REMOVAL_MP4 || process.env.S6_AUTHENTICITY_FIXTURE || path.join(root, "tests/fixtures/openrouter-fallback.mp4");
  if (!source) throw new Error("Set S6_SCRIPT_REMOVAL_MP4 to a real disposable MP4 source file.");
  await fs.access(source);
  const projectName = `Removal acceptance ${Date.now()}`;
  const observed = new Set<string>();
  await page.goto(`${requireIsolatedTarget().origin}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await createClipProject(page, { name: projectName, count: 1, mode: "Fast", aspect: "9:16", min: 8, max: 20, captions: false, source: { kind: "file", path: source } });
  await waitForProjectReady(page, observed);
  await expect(page.locator(".failure-strip")).toHaveCount(0);
  await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 30_000 });
  const playback = await assertPlayback(page);
  checkPlayback(playback, "uploaded MP4 clip");
  const clip = page.locator(".clip-tile.complete").first();
  await expect(clip).toContainText(/saved to Library|Library/i);
  const projects = await page.request.get(`${apiBase()}/projects`).then((response) => response.json()) as { id: string; name: string }[];
  const created = projects.find((project) => project.name === projectName);
  expect(created, "the uploaded source created the expected project").toBeTruthy();
  const jobs = await page.request.get(`${apiBase()}/jobs`).then((response) => response.json()) as { id: string; projectId: string; state: string; clips: { id: string; state: string; libraryAssetId?: string | null }[] }[];
  const published = jobs.find((job) => job.projectId === created!.id && job.state === "complete");
  expect(published?.clips, "completed output has a published Library asset").toEqual(expect.arrayContaining([expect.objectContaining({ state: "complete", libraryAssetId: expect.any(String) })]));
  const outputClip = published!.clips.find((entry) => entry.state === "complete")!;
  const assets = await page.request.get(`${apiBase()}/library/assets?origin=generated-clip`).then((response) => response.json()) as { id: string; origin: string; sourceProjectId: string | null; sourceJobId: string | null; sourceClipId: string | null }[];
  expect(assets).toEqual(expect.arrayContaining([expect.objectContaining({
    id: outputClip.libraryAssetId, origin: "generated-clip", sourceProjectId: created!.id,
    sourceJobId: published!.id, sourceClipId: outputClip.id,
  })]));
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download ZIP/ }).click()]);
  const zipPath = path.join(testInfo.outputDir, download.suggestedFilename());
  await download.saveAs(zipPath);
  assertZipIntact(zipPath);
  const entries = await extractZip(zipPath, path.join(testInfo.outputDir, "export"));
  expect(entries.some((entry) => entry.toLowerCase().endsWith(".mp4"))).toBeTruthy();
  await page.screenshot({ path: path.join(testInfo.outputDir, "completed.png"), fullPage: true });
});

test("disposable legacy Script output remains discoverable through the UI", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chromium", "legacy preview evidence runs once on desktop");
  const target = requireIsolatedTarget();
  const marker = path.join(target.dataPath, "recent-clips-fixture.json");
  try { await fs.access(marker); } catch { test.skip(true, "requires the disposable seed_recent_clips.py legacy-output fixture"); }
  const assets = await page.request.get(`${target.origin}/api/v1/library/assets?origin=script-output`).then((response) => response.json()) as { id: string; title: string; origin: string }[];
  const legacy = assets.find((asset) => asset.title === "RC script output");
  expect(legacy).toMatchObject({ origin: "script-output" });
  await page.goto(`${target.origin}/`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".recent-clips-section")).toBeVisible();
  const search = page.locator(".recent-clips-section").getByRole("searchbox");
  await search.fill("RC script output");
  const card = page.locator(`.recent-clip-card[data-asset-id="${legacy!.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "View in Library" }).click();
  await expect(page.locator(`.asset-card[data-asset-id="${legacy!.id}"]`)).toBeVisible();
  await page.locator(".asset-card.active[data-asset-id=" + JSON.stringify(legacy!.id) + "] .asset-preview-trigger").click();
  await assertPreviewAdvances(page.getByRole("dialog").locator("video"));
});

test("authorized supplied YouTube source imports and real output playback works", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chromium", "live YouTube import runs once on desktop");
  test.skip(process.env.S6_RUN_LIVE_YOUTUBE !== "1", "Explicit live YouTube opt-in required");
  test.setTimeout(20 * 60_000);
  const source = suppliedYoutube.sources[0] as { url: string; videoId: string };
  const projectName = `Authorized YouTube ${source.videoId} ${Date.now()}`;
  await page.goto(`${requireIsolatedTarget().origin}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(source.url);
  await page.getByRole("textbox", { name: "Project name" }).fill(projectName);
  await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
  const ready = page.locator(".process-checklist li").filter({ hasText: "Project ready" });
  await expect(ready).toHaveClass(/status-complete/, { timeout: 15 * 60_000 });
  const video = page.getByRole("region", { name: "Output viewer" }).locator("video");
  await expect(video).toBeVisible();
  const state = await video.evaluate(async (node: HTMLVideoElement) => {
    node.muted = true;
    if (node.readyState < 2) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("YouTube clip playback timed out")), 30_000);
      node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("YouTube clip decode failed")); }, { once: true });
    });
    const start = node.currentTime;
    await node.play();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    node.pause();
    return { readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, advanced: node.currentTime > start };
  });
  expect(state.readyState).toBeGreaterThanOrEqual(2);
  expect(state.width * state.height).toBeGreaterThan(0);
  expect(state.advanced).toBeTruthy();
  await page.screenshot({ path: path.join(testInfo.outputDir, "youtube-playback.png"), fullPage: true });
});
