/**
 * Independent live acceptance for the requested YouTube Clip-mode contract.
 * These tests create durable projects and therefore only run against the
 * disposable Compose deployment launched by support/run-isolated-youtube.sh.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checkPlayback, collectClips, gateway, jobBoundaries, openProjects, root, waitForProjectReady,
} from "./support/workspace";

const authorizedUrl = process.env.S6_YOUTUBE_URL;
const isolated = process.env.S6_ACCEPTANCE_ISOLATED === "1";
test.skip(!authorizedUrl, "Set S6_YOUTUBE_URL to an authorized public YouTube URL");
test.skip(!isolated, "Run support/run-isolated-youtube.sh; live tests require isolated disposable Compose/data");

test.describe.configure({ mode: "serial" });
test.setTimeout(90 * 60_000);

test.beforeAll(() => {
  if (!authorizedUrl || !isolated) return;
  if (!process.env.S6_ACCEPTANCE_URL || !process.env.S6_ACCEPTANCE_COMPOSE_PROJECT) {
    throw new Error("Isolated run must set S6_ACCEPTANCE_URL and S6_ACCEPTANCE_COMPOSE_PROJECT");
  }
  if (/:(8080|8001)$/.test(new URL(process.env.S6_ACCEPTANCE_URL).host)) {
    throw new Error("Refusing live acceptance on default S6_cut host ports 8080/8001");
  }
});

async function validateVisibleUi(page: import("@playwright/test").Page) {
  await openProjects(page);
  await page.getByRole("tab", { name: "YouTube" }).click();
  const url = page.locator("#source-youtube-url");
  await url.fill("http://youtube.com/watch?v=abcdefghijk");
  await page.getByRole("button", { name: /Create/ }).click();
  await expect(page.getByRole("alert")).toContainText("Only public HTTPS YouTube URLs are supported.");
  await url.fill("https://example.com/watch?v=abcdefghijk");
  await page.getByRole("button", { name: /Create/ }).click();
  await expect(page.getByRole("alert")).toContainText("Only public HTTPS YouTube URLs are supported.");

  await url.fill(authorizedUrl!);
  const serious = page.locator(".style-card").filter({ hasText: "Serious" }).first();
  const hype = page.locator(".style-card").filter({ hasText: "Hype" }).first();
  await serious.click();
  await expect(serious).toHaveAttribute("aria-pressed", "true");
  await expect(hype).toHaveAttribute("aria-pressed", "false");
  await hype.click();
  await expect(hype).toHaveAttribute("aria-pressed", "true");
  await expect(serious).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Advanced controls" }).click();
  await page.getByLabel("Minimum seconds").fill("7");
  await page.getByLabel("Maximum seconds").fill("15");
  await page.getByRole("button", { name: /Create/ }).click();
  await expect(page.getByRole("alert")).toContainText("Minimum seconds must be at least 8.");
  await page.getByLabel("Minimum seconds").fill("15");
  await page.getByLabel("Maximum seconds").fill("15");
  await page.getByRole("button", { name: /Create/ }).click();
  await expect(page.getByRole("alert")).toContainText("Maximum seconds must be greater than minimum seconds.");
}

function engineOutput(args: string[]) {
  const project = process.env.S6_ACCEPTANCE_COMPOSE_PROJECT;
  if (!project) throw new Error("missing isolated Compose project name");
  return execFileSync("docker", ["compose", "--project-name", project, "--file", path.join(root, "compose.yaml"), "exec", "-T", "engine", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

async function inspectDownloadedOutput(jobId: string, outputName: string, downloadPath: string, aspect: "9:16" | "1:1", sourceStart: number) {
  const source = engineOutput(["sh", "-lc", `find /app/data/jobs/${jobId}/source -type f ! -name '*.json' -print -quit`]);
  const output = `/app/data/jobs/${jobId}/clips/${outputName}`;
  const inspect = (file: string) => JSON.parse(engineOutput(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", file])) as {
    format: { duration?: string }; streams: { codec_type: string; width?: number; height?: number; sample_aspect_ratio?: string }[];
  };
  const [sourceProbe, outputProbe] = [inspect(source), inspect(output)];
  const sourceVideo = sourceProbe.streams.find((stream) => stream.codec_type === "video");
  const outputVideo = outputProbe.streams.find((stream) => stream.codec_type === "video");
  expect(sourceVideo?.width).toBeTruthy();
  expect(sourceVideo?.height).toBeTruthy();
  const sourceSar = sourceVideo?.sample_aspect_ratio && sourceVideo.sample_aspect_ratio !== "N/A" ? evalRatio(sourceVideo.sample_aspect_ratio) : 1;
  const sourceDisplayAspect = (sourceVideo!.width! / sourceVideo!.height!) * sourceSar;
  if (aspect === "9:16") expect(Math.abs(sourceDisplayAspect / (16 / 9) - 1)).toBeLessThanOrEqual(0.02);
  const expected = aspect === "9:16" ? [1080, 1920] : [1080, 1080];
  expect([outputVideo?.width, outputVideo?.height]).toEqual(expected);
  const sourceAudio = sourceProbe.streams.some((stream) => stream.codec_type === "audio");
  const outputAudio = outputProbe.streams.some((stream) => stream.codec_type === "audio");
  expect(outputAudio).toBe(sourceAudio);
  await engineOutput(["ffmpeg", "-v", "error", "-i", output, "-f", "null", "-"]);
  const internalHash = engineOutput(["sha256sum", output]).split(/\s+/)[0];
  const downloadHash = execFileSync("sha256sum", [downloadPath], { encoding: "utf8" }).split(/\s+/)[0];
  expect(downloadHash).toBe(internalHash);
  const reportPath = path.join(path.dirname(downloadPath), "media-probe-and-source.json");
  await fs.writeFile(reportPath, JSON.stringify({ sourcePath: source, outputPath: output, sourceProbe, outputProbe, sourceDisplayAspect, sourceAudio, outputAudio, internalHash }, null, 2));
  for (const [label, file, at] of [["source", source, sourceStart + 1], ["output", output, 1]] as const) {
    const png = execFileSync("docker", ["compose", "--project-name", process.env.S6_ACCEPTANCE_COMPOSE_PROJECT!, "--file", path.join(root, "compose.yaml"), "exec", "-T", "engine", "ffmpeg", "-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
    await fs.writeFile(path.join(path.dirname(downloadPath), `${label}-frame.png`), png);
  }
  return { sourceDisplayAspect, sourceAudio, outputAudio, outputProbe, internalHash };
}

function evalRatio(value: string) {
  const [numerator, denominator] = value.split(":").map(Number);
  return Number.isFinite(numerator / denominator) && denominator !== 0 ? numerator / denominator : 1;
}

async function createAndInspect(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo,
  settings: { mode: "Smart" | "Fast" | "Auto"; style: "Serious" | "Hype" | "Funny"; captions: boolean; aspect?: "9:16" | "1:1"; upload?: string }) {
  const name = `S6_ACCEPT_${process.env.S6_ACCEPTANCE_RUN}_${settings.mode}_${settings.style}_${Date.now()}`;
  const outputDir = path.join(testInfo.outputDir, name.replace(/[^a-z0-9-]/gi, "_"));
  await fs.mkdir(outputDir, { recursive: true });
  await openProjects(page);
  if (settings.upload) {
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(settings.upload);
    await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  } else {
    await page.getByRole("tab", { name: "YouTube" }).click();
    await page.locator("#source-youtube-url").fill(authorizedUrl!);
  }
  await page.getByLabel("Project name").fill(name);
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  await page.getByRole("button", { name: settings.mode, exact: true }).click();
  const chosen = page.locator(".style-card").filter({ hasText: settings.style }).first();
  await chosen.click();
  await expect(chosen).toHaveAttribute("aria-pressed", "true");
  const subtitles = page.locator(".subtitle-toggle").filter({ hasText: "Burn in subtitles" }).locator('input[type="checkbox"]');
  if (await subtitles.isEnabled() && await subtitles.isChecked() !== settings.captions) {
    await subtitles.setChecked(settings.captions);
  }
  if (settings.mode === "Fast") await expect(subtitles).not.toBeChecked();
  else expect(await subtitles.isChecked()).toBe(settings.captions);
  const advancedControls = page.getByRole("button", { name: "Advanced controls", exact: true });
  if (await advancedControls.getAttribute("aria-expanded") !== "true") await advancedControls.click();
  await page.getByLabel("Aspect").selectOption(settings.aspect || "9:16");
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("20");
  await page.getByRole("button", { name: /^Create 1 short clip$/ }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 60_000 });

  const { project, job } = await jobBoundaries(name);
  expect(project.sourceKind).toBe(settings.upload ? "upload" : "youtube");
  const downloadProgress: unknown[] = [];
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const current = await (await fetch(`${gateway}/api/v1/jobs/${job.id}`)).json();
    if (current.downloadProgress) downloadProgress.push(current.downloadProgress);
    if (["complete", "failed", "partial"].includes(current.state) && current.clips?.some((clip: { state: string }) => clip.state === "complete")) break;
    await page.waitForTimeout(2_000);
  }
  const observed = new Set<string>();
  await waitForProjectReady(page, observed, 30 * 60_000);
  const clips = await collectClips(page, name, outputDir);
  expect(clips).toHaveLength(1);
  expect(clips[0].sizeBytes).toBeGreaterThan(50_000);
  expect(clips[0].savedToLibrary).toBeTruthy();
  const downloaded = await fs.readFile(clips[0].downloadPath);
  expect(downloaded.subarray(4, 8).toString()).toBe("ftyp");
  const completed = await jobBoundaries(name);
  const engineClip = completed.job.clips.find((candidate: { state: string }) => candidate.state === "complete");
  expect(engineClip?.outputName).toBeTruthy();
  if (!settings.upload) {
    expect(engineClip?.creatorCredit).toMatch(/^Source:/);
    const burnScript = engineOutput(["cat", `/app/data/jobs/${completed.job.id}/clips/${engineClip.outputName.replace(/\.mp4$/, ".burn.ass")}`]);
    expect(burnScript).toContain(engineClip.creatorCredit);
  }
  if (settings.captions) {
    const sidecar = engineOutput(["cat", `/app/data/jobs/${completed.job.id}/clips/${engineClip.outputName.replace(/\.mp4$/, ".srt")}`]);
    const transcriptWords = engineClip?.transcriptExcerpt?.match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    const normalizeCaptionText = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
    const hasTranscriptWord = (value: string) => transcriptWords.some((word: string) =>
      normalizeCaptionText(value).includes(normalizeCaptionText(word)));
    expect(transcriptWords.length).toBeGreaterThan(0);
    expect(sidecar.trim()).not.toBe("");
    expect(hasTranscriptWord(sidecar)).toBeTruthy();
    const burnScript = engineOutput(["cat", `/app/data/jobs/${completed.job.id}/clips/${engineClip.outputName.replace(/\.mp4$/, ".burn.ass")}`]);
    expect(hasTranscriptWord(burnScript)).toBeTruthy();
  }
  const mediaVerification = await inspectDownloadedOutput(completed.job.id, engineClip.outputName, clips[0].downloadPath, settings.aspect || "9:16", clips[0].sourceStart);

  // Inspect actual rendered pixels in the served browser video at two known,
  // separated times. Reset first so a preview previously played to its end
  // cannot produce identical samples from a frozen final frame.
  await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
  const pixelInspection = await page.locator(".viewer-frame video").evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    video.pause();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      const finish = () => { clearTimeout(timeout); resolve(); };
      video.addEventListener("seeked", finish, { once: true });
      video.currentTime = 0.1;
      if (!video.seeking) finish();
    });
    video.playbackRate = 1;
    await video.play();
    const sample = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 96; canvas.height = 96;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startTime = video.currentTime;
    const first = sample();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const second = sample();
    let absoluteDifference = 0;
    for (let i = 0; i < first.length; i += 4) absoluteDifference += Math.abs(first[i] - second[i]);
    return { readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
      advanced: video.currentTime - startTime, meanPixelDifference: absoluteDifference / (first.length / 4),
      mediaError: video.error?.message ?? null };
  });
  expect(pixelInspection.readyState).toBeGreaterThanOrEqual(3);
  expect(pixelInspection.advanced).toBeGreaterThan(1.5);
  expect(pixelInspection.meanPixelDifference).toBeGreaterThanOrEqual(3);
  expect(pixelInspection.mediaError).toBeNull();
  if (settings.mode === "Auto") {
    const profiles = await (await fetch(`${gateway}/api/v1/profiles`)).json();
    expect(profiles, "disposable data starts without a connected provider").toHaveLength(0);
    expect([...observed].some((stage) => stage.startsWith("Speech transcribed:")),
      "Auto without a provider resolves through the Fast path").toBeFalsy();
  }
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible();
  const assetCard = page.locator(`.asset-card[data-asset-id="${clips[0].libraryAssetId}"]`);
  await expect(assetCard).toBeVisible();
  await assetCard.locator(".asset-preview-trigger").click();
  const libraryVideo = page.getByRole("dialog").locator("video");
  await expect(libraryVideo).toBeVisible();
  const libraryPlayback = await libraryVideo.evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
    const start = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { width: video.videoWidth, height: video.videoHeight, advancedBy: video.currentTime - start, error: video.error?.message ?? null };
  });
  expect(libraryPlayback.width).toBe(1080);
  expect(libraryPlayback.height).toBe(settings.aspect === "1:1" ? 1080 : 1920);
  expect(libraryPlayback.advancedBy).toBeGreaterThan(0.5);
  expect(libraryPlayback.error).toBeNull();
  await page.screenshot({ path: path.join(outputDir, "library-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Close video preview" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const mediaEvidence = { name, settings, projectId: project.id, jobId: job.id,
    downloadProgressSamples: downloadProgress, clip: clips[0], pixelInspection, mediaVerification, libraryPlayback,
    jobWarnings: job.warnings ?? [], observedStages: [...observed] };
  const evidencePath = path.join(outputDir, "youtube-render-evidence.json");
  await fs.writeFile(evidencePath, JSON.stringify(mediaEvidence, null, 2));
  await testInfo.attach("render-and-pixel-evidence", { path: evidencePath, contentType: "application/json" });
  await page.screenshot({ path: path.join(outputDir, "rendered-workspace.png"), fullPage: true });
  checkPlayback(clips[0].playback, `${settings.mode} ${settings.style}`);
}

test("YouTube Serious + Smart burns captions and downloads moving rendered media", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await validateVisibleUi(page);
  await createAndInspect(page, testInfo, { mode: "Smart", style: "Serious", captions: true });
});

test("Serious and Hype use eligible Smart/Fast/Auto framing; Funny upload and square output stay unchanged", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

  await createAndInspect(page, testInfo, { mode: "Smart", style: "Hype", captions: false });
  await createAndInspect(page, testInfo, { mode: "Fast", style: "Serious", captions: false });
  await createAndInspect(page, testInfo, { mode: "Fast", style: "Hype", captions: false });

  // Auto without a connected provider must use the Fast rendering path.
  await createAndInspect(page, testInfo, { mode: "Auto", style: "Hype", captions: false });

  // Negative controls: a non-target style, user-upload origin and square
  // output ratio must keep their established fit/crop behavior.
  await createAndInspect(page, testInfo, {
    mode: "Fast", style: "Funny", captions: false, aspect: "1:1",
    upload: path.join(root, "tests/fixtures/openrouter-fallback.mp4"),
  });
});
