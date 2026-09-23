import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

test.describe.configure({ mode: "serial" });

test("downloads only completed MP4s in a titled Unicode ZIP", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "failed";
    // Navigating away can abort an in-flight video preview request; it is not
    // an application failure. Every other failed request remains actionable.
    if (errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("Local engine ready")).toBeVisible();
  const existingJobsResponse = await page.request.get("/api/v1/jobs");
  if (existingJobsResponse.ok()) {
    const existingJobs = await existingJobsResponse.json() as { id: string; state: string }[];
    await Promise.all(existingJobs.filter((item) => ["queued", "active", "paused", "recovered"].includes(item.state)).map((item) => page.request.post(`/api/v1/jobs/${item.id}/control/stop-keep`)));
  }
  const title = `Café / Launch: Final? Bulk ${Date.now()}`;
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim().replace(/[ .]+$/, "");
  // The engine's data mount, not necessarily the repo's ./data: an isolated
  // stack points S6_DATA_PATH at a throwaway dataset, and the fixture has to be
  // written where that container can actually read it.
  const dataRoot = process.env.S6_DATA_PATH ? resolve(process.env.S6_DATA_PATH) : join(process.cwd(), "data");
  const sourcePath = join(dataRoot, "test-artifacts", "bulk-source.mp4");
  mkdirSync(join(dataRoot, "test-artifacts"), { recursive: true });
  // Host-generated fixtures must remain writable to the non-root engine
  // container when the isolated acceptance stack uses a host bind mount.
  try {
    chmodSync(join(dataRoot, "test-artifacts"), 0o777);
  } catch (error) {
    // The existing stack's fixture directory can be engine-owned. EPERM is
    // harmless there; ffmpeg will verify the directory's actual writability.
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
  }
  const sourceInput = join(dataRoot, "test-artifacts", "bulk-input.mp4");
  copyFileSync(join(process.cwd(), "test-video.mp4"), sourceInput);
  const ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "3", "-i", sourceInput, "-t", "45", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", sourcePath];
  try {
    execFileSync("ffmpeg", ffmpegArgs);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    execFileSync("docker", ["compose", "exec", "-T", "engine", "ffmpeg", ...ffmpegArgs.map((value) => value.replace(dataRoot, "/app/data").replace(process.cwd(), "/app"))]);
  }
  await page.getByLabel("Project name").fill(title);
  await page.getByLabel("Choose video file").setInputFiles(sourcePath);
  await page.getByRole("button", { name: "Fewer clips" }).click();
  await page.getByRole("button", { name: "Fewer clips" }).click();
  await page.getByRole("button", { name: "Fewer clips" }).click();
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Advanced controls" }).click();
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("10");
  await page.screenshot({ path: testInfo.outputPath("bulk-download-ui.png"), fullPage: false });
  await page.getByRole("button", { name: "Create 2 short clips" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

  const projectsResponse = await page.request.get("/api/v1/projects");
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json() as { id: string; name: string; latestJobId: string }[];
  const project = projects.find((item) => item.name === title);
  expect(project).toBeDefined();
  let job: { id: string; state: string; clips: { id: string; state: string; outputName: string | null }[] } | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/jobs/${project!.latestJobId}`);
    expect(response.ok()).toBeTruthy();
    job = await response.json();
    return job?.state;
  }, { timeout: 180_000, intervals: [1000, 2000, 5000] }).toBe("complete");
  expect(job?.clips.length).toBe(2);
  expect(job?.clips.every((clip) => clip.state === "complete" && clip.outputName)).toBeTruthy();

  const outputNames = job!.clips.map((clip) => clip.outputName!);
  execFileSync("docker", ["compose", "exec", "-T", "engine", "python", "-c", `from pathlib import Path
import sys
clips = Path('/app/data/jobs') / sys.argv[1] / 'clips'
for output_name in sys.argv[2:]:
    stem = Path(output_name).stem
    for suffix in ('.ass', '.srt', '.vtt'):
        (clips / f'{stem}{suffix}').write_text('subtitle sidecar')
(clips / 'metadata.json').write_text('metadata')
(clips / '.DS_Store').write_text('mac metadata')
(clips / 'render.mp4.partial').write_text('temporary')`, job!.id, ...outputNames]);

  const checks = page.locator('input[type="checkbox"]');
  for (let index = 0; index < await checks.count(); index += 1) if (!(await checks.nth(index).isChecked())) await checks.nth(index).check();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const download = await downloadPromise;
  const zipPath = testInfo.outputPath(`${safeTitle}.zip`);
  await download.saveAs(zipPath);
  expect(download.suggestedFilename()).toBe(`${safeTitle}.zip`);

  const listing = execFileSync("python3", ["-c", `import json, zipfile, sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps([(n, z.getinfo(n).file_size) for n in z.namelist()]))`, zipPath], { encoding: "utf8" }).trim();
  const entries = JSON.parse(listing) as [string, number][];
  expect(entries).toEqual([
    [`${safeTitle}/01-01-cut.mp4`, expect.any(Number)],
    [`${safeTitle}/02-02-cut.mp4`, expect.any(Number)],
    [`${safeTitle}/manifest.json`, expect.any(Number)],
    [`${safeTitle}/credits.json`, expect.any(Number)],
    [`${safeTitle}/warning-summary.json`, expect.any(Number)],
  ]);
  const media = entries.filter(([name]) => name.toLowerCase().endsWith(".mp4"));
  expect(media.every(([name, size]) => name.startsWith(`${safeTitle}/`) && size > 0)).toBeTruthy();
  const metadata = Object.fromEntries(entries.filter(([name]) => name.toLowerCase().endsWith(".json")));
  expect(metadata).toEqual({
    [`${safeTitle}/manifest.json`]: expect.any(Number),
    [`${safeTitle}/credits.json`]: expect.any(Number),
    [`${safeTitle}/warning-summary.json`]: expect.any(Number),
  });
  expect(entries.some(([name]) => /\.(ass|srt|vtt|log|partial|DS_Store)$/i.test(name))).toBe(false);
  expect(consoleErrors).toEqual([]);
  const unexpectedFailures = failedRequests.filter((failure) => !failure.includes("/api/v1/library/assets/") && !failure.includes("/api/v1/files/exports/") );
  expect(unexpectedFailures).toEqual([]);
  expect(projectsResponse.status()).toBe(200);
  mkdirSync(testInfo.outputDir, { recursive: true });
});
