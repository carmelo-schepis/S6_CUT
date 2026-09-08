/**
 * Content-authenticity acceptance: proves S6_cut renders real, playable video
 * rather than completing job records.
 *
 * Every job here is created through visible UI controls. The job API is read
 * only to recover each clip's source boundaries, which the workspace does not
 * display numerically and which the forensics step needs to prove source
 * correspondence; nothing is created or driven through it.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "test-artifacts/content-authenticity");
const fixture = process.env.S6_AUTHENTICITY_FIXTURE
  || path.join(artifacts, "fixture/s6cut-authenticity-source.mp4");
const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

const OVERALL_DEADLINE_MS = 15 * 60_000;

type ClipRecord = {
  index: number;
  id: string;
  title: string;
  metaText: string;
  reportedDuration: number;
  reportedWidth: number | null;
  reportedHeight: number | null;
  sourceStart: number;
  sourceEnd: number;
  savedToLibrary: boolean;
  libraryAssetId: string | null;
  downloadPath: string;
  sha256: string;
  sizeBytes: number;
  playback: PlaybackResult;
};

type PlaybackResult = {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  played: boolean;
  currentTimeAdvanced: boolean;
  advancedBy: number;
  seekMiddleOk: boolean;
  seekNearEndOk: boolean;
  mediaError: string | null;
};

async function checklist(page: Page) {
  return page.locator(".process-checklist li").evaluateAll((rows) => rows.map((row) => ({
    label: row.querySelector(".checklist-label")?.textContent?.trim() || "",
    status: /status-(active|complete|failed|skipped|pending)/.exec(row.className)?.[1] || "unknown",
  })));
}

/**
 * Poll the workspace until the job reaches a terminal, ready state.
 *
 * Clip projects publish one tile per output; Script projects publish a single
 * rendered video that the viewer auto-selects and a storyboard of beats, with
 * no clip tiles at all — so readiness is mode-aware.
 */
