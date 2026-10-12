import { verifyVideoOutput } from "../../support/video-output";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";

/** Verify browser playback and, for successful jobs, render pixels inside the engine container. */
export async function verifyHookTextMedia(page: Page, artifactDirectory: string, prefix: string, jobId: string, hookExpected = true) {
  const tiles = page.locator(".clip-tile.complete");
  await fs.mkdir(artifactDirectory, { recursive: true });
  const mediaPaths = [];
  for (let index = 0; index < await tiles.count(); index += 1) {
    const tile = tiles.nth(index);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      tile.locator('a[download]').click(),
    ]);
    const mediaPath = path.join(artifactDirectory, `${prefix}-${index + 1}.mp4`);
    await download.saveAs(mediaPath);
    mediaPaths.push(mediaPath);
  }
  const tile = tiles.first();
  await tile.getByRole("button", { name: /Preview/ }).click();
  const evidence = await verifyVideoOutput({
    video: page.locator(".viewer-frame video"),
    artifactDirectory,
    artifactPrefix: prefix,
    maximumDurationSeconds: 180,
    expectedWidth: 1080,
    expectedHeight: 1920,
    ...(hookExpected ? {
      expectedOverlayRegion: { x: 0.08, y: 0.02, width: 0.84, height: 0.23 },
      expectedOverlayTimestamp: 1,
    } : {}),
  });
  const engineEvidence = [];
  if (hookExpected) {
    const container = process.env.S6_AI_HOOK_TEXT_ENGINE_CONTAINER;
    if (!container) throw new Error("S6_AI_HOOK_TEXT_ENGINE_CONTAINER must identify the isolated engine container for in-container media verification");
    const response = await page.request.get(new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}`, page.url()).toString());
    if (!response.ok()) throw new Error(`Unable to read job ${jobId} for engine media verification`);
    const job = await response.json();
    for (const clip of job.clips.filter((item) => item.state === "complete" && item.hookText)) {
      const output = execFileSync("docker", ["exec", "-w", "/app", container, "python", "-m", "engine.tests.verify_hook_text_media", jobId, clip.id], { encoding: "utf8", maxBuffer: 1024 * 1024 });
      engineEvidence.push(JSON.parse(output));
    }
    if (engineEvidence.length !== job.clips.filter((item) => item.state === "complete" && item.hookText).length || !engineEvidence.length) {
      throw new Error("Engine-container verification did not cover every completed hook-bearing clip");
    }
  }
  return { ...evidence, mediaPaths, engineEvidence };
}
