import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPlayback, createClipProject, gateway, waitForProjectReady } from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_EMOJI_CAPTION_FIXTURE || path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const dataRoot = path.resolve(process.env.S6_DATA_PATH || "data");
const transcriptJson = process.env.S6_TEST_TRANSCRIPT_JSON || "";
const expectedEmoji = process.env.S6_EMOJI_EXPECTED || "😩";

async function compareVideoRegion(page: Page, captionPath: string, controlPath: string, timestamps: number[]) {
  const encodedCaption = (await fs.readFile(captionPath)).toString("base64");
  const encodedControl = (await fs.readFile(controlPath)).toString("base64");
  return page.evaluate(async ({ encodedCaption, encodedControl, timestamps }) => {
    const createVideo = async (encoded: string) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error(video.error?.message || "downloaded MP4 failed to decode")), { once: true });
      });
      return video;
    };
    const [caption, control] = await Promise.all([createVideo(encodedCaption), createVideo(encodedControl)]);
    if (caption.videoWidth !== 1080 || caption.videoHeight !== 1920) throw new Error(`unexpected downloaded video dimensions ${caption.videoWidth}x${caption.videoHeight}`);
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("downloaded-video pixel sampler unavailable");
    const x = 583, y = 941, width = 151, height = 192;
    const samples: { time: number; meanAbsoluteDifference: number; changedPixels: number; saturatedPixels: number }[] = [];
    for (const requested of timestamps) {
      for (const video of [caption, control]) {
        video.currentTime = Math.min(Math.max(0, requested), Math.max(0, video.duration - .05));
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("downloaded video seek failed")), { once: true });
        });
      }
      context.drawImage(caption, 0, 0);
      const actual = context.getImageData(x, y, width, height).data;
      context.drawImage(control, 0, 0);
      const baseline = context.getImageData(x, y, width, height).data;
      let energy = 0;
      let changedPixels = 0;
      let saturatedPixels = 0;
      for (let i = 0; i < actual.length; i += 4) {
        const delta = Math.abs(actual[i] - baseline[i]) + Math.abs(actual[i + 1] - baseline[i + 1]) + Math.abs(actual[i + 2] - baseline[i + 2]);
        energy += delta;
        if (delta > 60) changedPixels += 1;
        const high = Math.max(actual[i], actual[i + 1], actual[i + 2]);
        const low = Math.min(actual[i], actual[i + 1], actual[i + 2]);
        if (high - low > 65 && high > 100 && low < 220) saturatedPixels += 1;
      }
      samples.push({ time: requested, meanAbsoluteDifference: energy / (width * height * 3), changedPixels, saturatedPixels });
    }
    for (const video of [caption, control]) URL.revokeObjectURL(video.src);
    return samples;
  }, { encodedCaption, encodedControl, timestamps });
}

