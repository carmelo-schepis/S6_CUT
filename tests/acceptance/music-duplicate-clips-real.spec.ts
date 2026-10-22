import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const fixture = process.env.S6_DUPLICATE_FIXTURE;
const artifacts = process.env.S6_DUPLICATE_ARTIFACTS;

test("Music repeats valid windows through completion, Library and export", async ({ page, request, browser }, testInfo) => {
  test.skip(!fixture || !artifacts, "Run against the isolated transcript-fixture Docker review stack");
  test.setTimeout(900_000);
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("requestfailed", failed => failedRequests.push(`${failed.method()} ${failed.url()}: ${failed.failure()?.errorText}`));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const existingJobId = process.env.S6_DUPLICATE_EXISTING_JOB_ID;
  let jobId: string;
  if (existingJobId) {
    jobId = existingJobId;
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
  } else {
    await page.getByLabel("Choose video file").setInputFiles(fixture!);
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    for (let count = 5; count < 13; count++) await page.getByRole("button", { name: "More clips" }).click();
    await page.getByRole("button", { name: "Advanced controls" }).click();
    await page.getByLabel("Minimum seconds").fill("20");
    await page.getByLabel("Maximum seconds").fill("30");
    await page.getByLabel("Project name").fill("Music duplicate-window review");
    await expect(page.getByRole("status").filter({ hasText: "repeat valid windows when possible" })).toBeVisible();
    const create = page.getByRole("button", { name: "Create 13 short clips", exact: true });
    await expect(create).toBeEnabled();
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/v1/jobs/clip") && response.request().method() === "POST");
    await create.click();
    const accepted = await submitted;
    expect(accepted.status(), await accepted.text()).toBe(202);
    jobId = (await accepted.json()).job.id;
  }
  const readJob = async () => {
    const response = await request.get(`/api/v1/jobs/${jobId}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  if (!existingJobId) {
    await expect.poll(async () => {
      const current = await readJob();
      if (["failed", "partial", "stalled", "cancelled_kept"].includes(current.state)) throw new Error(JSON.stringify(current));
      return current.state === "complete" && current.steps.every((step: { status: string }) => ["complete", "skipped"].includes(step.status));
    }, { timeout: 840_000, intervals: [1000, 2000] }).toBe(true);
  }
  const finished = await readJob();
  expect(finished.requestedCount).toBe(13);
  expect(finished.clips).toHaveLength(13);
  expect(finished.steps.every((step: { status: string }) => ["complete", "skipped"].includes(step.status))).toBe(true);
  expect(new Set(finished.clips.map((clip: { id: string }) => clip.id)).size).toBe(13);
  expect(new Set(finished.clips.map((clip: { libraryAssetId: string }) => clip.libraryAssetId)).size).toBe(13);
  expect(new Set(finished.clips.map((clip: { outputName: string }) => clip.outputName)).size).toBe(13);
  expect(new Set(finished.clips.map((clip: { start: number; end: number }) => `${clip.start}:${clip.end}`)).size).toBe(3);
  expect(finished.warnings).toContain("Music found 3 valid unique lyric windows and repeated 10 window(s) to fill 13 requested clips.");
  expect(await page.getByText(/Music found 3 valid unique lyric windows and repeated 10 window/).count()).toBe(1);

  const assetsResponse = await request.get("/api/v1/library/assets");
  expect(assetsResponse.ok()).toBeTruthy();
  const assets = await assetsResponse.json();
  const published = assets.filter((asset: { id: string }) => finished.clips.some((clip: { libraryAssetId: string }) => clip.libraryAssetId === asset.id));
  expect(published).toHaveLength(13);
  expect(published.every((asset: { origin: string }) => asset.origin === "generated-clip")).toBe(true);

  await expect(page.locator(".clip-tile.complete")).toHaveCount(13);
  await page.locator(".clip-tile.complete").first().getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator("video").last();
  await expect(preview).toBeVisible();
  await preview.evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);

  await page.reload();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByText(/Music found 3 valid unique lyric windows and repeated 10 window/)).toBeVisible();
  await expect(page.locator(".clip-tile.complete")).toHaveCount(13);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Short creation progress" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });

  const exportResponse = await request.post(`/api/v1/jobs/${jobId}/export`, { data: { clipIds: finished.clips.map((clip: { id: string }) => clip.id) } });
  expect(exportResponse.ok(), await exportResponse.text()).toBeTruthy();
  const exportInfo = await exportResponse.json();
  const zip = await request.get(exportInfo.downloadUrl);
  expect(zip.ok()).toBeTruthy();
  await fs.mkdir(artifacts!, { recursive: true });
  await fs.writeFile(path.join(artifacts!, "music-duplicate-export.zip"), await zip.body());
  for (let index = 0; index < finished.clips.length; index++) {
    const clip = finished.clips[index];
    const output = await request.get(clip.downloadUrl);
    expect(output.ok(), `clip ${clip.index} download`).toBeTruthy();
    await fs.writeFile(path.join(artifacts!, `music-duplicate-${String(index + 1).padStart(2, "0")}.mp4`), await output.body());
  }

  // Supported iPhone status layout sees the persisted job after reload.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  try {
    const statusPage = await mobile.newPage();
    await statusPage.goto(process.env.S6_ACCEPTANCE_URL || "http://100.99.111.109:8187");
    await expect(statusPage.getByRole("heading", { name: "Nothing running" })).toBeVisible();
    await expect(statusPage.getByRole("heading", { name: "Recent runs" })).toBeVisible();
    await expect(statusPage.getByRole("button", { name: /Music duplicate-window review complete/ }).first()).toBeVisible();
    await statusPage.screenshot({ path: path.join(artifacts!, "music-duplicate-mobile-status.png"), fullPage: true });
  } finally {
    await mobile.close();
  }
  expect(browserErrors.filter(error => !error.startsWith("The Cross-Origin-Opener-Policy header has been ignored"))).toEqual([]);
  expect(failedRequests.filter(value => (value.includes("/api/") || value.includes("/jobs/")) && !value.includes("net::ERR_ABORTED"))).toEqual([]);
  await testInfo.attach("completed-job", { body: JSON.stringify(finished, null, 2), contentType: "application/json" });
});
