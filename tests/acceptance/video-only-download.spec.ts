import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const validUrl = "https://www.youtube.com/watch?v=8xEuFQz4E4A";
const taskApi = "**/api/v1/video-downloads";

// Service workers can hide requests from Playwright's route interception, so keep
// failure/stale-response tests deterministic across Chromium and WebKit.
test.use({ serviceWorkers: "block" });

async function openYoutubeSource(page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  const urlInput = page.getByRole("textbox", { name: "YouTube URL" });
  await urlInput.fill(validUrl);
  return { urlInput, downloadButton: page.getByRole("button", { name: "Download video" }) };
}

test("one click downloads a genuine full-duration source MP4 with audio and no clip pipeline", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const pipelinePosts: string[] = [];
  const createRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (/\/api\/v1\/(?:jobs|projects|openrouter|profiles)(?:\/|$)/.test(new URL(request.url()).pathname)) pipelinePosts.push(request.url());
    if (new URL(request.url()).pathname === "/api/v1/video-downloads") createRequests.push(request.url());
  });
  const { downloadButton } = await openYoutubeSource(page);
  await expect(downloadButton).toBeEnabled();
  await expect(downloadButton).toHaveText("Download video");

  const downloadEvent = page.waitForEvent("download", { timeout: 90_000 });
  await downloadButton.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/i);
  await expect(downloadButton).toHaveText("Download video");
  expect(createRequests).toHaveLength(1);
  expect(pipelinePosts).toEqual([]);

  const artifactPath = path.join(testInfo.outputDir, `full-source-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.mp4`);
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await download.saveAs(artifactPath);
  const stat = await fs.stat(artifactPath);
  expect(stat.size).toBeGreaterThan(50_000);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,sample_rate,channels", "-of", "json", artifactPath], { encoding: "utf8" })) as { format: { duration: string; format_name: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string; channels?: number }> };
  expect(probe.format.format_name).toContain("mp4");
  expect(Number(probe.format.duration)).toBeCloseTo(24.021, 1);
  expect(probe.streams).toEqual(expect.arrayContaining([
    expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 320, height: 180 }),
    expect.objectContaining({ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 1 }),
  ]));
  await testInfo.attach("genuine-full-source-mp4", { path: artifactPath, contentType: "video/mp4" });
  await testInfo.attach("ffprobe-evidence", { body: Buffer.from(JSON.stringify(probe, null, 2)), contentType: "application/json" });
  await testInfo.attach("download-evidence", { body: Buffer.from(JSON.stringify({ filename: download.suggestedFilename(), bytes: stat.size, createRequests: createRequests.length, clipPipelinePosts: pipelinePosts.length }, null, 2)), contentType: "application/json" });
});

test("invalid URL and failed request show useful errors; same button retries and renews signed link", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  const urlInput = page.getByRole("textbox", { name: "YouTube URL" });
  const button = page.getByRole("button", { name: "Download video" });
  await urlInput.fill("https://example.com/not-youtube");
  await button.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/valid.*YouTube URL/i);
  const buttonBox = await button.boundingBox();
  const alertBox = await alert.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(alertBox).not.toBeNull();
  expect(alertBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height - 1);

  let failOnce = true;
  await page.route(taskApi, async (route) => {
    if (route.request().method() === "POST" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Controlled download failure; retry" }) });
      return;
    }
    await route.continue();
  });
  await urlInput.fill(validUrl);
  await button.click();
  await expect(page.getByRole("alert")).toContainText(/controlled download failure/i);

  const firstEvent = page.waitForEvent("download", { timeout: 90_000 });
  await button.click();
  const firstDownload = await firstEvent;
  await expect(button).toHaveText("Download video");
  const firstDownloadPath = path.join(testInfo.outputDir, `retry-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.mp4`);
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await firstDownload.saveAs(firstDownloadPath);

  const taskId = await page.evaluate(() => window.localStorage.getItem("s6-cut.video-download-only-task"));
  expect(taskId).toMatch(/^[0-9a-f]{32}$/);
  const firstTaskResponse = await page.request.get(`/api/v1/video-downloads/${taskId}`);
  expect(firstTaskResponse.ok()).toBeTruthy();
  const firstSignedUrl = (await firstTaskResponse.json()).downloadUrl as string;
  expect(firstSignedUrl).toContain("signature=");

  await page.waitForTimeout(1200);
  const renewedEvent = page.waitForEvent("download", { timeout: 15_000 });
  await button.click();
  const renewedDownload = await renewedEvent;
  const renewedTaskResponse = await page.request.get(`/api/v1/video-downloads/${taskId}`);
  const renewedSignedUrl = (await renewedTaskResponse.json()).downloadUrl as string;
  expect(renewedSignedUrl).toContain("signature=");
  expect(renewedSignedUrl).not.toBe(firstSignedUrl);
  expect(renewedDownload.suggestedFilename()).toMatch(/\.mp4$/i);
  expect(await fs.stat(firstDownloadPath).then((file) => file.size)).toBeGreaterThan(50_000);
});

test("double-click produces only one task creation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(validUrl);
  const button = page.getByRole("button", { name: "Download video" });
  let createCount = 0;
  await page.route(taskApi, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Controlled duplicate-click check" }) });
  });
  await button.dblclick();
  await expect(page.getByRole("alert")).toContainText(/controlled duplicate-click check/i);
  expect(createCount).toBe(1);
});

test("changing URL while a request is pending cannot download stale video", async ({ page }) => {
  test.setTimeout(30_000);
  let releaseResponse: (() => void) | undefined;
  await page.route(taskApi, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "a".repeat(32), url: validUrl, state: "complete", phase: "complete", filename: "stale.mp4", downloadUrl: "/stale-signed-file" }) });
  });
  const { urlInput } = await openYoutubeSource(page);
  const downloadButton = page.locator(".video-only-download > button");
  const downloadEvents: string[] = [];
  page.on("download", (download) => downloadEvents.push(download.suggestedFilename()));
  await downloadButton.click();
  await expect(downloadButton).toContainText("Downloading…");
  await urlInput.fill("https://www.youtube.com/watch?v=abcdefghijk");
  releaseResponse?.();
  await expect(downloadButton).toHaveText("Download video");
  await page.waitForTimeout(300);
  expect(downloadEvents).toEqual([]);
});

test("ordinary YouTube clip creation still submits the clip job", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(validUrl);
  const jobsPost = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/jobs/clip", { timeout: 30_000 });
  await page.getByRole("button", { name: /Create \d+ short clips?/ }).click();
  const response = await jobsPost;
  expect(response.status()).toBe(202);
  expect(response.request().postData()).toContain(validUrl);
  expect(response.request().postData()).toContain("count");
});
