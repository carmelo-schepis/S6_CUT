import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });

test("downloads only completed MP4s in a titled Unicode ZIP", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("All local tools ready")).toBeVisible();
  const title = `Café / Launch: Final? Bulk ${Date.now()}`;
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim().replace(/[ .]+$/, "");
  const sourcePath = "/tmp/s6-cut-bulk-source.mp4";
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "3", "-i", "/Users/dummy/Documents/S6_CUT/test-video.mp4", "-t", "45", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", sourcePath]);
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

  const clipsDir = "/Users/dummy/Documents/S6_CUT/data/jobs/" + job!.id + "/clips";
  for (const clip of job!.clips) {
    const stem = clip.outputName!.replace(/\.[^.]+$/, "");
    writeFileSync(join(clipsDir, `${stem}.ass`), "subtitle sidecar");
    writeFileSync(join(clipsDir, `${stem}.srt`), "subtitle sidecar");
    writeFileSync(join(clipsDir, `${stem}.vtt`), "subtitle sidecar");
  }
  writeFileSync(join(clipsDir, "metadata.json"), "metadata");
  writeFileSync(join(clipsDir, ".DS_Store"), "mac metadata");
  writeFileSync(join(clipsDir, "render.mp4.partial"), "temporary");

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
  ]);
  expect(entries.every(([name, size]) => name.startsWith(`${safeTitle}/`) && name.toLowerCase().endsWith(".mp4") && size > 0)).toBeTruthy();
  expect(entries.some(([name]) => /\.(ass|srt|vtt|json|log|partial|DS_Store)$/i.test(name))).toBe(false);
  expect(consoleErrors).toEqual([]);
  const unexpectedFailures = failedRequests.filter((failure) => !failure.includes("/api/v1/library/assets/") && !failure.includes("/api/v1/files/exports/") );
  expect(unexpectedFailures).toEqual([]);
  expect(projectsResponse.status()).toBe(200);
  mkdirSync(testInfo.outputDir, { recursive: true });
});
