import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const authorizedFixtureUrl = "https://www.youtube.com/watch?v=8xEuFQz4E4A";

test("live authorized YouTube source downloads as a complete MP4 with audio", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(authorizedFixtureUrl);
  const button = page.getByRole("button", { name: "Download video" });
  const downloadEvent = page.waitForEvent("download", { timeout: 210_000 });
  await button.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/i);
  const artifactPath = path.join(testInfo.outputDir, `live-source-${testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-")}.mp4`);
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await download.saveAs(artifactPath);
  const stat = await fs.stat(artifactPath);
  expect(stat.size).toBeGreaterThan(50_000);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name", "-of", "json", artifactPath], { encoding: "utf8" })) as { format: { duration: string; format_name: string }; streams: Array<{ codec_type: string; codec_name: string }> };
  expect(probe.format.format_name).toContain("mp4");
  expect(Number(probe.format.duration)).toBeGreaterThan(0);
  expect(probe.streams.some((stream) => stream.codec_type === "video")).toBeTruthy();
  expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBeTruthy();
  await testInfo.attach("live-youtube-full-source-mp4", { path: artifactPath, contentType: "video/mp4" });
  await testInfo.attach("live-youtube-ffprobe", { body: Buffer.from(JSON.stringify(probe, null, 2)), contentType: "application/json" });
});