test("Smart captions render bundled color emoji and keep Unicode caption downloads", async ({ page }, testInfo) => {
  test.setTimeout(25 * 60_000);
  expect(process.env.S6_ACCEPTANCE_ISOLATED, "run only against the isolated emoji acceptance stack").toBe("1");
  expect(dataRoot, "the dataset must be a unique disposable branch-local path").toMatch(/\/git_branches\/S6_CUT-subtitle-emoji-[^/]+\//);
  expect(["127.0.0.1", "localhost", "::1"], "never mutate a shared deployment").toContain(new URL(gateway).hostname);
  expect(transcriptJson, "the isolated engine must receive the deterministic transcript hook").not.toBe("");
  const transcript = JSON.parse(transcriptJson) as { words?: { text: string; start: number; end: number }[] };
  const words = transcript.words || [];
  const emojiWordIndex = words.findIndex((word) => word.text.includes(expectedEmoji));
  expect(emojiWordIndex, "fixture transcript must contain the expected complete emoji").toBeGreaterThanOrEqual(0);
  await fs.access(fixture);

  const createdProjectIds: string[] = [];
  try {
    const projectName = `Color emoji acceptance ${Date.now()}`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await createClipProject(page, { name: projectName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13, captions: true, style: "Funny", source: { kind: "file", path: fixture } });
    const projectResponse = await page.request.get(`${gateway}/api/v1/projects`);
    expect(projectResponse.ok()).toBeTruthy();
    const projects = await projectResponse.json() as { id: string; name: string }[];
    const project = projects.find((item) => item.name === projectName);
    expect(project, "project was created through the UI").toBeTruthy();
    createdProjectIds.push(project!.id);
    await waitForProjectReady(page, new Set(), 20 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    const playback = await assertPlayback(page);
    expect(playback.currentTimeAdvanced).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png"), fullPage: true });

    const jobListResponse = await page.request.get(`${gateway}/api/v1/jobs`);
    expect(jobListResponse.ok()).toBeTruthy();
    const jobs = await jobListResponse.json() as { id: string; projectId: string }[];
    const job = jobs.find((item) => item.projectId === project!.id);
    expect(job).toBeTruthy();
    const detailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(job!.id)}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json() as {
      burnSubtitles: boolean;
      processingMode: string;
      clips: { start: number; end: number; downloadUrl: string; captionDownloads: { format: string; url: string }[] }[];
    };
    expect(detail.burnSubtitles).toBe(true);
    expect(detail.processingMode).toBe("smart");
    expect(detail.clips).toHaveLength(1);
    const clip = detail.clips[0];
    expect(clip.captionDownloads.map((item) => item.format).sort()).toEqual(["ass", "srt", "vtt"]);
    const sidecars: Record<string, string> = {};
    for (const item of clip.captionDownloads) {
      const response = await page.request.get(new URL(item.url, gateway).toString());
      expect(response.ok(), `${item.format} caption download`).toBeTruthy();
      const text = (await response.body()).toString("utf8");
      expect(text).toContain(expectedEmoji);
      sidecars[item.format] = text;
    }
    await fs.writeFile(testInfo.outputPath("caption-downloads.json"), JSON.stringify(sidecars, null, 2));

    const mp4Response = await page.request.get(new URL(clip.downloadUrl, gateway).toString());
    expect(mp4Response.ok()).toBeTruthy();
    expect(mp4Response.headers()["content-type"] || "").toMatch(/^video\//);
    const downloadedVideo = testInfo.outputPath("captioned-emoji.mp4");
    await fs.writeFile(downloadedVideo, await mp4Response.body());
    const groupStart = Math.floor(emojiWordIndex / 3) * 3;
    const group = words.slice(groupStart, groupStart + 3);
    const localStart = Math.max(0, group[0].start - clip.start);
    const localEnd = Math.min(clip.end - clip.start, group[group.length - 1].end - clip.start);
    expect(localEnd).toBeGreaterThan(localStart);
    const times = [Math.max(0, localStart - .25), (localStart + localEnd) / 2, Math.min(clip.end - clip.start - .05, localEnd + .25)];

    // Exercise the no-subtitles path through the UI as a pixel-matched control.
    const controlName = `No subtitles control ${Date.now()}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png"), fullPage: true });
    await createClipProject(page, { name: controlName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13, captions: false, style: "Funny", source: { kind: "file", path: fixture } });
    const controlProjectResponse = await page.request.get(`${gateway}/api/v1/projects`);
    const controlProjects = await controlProjectResponse.json() as { id: string; name: string }[];
    const controlProject = controlProjects.find((item) => item.name === controlName);
    expect(controlProject).toBeTruthy();
    createdProjectIds.push(controlProject!.id);
    await waitForProjectReady(page, new Set(), 20 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    const controlJobsResponse = await page.request.get(`${gateway}/api/v1/jobs`);
    const controlJobs = await controlJobsResponse.json() as { id: string; projectId: string }[];
    const controlJob = controlJobs.find((item) => item.projectId === controlProject!.id);
    expect(controlJob).toBeTruthy();
    const controlDetailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(controlJob!.id)}`);
    const controlDetail = await controlDetailResponse.json() as { clips: { start: number; end: number; downloadUrl: string }[] };
    expect(controlDetail.clips).toHaveLength(1);
    expect(controlDetail.clips[0].start).toBeCloseTo(clip.start, 2);
    expect(controlDetail.clips[0].end).toBeCloseTo(clip.end, 2);
    const controlResponse = await page.request.get(new URL(controlDetail.clips[0].downloadUrl, gateway).toString());
    expect(controlResponse.ok()).toBeTruthy();
    const controlVideo = testInfo.outputPath("no-subtitles-control.mp4");
    await fs.writeFile(controlVideo, await controlResponse.body());
    const samples = await compareVideoRegion(page, downloadedVideo, controlVideo, times);
    expect(samples[1].meanAbsoluteDifference, "downloaded video contains Fluent image pixels during the emoji interval").toBeGreaterThan(12);
    expect(samples[1].changedPixels, "color image differs from matching no-subtitle control inside its timed slot").toBeGreaterThan(1_000);
    expect(samples[0].meanAbsoluteDifference, "emoji is absent before the half-open interval").toBeLessThan(5);
    expect(samples[2].meanAbsoluteDifference, "emoji is absent after the half-open interval").toBeLessThan(5);
    await fs.writeFile(testInfo.outputPath("emoji-frame-samples.json"), JSON.stringify(samples, null, 2));
  } finally {
    if (process.env.S6_KEEP_EMOJI_DEMO !== "1") {
      for (const projectId of createdProjectIds) {
        await page.request.delete(`${gateway}/api/v1/projects/${encodeURIComponent(projectId)}?delete_assets=true`, { timeout: 30_000 }).catch(() => undefined);
      }
    }
  }
});
