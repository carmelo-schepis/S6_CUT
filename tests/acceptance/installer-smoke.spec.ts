import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertPlayback, capturePlaybackStills, checkPlayback, createClipProject,
  downloadTile, jobBoundaries, openWorkspaceForProject, waitForProjectReady,
} from "./support/workspace";

const enabled = process.env.S6_RUN_INSTALLER_SMOKE === "1" && process.env.S6_ACCEPTANCE_ISOLATED === "1";
const artifacts = path.resolve(process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts/installer-smoke");
const phase = process.env.S6_INSTALLER_SMOKE_PHASE || "create";
const manifestPath = process.env.S6_INSTALLER_SMOKE_MANIFEST || path.join(artifacts, "installed-project.json");

test("installed gateway creates, plays, downloads and preserves a Fast clip", async ({ page, request }) => {
  test.skip(!enabled, "Requires an explicitly isolated installer deployment");
  test.setTimeout(10 * 60_000);
  await fs.mkdir(artifacts, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("requestfailed", event => {
    if (new URL(event.url()).pathname.startsWith("/api/") && event.failure()?.errorText !== "net::ERR_ABORTED") {
      errors.push(`${event.method()} ${event.url()} ${event.failure()?.errorText}`);
    }
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await expect.poll(async () => {
    try { return (await request.get("/api/health")).status(); } catch { return 0; }
  }, { timeout: 90_000 }).toBe(200);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: path.join(artifacts, `${phase}-engine-ready.png`), fullPage: true });

  let name: string;
  let original: { name: string; projectId: string; clipId: string; sha256: string } | undefined;
  if (phase === "verify") {
    original = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    name = original!.name;
    await openWorkspaceForProject(page, name);
  } else {
    name = `Windows installer smoke ${Date.now()}`;
    await createClipProject(page, {
      name, count: 1, mode: "Fast", aspect: "16:9", min: 4, max: 6, captions: false,
      source: { kind: "file", path: path.resolve("tests/fixtures/openrouter-fallback.mp4") },
    });
    await waitForProjectReady(page, new Set<string>());
  }

  const tiles = page.locator(".clip-tile.complete");
  await expect(tiles).toHaveCount(1);
  const tile = tiles.first();
  await tile.getByRole("button", { name: /Preview/ }).click();
  const playback = await assertPlayback(page);
  checkPlayback(playback, phase);
  const decodedFrames = await page.locator(".viewer-frame video").evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  expect(decodedFrames).toBeGreaterThan(3);
  await capturePlaybackStills(page, artifacts, `${phase}-clip`);
  const download = await downloadTile(page, tile, path.join(artifacts, `${phase}-clip.mp4`));
  expect(download.sizeBytes).toBeGreaterThan(10_000);
  const { project, job } = await jobBoundaries(name);
  expect(job.state).toBe("complete");
  expect(job.processingMode).toBe("fast");
  expect(job.clips[0].libraryAssetId).toBeTruthy();
  if (original) {
    expect(project.id).toBe(original.projectId);
    expect(job.clips[0].id).toBe(original.clipId);
    expect(download.sha256).toBe(original.sha256);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await openWorkspaceForProject(page, name);
  await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
  await page.locator(".clip-tile.complete").getByRole("button", { name: /Preview/ }).click();
  const replay = await assertPlayback(page);
  checkPlayback(replay, `${phase} after refresh`);
  await page.screenshot({ path: path.join(artifacts, `${phase}-after-refresh.png`), fullPage: true });
  const report = { name, projectId: project.id, clipId: job.clips[0].id, sha256: download.sha256, job, playback, replay, decodedFrames, download, errors };
  await fs.writeFile(path.join(artifacts, `${phase}-report.json`), JSON.stringify(report, null, 2));
  if (phase !== "verify") await fs.writeFile(manifestPath, JSON.stringify(report, null, 2));
  expect(errors).toEqual([]);
});
