import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertPlayback,
  checkPlayback,
  collectClips,
  assertZipIntact,
  createClipProject,
  jobBoundaries,
  waitForProjectReady,
  zipEntry,
  zipNames,
} from "./support/workspace";

const enabled = process.env.S6_RUN_LIVE_SMART_SPEECH === "1";
const isolated = process.env.S6_ACCEPTANCE_ISOLATED === "1";
const sourceUrl = process.env.S6_SMART_SPEECH_SOURCE_URL || "https://www.youtube.com/watch?v=JnfBXjWm7hc";
const dataRoot = path.resolve(process.env.S6_DATA_PATH || "data");

test("real YouTube Speech / Smart render uses the durable presentation and playable media", async ({ page }, testInfo) => {
  test.skip(!enabled, "Set S6_RUN_LIVE_SMART_SPEECH=1 for a live isolated YouTube + local Whisper run");
  test.skip(testInfo.project.name !== "Desktop Chromium", "one destructive live job per disposable stack");
  test.setTimeout(20 * 60_000);
  expect(isolated, "live project creation is allowed only on a disposable isolated stack").toBe(true);

  const projectName = `Smart speech media ${Date.now()}`;
  const errors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    const expectedHttpCoopNotice = text.includes("Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy");
    if (message.type() === "error" && !expectedHttpCoopNotice) errors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "failed";
    // Download navigation reports ERR_ABORTED after Chromium hands the file to
    // the download manager; the export has already been saved and verified.
    if (!failure.includes("ERR_ABORTED")) errors.push(`request: ${request.method()} ${request.url()} ${failure}`);
  });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`response: ${response.status()} ${response.url()}`); });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: testInfo.outputPath("smart-speech-projects-before-create.png"), fullPage: true });
  await createClipProject(page, {
    name: projectName, count: 1, mode: "Smart", aspect: "9:16", style: "Educational",
    min: 12, max: 25, captions: true, source: { kind: "url", url: sourceUrl },
  });
  await page.screenshot({ path: testInfo.outputPath("smart-speech-job-created.png"), fullPage: true });
  await waitForProjectReady(page, new Set(), 19 * 60_000);
  await page.screenshot({ path: testInfo.outputPath("smart-speech-workspace-ready.png"), fullPage: true });

  const { project, job } = await jobBoundaries(projectName);
  await expect(page.locator(".workspace-source-meta")).toHaveText(project.sourceTitle);
  expect(job.processingMode).toBe("smart");
  expect(job.contentFormat).toBe("short");
  expect(job.sourceProfile).toBe("speech");
  expect(job.burnSubtitles).toBe(true);
  expect(project.sourceKind).toBe("youtube");
  expect(project.sourceTitle).toBeTruthy();
  expect(project.sourceCreator).toBeTruthy();
  expect(job.clips).toHaveLength(1);
  expect(job.clips[0].creatorCredit).toMatch(/^Source: /);

  const clips = await collectClips(page, projectName, testInfo.outputPath("downloaded"));
  expect(clips).toHaveLength(1);
  checkPlayback(clips[0].playback, "Smart speech YouTube clip");
  const playback = await assertPlayback(page);
  checkPlayback(playback, "Smart speech workspace preview");
  const player = page.locator(".viewer-frame video");
  await player.evaluate((node: HTMLVideoElement) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    node.currentTime = Math.min(1.25, node.duration / 2);
  }));
  await page.locator(".viewer-stage").screenshot({ path: testInfo.outputPath("smart-speech-preview-playing.png") });

  const sourceValidation = job.steps.find((step: { id: string }) => step.id === "probe")?.detail || "";
  const sourceDurationSeconds = Number(/([\d.]+)s/.exec(sourceValidation)?.[1]);
  expect(sourceDurationSeconds).toBeGreaterThan(0);
  const included = page.locator(".clip-tile.complete input[type=checkbox]").first();
  if (!(await included.isChecked())) await included.check();
  const [zipDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.getByRole("button", { name: /Download ZIP/ }).click(),
  ]);
  const zipPath = testInfo.outputPath("smart-speech-selected.zip");
  await zipDownload.saveAs(zipPath);
  assertZipIntact(zipPath);
  const zipEntries = zipNames(zipPath);
  expect(zipEntries.filter((entry) => entry.toLowerCase().endsWith(".mp4"))).toHaveLength(1);
  const creditsPath = zipEntries.find((entry) => entry.endsWith("credits.json"));
  expect(creditsPath).toBeTruthy();
  expect(zipEntry(zipPath, creditsPath!)).toContain(job.clips[0].creatorCredit);
  expect(zipEntries.some((entry) => /\.ass$|\.srt$|\.vtt$/i.test(entry))).toBe(false);

  const assetId = job.clips[0].libraryAssetId;
  expect(assetId).toBeTruthy();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const assetCard = page.locator(`.asset-card[data-asset-id="${assetId}"]`);
  await expect(assetCard).toBeVisible({ timeout: 30_000 });
  await assetCard.getByRole("button", { name: /^Preview / }).click();
  const libraryVideo = page.getByRole("dialog").locator("video");
  await expect(libraryVideo).toBeVisible();
  await expect.poll(() => libraryVideo.evaluate((video: HTMLVideoElement) => video.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const libraryPlayback = await libraryVideo.evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    const before = video.currentTime;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 800));
    video.pause();
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, advancedBy: video.currentTime - before, error: video.error?.code || null };
  });
  expect(libraryPlayback).toMatchObject({ width: 1080, height: 1920, error: null });
  expect(libraryPlayback.advancedBy).toBeGreaterThan(0.05);
  await page.getByRole("dialog").screenshot({ path: testInfo.outputPath("smart-speech-library-preview.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Shorts Editor", exact: true }).click();
  await page.getByRole("tab", { name: "Library" }).click();
  const sourcePicker = page.locator("#shorts-source");
  await expect(sourcePicker).toBeEnabled();
  await sourcePicker.selectOption(assetId);
  const editorVideo = page.locator(".shorts-video-frame video");
  await expect(editorVideo).toBeVisible();
  await expect.poll(() => editorVideo.evaluate((video: HTMLVideoElement) => video.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const editorPlayback = await editorVideo.evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    const before = video.currentTime;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 800));
    video.pause();
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, advancedBy: video.currentTime - before, error: video.error?.code || null };
  });
  expect(editorPlayback).toMatchObject({ width: 1080, height: 1920, error: null });
  expect(editorPlayback.advancedBy).toBeGreaterThan(0.05);
  await page.locator(".video-editing-stage").screenshot({ path: testInfo.outputPath("smart-speech-shorts-editor-preview.png") });

  const clipDirectory = path.join(dataRoot, "jobs", job.id, "clips");
  const outputAss = path.join(clipDirectory, `${path.parse(job.clips[0].outputName).name}.burn.ass`);
  const renderedAss = await fs.readFile(outputAss, "utf8");
  expect(renderedAss).toContain("Style: Caption,Montserrat ExtraBold,");
  expect(renderedAss.match(/^Dialogue: 10,/gm)?.length || 0).toBeGreaterThan(0);
  expect(renderedAss).toContain("Dialogue: 2,0,");
  expect(renderedAss).not.toMatch(/Dialogue: 2,0,[^\n]*Source:/);
  expect(renderedAss).toMatch(/\\pos\(540,1037\)/);
  await fs.copyFile(outputAss, testInfo.outputPath("smart-speech-burn.ass"));
  await fs.copyFile(clips[0].downloadPath, testInfo.outputPath("smart-speech-output.mp4"));
  await testInfo.attach("live-source-attribution", {
    body: Buffer.from(JSON.stringify({
      sourceUrl, sourceTitle: project.sourceTitle, creator: project.sourceCreator,
      sourceDurationSeconds, clipDuration: job.clips[0].duration, creatorCredit: job.clips[0].creatorCredit,
      output: job.clips[0].outputName, playback,
    }, null, 2)),
    contentType: "application/json",
  });
  expect(errors, errors.join("\n")).toEqual([]);
});
