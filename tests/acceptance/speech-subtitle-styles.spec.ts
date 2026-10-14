import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipProject, gateway, waitForProjectReady } from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_SPEECH_STYLE_FIXTURE || path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const artifacts = process.env.S6_PLAYWRIGHT_ARTIFACTS || path.join(root, "test-artifacts/speech-subtitle-styles");
const youtubeUrl = process.env.S6_SPEECH_STYLE_YOUTUBE_URL || "";
const styles = ["Funny", "Serious", "Educational", "Hype"] as const;
const outputDir = path.join(artifacts, "speech-subtitle-styles");

test.describe.configure({ mode: "serial" });

test("real local speech fixture renders all four selected subtitle styles and a subtitles-off control", async ({ page }, testInfo) => {
  test.setTimeout(60 * 60_000);
  expect(process.env.S6_ACCEPTANCE_ISOLATED, "requires its dedicated isolated stack").toBe("1");
  expect(path.isAbsolute(path.resolve(process.env.S6_DATA_PATH || "")), "isolated data root is configured").toBe(true);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(new URL(gateway).hostname);
  await fs.access(fixture);
  await fs.mkdir(outputDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 120_000 });

  const signatures = new Map<string, string>();
  let reference: { start: number; end: number } | undefined;
  for (const style of styles) {
    const name = `Subtitle style ${style} ${Date.now()}`;
    await createClipProject(page, {
      name, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13,
      captions: true, style, source: { kind: "file", path: fixture },
    });
    // createClipProject asserts aria-pressed on the selected style card before submission.
    await waitForProjectReady(page, new Set(), 25 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`${style.toLowerCase()}-workspace.png`), fullPage: true });

    const projectResponse = await page.request.get(`${gateway}/api/v1/projects`);
    expect(projectResponse.ok()).toBeTruthy();
    const projects = await projectResponse.json() as { id: string; name: string }[];
    const project = projects.find((item) => item.name === name);
    expect(project, "project came from visible UI submission").toBeTruthy();
    const jobsResponse = await page.request.get(`${gateway}/api/v1/jobs`);
    expect(jobsResponse.ok()).toBeTruthy();
    const jobs = await jobsResponse.json() as { id: string; projectId: string }[];
    const job = jobs.find((item) => item.projectId === project!.id);
    expect(job).toBeTruthy();
    const detailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(job!.id)}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json() as {
      burnSubtitles: boolean;
      clips: { start: number; end: number; downloadUrl: string; previewUrl?: string; transcriptExcerpt?: string; captionDownloads?: { format: string; url: string }[] }[];
    };
    expect(detail.burnSubtitles).toBe(true);
    expect(detail.clips).toHaveLength(1);
    const clip = detail.clips[0];
    if (reference) {
      expect(clip.start).toBeCloseTo(reference.start, 1);
      expect(clip.end).toBeCloseTo(reference.end, 1);
    } else reference = { start: clip.start, end: clip.end };
    expect(clip.transcriptExcerpt?.trim(), "the engine recorded recognized speech for the clip").toBeTruthy();

    const downloads = clip.captionDownloads || [];
    expect(downloads.map((item) => item.format).sort()).toEqual(["ass", "srt", "vtt"]);
    const texts: Record<string, string> = {};
    for (const item of downloads) {
      const response = await page.request.get(new URL(item.url, gateway).toString());
      expect(response.ok(), `${item.format} download`).toBeTruthy();
      texts[item.format] = (await response.body()).toString("utf8");
      expect(texts[item.format].trim()).not.toBe("");
      expect(texts[item.format].toLowerCase()).toContain(clip.transcriptExcerpt!.trim().split(/\s+/)[0].toLowerCase());
    }
    const ass = texts.ass;
    const captionStyle = ass.split(/\r?\n/).find((line) => line.startsWith("Style: Caption,"));
    expect(captionStyle, "downloaded ASS carries a renderer Caption style declaration").toBeTruthy();
    const fields = captionStyle!.replace("Style: ", "").split(",");
    const rendererContract = {
      Funny: { font: "Archivo Black", size: "86", highlight: "&H0000D7FF&" },
      Serious: { font: "Barlow", size: "60", highlight: "&H00F4F5F7&" },
      Educational: { font: "Barlow", size: "68", highlight: "&H0000D7FF&" },
      Hype: { font: "Montserrat ExtraBold", size: "104", highlight: "&H0000D7FF&" },
    }[style];
    expect(fields[0], "ASS event style is Caption").toBe("Caption");
    expect(fields[1], `${style} renderer font`).toBe(rendererContract.font);
    expect(fields[2], `${style} rendered size`).toBe(rendererContract.size);
    expect(fields[4], `${style} renderer current-word highlight`).toBe(rendererContract.highlight);
    const timedEvents = ass.split(/\r?\n/).filter((line) => line.startsWith("Dialogue: 10,"));
    expect(timedEvents.length, "ASS contains timed subtitle events").toBeGreaterThan(0);
    if (style === "Serious") {
      expect(timedEvents.every((line) => !line.includes("{\\c&H0000D7FF&}")), "Serious never emits moving yellow emphasis").toBe(true);
      const assWords = timedEvents.flatMap((line) => line.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "").replaceAll("\\N", " ").split(/\s+/).filter(Boolean));
      const srtWords = texts.srt.split(/\r?\n/).filter((line) => line && !/^\d+$/.test(line) && !/^\d{2}:\d{2}:\d{2},\d{3} --> /.test(line)).flatMap((line) => line.split(/\s+/));
      expect(assWords, "Serious ASS phrases preserve the full transcript represented by SRT").toEqual(srtWords);
    }
    else expect(timedEvents.every((line) => (line.match(/\\c&H0000D7FF&/g) || []).length === 1), `${style} marks exactly one spoken word per active interval`).toBe(true);
    if (style === "Hype") expect(timedEvents.every((line) => line.includes("\\pos(540,1037)")), "Hype retains its exact central anchor").toBe(true);
    signatures.set(style, captionStyle!);
    await fs.writeFile(testInfo.outputPath(`${style.toLowerCase()}-captions.json`), JSON.stringify(texts, null, 2));

    const video = await page.request.get(new URL(clip.downloadUrl, gateway).toString());
    expect(video.ok(), "completed caption-burned MP4 downloads").toBeTruthy();
    expect(video.headers()["content-type"] || "").toMatch(/^video\//);
    const videoBytes = await video.body();
    expect(videoBytes.length).toBeGreaterThan(20_000);
    await fs.writeFile(testInfo.outputPath(`${style.toLowerCase()}-captioned.mp4`), videoBytes);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    await expect(page.locator(".viewer-stage video")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${style.toLowerCase()}-app-preview.png`), fullPage: true });
    const previewUrl = clip.previewUrl || clip.downloadUrl;
    const preview = await page.request.get(new URL(previewUrl, gateway).toString());
    expect(preview.ok(), "workspace preview MP4 is downloadable").toBeTruthy();
    expect(Buffer.compare(videoBytes, await preview.body()), "preview and download expose the same caption-burned MP4").toBe(0);
  }
  expect(new Set(signatures.values()).size, "renderer ASS style declaration differs across all four selections").toBe(4);

  const offName = `Subtitle style off control ${Date.now()}`;
  await createClipProject(page, {
    name: offName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13,
    captions: false, style: "Funny", source: { kind: "file", path: fixture },
  });
  await waitForProjectReady(page, new Set(), 25 * 60_000);
  const projectsResponse = await page.request.get(`${gateway}/api/v1/projects`);
  const offProject = (await projectsResponse.json() as { id: string; name: string }[]).find((item) => item.name === offName);
  expect(offProject).toBeTruthy();
  const offJobs = await (await page.request.get(`${gateway}/api/v1/jobs`)).json() as { id: string; projectId: string }[];
  const offJob = offJobs.find((item) => item.projectId === offProject!.id);
  expect(offJob).toBeTruthy();
  const offResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(offJob!.id)}`);
  const offDetail = await offResponse.json() as { burnSubtitles: boolean; clips: { downloadUrl: string; captionDownloads?: { format: string; url: string }[] }[] };
  expect(offDetail.burnSubtitles).toBe(false);
  expect(offDetail.clips).toHaveLength(1);
  const offCaptions = offDetail.clips[0].captionDownloads || [];
  expect(offCaptions.map((item) => item.format).sort()).toEqual(["ass", "srt", "vtt"]);
  const offSrt = offCaptions.find((item) => item.format === "srt");
  expect(offSrt).toBeTruthy();
  const offSrtResponse = await page.request.get(new URL(offSrt!.url, gateway).toString());
  expect(offSrtResponse.ok(), "text subtitle download remains available when burn-in is off").toBeTruthy();
  expect((await offSrtResponse.text()).trim()).not.toBe("");
  const offVideo = await page.request.get(new URL(offDetail.clips[0].downloadUrl, gateway).toString());
  expect(offVideo.ok(), "subtitles-off MP4 export downloads").toBeTruthy();
  expect(offVideo.headers()["content-type"] || "").toMatch(/^video\//);
  await fs.writeFile(testInfo.outputPath("subtitles-off.mp4"), await offVideo.body());
  await page.screenshot({ path: testInfo.outputPath("subtitles-off-workspace.png"), fullPage: true });
});