async function waitForProjectReady(page: Page, observed: Set<string>, mode: "clip" | "script" = "clip", deadlineMs = OVERALL_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    for (const step of await checklist(page)) {
      if (step.label && step.status !== "pending") observed.add(`${step.label}:${step.status}`);
    }
    const ready = await page.locator(".process-checklist li").filter({ hasText: "Project ready" })
      .evaluateAll((rows) => rows.some((row) => /status-complete/.test(row.className)));
    const complete = mode === "clip"
      ? await page.locator(".clip-tile.complete").count()
      : await page.locator(".viewer-frame video").count();
    const failedBanner = await page.getByText("Project failed", { exact: true }).count();
    if (failedBanner) throw new Error("The project reported a global failure while waiting for outputs");
    if (ready && complete > 0) {
      // The snapshot above was taken before the readiness query, so the final
      // engine update — which can flip several steps at once — may not be in it
      // yet. Re-read once so the last transitions are recorded.
      for (const step of await checklist(page)) {
        if (step.label && step.status !== "pending") observed.add(`${step.label}:${step.status}`);
      }
      return { ready, complete };
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const active = (await checklist(page)).find((step) => step.status === "active");
      // eslint-disable-next-line no-console
      console.log(`  … waiting (${Math.round((Date.now() - (deadline - deadlineMs)) / 1000)}s) active=${active?.label || "none"} outputs=${complete}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`The project did not become ready within ${deadlineMs}ms`);
}

/**
 * Drive the real <video> element the workspace renders. The element is muted
 * first because headless Chromium refuses unmuted programmatic playback; audio
 * is proven separately by decoding the downloaded file.
 */
async function assertPlayback(page: Page): Promise<PlaybackResult> {
  const player = page.locator(".viewer-frame video");
  await expect(player).toBeVisible({ timeout: 30_000 });
  await player.evaluate((node: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
    node.muted = true;
    if (node.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`readyState stayed ${node.readyState}`)), 30_000);
    node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("media element error")); }, { once: true });
  }));

  return await player.evaluate(async (node: HTMLVideoElement) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const seek = (target: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      node.addEventListener("seeked", () => { clearTimeout(timer); resolve(true); }, { once: true });
      try { node.currentTime = target; } catch { clearTimeout(timer); resolve(false); }
    });

    node.muted = true;
    node.currentTime = 0;
    const before = node.currentTime;
    let played = false;
    try { await node.play(); played = true; } catch { played = !node.paused; }
    await wait(1_200);
    const advancedBy = node.currentTime - before;
    node.pause();

    const seekMiddleOk = await seek(node.duration / 2);
    const seekNearEndOk = await seek(Math.max(0, node.duration - 0.35));

    return {
      readyState: node.readyState,
      videoWidth: node.videoWidth,
      videoHeight: node.videoHeight,
      duration: node.duration,
      played,
      currentTimeAdvanced: advancedBy > 0.05,
      advancedBy,
      seekMiddleOk,
      seekNearEndOk,
      mediaError: node.error ? `code ${node.error.code}: ${node.error.message}` : null,
    };
  });
}

function checkPlayback(result: PlaybackResult, label: string) {
  expect(result.mediaError, `${label}: media element error`).toBeNull();
  expect(result.readyState, `${label}: readyState`).toBeGreaterThanOrEqual(2);
  expect(result.videoWidth, `${label}: videoWidth`).toBeGreaterThan(0);
  expect(result.videoHeight, `${label}: videoHeight`).toBeGreaterThan(0);
  expect(Number.isFinite(result.duration), `${label}: finite duration`).toBeTruthy();
  expect(result.duration, `${label}: duration`).toBeGreaterThan(0);
  expect(result.played, `${label}: play() reached a playing state`).toBeTruthy();
  expect(result.currentTimeAdvanced, `${label}: currentTime advanced (${result.advancedBy.toFixed(3)}s)`).toBeTruthy();
  expect(result.seekMiddleOk, `${label}: seek to middle`).toBeTruthy();
  expect(result.seekNearEndOk, `${label}: seek near end`).toBeTruthy();
}

/** Capture playback stills at three positions using the live video element. */
async function capturePlaybackStills(page: Page, outputDir: string, prefix: string) {
  const player = page.locator(".viewer-frame video");
  const duration = await player.evaluate((node: HTMLVideoElement) => node.duration);
  const points: { name: string; at: number }[] = [
    { name: "early", at: Math.min(0.5, duration * 0.08) },
    { name: "midpoint", at: duration / 2 },
    { name: "near-end", at: Math.max(0, duration - 0.4) },
  ];
  for (const point of points) {
    await player.evaluate((node: HTMLVideoElement, target) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 8_000);
      node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.currentTime = target;
    }), point.at);
    await page.waitForTimeout(250);
    await page.locator(".viewer-stage").screenshot({ path: path.join(outputDir, `${prefix}-${point.name}.png`) });
  }
}

async function downloadTile(page: Page, tile: Locator, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    tile.locator('a[download]').click(),
  ]);
  await download.saveAs(target);
  const bytes = await fs.readFile(target);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

/**
 * Extract a ZIP with the engine image's unzip, so the host needs no archive
 * tooling. Returns the media files the archive contains.
 */
async function extractZip(zipPath: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const mount = path.dirname(path.dirname(zipPath));
  const rel = (target: string) => `/work/${path.relative(mount, target)}`;
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", ["run", "--rm", "--network", "none", "--entrypoint", "unzip",
      "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-e", "HOME=/tmp",
      "-v", `${mount}:/work`, process.env.S6_FORENSICS_IMAGE || "s6-cut-engine",
      "-o", rel(zipPath), "-d", rel(destination)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`unzip failed: ${stderr.slice(-300)}`))));
  });
  const entries = await fs.readdir(destination, { recursive: true }) as string[];
  return entries.map((entry) => path.join(destination, entry));
}

/** Read clip boundaries from the job record; the workspace does not show them. */
async function jobBoundaries(projectName: string) {
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json();
  const project = projects.find((item: { name: string }) => item.name === projectName);
  if (!project) throw new Error(`project ${projectName} not found in the engine record`);
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json();
  const job = jobs.find((item: { projectId: string }) => item.projectId === project.id);
  if (!job) throw new Error(`job for ${projectName} not found`);
  return { project, job };
}

async function openProjects(page: Page) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Make the first cut" })).toBeVisible({ timeout: 30_000 });
}

/** Create a clip project entirely through visible controls. */
async function createClipProject(page: Page, options: {
  name: string; count: number; mode: "Fast" | "Smart" | "Auto";
  aspect: string; min: number; max: number; captions: boolean;
}) {
  await openProjects(page);
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(fixture);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(options.name);

  const countValue = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) > options.count; guard += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) < options.count; guard += 1) {
    await page.getByRole("button", { name: "More clips", exact: true }).click();
  }
  await expect(countValue).toHaveText(String(options.count));

  await page.getByRole("button", { name: options.mode, exact: true }).click();

  const subtitles = page.locator(".subtitle-toggle input");
  if ((await subtitles.isChecked()) !== options.captions) await subtitles.setChecked(options.captions);
  expect(await subtitles.isChecked()).toBe(options.captions);

  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption(options.aspect);
  await page.getByLabel("Minimum seconds").fill(String(options.min));
  await page.getByLabel("Maximum seconds").fill(String(options.max));

  await page.getByRole("button", { name: new RegExp(`^Create ${options.count} short clips?$`) }).click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible({ timeout: 60_000 });
}

/** Collect everything the workspace shows about each finished clip. */
async function collectClips(page: Page, projectName: string, outputDir: string): Promise<ClipRecord[]> {
  const { job } = await jobBoundaries(projectName);
  const tiles = page.locator(".clip-tile.complete");
  const total = await tiles.count();
  const records: ClipRecord[] = [];
  for (let index = 0; index < total; index += 1) {
    const tile = tiles.nth(index);
    const number = Number((await tile.locator(".clip-number").textContent())?.trim());
    const engineClip = job.clips.find((clip: { index: number }) => clip.index === number);
    if (!engineClip) throw new Error(`no engine record for visible clip ${number}`);

    const metaText = (await tile.locator(".clip-meta").textContent())?.trim() || "";
    const savedToLibrary = await tile.locator(".saved-badge").count() > 0;
    await expect(tile.locator('a[download]')).toBeVisible();

    await tile.getByRole("button", { name: /Preview/ }).click();
    const playback = await assertPlayback(page);
    checkPlayback(playback, `clip ${number}`);
    await capturePlaybackStills(page, outputDir, `clip-${number}`);

    const downloadPath = path.join(outputDir, `clip-${number}.mp4`);
    const { sha256, sizeBytes } = await downloadTile(page, tile, downloadPath);

    records.push({
      index: number,
      id: engineClip.id,
      title: (await tile.locator(".clip-title").textContent())?.trim() || "",
      metaText,
      reportedDuration: engineClip.duration,
      reportedWidth: engineClip.width ?? null,
      reportedHeight: engineClip.height ?? null,
      sourceStart: engineClip.start,
      sourceEnd: engineClip.end,
      savedToLibrary,
      libraryAssetId: engineClip.libraryAssetId ?? null,
      downloadPath,
      sha256,
      sizeBytes,
      playback,
    });
  }
  return records;
}

async function writeManifest(name: string, payload: unknown) {
  await fs.mkdir(path.join(artifacts, "reports"), { recursive: true });
  await fs.writeFile(path.join(artifacts, "reports", `${name}.json`), JSON.stringify(payload, null, 2));
}

test.describe.configure({ mode: "serial" });

test.describe("S6_cut generates real playable video", () => {
  test("Smart mode renders multiple clips from the uploaded source", async ({ page }) => {
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "smart");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Smart authenticity ${Date.now()}`;
    const observed = new Set<string>();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("All local tools ready")).toBeVisible({ timeout: 90_000 });

    await createClipProject(page, { name: projectName, count: 2, mode: "Smart", aspect: "9:16", min: 8, max: 20, captions: true });
    await waitForProjectReady(page, observed);

    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);

    // The engine's own progress reporting must show the real pipeline stages.
    for (const label of ["Source received", "Video validated", "Audio prepared", "Speech transcribed",
      "Complete moments selected", "Clip boundaries verified", "Clips rendered and saved",
      "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }
    expect([...observed], "planning stage observed").toEqual(
      expect.arrayContaining([expect.stringMatching(/^(OpenRouter planning|Local planning fallback):/)]),
    );

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "at least one clip completed").toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.reportedDuration, `clip ${clip.index} duration`).toBeGreaterThan(0);
      expect(clip.metaText, `clip ${clip.index} shows dimensions`).toMatch(/\d+\s*×\s*\d+ px/);
      expect(clip.savedToLibrary, `clip ${clip.index} saved to Library`).toBeTruthy();
      expect(clip.sizeBytes, `clip ${clip.index} size`).toBeGreaterThan(50_000);
    }
    if (clips.length > 1) {
      const ranges = clips.map((clip) => `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`);
      expect(new Set(ranges).size, "clips use different source ranges").toBe(clips.length);
      expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    }

    // Playback must survive switching between clips.
    if (clips.length > 1) {
      const tiles = page.locator(".clip-tile.complete");
      await tiles.nth(0).getByRole("button", { name: /Preview/ }).click();
      checkPlayback(await assertPlayback(page), "clip switch back to first");
    }

    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    // --- Persistence across a full reload -----------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.locator(".project-card").filter({ hasText: projectName }).first().click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" })).toHaveClass(/status-complete/);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    // --- The generated clips exist in the Library ---------------------------
    // The isolated dataset is shared with the other workflows in this file, so
    // assertions are scoped to the assets this project published rather than to
    // the Library total.
    const listGenerated = async () => (await (await fetch(`${gateway}/api/v1/library/assets?origin=generated-clip`)).json()) as
      { id: string; title: string; blobId: string }[];

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });

    const publishedIds = clips.map((clip) => clip.libraryAssetId).filter(Boolean) as string[];
    expect(publishedIds.length, "every completed clip records a Library asset").toBe(clips.length);
    const generatedBefore = await listGenerated();
    const idsBefore = generatedBefore.map((asset) => asset.id).sort();
    for (const id of publishedIds) {
      expect(idsBefore, `clip asset ${id} is in the Library`).toContain(id);
    }
    // Each of this project's assets must be visible as its own card.
    for (const asset of generatedBefore.filter((item) => publishedIds.includes(item.id))) {
      await expect(page.locator(".asset-card").filter({ hasText: asset.title }).first()).toBeVisible();
    }

    // A reload must not republish the same outputs as new assets.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });
    const generated = await listGenerated();
    const assetIdsAfterReload = generated.map((asset) => asset.id).sort();
    expect(assetIdsAfterReload, "reload created no duplicate Library assets").toEqual(idsBefore);

    // Every generated asset must be a distinct blob from the uploaded source.
    const sources = await (await fetch(`${gateway}/api/v1/library/assets?origin=project-source`)).json();
    const sourceBlobIds = new Set(sources.map((asset: { blobId: string }) => asset.blobId));
    for (const asset of generated) {
      expect(sourceBlobIds.has(asset.blobId), `generated asset ${asset.id} is not the uploaded source blob`).toBeFalsy();
    }

    // Preview one of *this* project's generated assets, not whatever is first.
    const mine = generated.find((asset) => asset.id === publishedIds[0]);
    expect(mine, "this project's asset is listed").toBeTruthy();
    const firstAsset = page.locator(".asset-card").filter({ hasText: mine!.title }).first();
    await firstAsset.locator(".asset-preview-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const libraryPlayback = await dialog.locator("video").evaluate(async (node: HTMLVideoElement) => {
      node.muted = true;
      if (node.readyState < 2) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("library preview never loaded")), 30_000);
          node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
          node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("library preview error")); }, { once: true });
        });
      }
      return { readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, duration: node.duration, src: node.currentSrc };
    });
    expect(libraryPlayback.readyState).toBeGreaterThanOrEqual(2);
    expect(libraryPlayback.width).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(outputDir, "library-generated-assets.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Close video preview" }).click();

    await writeManifest("smart", {
      mode: "smart", projectName, requestedCount: 2, actualCount: clips.length,
      observedStages: [...observed].sort(), clips, libraryPlayback,
      libraryAssetCount: generated.length,
      libraryAssetIds: assetIdsAfterReload,
      assetIdsBeforeReload: idsBefore,
      publishedIds,
    });
  });

  test("Fast mode renders without any provider or transcription dependency", async ({ page }) => {
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "fast");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Fast authenticity ${Date.now()}`;
    const observed = new Set<string>();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("All local tools ready")).toBeVisible({ timeout: 90_000 });

    await createClipProject(page, { name: projectName, count: 2, mode: "Fast", aspect: "9:16", min: 8, max: 20, captions: false });
    await waitForProjectReady(page, observed);

    await expect(page.locator(".failure-strip")).toHaveCount(0);
    // Fast mode must not run the Smart-only stages at all.
    for (const absent of ["Speech transcribed", "OpenRouter planning", "Complete moments selected"]) {
      expect([...observed].some((entry) => entry.startsWith(`${absent}:`)), `fast mode skips ${absent}`).toBeFalsy();
    }
    for (const label of ["Source received", "Video validated", "Cut points planned",
      "Clips rendered and saved", "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length).toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.reportedDuration).toBeGreaterThan(0);
      expect(clip.metaText).toMatch(/\d+\s*×\s*\d+ px/);
      expect(clip.sizeBytes).toBeGreaterThan(50_000);
    }
    if (clips.length > 1) {
      expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    }
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.locator(".project-card").filter({ hasText: projectName }).first().click();
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "fast after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifest("fast", {
      mode: "fast", projectName, requestedCount: 2, actualCount: clips.length,
      observedStages: [...observed].sort(), clips,
    });
  });

  /**
   * Runs only in the isolated stack the harness starts with the provider
   * failure seam enabled. It complements the committed
   * openrouter-fallback.spec.ts by putting the *rendered output* of a real
   * provider failure through the same content forensics as every other mode.
   */
  test("Smart mode keeps rendering real video when OpenRouter fails", async ({ page }) => {
    test.skip(!process.env.S6_TEST_OPENROUTER_FAILURE, "provider failure seam is not enabled in this stack");
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "fallback");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Fallback authenticity ${Date.now()}`;
    const observed = new Set<string>();

    // Seed the connected profile through the gateway API so no key value is
    // ever typed into a field Playwright's trace could record. The browser
    // still confirms the connected profile in Settings before any job.
    const profileKey = process.env.S6_E2E_PROFILE_KEY;
    if (!profileKey) throw new Error("the harness did not provide a profile key");
    const created = await fetch(`${gateway}/api/v1/profiles`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Authenticity OpenRouter failure", modelId: "openai/gpt-4.1-mini", openrouterKey: profileKey, persistence: "encrypted", selected: true }),
    });
    expect(created.ok).toBeTruthy();
    const profile = await created.json();
    expect((await fetch(`${gateway}/api/v1/profiles/${profile.id}/test`, { method: "POST" })).ok).toBeTruthy();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("All local tools ready")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: "Authenticity OpenRouter failure" }).first())
      .toContainText(/Connected/, { timeout: 30_000 });

    await createClipProject(page, { name: projectName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 20, captions: true });
    await waitForProjectReady(page, observed);

    // The provider really failed, and the engine really continued locally.
    const notes = page.getByRole("region", { name: "Processing notes" });
    await expect(notes.getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1, { timeout: 30_000 });
    await expect(notes.getByText(/Continuing with deterministic local planning/i)).toBeVisible();
    await expect(page.locator(".process-checklist li").filter({ hasText: "OpenRouter planning" })).toHaveClass(/status-failed/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Local planning fallback" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Clips rendered and saved" })).toHaveClass(/status-complete/);
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);
    expect([...observed]).toContain("OpenRouter planning:failed");
    expect([...observed]).toContain("Local planning fallback:complete");

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "a real video completed despite the provider failure").toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.locator(".project-card").filter({ hasText: projectName }).first().click();
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Processing notes" }).getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "fallback after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifest("fallback", {
      mode: "fallback", projectName, requestedCount: 1, actualCount: clips.length,
      observedStages: [...observed].sort(), clips,
    });
  });

  test("Script mode renders a video from pasted text with local narration", async ({ page }) => {
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "script");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Script authenticity ${Date.now()}`;
    const observed = new Set<string>();
    const script = "A copper kettle warms slowly on the workshop bench. "
      + "The deterministic planner divides this narration into short visual beats. "
      + "Every rendered frame is produced on this machine without any hosted service. "
      + "Local narration keeps the whole pipeline offline and repeatable.";

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("All local tools ready")).toBeVisible({ timeout: 90_000 });
    await openProjects(page);

    await page.getByRole("button", { name: /Script mode/ }).click();
    await page.locator(".script-input-wrap textarea").fill(script);
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("Narration source").selectOption("local");
    await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
    await page.getByLabel("Aspect").selectOption("9:16");
    await page.getByRole("button", { name: "Create script video", exact: true }).click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });

    await waitForProjectReady(page, observed, "script");
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    for (const label of ["Script validated", "Words aligned", "Visual beats planned",
      "Video rendered and saved", "Output verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }
    // Local narration was requested, so the local voice must be what ran.
    expect([...observed], "local narration produced the voice track").toEqual(
      expect.arrayContaining([expect.stringMatching(/^Local narration fallback:(complete|skipped)/)]),
    );

    // The storyboard must carry beats derived from the pasted script.
    const beatTiles = page.locator(".beat-tile");
    const beats = await beatTiles.count();
    expect(beats, "storyboard beats were planned").toBeGreaterThan(0);
    const beatText = (await beatTiles.allTextContents()).join(" ").toLowerCase();
    const scriptWords = ["kettle", "planner", "beats", "machine", "narration"];
    const matched = scriptWords.filter((word) => beatText.includes(word));
    expect(matched.length, `beats reflect the pasted script (matched ${matched.join(",")})`).toBeGreaterThanOrEqual(2);

    // Script mode renders one video, auto-selected in the viewer.
    const playback = await assertPlayback(page);
    checkPlayback(playback, "script output");
    await capturePlaybackStills(page, outputDir, "script-output");
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    // The only workspace download control for a Script project is Download ZIP.
    const zipPath = path.join(outputDir, "script-export.zip");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 180_000 }),
      page.getByRole("button", { name: /Download ZIP/ }).click(),
    ]);
    await download.saveAs(zipPath);
    const extracted = await extractZip(zipPath, path.join(outputDir, "export"));
    const media = extracted.filter((entry) => entry.toLowerCase().endsWith(".mp4"));
    expect(media.length, "the export ZIP contains rendered media").toBeGreaterThanOrEqual(1);
    // Sidecars are recorded, not asserted: commit 2af8f9c deliberately reduced
    // the archive to video only ("clean video ZIP exports"), while
    // ARCHITECTURE.md, README.md, IMPLEMENTATION_STATUS.md and
    // DO-NOT-CHANGE/AGENTS.md still describe manifest.json and credits.json.
    // That drift is reported by the run rather than enforced here.
    const sidecars = extracted.filter((entry) => /manifest\.json|credits\.json|warnings\.txt/.test(entry))
      .map((entry) => path.basename(entry));

    const { job } = await jobBoundaries(projectName);
    const engineClip = job.clips.find((clip: { state: string }) => clip.state === "complete");
    const bytes = await fs.readFile(media[0]);
    const clips = [{
      index: 1,
      id: engineClip.id,
      title: engineClip.title || "",
      metaText: "",
      reportedDuration: engineClip.duration,
      reportedWidth: engineClip.width ?? null,
      reportedHeight: engineClip.height ?? null,
      sourceStart: engineClip.start,
      sourceEnd: engineClip.end,
      savedToLibrary: Boolean(engineClip.libraryAssetId),
      libraryAssetId: engineClip.libraryAssetId ?? null,
      downloadPath: media[0],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      playback,
    }];
    expect(clips[0].savedToLibrary, "script output is saved to the Library").toBeTruthy();

    // Persistence across reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.locator(".project-card").filter({ hasText: projectName }).first().click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".beat-tile")).toHaveCount(beats, { timeout: 60_000 });
    checkPlayback(await assertPlayback(page), "script after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    const narrationNotes = await page.locator(".notice-panel").allTextContents();
    await writeManifest("script", {
      mode: "script", projectName, script, requestedCount: 1, actualCount: clips.length,
      observedStages: [...observed].sort(), beats, beatText, clips, narrationNotes,
      exportEntries: extracted.map((entry) => path.basename(entry)),
      exportSidecars: sidecars,
    });
  });
});
