import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPlayback, assertZipIntact, createClipProject, gateway, openWorkspaceForProject, waitForProjectReady, zipNames } from "./support/workspace";

/**
 * Fixture-assisted live-media scenario: nginx UI upload, deterministic timed
 * transcript phrase "that was hilarious", Smart/Funny speech, reaction_policy
 * v1. The encoded MP4 is compared with a subtitles-off UI render of the same
 * source and asserted clip window. 1080x1920 (9:16); ironic-v1 reaction area
 * is centered at x≈484..596, y≈803..915 in legacy geometry. All jobs must be
 * driven serially by the isolated QA runner (single engine worker).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const dataRoot = path.resolve(process.env.S6_DATA_PATH || "data");
const transcriptJson = process.env.S6_TEST_TRANSCRIPT_JSON || "";

async function waitForJobComplete(page, projectId: string, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${gateway}/api/v1/jobs`);
    expect(response.ok()).toBeTruthy();
    const jobs = await response.json() as { projectId: string; state: string; id: string }[];
    const job = jobs.find((item) => item.projectId === projectId);
    if (!job) throw new Error(`no render job was persisted for project ${projectId}`);
    if (job.state === "complete") return job;
    if (job.state === "failed") throw new Error(`render job ${job.id} failed`);
    await page.waitForTimeout(1_000);
  }
  throw new Error(`render job for project ${projectId} did not complete within ${timeoutMs}ms`);
}

async function sampleReactionRegion(page, reactionVideo: string, controlVideo: string, times: number[]) {
  const [reaction, control] = await Promise.all([
    fs.readFile(reactionVideo).then((bytes) => bytes.toString("base64")),
    fs.readFile(controlVideo).then((bytes) => bytes.toString("base64")),
  ]);
  return page.evaluate(async ({ reaction, control, times }) => {
    const open = async (encoded: string) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], { type: "video/mp4" }));
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error(video.error?.message || "downloaded MP4 decode failed")), { once: true });
      });
      return video;
    };
    const [withReaction, baseline] = await Promise.all([open(reaction), open(control)]);
    if (withReaction.videoWidth !== 1080 || withReaction.videoHeight !== 1920) throw new Error(`expected 1080x1920, got ${withReaction.videoWidth}x${withReaction.videoHeight}`);
    if (baseline.videoWidth !== withReaction.videoWidth || baseline.videoHeight !== withReaction.videoHeight) throw new Error("control dimensions do not match reaction render");
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("pixel sampler unavailable");
    // Legacy-caption 9:16 ironic-v1 reaction-plan bounds (112px centered image).
    const region = { x: 484, y: 803, width: 112, height: 112 };
    const samples = [];
    for (const time of times) {
      for (const video of [withReaction, baseline]) {
        video.currentTime = Math.min(Math.max(0, time), video.duration - .05);
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("downloaded MP4 seek failed")), { once: true });
        });
      }
      context.drawImage(withReaction, 0, 0);
      const actual = context.getImageData(region.x, region.y, region.width, region.height).data;
      context.drawImage(baseline, 0, 0);
      const expected = context.getImageData(region.x, region.y, region.width, region.height).data;
      let energy = 0, changed = 0;
      for (let i = 0; i < actual.length; i += 4) {
        const delta = Math.abs(actual[i] - expected[i]) + Math.abs(actual[i + 1] - expected[i + 1]) + Math.abs(actual[i + 2] - expected[i + 2]);
        energy += delta;
        if (delta > 60) changed += 1;
      }
      samples.push({ time, meanAbsoluteDifference: energy / (region.width * region.height * 3), changedPixels: changed, region });
    }
    for (const video of [withReaction, baseline]) URL.revokeObjectURL(video.src);
    return samples;
  }, { reaction, control, times });
}

test("reaction_policy ironic_v1 renders a phrase-timed reaction into the downloaded Smart speech clip", async ({ page }, testInfo) => {
  test.setTimeout(120 * 60_000);
  expect(process.env.S6_ACCEPTANCE_ISOLATED, "run only against its isolated Compose stack").toBe("1");
  expect(path.isAbsolute(dataRoot)).toBe(true);
  expect([".run-artifacts", "test-artifacts"]).toContain(path.relative(root, dataRoot).split(path.sep)[0]);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(new URL(gateway).hostname);
  expect(transcriptJson, "the isolated fixture transcript hook is required").not.toBe("");
  const transcript = JSON.parse(transcriptJson) as { words: { text: string; start: number; end: number }[] };
  const phrase = transcript.words.findIndex((word, index, words) => words.slice(index, index + 3).map((item) => item.text.toLowerCase()).join(" ") === "that was hilarious");
  expect(phrase, "fixture-assisted transcript contains exact controlled phrase").toBeGreaterThanOrEqual(0);
  const phraseWords = transcript.words.slice(phrase, phrase + 3);
  expect(phraseWords[0].start).toBeLessThan(phraseWords[1].start);
  expect(phraseWords[1].start).toBeLessThan(phraseWords[2].start);
  expect(phraseWords[2].end).toBeGreaterThan(phraseWords[2].start);
  await fs.access(fixture);

  const createdIds: string[] = [];
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    const projectName = `Reaction policy Smart Funny ${Date.now()}`;
    await createClipProject(page, { name: projectName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13, captions: true, style: "Funny", source: { kind: "file", path: fixture } });
    const projectsResponse = await page.request.get(`${gateway}/api/v1/projects`);
    expect(projectsResponse.ok()).toBeTruthy();
    const projects = await projectsResponse.json() as { id: string; name: string; state: string }[];
    const project = projects.find((item) => item.name === projectName);
    expect(project, "UI-created project is saved").toBeTruthy();
    createdIds.push(project!.id);
    expect(project!.state).not.toBe("failed");
    await waitForProjectReady(page, new Set(), 20 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    const playback = await assertPlayback(page);
    expect(playback.currentTimeAdvanced).toBeTruthy();

    const jobsResponse = await page.request.get(`${gateway}/api/v1/jobs`);
    expect(jobsResponse.ok()).toBeTruthy();
    const jobs = await jobsResponse.json() as { id: string; projectId: string; state: string }[];
    const job = jobs.find((item) => item.projectId === project!.id);
    expect(job, "saved job is linked to the saved project").toBeTruthy();
    expect(job!.state).toBe("complete");
    const detailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(job!.id)}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json() as {
      processingMode: string; sourceProfile: string; burnSubtitles: boolean;
      clips: { start: number; end: number; downloadUrl: string; captionDownloads: { format: string; url: string }[] }[];
    };
    expect(detail.processingMode).toBe("smart");
    expect(detail.sourceProfile).toBe("speech");
    expect(detail.burnSubtitles).toBe(true);
    expect(detail.clips).toHaveLength(1);
    const clip = detail.clips[0];
    expect(clip.end).toBeGreaterThan(clip.start);
    expect(clip.captionDownloads.map((item) => item.format).sort()).toEqual(["ass", "srt", "vtt"]);

    const sidecars: Record<string, string> = {};
    for (const download of clip.captionDownloads) {
      const response = await page.request.get(new URL(download.url, gateway).toString());
      expect(response.ok(), `${download.format} sidecar download`).toBeTruthy();
      const body = (await response.body()).toString("utf8");
      const captionTokens = body
        .replace(/\\N/gi, " ")
        .replace(/\\[a-z][^{}]*/gi, " ")
        .replace(/\{[^}]*\}|<[^>]*>/g, " ")
        .toLowerCase()
        .match(/[a-z0-9]+(?:['’][a-z0-9]+)*/g) || [];
      let previous = -1;
      for (const word of ["that", "was", "hilarious"]) {
        previous = captionTokens.indexOf(word, previous + 1);
        expect(previous, `${download.format} retains transcript word ${word} in order`).toBeGreaterThanOrEqual(0);
      }
      expect(body).not.toMatch(/(?:_emoji_text|\[\[.*?emoji.*?\]\]|<img\b|\{\\p\d)/i);
      sidecars[download.format] = body;
    }
    await fs.writeFile(testInfo.outputPath("reaction-policy-caption-sidecars.json"), JSON.stringify(sidecars, null, 2));

    const downloadResponse = await page.request.get(new URL(clip.downloadUrl, gateway).toString());
    expect(downloadResponse.ok()).toBeTruthy();
    expect(downloadResponse.headers()["content-type"] || "").toMatch(/^video\//);
    const encodedPath = testInfo.outputPath("reaction-policy-smart-funny.mp4");
    await fs.writeFile(encodedPath, await downloadResponse.body());

    // Render matching source/window with captions disabled; the UI helper still
    // creates and the same single engine worker finishes it before media compare.
    const controlName = `Reaction policy no subtitles control ${Date.now()}`;
    await createClipProject(page, { name: controlName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 13, captions: false, style: "Funny", source: { kind: "file", path: fixture } });
    const controlProjectsResponse = await page.request.get(`${gateway}/api/v1/projects`);
    expect(controlProjectsResponse.ok()).toBeTruthy();
    const controlProjects = await controlProjectsResponse.json() as { id: string; name: string }[];
    const controlProject = controlProjects.find((item) => item.name === controlName);
    expect(controlProject).toBeTruthy();
    createdIds.push(controlProject!.id);
    await waitForProjectReady(page, new Set(), 20 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    const controlJobsResponse = await page.request.get(`${gateway}/api/v1/jobs`);
    expect(controlJobsResponse.ok()).toBeTruthy();
    const controlJobs = await controlJobsResponse.json() as { id: string; projectId: string }[];
    const controlJob = controlJobs.find((item) => item.projectId === controlProject!.id);
    expect(controlJob).toBeTruthy();
    const controlDetailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(controlJob!.id)}`);
    expect(controlDetailResponse.ok()).toBeTruthy();
    const controlDetail = await controlDetailResponse.json() as { burnSubtitles: boolean; clips: { start: number; end: number; downloadUrl: string }[] };
    expect(controlDetail.burnSubtitles).toBe(false);
    expect(controlDetail.clips).toHaveLength(1);
    expect(controlDetail.clips[0].start).toBeCloseTo(clip.start, 2);
    expect(controlDetail.clips[0].end).toBeCloseTo(clip.end, 2);
    const controlResponse = await page.request.get(new URL(controlDetail.clips[0].downloadUrl, gateway).toString());
    expect(controlResponse.ok()).toBeTruthy();
    const controlPath = testInfo.outputPath("reaction-policy-no-subtitles-control.mp4");
    await fs.writeFile(controlPath, await controlResponse.body());

    const phraseStart = phraseWords[0].start - clip.start;
    const phraseEnd = phraseWords[2].end - clip.start;
    expect(phraseStart).toBeGreaterThanOrEqual(0);
    expect(phraseEnd).toBeLessThan(clip.end - clip.start);
    // The selector begins 150ms before phrase end and its 1.1s duration is
    // measured from that start. Sample before, well within, and after it.
    const reactionStart = phraseEnd - 0.15;
    const reactionEnd = reactionStart + 1.1;
    const clipDuration = clip.end - clip.start;
    expect(reactionStart).toBeGreaterThan(0);
    expect(reactionEnd).toBeLessThan(clipDuration - 0.05);
    const samples = await sampleReactionRegion(page, encodedPath, controlPath, [Math.max(0.1, reactionStart - 0.3), (reactionStart + reactionEnd) / 2, Math.min(clipDuration - 0.05, reactionEnd + 0.3)]);
    expect(samples[1].meanAbsoluteDifference, "encoded reaction pixels differ from the same-window no-subtitles control inside phrase interval").toBeGreaterThan(10);
    expect(samples[1].changedPixels, "reaction image occupies meaningful pixels during phrase interval").toBeGreaterThan(500);
    expect(samples[0].meanAbsoluteDifference, "no reaction appears before the phrase interval").toBeLessThan(5);
    expect(samples[2].meanAbsoluteDifference, "reaction has ended outside its timed interval").toBeLessThan(5);
    await fs.writeFile(testInfo.outputPath("reaction-policy-frame-samples.json"), JSON.stringify({ fixtureAssisted: true, phrase: phraseWords, clip: { start: clip.start, end: clip.end }, samples }, null, 2));
    await page.screenshot({ path: testInfo.outputPath("reaction-policy-workspace.png"), fullPage: true });

    // Reopen the main reaction clip after rendering the no-subtitles control;
    // both jobs are complete in this isolated project list.
    await openWorkspaceForProject(page, projectName);
    // Export must package these already-rendered bytes unchanged (no media
    // regeneration or policy bypass in the download path).
    const includeClip = page.locator(".clip-tile.complete input[type=checkbox]").first();
    if (!(await includeClip.isChecked())) await includeClip.check();
    const [zipDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.getByRole("button", { name: /Download ZIP/i }).click(),
    ]);
    const zipPath = testInfo.outputPath("reaction-policy-export.zip");
    await zipDownload.saveAs(zipPath);
    assertZipIntact(zipPath);
    const zipEntries = zipNames(zipPath);
    const mp4Entries = zipEntries.filter((entry) => path.extname(entry).toLowerCase() === ".mp4");
    expect(mp4Entries, "ZIP contains exactly one rendered MP4").toHaveLength(1);
    const exportVideo = testInfo.outputPath("reaction-policy-exported.mp4");
    execFileSync("python3", ["-c", "import sys, zipfile; archive = zipfile.ZipFile(sys.argv[1]); open(sys.argv[3], 'wb').write(archive.read(sys.argv[2]))", zipPath, mp4Entries[0], exportVideo]);
    const directHash = createHash("sha256").update(await fs.readFile(encodedPath)).digest("hex");
    const exportHash = createHash("sha256").update(await fs.readFile(exportVideo)).digest("hex");
    expect(exportHash, "ZIP preserves the exact downloaded reaction-rendered MP4").toBe(directHash);

    // UI-created representative snapshots exercise eligibility boundaries with
    // the same deterministic source. Each job is awaited before creating the
    // next, keeping the live renderer serial and its evidence attributable.
    const cases = [
      { label: "smart-educational", mode: "Smart" as const, style: "Educational", captions: true, sourceProfile: "speech", format: "short" as const },
      { label: "long-smart", mode: "Smart" as const, style: "Funny", captions: true, sourceProfile: "speech", format: "long" as const },
      { label: "hype-style", mode: "Smart" as const, style: "Hype", captions: true, sourceProfile: "speech", format: "short" as const },
      { label: "high-volume-auto-serious", mode: "Auto" as const, style: "Serious", captions: false, sourceProfile: "speech", format: "short" as const, batch: "high-volume" as const },
      { label: "music-profile", mode: "Smart" as const, style: "Funny", captions: false, sourceProfile: "music", format: "short" as const },
      { label: "subtitles-disabled", mode: "Smart" as const, style: "Funny", captions: false, sourceProfile: "speech", format: "short" as const },
      { label: "fast-no-timed-speech", mode: "Fast" as const, captions: false, sourceProfile: "speech", format: "short" as const },
    ];
    const snapshots = [];
    for (const scenario of cases) {
      const name = `Reaction eligibility ${scenario.label} ${Date.now()}`;
      await createClipProject(page, {
        name, count: 1, mode: scenario.mode, aspect: scenario.format === "long" ? "16:9" : "9:16",
        batch: scenario.batch,
        min: 8, max: 13, captions: scenario.captions, style: scenario.style,
        format: scenario.format, sourceProfile: scenario.sourceProfile as "speech" | "music",
        source: { kind: "file", path: fixture },
      });
      const snapshotResponse = await page.request.get(`${gateway}/api/v1/projects`);
      expect(snapshotResponse.ok()).toBeTruthy();
      const snapshotProjects = await snapshotResponse.json() as { id: string; name: string; sourceProfile?: string; batchMode?: string }[];
      const snapshotProject = snapshotProjects.find((item) => item.name === name);
      expect(snapshotProject, `${scenario.label}: saved UI project snapshot`).toBeTruthy();
      expect(snapshotProject!.batchMode).toBe(scenario.batch?.replace("-", "_") || "standard");
      createdIds.push(snapshotProject!.id);
      await waitForJobComplete(page, snapshotProject!.id);
      await openWorkspaceForProject(page, name);
      await expect(page.getByRole("heading", { name })).toBeVisible();
      const completedTile = page.locator(".clip-tile.complete");
      await expect(completedTile).toHaveCount(1);
      await completedTile.getByRole("button", { name: /Preview/ }).click();
      await expect(page.locator(".viewer-frame video")).toBeVisible();
      const snapshotJobsResponse = await page.request.get(`${gateway}/api/v1/jobs`);
      expect(snapshotJobsResponse.ok()).toBeTruthy();
      const snapshotJobs = await snapshotJobsResponse.json() as { id: string; projectId: string; state: string; sourceProfile?: string; burnSubtitles?: boolean }[];
      const snapshotJob = snapshotJobs.find((item) => item.projectId === snapshotProject!.id);
      expect(snapshotJob, `${scenario.label}: persisted render job`).toBeTruthy();
      expect(snapshotJob!.state).toBe("complete");
      const snapshotDetailResponse = await page.request.get(`${gateway}/api/v1/jobs/${encodeURIComponent(snapshotJob!.id)}`);
      expect(snapshotDetailResponse.ok()).toBeTruthy();
      const snapshotDetail = await snapshotDetailResponse.json() as { sourceProfile: string; burnSubtitles: boolean; processingMode: string; contentFormat: string; style: string; clips: { start: number; end: number; downloadUrl: string }[] };
      expect(snapshotDetail.clips).toHaveLength(1);
      expect(snapshotDetail.contentFormat).toBe(scenario.format);
      if (scenario.style) expect(snapshotDetail.style).toBe(scenario.style.toLowerCase());
      expect(snapshotDetail.sourceProfile).toBe(scenario.sourceProfile);
      if (scenario.sourceProfile !== "music") expect(snapshotDetail.burnSubtitles).toBe(scenario.captions);
      expect(
        scenario.mode === "Auto" ? ["smart", "fast"] : [scenario.mode.toLowerCase()],
        `${scenario.label}: resolved processing mode for requested UI mode ${scenario.mode}`,
      ).toContain(snapshotDetail.processingMode);
      const rendered = await page.request.get(new URL(snapshotDetail.clips[0].downloadUrl, gateway).toString());
      expect(rendered.ok(), `${scenario.label}: rendered clip download`).toBeTruthy();
      const renderPath = testInfo.outputPath(`reaction-eligibility-${scenario.label}.mp4`);
      await fs.writeFile(renderPath, await rendered.body());
      snapshots.push({ ...scenario, projectId: snapshotProject!.id, jobId: snapshotJob!.id, clip: snapshotDetail.clips[0], renderPath });
    }
    await fs.writeFile(testInfo.outputPath("reaction-eligibility-snapshots.json"), JSON.stringify(snapshots, null, 2));
  } finally {
    for (const id of createdIds) await page.request.delete(`${gateway}/api/v1/projects/${encodeURIComponent(id)}?delete_assets=true`, { timeout: 30_000 }).catch(() => undefined);
  }
});
