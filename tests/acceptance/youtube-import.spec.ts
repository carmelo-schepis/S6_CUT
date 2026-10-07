/**
 * YouTube import acceptance: proves S6_cut imports an authorised public
 * YouTube URL through the visible workflow and renders real, playable Shorts
 * from it.
 *
 * Nothing here bypasses authentication, age or geographic restrictions, rate
 * limits, bot protection, or signatures — the application's own constrained
 * yt-dlp integration performs the import. No cookies, signed CDN URLs, or
 * request headers are recorded.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPlayback, checkPlayback, collectClips,
  createClipProject, gateway, openWorkspaceForProject, waitForProjectReady,
  writeManifest as writeManifestTo,
} from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "test-artifacts/youtube-import");
const writeManifest = (name: string, payload: unknown) => writeManifestTo(artifacts, name, payload);

const url = process.env.S6_YOUTUBE_URL;
test.skip(!url, "requires S6_YOUTUBE_URL with an authorised public YouTube URL");
const videoId = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(url);
const expectedId = videoId?.[1] || videoId?.[2] || "";

// A 22-minute source has to be downloaded, probed, transcribed locally, planned
// and rendered. The deadline is generous but bounded, and the wait reports the
// engine's own progress rather than sleeping.
const IMPORT_DEADLINE_MS = 25 * 60_000;

// Smart mode transcribes the whole source locally, so a long video needs real
// RAM in the engine container. On a memory-constrained host the browser is the
// other large consumer; S6_LOW_MEMORY_BROWSER trims it so the engine keeps more
// headroom. It changes nothing about the application under test or any
// assertion — only how much memory Chromium reserves alongside it.
if (process.env.S6_LOW_MEMORY_BROWSER) {
  test.use({
    launchOptions: {
      args: ["--disable-dev-shm-usage", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256"],
    },
  });
}

/** Engine-reported import progress, used to prove the download really ran. */
async function importProgress(projectName: string) {
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json();
  const project = projects.find((item: { name: string }) => item.name === projectName);
  if (!project) return null;
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json();
  const job = jobs.find((item: { projectId: string }) => item.projectId === project.id);
  return job ? { project, job, download: job.downloadProgress ?? null } : null;
}

/** Watch the import stage until bytes actually arrive, recording what it reported. */
async function observeImport(page: Page, projectName: string, seen: Record<string, unknown>[]) {
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  let sawBytes = false;
  while (Date.now() < deadline) {
    const state = await importProgress(projectName);
    if (state?.download) {
      const { phase, downloadedBytes, totalBytes, percent } = state.download;
      const last = seen.at(-1);
      if (!last || last.phase !== phase || last.downloadedBytes !== downloadedBytes) {
        seen.push({ phase, downloadedBytes, totalBytes, percent, at: new Date().toISOString() });
      }
      if (typeof downloadedBytes === "number" && downloadedBytes > 0) sawBytes = true;
    }
    // The import step is complete once the engine moves past source acquisition.
    const sourceDone = await page.locator(".process-checklist li").filter({ hasText: "Source received" })
      .evaluateAll((rows) => rows.some((row) => /status-complete/.test(row.className)));
    if (sourceDone) return { sawBytes, complete: true };
    const failed = await page.getByText("Project failed", { exact: true }).count();
    if (failed) return { sawBytes, complete: false };
    await page.waitForTimeout(2_000);
  }
  return { sawBytes, complete: false };
}

test.describe.configure({ mode: "serial" });

