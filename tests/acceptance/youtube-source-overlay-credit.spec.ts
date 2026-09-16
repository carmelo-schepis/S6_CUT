import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertPlayback,
  checkPlayback,
  collectClips,
  gateway,
  jobBoundaries,
  openProjects,
  createClipProject,
  waitForProjectReady,
} from "./support/workspace";

const approvedUrl = "https://www.youtube.com/watch?v=KNVr5pHAygI";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const artifacts = path.join(root, "test-artifacts/youtube-source-overlay-credit");
const dataRoot = path.join(root, "data");
const deadlineMs = 45 * 60_000;
const mediaImage = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";
const workPath = (value: string) => `/work/${path.relative(root, value)}`;
const runMediaTool = (tool: string, args: string[], encoding?: BufferEncoding) => execFileSync("docker", [
  "run", "--rm", "--network", "none", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  "-v", `${root}:/work`, "--entrypoint", tool, mediaImage, ...args,
], encoding ? { encoding } : undefined);

test("renders a clean Smart YouTube Short with a bottom-edge creator credit", async ({ page }) => {
  test.setTimeout(deadlineMs + 60_000);
  await fs.mkdir(artifacts, { recursive: true });
  const projectName = `YouTube source overlay credit ${Date.now()}`;
  let projectId: string | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!/\/api\/v1\/jobs\/[^/]+\/events(?:\?|$)/.test(url) && !/\/api\/v1\/library\/assets\/[^/]+\/preview(?:\?|$)/.test(url) && !/\/api\/v1\/files\/exports\//.test(url)) {
      failedRequests.push(`${request.method()} ${url} — ${request.failure()?.errorText || "failed"}`);
    }
  });

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await createClipProject(page, {
      name: projectName,
      count: 1,
      mode: "Smart",
      aspect: "9:16",
      style: "Educational",
      min: 15,
      max: 45,
      captions: true,
      source: { kind: "url", url: approvedUrl },
    });

    const created = await jobBoundaries(projectName);
    projectId = created.project.id;
    expect(created.project.sourceKind).toBe("youtube");
    expect(created.job.processingMode).toBe("smart");
    await waitForProjectReady(page, new Set(), "clip", deadlineMs);
    const outputDir = path.join(artifacts, "output");
    const clips = await collectClips(page, projectName, outputDir);
    expect(clips).toHaveLength(1);
    const clip = clips[0];
    checkPlayback(clip.playback, "Smart YouTube output");
    expect(clip.playback.videoWidth).toBe(1080);
    expect(clip.playback.videoHeight).toBe(1920);

    const job = (await jobBoundaries(projectName)).job;
    const jobClip = job.clips.find((item: { id: string }) => item.id === clip.id);
    expect(jobClip?.creatorCredit).toMatch(/^Source: /);
    expect(jobClip?.fallbackUsed).toBeFalsy();
    expect(jobClip?.provenance.some((item: { provider: string }) => item.provider === "local-text-card")).toBeFalsy();

    const clipDir = path.join(dataRoot, "jobs", job.id, "clips");
    const burnName = (await fs.readdir(clipDir)).find((name) => name.endsWith(".burn.ass"));
    expect(burnName, "the credited ASS burn script exists").toBeTruthy();
    const assPath = path.join(clipDir, burnName!);
    const assArtifact = path.join(artifacts, path.basename(assPath));
    await fs.copyFile(assPath, assArtifact);
    const ass = await fs.readFile(assPath, "utf8");
    const creditStyle = ass.split("\n").find((line) => line.startsWith("Style: Credit,"));
    expect(creditStyle).toBeTruthy();
    const creditFields = creditStyle!.slice("Style: ".length).split(",");
    expect(["1", "3"]).toContain(creditFields[18]);
    expect(Number(creditFields[21])).toBe(Math.max(12, Math.round(1920 * .0125)));
    expect(Number(creditFields[21])).toBeLessThanOrEqual(1920 * .02);
    expect(ass).toMatch(/^Dialogue: 2,0,0:00:/m);
    expect(ass).not.toMatch(/^Dialogue: \d+,.*?,Visual,/m);
    expect(ass).not.toMatch(/,Visual,,.*(?:Key idea|GPT)/);
    expect(ass).toMatch(/^Dialogue: 10,/m);

    const probe = JSON.parse(runMediaTool("ffprobe", [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", workPath(clip.downloadPath),
    ], "utf8")) as { streams: { codec_type?: string; width?: number; height?: number }[]; format: { duration?: string } };
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(Number(probe.format.duration)).toBeGreaterThan(0);

    const framePaths: string[] = [];
    const duration = Number(probe.format.duration);
    for (const [name, timestamp] of [["early", .75], ["middle", duration / 2], ["end", Math.max(.1, duration - .25)] as const]) {
      const frame = path.join(artifacts, `frame-${name}.png`);
      runMediaTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(timestamp), "-i", workPath(clip.downloadPath), "-frames:v", "1", workPath(frame)]);
      expect((await fs.stat(frame)).size).toBeGreaterThan(1_000);
      framePaths.push(frame);
    }
    const contactSheet = path.join(artifacts, "contact-sheet.png");
    runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", ...framePaths.flatMap((frame) => ["-i", workPath(frame)]),
      "-filter_complex", "[0:v]scale=540:-2[a];[1:v]scale=540:-2[b];[2:v]scale=540:-2[c];[a][b][c]hstack=inputs=3[outv]",
      "-map", "[outv]", workPath(contactSheet),
    ]);
    expect((await fs.stat(contactSheet)).size).toBeGreaterThan(1_000);
    await page.screenshot({ path: path.join(artifacts, "completed-project.png"), fullPage: true });

    // Preview remains a playable burned MP4 after a full page reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await page.locator(".project-card").filter({ hasText: projectName }).first().click();
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 60_000 });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "Smart YouTube output after reload");
    await page.screenshot({ path: path.join(artifacts, "preview-after-reload.png"), fullPage: true });

    const zipPath = path.join(artifacts, "youtube-source-overlay-credit.zip");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download ZIP/ }).click(),
    ]);
    await download.saveAs(zipPath);
    const manifestName = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").find((name) => name.endsWith("/manifest.json"));
    expect(manifestName).toBeTruthy();
    const manifest = JSON.parse(execFileSync("unzip", ["-p", zipPath, manifestName!], { encoding: "utf8" })) as {
      project?: { source_creator?: string | null };
      outputs?: { creator_credit?: string | null; provenance?: { provider: string }[] }[];
    };
    expect(manifest.project?.source_creator).toBeTruthy();
    expect(manifest.outputs?.[0]?.creator_credit).toBe(jobClip?.creatorCredit);
    expect(manifest.outputs?.[0]?.provenance?.some((item) => item.provider === "local-text-card")).toBeFalsy();

    expect(consoleErrors, "unexpected console errors").toEqual([]);
    expect(pageErrors, "unexpected page errors").toEqual([]);
    expect(failedRequests, "unexpected failed requests").toEqual([]);
  } finally {
    if (!projectId) {
      try { projectId = (await jobBoundaries(projectName)).project.id; } catch { /* creation may have failed before persistence */ }
    }
    if (projectId) {
      await page.request.delete(`${gateway}/api/v1/projects/${encodeURIComponent(projectId)}?delete_assets=true`, { timeout: 30_000 }).catch(() => undefined);
    }
  }
});
