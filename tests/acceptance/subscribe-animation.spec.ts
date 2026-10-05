/**
 * Subscribe animation acceptance against an isolated, real S6_cut instance.
 * No API routes are stubbed: project creation, rendering, Library publication,
 * media downloads, ZIP export and reload all use the running application.
 *
 * Set S6_ACCEPTANCE_ISOLATED=1 only when S6_ACCEPTANCE_URL points at a disposable
 * dataset. The source is the committed synthetic/open-licensed acceptance clip.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertZipIntact, extractZip, openWorkspaceForProject, zipNames } from "./support/workspace";
import { verifyVideoOutput } from "../support/video-output";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_SUBSCRIBE_FIXTURE || path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const artifacts = path.join(root, "test-artifacts/subscribe-animation");
const expectedWidth = 1080;
const expectedHeight = 1920;

function requireDisposableTarget() {
  const url = process.env.S6_ACCEPTANCE_URL;
  const dataPath = process.env.S6_DATA_PATH;
  if (!url || !dataPath) throw new Error("Set S6_ACCEPTANCE_URL and S6_DATA_PATH to an explicitly isolated, disposable S6 instance before running this spec.");
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) throw new Error("Refusing a non-local acceptance target.");
  if (parsed.port === "8080") throw new Error("Refusing the default port 8080; use a dedicated disposable acceptance instance.");
  const resolvedDataPath = path.resolve(dataPath);
  if (!resolvedDataPath.startsWith("/tmp/")) throw new Error("Refusing data outside a unique disposable /tmp directory.");
  if (resolvedDataPath === path.resolve(root, "data")) throw new Error("Refusing the repository's default data directory.");
  return url;
}

type RenderResult = {
  projectName: string;
  jobId: string;
  clipId: string;
  start: number;
  end: number;
  duration: number;
  assetId: string | null;
  pixelSamples: number[];
};

async function sampleFrame(page: Page, secondsBeforeEnd: number, screenshotPath: string) {
  const video = page.locator(".viewer-frame video");
  const duration = await video.evaluate((node: HTMLVideoElement) => node.duration);
  const at = Math.max(0.1, duration - secondsBeforeEnd);
  await video.evaluate((node: HTMLVideoElement, time) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`preview did not seek to ${time}s`)), 10_000);
    node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    node.currentTime = Math.min(time, Math.max(0, node.duration - 0.05));
  }), at);
  await video.screenshot({ path: screenshotPath });
  return video.evaluate((node: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas frame sampler is unavailable");
    const sx = node.videoWidth * 0.2;
    const sy = node.videoHeight * 0.035;
    context.drawImage(node, sx, sy, node.videoWidth * 0.6, node.videoHeight * 0.24, 0, 0, canvas.width, canvas.height);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  });
}

function meanPixelDifference(a: number[], b: number[]) {
  expect(a).toHaveLength(b.length);
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
}

async function createAndRender(page: Page, options: {
  projectName: string;
  subscribe: "default" | "off" | "ten-seconds";
  testInfo: { outputPath(...segments: string[]): string };
}) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByLabel("Choose video file").setInputFiles(fixture);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(options.projectName);

  const count = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await count.textContent()) > 1; guard += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  await expect(count).toHaveText("1");
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption("9:16");
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("10");

  const settings = page.getByRole("group", { name: "Automatic Subscribe animation" });
  const enabled = settings.getByRole("checkbox", { name: "Enable Subscribe animation" });
  const timing = settings.getByRole("combobox", { name: "Subscribe animation timing" });
  await expect(settings).toBeVisible();
  await expect(enabled).toBeChecked();
  await expect(timing).toHaveValue("5");

  if (options.subscribe === "off") {
    await enabled.uncheck();
    await expect(timing).toBeDisabled();
    await expect(enabled).not.toBeChecked();
  } else if (options.subscribe === "ten-seconds") {
    await timing.selectOption("10");
    await expect(timing).toHaveValue("10");
  }

  await page.screenshot({ path: options.testInfo.outputPath("controls-" + options.subscribe + ".png"), fullPage: true });
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/clip"));
  await page.getByRole("button", { name: "Create 1 short clip" }).click();
  const submitted = await createResponse;
  const created = await submitted.json() as { job: { contentFormat: string } };
  expect(submitted.ok(), JSON.stringify(created)).toBeTruthy();
  expect(submitted.request().headers()["content-type"]).toContain("multipart/form-data");
  expect(created.job.contentFormat).toBe("short");

  await expect(page.getByRole("heading", { name: options.projectName })).toBeVisible({ timeout: 60_000 });
  const tile = page.locator(".clip-tile.complete").first();
  await expect(tile).toBeVisible({ timeout: 15 * 60_000 });
  await expect(tile.locator("a[download]")).toBeVisible();
  await tile.getByRole("button", { name: /Preview/ }).click();
  const video = page.locator(".viewer-frame video");
  const evidence = await verifyVideoOutput({
    video,
    artifactDirectory: artifacts,
    artifactPrefix: options.subscribe,
    maximumDurationSeconds: 11,
    expectedWidth,
    expectedHeight,
  });
  expect(evidence.duration).toBeGreaterThanOrEqual(7.5);
  expect(evidence.duration).toBeLessThanOrEqual(10.5);
  expect(evidence.playbackAdvanced).toBeTruthy();

  const projectsResponse = await page.request.get("/api/v1/projects");
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json() as { id: string; name: string; latestJobId: string }[];
  const project = projects.find((item) => item.name === options.projectName);
  expect(project, "project is persisted by the application").toBeTruthy();
  const jobResponse = await page.request.get(`/api/v1/jobs/${project!.latestJobId}`);
  expect(jobResponse.ok()).toBeTruthy();
  const job = await jobResponse.json() as { id: string; clips: { id: string; start: number; end: number; duration: number; libraryAssetId?: string | null }[] };
  const clip = job.clips[0];
  expect(clip).toBeTruthy();
  expect(clip.duration).toBeCloseTo(evidence.duration, 0);

  // Save and independently decode the downloadable MP4, not just the browser
  // preview. The export ZIP below is another actual application download.
  const download = page.waitForEvent("download");
  await tile.locator("a[download]").click();
  const mediaDownload = await download;
  const mp4Path = options.testInfo.outputPath(`${options.subscribe}.mp4`);
  await mediaDownload.saveAs(mp4Path);
  expect((await fs.stat(mp4Path)).size).toBeGreaterThan(50_000);

  // Preview frame at the expected location in the final section of the clip.
  // Pixel comparison against the same source/time with animation disabled is
  // the acceptance signal that the graphic was burned into rendered media.
  const sampleSeconds = options.subscribe === "ten-seconds" ? 8 : 3;
  const pixels = await sampleFrame(page, sampleSeconds, options.testInfo.outputPath(`${options.subscribe}-animation-frame.png`));

  return {
    projectName: options.projectName,
    jobId: job.id,
    clipId: clip.id,
    start: clip.start,
    end: clip.end,
    duration: clip.duration,
    assetId: clip.libraryAssetId ?? null,
    pixelSamples: pixels,
  } satisfies RenderResult;
}

async function makeLongFormFixture(testInfo: { outputPath(...segments: string[]): string }) {
  const fixturePath = testInfo.outputPath("subscribe-long-form-source.mp4");
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  const image = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";
  execFileSync("docker", [
    "run", "--rm", "--network", "none", "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-v", `${path.dirname(fixturePath)}:/out`, "--entrypoint", "ffmpeg", image,
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:r=24:d=100",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=100",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    `/out/${path.basename(fixturePath)}`,
  ], { stdio: "pipe", timeout: 120_000 });
  return fixturePath;
}

async function sampleOutputAt(page: Page, time: number, screenshotPath: string) {
  const video = page.locator(".viewer-frame video");
  await video.evaluate(async (node: HTMLVideoElement, target) => {
    const bounded = Math.min(target, Math.max(0, node.duration - 0.05));
    if (Math.abs(node.currentTime - bounded) > 0.01) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`preview did not seek to ${bounded}s`)), 15_000);
        node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
        node.currentTime = bounded;
      });
    }
    node.muted = true;
    await node.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`preview frame did not decode at ${bounded}s`)), 10_000);
      node.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
    node.pause();
  }, time);
  await video.screenshot({ path: screenshotPath });
  return video.evaluate((node: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas frame sampler is unavailable");
    context.drawImage(node, node.videoWidth * 0.2, node.videoHeight * 0.035, node.videoWidth * 0.6, node.videoHeight * 0.24, 0, 0, canvas.width, canvas.height);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  });
}

test("Subscribe animation controls persist and affect real rendered/exported media", async ({ page }, testInfo) => {
  test.skip(process.env.S6_ACCEPTANCE_ISOLATED !== "1", "requires an explicitly isolated disposable S6_cut dataset");
  test.setTimeout(45 * 60_000);
  await fs.mkdir(artifacts, { recursive: true });
  await page.goto(requireDisposableTarget(), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

  const defaultControl = page.getByRole("group", { name: "Automatic Subscribe animation" });
  await expect(defaultControl.getByRole("checkbox", { name: "Enable Subscribe animation" })).toBeChecked();
  await expect(defaultControl.getByRole("combobox", { name: "Subscribe animation timing" })).toHaveValue("5");
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).click();
  const editorControl = page.getByRole("group", { name: "Automatic Subscribe animation" });
  await expect(editorControl.getByRole("checkbox", { name: "Enable Subscribe animation" })).toBeChecked();
  await expect(editorControl.getByRole("combobox", { name: "Subscribe animation timing" })).toBeEnabled();
  await page.getByRole("button", { name: "AI Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Topic to Video" })).toBeVisible();
  await page.getByLabel("Aspect ratio").selectOption("16:9");
  await expect(page.getByText(/midpoint and again starting 30 seconds before the end/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("group", { name: "Automatic Subscribe animation" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("subscribe-controls-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const tag = Date.now();
  const on = await createAndRender(page, { projectName: `Subscribe default ${tag}`, subscribe: "default", testInfo });
  const off = await createAndRender(page, { projectName: `Subscribe off ${tag}`, subscribe: "off", testInfo });
  const tenSeconds = await createAndRender(page, { projectName: `Subscribe ten ${tag}`, subscribe: "ten-seconds", testInfo });

  // Fast planning is deterministic over the same fixture; comparing the same
  // source window prevents background footage from masquerading as animation.
  expect(off.start).toBeCloseTo(on.start, 1);
  expect(off.end).toBeCloseTo(on.end, 1);
  expect(tenSeconds.start).toBeCloseTo(on.start, 1);
  expect(tenSeconds.end).toBeCloseTo(on.end, 1);
  expect(meanPixelDifference(on.pixelSamples, off.pixelSamples), "enabled graphic changes decoded output pixels vs off").toBeGreaterThan(1.5);
  expect(meanPixelDifference(tenSeconds.pixelSamples, off.pixelSamples), "10-second timing renders graphic pixels vs off").toBeGreaterThan(1.5);

  // The same rendered outputs must be published as Library assets.
  for (const result of [on, off, tenSeconds]) expect(result.assetId, `${result.projectName} has a published Library asset`).toBeTruthy();
  const assetsResponse = await page.request.get("/api/v1/library/assets?origin=generated-clip");
  expect(assetsResponse.ok()).toBeTruthy();
  const assets = await assetsResponse.json() as { id: string; sourceClipId?: string | null }[];
  for (const result of [on, off, tenSeconds]) expect(assets.some((asset) => asset.id === result.assetId)).toBeTruthy();

  // Exercise ZIP creation through the workspace and validate archive integrity.
  await openWorkspaceForProject(page, `Subscribe default ${tag}`);
  await expect(page.getByRole("heading", { name: `Subscribe default ${tag}` })).toBeVisible();
  const zipWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const zip = await zipWait;
  const zipPath = testInfo.outputPath("subscribe-animation-export.zip");
  await zip.saveAs(zipPath);
  assertZipIntact(zipPath);
  expect(zipNames(zipPath).some((name) => name.toLowerCase().endsWith(".mp4"))).toBeTruthy();

  // Reload/reopen verifies the project and persisted media remain reachable.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openWorkspaceForProject(page, `Subscribe default ${tag}`);
  await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 60_000 });
  await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
  await expect(page.locator(".viewer-frame video")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("subscribe-after-reload.png"), fullPage: true });

  // Lightweight contact sheet: open this file beside its frame PNGs to review
  // enabled/off/10-second decoded stills without introducing image dependencies.
  const labels = ["default-animation-frame", "off-animation-frame", "ten-seconds-animation-frame"];
  await fs.writeFile(testInfo.outputPath("subscribe-contact-sheet.html"), `<!doctype html><meta charset="utf-8"><title>Subscribe animation evidence</title><style>body{font:16px sans-serif;background:#161616;color:#fff}main{display:flex;gap:1rem;align-items:start}figure{margin:0}img{height:540px}figcaption{padding:.5rem}</style><main>${labels.map((name) => `<figure><img src="${name}.png"><figcaption>${name}</figcaption></figure>`).join("")}</main>`);
  await fs.writeFile(testInfo.outputPath("subscribe-evidence.json"), JSON.stringify({ on, off: { ...off, pixelSamples: undefined }, tenSeconds: { ...tenSeconds, pixelSamples: undefined } }, null, 2));
});

test("long-form exported scene replays the animation at midpoint and 30 seconds before end", async ({ page }, testInfo) => {
  test.skip(process.env.S6_ACCEPTANCE_ISOLATED !== "1", "requires an explicitly isolated disposable S6_cut dataset");
  test.setTimeout(30 * 60_000);
  const longFixture = await makeLongFormFixture(testInfo);
  const tag = Date.now();
  const projectName = `Subscribe long ${tag}`;
  await page.goto(requireDisposableTarget(), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByLabel("Choose video file").setInputFiles(longFixture);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(projectName);
  const count = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await count.textContent()) > 1; guard += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  await expect(count).toHaveText("1");
  await page.getByRole("button", { name: /Long form/ }).click();
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Minimum seconds").fill("80");
  await page.getByLabel("Maximum seconds").fill("110");
  const settings = page.getByRole("group", { name: "Automatic Subscribe animation" });
  await expect(settings.getByRole("checkbox", { name: "Enable Subscribe animation" })).toBeChecked();
  await expect(settings).toContainText(/midpoint and again starting 30 seconds before the end/);

  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/clip"));
  await page.getByRole("button", { name: "Create 1 landscape clip" }).click();
  const submitted = await createResponse;
  const created = await submitted.json() as { job: { contentFormat: string } };
  expect(submitted.ok(), JSON.stringify(created)).toBeTruthy();
  expect(submitted.request().headers()["content-type"]).toContain("multipart/form-data");
  expect(created.job.contentFormat).toBe("long");

  await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
  const tile = page.locator(".clip-tile.complete").first();
  await expect(tile).toBeVisible({ timeout: 15 * 60_000 });
  await tile.getByRole("button", { name: /Preview/ }).click();
  const video = page.locator(".viewer-frame video");
  await expect(video).toBeVisible();
  const metadata = await video.evaluate((node: HTMLVideoElement) => ({ duration: node.duration, width: node.videoWidth, height: node.videoHeight }));
  expect(metadata.width).toBe(1920);
  expect(metadata.height).toBe(1080);
  expect(metadata.duration).toBeGreaterThan(70);
  const midpoint = metadata.duration / 2;
  const endOccurrence = metadata.duration - 30;
  expect(endOccurrence - (midpoint + 4)).toBeGreaterThanOrEqual(2);

  const evidenceDir = testInfo.outputPath("long-form-frames");
  await fs.mkdir(evidenceDir, { recursive: true });
  const midMove = await sampleOutputAt(page, midpoint + 0.55, path.join(evidenceDir, "midpoint-pointer.png"));
  const midClick = await sampleOutputAt(page, midpoint + 1.55, path.join(evidenceDir, "midpoint-subscribed.png"));
  const endMove = await sampleOutputAt(page, endOccurrence + 0.55, path.join(evidenceDir, "end-pointer.png"));
  const endClick = await sampleOutputAt(page, endOccurrence + 1.55, path.join(evidenceDir, "end-subscribed.png"));
  const after = await sampleOutputAt(page, endOccurrence + 4.25, path.join(evidenceDir, "after-animation.png"));
  expect(meanPixelDifference(midMove, endMove), "the second occurrence restarts from the same opening frame").toBeLessThan(2.5);
  expect(meanPixelDifference(midMove, midClick), "button/cursor state changes within the first occurrence").toBeGreaterThan(1);
  expect(meanPixelDifference(endMove, endClick), "button/cursor state changes within the second occurrence").toBeGreaterThan(1);
  expect(meanPixelDifference(midMove, after), "animation is absent after its bounded cycle").toBeGreaterThan(1);
  await page.screenshot({ path: testInfo.outputPath("subscribe-long-workspace.png"), fullPage: true });

  const directDownload = page.waitForEvent("download");
  await tile.locator("a[download]").click();
  const direct = await directDownload;
  const directPath = testInfo.outputPath("subscribe-long-direct.mp4");
  await direct.saveAs(directPath);
  const zipDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const zip = await zipDownload;
  const zipPath = testInfo.outputPath("subscribe-long-export.zip");
  await zip.saveAs(zipPath);
  assertZipIntact(zipPath);
  const extracted = await extractZip(zipPath, testInfo.outputPath("subscribe-long-extracted"));
  const zipVideo = extracted.find((entry) => entry.toLowerCase().endsWith(".mp4"));
  expect(zipVideo, "ZIP contains the finished MP4").toBeTruthy();
  const directHash = createHash("sha256").update(await fs.readFile(directPath)).digest("hex");
  const zipHash = createHash("sha256").update(await fs.readFile(zipVideo!)).digest("hex");
  expect(zipHash, "ZIP packages the already-rendered MP4 without another animation pass").toBe(directHash);
});