test.describe("S6_cut imports an authorised YouTube URL", () => {
  test("Smart mode renders Shorts from the YouTube source", async ({ page }) => {
    test.setTimeout(IMPORT_DEADLINE_MS + 20 * 60_000);
    const outputDir = path.join(artifacts, "smart");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `YouTube smart ${Date.now()}`;
    const observed = new Set<string>();
    const downloadSamples: Record<string, unknown>[] = [];
    const startedAt = Date.now();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    // The URL workflow needs the engine's yt-dlp to be reported available.
    await expect(page.locator(".engine-chips")).toBeVisible();

    await createClipProject(page, {
      name: projectName, count: 2, mode: "Smart", aspect: "9:16", style: "Educational",
      min: 15, max: 45, captions: true, source: { kind: "url", url: url! },
    });

    // Exactly one project and one job may be created from one intent.
    const created = await importProgress(projectName);
    expect(created, "the project was created").toBeTruthy();
    const allProjects = await (await fetch(`${gateway}/api/v1/projects`)).json();
    expect(allProjects.filter((item: { name: string }) => item.name === projectName).length,
      "exactly one project created").toBe(1);
    const allJobs = await (await fetch(`${gateway}/api/v1/jobs`)).json();
    expect(allJobs.filter((item: { projectId: string }) => item.projectId === created!.project.id).length,
      "exactly one job created").toBe(1);
    expect(created!.project.sourceKind, "project records a YouTube source").toBe("youtube");

    const importResult = await observeImport(page, projectName, downloadSamples);
    const importSeconds = (Date.now() - startedAt) / 1000;
    await writeManifest("import-progress", { projectName, videoId: expectedId, importSeconds, samples: downloadSamples, importResult });
    expect(importResult.complete, "YouTube import completed").toBeTruthy();
    expect(importResult.sawBytes, "the engine reported real downloaded bytes").toBeTruthy();

    await waitForProjectReady(page, observed, IMPORT_DEADLINE_MS);
    const processingSeconds = (Date.now() - startedAt) / 1000;

    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);

    for (const label of ["Source received", "Video validated", "Audio prepared", "Speech transcribed",
      "Complete moments selected", "Clip boundaries verified", "Clips rendered and saved",
      "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "at least one clip rendered").toBeGreaterThanOrEqual(1);
    // A 22-minute talk carries far more than two usable spoken moments, so the
    // requested count is the expectation, not a lower bound.
    expect(clips.length, "the requested number of clips was produced").toBe(2);
    for (const clip of clips) {
      expect(clip.reportedDuration).toBeGreaterThan(0);
      expect(clip.metaText).toMatch(/\d+\s*×\s*\d+ px/);
      expect(clip.savedToLibrary, `clip ${clip.index} saved to Library`).toBeTruthy();
      expect(clip.sizeBytes).toBeGreaterThan(50_000);
    }
    if (clips.length > 1) {
      const ranges = clips.map((clip) => `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`);
      expect(new Set(ranges).size, "clips use distinct source ranges").toBe(clips.length);
      expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    }
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    // --- Persistence -------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "youtube smart after reload");
    // The download action must still work after a reload.
    const href = await page.locator(".clip-tile.complete").first().locator("a[download]").getAttribute("href");
    const reDownload = await page.request.get(href || "");
    expect(reDownload.ok(), "download link still works after reload").toBeTruthy();
    expect(reDownload.headers()["content-type"] || "").toMatch(/^video\//);
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    // --- Library -----------------------------------------------------------
    const listGenerated = async () => (await (await fetch(`${gateway}/api/v1/library/assets?origin=generated-clip`)).json()) as
      { id: string; title: string; blobId: string }[];
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });
    const publishedIds = clips.map((clip) => clip.libraryAssetId).filter(Boolean) as string[];
    const before = (await listGenerated()).map((asset) => asset.id).sort();
    for (const id of publishedIds) expect(before, `asset ${id} present exactly once`).toContain(id);
    expect(new Set(before).size, "no duplicate asset ids").toBe(before.length);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });
    const generated = await listGenerated();
    expect(generated.map((asset) => asset.id).sort(), "reload created no duplicates").toEqual(before);

    // The generated output must never be the imported source blob itself.
    const sources = await (await fetch(`${gateway}/api/v1/library/assets?origin=project-source`)).json();
    const sourceBlobIds = new Set(sources.map((asset: { blobId: string }) => asset.blobId));
    for (const asset of generated) {
      expect(sourceBlobIds.has(asset.blobId), `generated asset ${asset.id} is not the imported source`).toBeFalsy();
    }
    const mine = generated.find((asset) => asset.id === publishedIds[0]);
    expect(mine, "this project's asset is listed").toBeTruthy();
    await page.locator(".asset-card").filter({ hasText: mine!.title }).first().locator(".asset-preview-trigger").click();
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
      return { readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, duration: node.duration };
    });
    expect(libraryPlayback.readyState).toBeGreaterThanOrEqual(2);
    expect(libraryPlayback.width).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close video preview" }).click();
    await page.screenshot({ path: path.join(outputDir, "library-generated-assets.png"), fullPage: true });

    await writeManifest("smart", {
      mode: "smart", projectName, videoId: expectedId, requestedCount: 2, actualCount: clips.length,
      importSeconds, processingSeconds, observedStages: [...observed].sort(), clips,
      libraryAssetIds: before, publishedIds, libraryPlayback,
      sourceProjectAssets: sources.map((asset: { id: string; title: string; blobId: string }) => ({ id: asset.id, title: asset.title, blobId: asset.blobId })),
    });
  });

  test("Fast mode renders from the YouTube source without any provider", async ({ page }) => {
    test.setTimeout(IMPORT_DEADLINE_MS + 20 * 60_000);
    const outputDir = path.join(artifacts, "fast");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `YouTube fast ${Date.now()}`;
    const observed = new Set<string>();
    const downloadSamples: Record<string, unknown>[] = [];
    const startedAt = Date.now();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

    await createClipProject(page, {
      name: projectName, count: 2, mode: "Fast", aspect: "9:16",
      min: 15, max: 45, captions: false, source: { kind: "url", url: url! },
    });
    const importResult = await observeImport(page, projectName, downloadSamples);
    expect(importResult.complete, "YouTube import completed").toBeTruthy();

    await waitForProjectReady(page, observed, IMPORT_DEADLINE_MS);
    const processingSeconds = (Date.now() - startedAt) / 1000;
    await expect(page.locator(".failure-strip")).toHaveCount(0);

    // Fast mode must not depend on transcription or a provider.
    for (const absent of ["Speech transcribed", "OpenRouter planning", "Complete moments selected"]) {
      expect([...observed].some((entry) => entry.startsWith(`${absent}:`)), `fast mode skips ${absent}`).toBeFalsy();
    }
    for (const label of ["Source received", "Video validated", "Cut points planned",
      "Clips rendered and saved", "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "the requested number of clips was produced").toBe(2);
    expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    expect(new Set(clips.map((clip) => `${clip.sourceStart}-${clip.sourceEnd}`)).size,
      "clips use distinct source ranges").toBe(clips.length);
    for (const clip of clips) {
      expect(clip.savedToLibrary, `clip ${clip.index} saved to Library`).toBeTruthy();
      expect(clip.sizeBytes).toBeGreaterThan(50_000);
    }
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "youtube fast after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifest("fast", {
      mode: "fast", projectName, videoId: expectedId, requestedCount: 2, actualCount: clips.length,
      processingSeconds, observedStages: [...observed].sort(), clips, downloadSamples,
    });
  });

  /**
   * URL handling. These use obviously invalid or nonexistent inputs; nothing
   * here attempts to reach restricted, private, or age-gated material.
   */
  test("rejects malformed and unsupported URLs with understandable errors", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const outputDir = path.join(artifacts, "errors");
    await fs.mkdir(outputDir, { recursive: true });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.getByRole("tab", { name: "YouTube" }).click();
    const field = page.locator("#source-youtube-url");
    const create = page.getByRole("button", { name: /^Create \d+ short clips?$/ });

    const rejected: { input: string; message: string }[] = [];
    for (const [label, candidate] of [
      ["malformed", "not a url at all"],
      ["non-YouTube host", "https://vimeo.com/76979871"],
      ["insecure scheme", "http://www.youtube.com/watch?v=FylHa4_neOA"],
    ] as const) {
      await field.fill(candidate);
      await create.click();
      const error = page.locator(".form-error");
      await expect(error, `${label} is rejected`).toBeVisible({ timeout: 15_000 });
      rejected.push({ input: label, message: (await error.textContent())?.trim() || "" });
      // A rejected URL must not create a project or leave a job pending.
      expect(await page.getByRole("heading", { name: "Create a project" }).count(),
        `${label} did not navigate into a project`).toBe(1);
    }
    await page.screenshot({ path: path.join(outputDir, "url-validation.png"), fullPage: true });

    // Accepted forms of the authorised video: canonical, youtu.be, and extra
    // query parameters. These are only checked for client acceptance, not run.
    const accepted: string[] = [];
    for (const candidate of [
      `https://www.youtube.com/watch?v=${expectedId}`,
      `https://youtu.be/${expectedId}`,
      `https://www.youtube.com/watch?v=${expectedId}&t=30s&feature=share`,
    ]) {
      await field.fill(candidate);
      await expect(field).toHaveValue(candidate);
      // The client-side guard must not flag these; the create button stays live.
      await expect(create).toBeEnabled();
      accepted.push(candidate.replace(expectedId, "<id>"));
    }

    // A well-formed URL for a nonexistent video must fail visibly, not hang.
    const missingName = `YouTube missing ${Date.now()}`;
    await page.getByLabel("Project name").fill(missingName);
    await field.fill("https://www.youtube.com/watch?v=AAAAAAAAAAA");
    await create.click();
    await expect(page.getByRole("heading", { name: missingName })).toBeVisible({ timeout: 60_000 });
    const failed = page.locator(".failure-strip");
    await expect(failed, "a nonexistent video fails visibly within the deadline").toBeVisible({ timeout: 6 * 60_000 });
    const failureText = (await failed.textContent())?.trim() || "";
    // The message must be human-readable and must not leak internals.
    expect(failureText).not.toMatch(/\/app\/data|Traceback|https?:\/\/[^ ]*googlevideo/i);
    await page.screenshot({ path: path.join(outputDir, "nonexistent-video.png"), fullPage: true });

    await writeManifest("errors", { rejected, accepted, nonexistentVideo: { project: missingName, failureText } });
  });
});