test("real public YouTube import downloads, transcribes, and renders with subtitles", async ({ page }, testInfo) => {
  test.skip(!youtubeUrl, "set S6_SPEECH_STYLE_YOUTUBE_URL to an authorized public YouTube speech video; import is never mocked");
  test.setTimeout(60 * 60_000);
  expect(process.env.S6_ACCEPTANCE_ISOLATED).toBe("1");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 120_000 });
  const name = `Real YouTube speech subtitles ${Date.now()}`;
  const started = Date.now();
  await createClipProject(page, {
    name, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 30,
    captions: true, style: "Educational", source: { kind: "url", url: youtubeUrl },
  });
  const projects = await (await page.request.get(`${gateway}/api/v1/projects`)).json() as { id: string; name: string; sourceKind?: string }[];
  const project = projects.find((item) => item.name === name);
  expect(project, "project created from public source through UI").toBeTruthy();
  expect(project!.sourceKind).toBe("youtube");
  await expect.poll(async () => {
    const allJobs = await (await page.request.get(`${gateway}/api/v1/jobs`)).json() as { id: string; projectId: string; downloadProgress?: { downloadedBytes?: number } }[];
    return allJobs.find((job) => job.projectId === project!.id)?.downloadProgress?.downloadedBytes || 0;
  }, { timeout: 25 * 60_000, intervals: [1_000, 3_000, 5_000] }).toBeGreaterThan(0);
  const seen = new Set<string>();
  await waitForProjectReady(page, seen, 45 * 60_000);
  for (const stage of ["Source received", "Video validated", "Speech transcribed", "Clips rendered and saved", "Outputs verified", "Project ready"])
    expect([...seen].some((item) => item.startsWith(`${stage}:`)), `successful real-import stage: ${stage}`).toBeTruthy();
  await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("youtube-import-rendered.png"), fullPage: true });
  const jobList = await (await page.request.get(`${gateway}/api/v1/jobs`)).json() as { id: string; projectId: string }[];
  const job = jobList.find((item) => item.projectId === project!.id);
  expect(job).toBeTruthy();
  const response = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(job!.id)}`);
  const detail = await response.json() as { burnSubtitles: boolean; clips: { downloadUrl: string; transcriptExcerpt?: string; captionDownloads?: { format: string; url: string }[] }[] };
  expect(detail.burnSubtitles).toBe(true);
  expect(detail.clips).toHaveLength(1);
  expect(detail.clips[0].transcriptExcerpt?.trim()).toBeTruthy();
  const rendered = await page.request.get(new URL(detail.clips[0].downloadUrl, gateway).toString());
  expect(rendered.ok(), "real YouTube render downloads").toBeTruthy();
  expect(rendered.headers()["content-type"] || "").toMatch(/^video\//);
  await fs.writeFile(testInfo.outputPath("youtube-captioned.mp4"), await rendered.body());
  await fs.writeFile(testInfo.outputPath("youtube-import-summary.json"), JSON.stringify({ url: youtubeUrl, elapsedSeconds: (Date.now() - started) / 1000, stages: [...seen].sort(), transcriptExcerpt: detail.clips[0].transcriptExcerpt }, null, 2));
});
