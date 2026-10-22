import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { openProjects, jobBoundaries, waitForProjectReady } from "./support/workspace";
import { verifyVideoOutput } from "../support/video-output";

const sourceUrl = process.env.S6_MUSIC_VIDEO_URL;
const songUrl = process.env.S6_MUSIC_SONG_URL;
const referencePath = process.env.S6_PRIVATE_LYRIC_REFERENCE;
const gateway = process.env.S6_ACCEPTANCE_URL;
const artifactRoot = path.resolve(process.env.S6_MUSIC_LYRIC_ARTIFACTS || "test-artifacts/music-lyrics-live");

type TimedWord = { text: string; start: number; end: number };

function tokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function editErrors(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row++) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (reference[row - 1] === hypothesis[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

test("local Music lyrics match a private timed reference and render a playable clip", async ({ page }, testInfo) => {
  test.skip(!sourceUrl || !songUrl || !referencePath || !gateway, "requires YouTube source/song URLs, a private timed lyric reference, and an isolated gateway");
  test.setTimeout(25 * 60_000);
  await fs.mkdir(artifactRoot, { recursive: true });
  const referenceFile = path.resolve(referencePath!);
  const reference = JSON.parse(await fs.readFile(referenceFile, "utf8")) as TimedWord[];
  expect(reference.length, "private timed reference must contain word-level timing").toBeGreaterThan(0);

  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await openProjects(page);
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.locator("#source-youtube-url").fill(sourceUrl!);
  const projectName = "Private Music Accuracy " + Date.now();
  await page.getByLabel("Project name").fill(projectName);
  const count = page.locator(".count-control strong");
  while (Number(await count.textContent()) > 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  await page.getByRole("button", { name: "Music / sung vocals", exact: true }).click();
  await page.getByLabel("YouTube song URL").fill(songUrl!);
  await page.getByRole("button", { name: "Advanced controls" }).click();
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("20");
  await page.screenshot({ path: path.join(artifactRoot, "project-before-create.png"), fullPage: true });
  await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });

  const observed = new Set<string>();
  await waitForProjectReady(page, observed, 22 * 60_000);
  const { project, job } = await jobBoundaries(projectName);
  const clip = job.clips[0];
  const tile = page.locator(".clip-tile.complete").first();
  await expect(tile).toBeVisible();
  const href = await tile.locator("a[download]").getAttribute("href");
  expect(href).toBeTruthy();
  const downloaded = await page.request.get(new URL(href!, gateway).toString());
  const mp4Path = path.join(artifactRoot, "music-output.mp4");
  const mp4 = await downloaded.body();
  await fs.writeFile(mp4Path, mp4);
  await fs.writeFile(path.join(artifactRoot, "private-reference.sha256"), createHash("sha256").update(await fs.readFile(referenceFile)).digest("hex") + "\n");
  const captionText = (clip.captionCues || []).map((cue: { text: string }) => cue.text).join(" ");
  const expectedWords = reference
    .filter(word => (word.start + word.end) / 2 >= clip.start && (word.start + word.end) / 2 < clip.end)
    .flatMap(word => tokens(word.text));
  const actualWords = tokens(captionText);
  const score = {
    referenceWords: expectedWords.length,
    captionWords: actualWords.length,
    editErrors: editErrors(expectedWords, actualWords),
    wer: expectedWords.length ? editErrors(expectedWords, actualWords) / expectedWords.length : null,
  };
  const record: Record<string, unknown> = {
    projectId: project.id, jobId: job.id, sourceKind: project.sourceKind,
    state: job.state, profile: job.sourceProfile, clip: {
      start: clip.start, end: clip.end, duration: clip.duration,
      reviewRequired: clip.reviewRequired, captionQaWarnings: clip.captionQaWarnings,
      captionCues: clip.captionCues,
    },
    captionText, score, observedStages: [...observed], browserErrors,
    output: { path: mp4Path, bytes: mp4.length, sha256: createHash("sha256").update(mp4).digest("hex") },
    evidenceCapturedAt: new Date().toISOString(),
  };
  const reportPath = path.join(artifactRoot, "verification.json");
  await fs.writeFile(reportPath, JSON.stringify(record, null, 2) + "\n");
  await page.screenshot({ path: path.join(artifactRoot, "project-complete.png"), fullPage: true });

  await tile.getByRole("button", { name: /Preview/ }).click();
  const player = page.getByRole("region", { name: "Output viewer" }).locator("video");
  const videoEvidence = await verifyVideoOutput({
    video: player,
    artifactDirectory: artifactRoot,
    artifactPrefix: "music-output",
    maximumDurationSeconds: 25,
    expectedWidth: 1080,
    expectedHeight: 1920,
  });
  record.videoEvidence = videoEvidence;
  record.browserErrors = browserErrors;
  await fs.writeFile(reportPath, JSON.stringify(record, null, 2) + "\n");

  expect(downloaded.ok()).toBeTruthy();
  expect(job.state).toBe("complete");
  expect(job.sourceProfile).toBe("music");
  expect(clip.duration).toBeGreaterThanOrEqual(8);
  expect(clip.duration).toBeLessThanOrEqual(20);
  expect(score.referenceWords, "reference must overlap the selected lyric clip").toBeGreaterThan(0);
  expect(score.wer, "caption word error rate against private timed reference").toBeLessThanOrEqual(.2);
  expect(videoEvidence.playbackAdvanced).toBeTruthy();
  expect(videoEvidence.frameDifferences.some(value => value > 1)).toBeTruthy();
  expect(browserErrors).toEqual([]);
});
