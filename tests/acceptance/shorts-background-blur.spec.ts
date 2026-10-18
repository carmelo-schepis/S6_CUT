import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createClipProject, gateway, root } from "./support/workspace";

const approvedUrl = "https://www.youtube.com/watch?v=KNVr5pHAygI";
const aspects = ["9:16", "1:1", "4:5", "16:9"] as const;
type Aspect = (typeof aspects)[number];
type Job = {
  id: string;
  projectId: string;
  mode: string;
  state: string;
  clips: { state: string; outputName?: string | null; start: number; end: number }[];
};
type Project = { id: string; name: string; createdAt?: string; sourceKind?: string };
type Probe = { format: { duration?: string }; streams: { codec_type: string; width?: number; height?: number }[] };

test.setTimeout(45 * 60_000);

const artifacts = path.join(root, "test-artifacts");
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function engineBinary(args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("docker", ["compose", "exec", "-T", "engine", ...args], { cwd: root });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(`${args[0]} failed: ${Buffer.concat(stderr).toString().slice(-500)}`)));
  });
}

async function engineText(args: string[]) {
  return (await engineBinary(args)).toString("utf8");
}

async function probe(file: string): Promise<Probe> {
  return JSON.parse(await engineText(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", file])) as Probe;
}

async function frame(file: string, timestamp: number, filter: string) {
  return engineBinary([
    "ffmpeg", "-v", "error", "-ss", timestamp.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", `${filter},scale=64:64:flags=bilinear,format=gray`, "-f", "rawvideo", "-",
  ]);
}

function mean(frameData: Buffer) {
  return [...frameData].reduce((sum, value) => sum + value, 0) / frameData.length;
}

function edgeEnergy(frameData: Buffer) {
  let total = 0;
  for (let y = 0; y < 63; y += 1) {
    for (let x = 0; x < 63; x += 1) {
      const index = y * 64 + x;
      total += Math.abs(frameData[index] - frameData[index + 1]) + Math.abs(frameData[index] - frameData[index + 64]);
    }
  }
  return total / (63 * 63 * 2);
}

function layoutRegions(sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number) {
  if (Math.abs((sourceWidth / sourceHeight) / (outputWidth / outputHeight) - 1) <= 0.12) return null;
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const fitWidth = Math.round(sourceWidth * scale);
  const fitHeight = Math.round(sourceHeight * scale);
  if (fitHeight < outputHeight) {
    const band = Math.max(2, Math.floor((outputHeight - fitHeight) / 2) - 4);
    return {
      foreground: `crop=${outputWidth}:${fitHeight}:0:${Math.floor((outputHeight - fitHeight) / 2)}`,
      background: [`crop=${outputWidth}:${band}:0:0`, `crop=${outputWidth}:${band}:0:${outputHeight - band}`],
    };
  }
  const band = Math.max(2, Math.floor((outputWidth - fitWidth) / 2) - 4);
  return {
    foreground: `crop=${fitWidth}:${outputHeight}:${Math.floor((outputWidth - fitWidth) / 2)}:0`,
    background: [`crop=${band}:${outputHeight}:0:0`, `crop=${band}:${outputHeight}:${outputWidth - band}:0`],
  };
}

async function apiJson<T>(pathname: string) {
  const response = await fetch(`${gateway}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return await response.json() as T;
}

async function findProjectJob(name: string) {
  const projects = await apiJson<Project[]>("/api/v1/projects");
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) return null;
  const jobs = await apiJson<Job[]>("/api/v1/jobs");
  return { project, job: jobs.find((candidate) => candidate.projectId === project.id) || null };
}

async function waitForComplete(name: string) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const result = await findProjectJob(name);
    if (result?.job && ["complete", "failed", "partial", "cancelled_kept"].includes(result.job.state)) {
      expect(result.job.state, `${name} completed`).toBe("complete");
      expect(result.job.clips.some((clip) => clip.state === "complete")).toBeTruthy();
      return result;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function queueShorts(page: Page, name: string, aspect: Aspect, source: "url" | string) {
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Editor", exact: true })).toBeVisible();
  if (source === "url") {
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    await page.getByLabel("YouTube URL").fill(approvedUrl);
  } else {
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    const libraryVideo = page.getByLabel("Library video");
    await expect(libraryVideo).toBeEnabled({ timeout: 30_000 });
    await libraryVideo.selectOption(source, { timeout: 30_000 });
  }
  await page.locator('input[aria-label="Start seconds"]').fill("0", { timeout: 10_000 });
  await page.locator('input[aria-label="End seconds"]').fill("10", { timeout: 10_000 });
  await page.locator('select[aria-label="Aspect ratio"]').selectOption(aspect, { timeout: 10_000 });
  await page.locator('input[placeholder="Optional project name"]').fill(name, { timeout: 10_000 });
  await page.getByRole("button", { name: "Queue short" }).click();
  return waitForComplete(name);
}

async function analyzeJob(result: { job: Job }, aspect: Aspect) {
  const clip = result.job.clips.find((candidate) => candidate.state === "complete");
  if (!clip?.outputName) throw new Error(`No completed output for ${aspect}`);
  const output = `/app/data/jobs/${result.job.id}/clips/${clip.outputName}`;
  const source = (await engineText(["sh", "-lc", `find /app/data/jobs/${result.job.id}/source -type f -print -quit`])).trim();
  const outputProbe = await probe(output);
  const framePng = await engineBinary(["ffmpeg", "-v", "error", "-ss", "1", "-i", output, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
  await fs.writeFile(path.join(artifacts, `shorts-blur-${aspect.replace(":", "-")}.png`), framePng);
  const video = outputProbe.streams.find((stream) => stream.codec_type === "video");
  const expected = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] }[aspect];
  expect([video?.width, video?.height]).toEqual(expected);
  const duration = Number(outputProbe.format.duration || 0);
  const sourceProbe = await probe(source);
  const sourceVideo = sourceProbe.streams.find((stream) => stream.codec_type === "video");
  if (!sourceVideo?.width || !sourceVideo.height) throw new Error("source video dimensions unavailable");
  const regions = layoutRegions(sourceVideo.width, sourceVideo.height, expected[0], expected[1]);
  const timestamps = [0.5, Math.max(0.5, duration / 2), Math.max(0.5, duration - 0.5)];
  const sourceBackgroundCrops = regions
    ? (() => {
      const targetAspect = expected[0] / expected[1];
      const sourceAspect = sourceVideo.width! / sourceVideo.height!;
      const coverWidth = sourceAspect > targetAspect ? Math.floor(sourceVideo.height! * targetAspect) : sourceVideo.width!;
      const coverHeight = sourceAspect > targetAspect ? sourceVideo.height! : Math.floor(sourceVideo.width! / targetAspect);
      const coverX = Math.floor((sourceVideo.width! - coverWidth) / 2);
      const coverY = Math.floor((sourceVideo.height! - coverHeight) / 2);
      const fitScale = Math.min(expected[0] / sourceVideo.width!, expected[1] / sourceVideo.height!);
      const fitHeight = Math.round(sourceVideo.height! * fitScale);
      const band = fitHeight < expected[1] ? Math.max(2, Math.floor((expected[1] - fitHeight) / 2) - 4) : 2;
      const sourceBand = Math.max(2, Math.floor(coverHeight * band / expected[1]));
      return [`crop=${coverWidth}:${sourceBand}:${coverX}:${coverY}`, `crop=${coverWidth}:${sourceBand}:${coverX}:${coverY + coverHeight - sourceBand}`];
    })()
    : [];
  const samples = [];
  for (const timestamp of timestamps) {
    if (regions) {
      const foreground = await frame(output, timestamp, regions.foreground);
      const backgrounds = await Promise.all(regions.background.map((crop) => frame(output, timestamp, crop)));
      const sourceBackgrounds = await Promise.all(sourceBackgroundCrops.map((crop) => frame(source, clip.start + timestamp, crop)));
      const backgroundMean = backgrounds.reduce((sum, sample) => sum + mean(sample), 0) / backgrounds.length;
      const sourceMean = sourceBackgrounds.reduce((sum, sample) => sum + mean(sample), 0) / sourceBackgrounds.length;
      const luminanceRatio = Math.min(...backgrounds.map((sample, index) => mean(sample) / Math.max(1, mean(sourceBackgrounds[index]))));
      const backgroundEdge = backgrounds.reduce((sum, sample) => sum + edgeEnergy(sample), 0) / backgrounds.length;
      samples.push({ timestamp, sourceLuminance: sourceMean, backgroundLuminance: backgroundMean, luminanceRatio, foregroundEdgeEnergy: edgeEnergy(foreground), backgroundEdgeEnergy: backgroundEdge });
    } else {
      const sourceMean = mean(await frame(source, clip.start + timestamp, "null"));
      samples.push({ timestamp, sourceLuminance: sourceMean, backgroundLuminance: mean(await frame(output, timestamp, "null")), luminanceRatio: 1, foregroundEdgeEnergy: null, backgroundEdgeEnergy: null });
    }
  }
  const mismatched = Boolean(regions);
  if (mismatched) {
    expect(Math.min(...samples.map((sample) => sample.luminanceRatio))).toBeGreaterThanOrEqual(0.72);
    expect(samples.every((sample) => (sample.backgroundEdgeEnergy || 0) < (sample.foregroundEdgeEnergy || 0) * 0.9)).toBeTruthy();
  }
  return { aspect, sourceDimensions: [sourceVideo.width, sourceVideo.height], outputDimensions: expected, blurPercent: 30, blurSigma: 30, testedTimestamps: timestamps, samples, verdict: "PASS" };
}

test("renders undarkened blurred Shorts backgrounds across every aspect", async ({ page }) => {
  await fs.mkdir(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const projectIds: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => { if (!/\/api\/v1\/jobs\/[^/]+\/events(?:\?|$)/.test(request.url()) && !/\/api\/v1\/library\/assets\/[^/]+\/preview(?:\?|$)/.test(request.url())) failedRequests.push(`${request.method()} ${request.url()}`); });
  const names = Object.fromEntries(aspects.map((aspect) => [aspect, `Shorts blur ${aspect.replace(":", "-")} ${Date.now()}`])) as Record<Aspect, string>;
  const reports: Record<string, unknown>[] = [];
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Projects", exact: true }).first().click();
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    const first = await queueShorts(page, names["9:16"], "9:16", "url");
    projectIds.push(first.project.id);
    for (const aspect of ["1:1", "16:9"] as const) {
      const result = await queueShorts(page, names[aspect], aspect, "url");
      projectIds.push(result.project.id);
    }
    const smartResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/clip"));
    const smartName = names["4:5"];
    await createClipProject(page, { name: smartName, count: 1, mode: "Smart", aspect: "4:5", style: "Educational", min: 8, max: 12, captions: false, source: { kind: "url", url: approvedUrl } });
    expect((await smartResponse).ok()).toBeTruthy();
    const smart = await waitForComplete(smartName);
    projectIds.push(smart.project.id);
    for (const [aspect, name] of Object.entries(names) as [Aspect, string][]) {
      const result = await findProjectJob(name);
      expect(result?.job).toBeTruthy();
      reports.push(await analyzeJob({ job: result!.job! }, aspect));
    }
    await fs.writeFile(path.join(artifacts, "shorts-blur-analysis.json"), JSON.stringify(reports, null, 2));
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    for (const projectId of projectIds) await page.request.delete(`${gateway}/api/v1/projects/${encodeURIComponent(projectId)}?delete_assets=true`, { timeout: 30_000 }).catch(() => undefined);
    if (reports.length) await fs.writeFile(path.join(artifacts, "shorts-blur-analysis.json"), JSON.stringify(reports, null, 2));
  }
});
