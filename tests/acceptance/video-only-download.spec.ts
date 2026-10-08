import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const validUrl = "https://www.youtube.com/watch?v=8xEuFQz4E4A";

test("downloads one full source MP4 without entering project or clip processing", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const unexpectedPipelineRequests: string[] = [];
  let fileResponse: { contentType: string; disposition: string } | null = null;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/v1\/(?:jobs|projects|openrouter|profiles)/.test(request.url())) unexpectedPipelineRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  const urlInput = page.getByRole("textbox", { name: "YouTube URL" });
  await urlInput.fill(validUrl);
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  const downloadButton = page.getByRole("button", { name: "Download video only" });
  await expect(downloadButton).toBeEnabled();
  await urlInput.focus();
  await page.keyboard.press("Tab");
  await expect(downloadButton).toBeFocused();

  const downloadEvent = page.waitForEvent("download", { timeout: 80_000 });
  await page.keyboard.press("Enter");
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("youtube-video.mp4");
  const downloadLink = page.getByRole("link", { name: "Download MP4" });
  await expect(downloadLink).toBeVisible();
  await expect(page.locator(".video-only-status")).toContainText("Ready");
  // Browser downloads are emitted as Download events, not always as page
  // Response events, so inspect the same server-issued URL explicitly too.
  const signedHref = await downloadLink.getAttribute("href");
  expect(signedHref).toBeTruthy();
  const mediaResponse = await page.request.get(new URL(signedHref!, page.url()).href);
  expect(mediaResponse.ok()).toBe(true);
  const headers = mediaResponse.headers();
  fileResponse = { contentType: headers["content-type"] || "", disposition: headers["content-disposition"] || "" };
  expect(fileResponse?.contentType).toMatch(/^video\/mp4(?:;|$)/);
  expect(fileResponse?.disposition).toMatch(/attachment/i);
  expect(fileResponse?.disposition).toContain("youtube-video.mp4");
  expect(unexpectedPipelineRequests).toEqual([]);

  const artifactPath = path.join(testInfo.outputDir, `downloaded-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.mp4`);
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await download.saveAs(artifactPath);
  await testInfo.attach("downloaded-mp4", { path: artifactPath, contentType: "video/mp4" });
  await testInfo.attach("download-headers", { body: Buffer.from(JSON.stringify(fileResponse, null, 2)), contentType: "application/json" });
  await expect(page).toHaveURL(/\/$/);
});
