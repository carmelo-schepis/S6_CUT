import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPlayback, capturePlaybackStills, checkPlayback, downloadTile, openWorkspaceForProject } from "./support/workspace";

const enabled = process.env.S6_LOCAL_ENGINE_LIVE === "1" && process.env.S6_ACCEPTANCE_ISOLATED === "1";
const artifacts = path.resolve(process.env.S6_PLAYWRIGHT_ARTIFACTS || ".qa/local-engine-live/evidence");

test.describe("Local execution against a real isolated engine", () => {
  test.skip(!enabled, "Requires explicit opt-in and disposable engine data");
  test.describe.configure({ mode: "serial" });
  test.use({ serviceWorkers: "block" });

  for (const policy of ["engine_only", "auto"] as const) {
    test("creates, plays and downloads a real locally captioned video: " + policy, async ({ page }) => {
      test.setTimeout(20 * 60_000);
      const output = path.join(artifacts, policy);
      await fs.mkdir(output, { recursive: true });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await expect.poll(async () => {
        try { return (await page.request.get("/api/v1/health")).status(); }
        catch { return 0; }
      }, { timeout: 90_000 }).toBe(200);
      const profiles = await page.request.get("/api/v1/profiles");
      expect(await profiles.json()).toEqual([]);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Local engine ready", { exact: true })).toBeVisible({ timeout: 90_000 });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await page.locator('input[aria-label="Choose video file"]').setInputFiles("tests/fixtures/openrouter-fallback.mp4");
      const name = "Local video playback " + policy + " " + Date.now();
      await page.getByLabel("Project name").fill(name);
      for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
      await expect(page.locator(".count-control strong")).toHaveText("1");
      if (policy === "engine_only") await page.getByRole("button", { name: "Engine only", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: /Burn in subtitles/ })).toBeChecked();
      await page.getByRole("checkbox", { name: "Hook text", exact: true }).check();
      await page.getByTestId("youtube-metadata-toggle").check();
      await page.getByLabel("Enable Subscribe animation").uncheck();
      await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
      await page.getByLabel("Minimum seconds").fill("8");
      await page.getByLabel("Maximum seconds").fill("12");
      await page.screenshot({ path: path.join(output, "creation.png"), fullPage: true });
      const createdResponse = page.waitForResponse(r => r.url().endsWith("/api/v1/jobs/clip") && r.status() === 202);
      await page.getByRole("button", { name: /^Create 1 short clip$/ }).click();
      const created = await (await createdResponse).json();
      expect(created.job.executionPolicy).toBe(policy);
      await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" }))
        .toHaveClass(/status-complete/, { timeout: 15 * 60_000 });
      await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
      const jobResponse = await page.request.get("/api/v1/jobs/" + created.job.id);
      const job = await jobResponse.json();
      expect(job.state).toBe("complete");
      expect(job.processingMode).toBe("smart");
      expect(job.burnSubtitles).toBe(true);
      expect(job.clips[0].hookText.length).toBeGreaterThanOrEqual(20);
      expect(job.clips[0].youtubeMetadataStatus).toBe("fallback");
      expect(job.clips[0].libraryAssetId).toBeTruthy();
      await page.locator(".clip-tile.complete").getByRole("button", { name: /Preview/ }).click();
      const playback = await assertPlayback(page);
      checkPlayback(playback, policy);
      const decodedFrames = await page.locator(".viewer-frame video").evaluate((video: HTMLVideoElement) =>
        video.getVideoPlaybackQuality().totalVideoFrames);
      expect(decodedFrames).toBeGreaterThan(3);
      await capturePlaybackStills(page, output, "video");
      const download = await downloadTile(page, page.locator(".clip-tile.complete"), path.join(output, "clip.mp4"));
      expect(download.sizeBytes).toBeGreaterThan(10_000);
      await page.screenshot({ path: path.join(output, "completed.png"), fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await openWorkspaceForProject(page, name);
      await page.locator(".clip-tile.complete").getByRole("button", { name: /Preview/ }).click();
      const replay = await assertPlayback(page);
      checkPlayback(replay, policy + " after reload");
      expect(errors).toEqual([]);
      await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ job, playback, replay, decodedFrames, download, errors }, null, 2));
    });
  }
});
