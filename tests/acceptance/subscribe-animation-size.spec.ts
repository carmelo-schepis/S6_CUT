/**
 * Real-app Subscribe animation acceptance. This spec deliberately requires an
 * explicitly disposable app URL and data directory; it never starts an app.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertZipIntact, extractZip, openWorkspaceForProject, zipNames } from "./support/workspace";
import { verifyVideoOutput } from "../support/video-output";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_SUBSCRIBE_FIXTURE || path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const artifacts = path.join(root, "test-artifacts/subscribe-animation");
const dimensions = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
} as const;
type Aspect = keyof typeof dimensions;
type Frame = { width: number; height: number; pixels: number[] };
type RenderResult = { projectName: string; jobId: string; clipId: string; start: number; end: number; duration: number; assetId: string | null; aspect: Aspect; mp4Path: string; stateFrames: Frame[]; offCycleFrame: Frame };

function requireDisposableTarget() {
  const url = process.env.S6_ACCEPTANCE_URL;
  const dataPath = process.env.S6_DATA_PATH;
  if (!url || !dataPath) throw new Error("Set S6_ACCEPTANCE_URL and S6_DATA_PATH to an explicitly isolated, disposable S6 instance before running this spec.");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Refusing a non-local acceptance target.");
  if (parsed.port === "8080") throw new Error("Refusing the default port 8080; use a dedicated disposable acceptance instance.");
  const resolvedDataPath = path.resolve(dataPath);
  if (!resolvedDataPath.startsWith("/tmp/")) throw new Error("Refusing data outside a unique disposable /tmp directory.");
  if (resolvedDataPath === path.resolve(root, "data")) throw new Error("Refusing the repository's default data directory.");
  return url;
}

async function captureFrame(page: Page, time: number, screenshotPath: string): Promise<Frame> {
  const video = page.locator(".viewer-frame video");
  await video.evaluate(async (node: HTMLVideoElement, target) => {
    const at = Math.min(target, Math.max(0, node.duration - 0.05));
    if (Math.abs(node.currentTime - at) > 0.01) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`video seek timed out at ${at}s`)), 15_000);
      node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.currentTime = at;
    });
    node.muted = true;
    await node.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`video did not decode at ${at}s`)), 10_000);
      node.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
    node.pause();
  }, time);
  await video.screenshot({ path: screenshotPath });
  return video.evaluate((node: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    // Keep enough resolution for a stable pixel-derived artwork bounding box.
    canvas.width = 192;
    canvas.height = Math.round(192 * node.videoHeight / node.videoWidth);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("decoded frame sampler unavailable");
    context.drawImage(node, 0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] };
  });
}

function differenceBox(on: Frame, off: Frame) {
  expect([on.width, on.height]).toEqual([off.width, off.height]);
  let minX = on.width, minY = on.height, maxX = -1, maxY = -1, changed = 0;
  // Compare decoded output pixels, excluding the lower caption/credit band.
  // The animation is composited at y=8%; pixels below 45% are not artwork.
  for (let y = 0; y < Math.floor(on.height * 0.45); y += 1) for (let x = 0; x < on.width; x += 1) {
    const p = (y * on.width + x) * 4;
    const delta = Math.max(Math.abs(on.pixels[p] - off.pixels[p]), Math.abs(on.pixels[p + 1] - off.pixels[p + 1]), Math.abs(on.pixels[p + 2] - off.pixels[p + 2]));
    if (delta < 24) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); changed += 1;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, changed };
}

async function createAndRender(page: Page, options: { projectName: string; aspect: Aspect; subscribe: boolean; testInfo: { outputPath(...segments: string[]): string } }): Promise<RenderResult> {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByLabel("Choose video file").setInputFiles(fixture);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(options.projectName);
  const count = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await count.textContent()) > 1; guard += 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  await expect(count).toHaveText("1");
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption(options.aspect);
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("10");
  const settings = page.getByRole("group", { name: "Automatic Subscribe animation" });
  const enabled = settings.getByRole("checkbox", { name: "Enable Subscribe animation" });
  const timing = settings.getByRole("combobox", { name: "Subscribe animation timing" });
  if (options.subscribe) {
    await expect(enabled).toBeChecked();
    await expect(timing).toHaveValue("5");
  } else {
    await enabled.uncheck();
    await expect(enabled).not.toBeChecked();
    await expect(timing).toBeDisabled();
  }
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/clip"));
  await page.getByRole("button", { name: "Create 1 short clip" }).click();
  const submitted = await createResponse;
  expect(submitted.ok(), await submitted.text()).toBeTruthy();
  await expect(page.getByRole("heading", { name: options.projectName })).toBeVisible({ timeout: 60_000 });
  const tile = page.locator(".clip-tile.complete").first();
  await expect(tile).toBeVisible({ timeout: 15 * 60_000 });
  await tile.getByRole("button", { name: /Preview/ }).click();
  const [width, height] = dimensions[options.aspect];
  const prefix = `${options.aspect.replace(":", "-")}-${options.subscribe ? "enabled" : "disabled"}`;
  const evidence = await verifyVideoOutput({ video: page.locator(".viewer-frame video"), artifactDirectory: artifacts, artifactPrefix: prefix, maximumDurationSeconds: 11, expectedWidth: width, expectedHeight: height });
  expect(evidence.playbackAdvanced).toBe(true);
  expect(evidence.duration).toBeGreaterThanOrEqual(7.5);

  const projectsResponse = await page.request.get("/api/v1/projects");
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json() as { id: string; name: string; latestJobId: string }[];
  const project = projects.find((item) => item.name === options.projectName);
  expect(project).toBeTruthy();
  const jobResponse = await page.request.get(`/api/v1/jobs/${project!.latestJobId}`);
  expect(jobResponse.ok()).toBeTruthy();
  const job = await jobResponse.json() as { id: string; clips: { id: string; start: number; end: number; duration: number; libraryAssetId?: string | null }[] };
  const clip = job.clips[0];
  expect(clip).toBeTruthy();
  const mediaDownload = page.waitForEvent("download");
  await tile.locator("a[download]").click();
  const download = await mediaDownload;
  const mp4Path = options.testInfo.outputPath(`${prefix}.mp4`);
  await download.saveAs(mp4Path);
  expect((await fs.stat(mp4Path)).size).toBeGreaterThan(50_000);
  const start = evidence.duration - 5;
  const stateFrames: Frame[] = [];
  for (const [index, offset] of [0.65, 1.05, 2.0].entries()) stateFrames.push(await captureFrame(page, start + offset, options.testInfo.outputPath(`${prefix}-state-${index}.png`)));
  const offCycleFrame = await captureFrame(page, evidence.duration - 0.15, options.testInfo.outputPath(`${prefix}-after-animation.png`));
  return { projectName: options.projectName, jobId: job.id, clipId: clip.id, start: clip.start, end: clip.end, duration: clip.duration, assetId: clip.libraryAssetId ?? null, aspect: options.aspect, mp4Path, stateFrames, offCycleFrame };
}

test("Subscribe animation renders and exports at all supported aspect ratios", async ({ page }, testInfo) => {
  test.setTimeout(60 * 60_000);
  const appUrl = requireDisposableTarget();
  await fs.access(fixture);
  await fs.mkdir(artifacts, { recursive: true });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  const tag = Date.now();
  const rendered: RenderResult[] = [];
  for (const aspect of ["9:16", "16:9", "1:1", "4:5"] as const) {
    rendered.push(await createAndRender(page, { projectName: `Subscribe ${aspect} ${tag}`, aspect, subscribe: true, testInfo }));
  }
  const disabledOutputs: RenderResult[] = [];
  for (const aspect of ["9:16", "16:9", "1:1", "4:5"] as const) {
    disabledOutputs.push(await createAndRender(page, { projectName: `Subscribe disabled ${aspect} ${tag}`, aspect, subscribe: false, testInfo }));
  }
  for (const [index, output] of rendered.entries()) {
    expect(disabledOutputs[index].start).toBeCloseTo(output.start, 1);
    expect(disabledOutputs[index].end).toBeCloseTo(output.end, 1);
  }

  // Measure the changed artwork bbox in rendered video pixels, not the MOV's
  // transparent canvas or the player element. Portrait/square targets are
  // 55–65% of output width; landscape is 40–50%.
  for (const [index, output] of rendered.entries()) {
    const reference = disabledOutputs[index];
    const boxes = output.stateFrames.map((frame, state) => differenceBox(frame, reference.stateFrames[state]));
    const box = { x: Math.min(...boxes.map((item) => item.x)), y: Math.min(...boxes.map((item) => item.y)), right: Math.max(...boxes.map((item) => item.x + item.width)), bottom: Math.max(...boxes.map((item) => item.y + item.height)), changed: boxes.reduce((sum, item) => sum + item.changed, 0) };
    const ratio = (box.right - box.x) / output.stateFrames[0].width;
    const [low, high] = output.aspect === "16:9" ? [0.40, 0.50] : [0.55, 0.65];
    expect(box.changed, `${output.aspect} has animation pixels distinct from disabled reference`).toBeGreaterThan(250);
    expect(ratio, `${output.aspect} visible-artwork bbox width ratio=${ratio.toFixed(3)} bbox=${JSON.stringify(box)}`).toBeGreaterThanOrEqual(low);
    expect(ratio, `${output.aspect} visible-artwork bbox width ratio=${ratio.toFixed(3)} bbox=${JSON.stringify(box)}`).toBeLessThanOrEqual(high);
    expect(box.y / output.stateFrames[0].height).toBeGreaterThan(0.04);
    expect(box.bottom / output.stateFrames[0].height).toBeLessThan(0.40);
  }
  for (const [index, output] of rendered.entries()) expect(meanDifference(output.offCycleFrame, disabledOutputs[index].offCycleFrame), "disabled render and enabled output match after the animation cycle").toBeLessThan(1.5);

  // Capture decoded Subscribe, cursor/click, and Subscribed frames on desktop
  // and mobile. Each screenshot comes from playback/seeking the finished MP4.
  const desktop = rendered[0];
  await openWorkspaceForProject(page, desktop.projectName);
  const tile = page.locator(".clip-tile.complete").first();
  await tile.getByRole("button", { name: /Preview/ }).click();
  const video = page.locator(".viewer-frame video");
  const begin = desktop.duration - 5;
  const phaseTimes = [begin + 0.65, begin + 1.18, begin + 2.0];
  const phases = ["Subscribe", "click", "Subscribed"];
  const desktopFrames: Frame[] = [];
  for (const [index, phase] of phases.entries()) desktopFrames.push(await captureFrame(page, phaseTimes[index], testInfo.outputPath(`desktop-${phase}.png`)));
  expect(meanDifference(desktopFrames[0], desktopFrames[1]), "decoded Subscribe and click phases differ").toBeGreaterThan(0.1);
  expect(meanDifference(desktopFrames[1], desktopFrames[2]), "decoded click and Subscribed phases differ").toBeGreaterThan(0.1);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [index, phase] of phases.entries()) await captureFrame(page, phaseTimes[index], testInfo.outputPath(`mobile-${phase}.png`));
  await expect(video).toBeVisible();

  // Verify ZIP contains byte-identical MP4 to the direct real-app download.
  await page.setViewportSize({ width: 1280, height: 900 });
  const zipEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const zipDownload = await zipEvent;
  const zipPath = testInfo.outputPath("subscribe-9-16-export.zip");
  await zipDownload.saveAs(zipPath);
  assertZipIntact(zipPath);
  expect(zipNames(zipPath).some((name) => name.toLowerCase().endsWith(".mp4"))).toBeTruthy();
  const extracted = await extractZip(zipPath, testInfo.outputPath("subscribe-zip-extracted"));
  const packagedMp4 = extracted.find((entry) => entry.toLowerCase().endsWith(".mp4"));
  expect(packagedMp4).toBeTruthy();
  const sha = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
  expect(await sha(packagedMp4!), "ZIP MP4 is byte-identical to the direct download").toBe(await sha(desktop.mp4Path));

  for (const output of [...rendered, ...disabledOutputs]) expect(output.assetId, `${output.projectName} published a Library asset`).toBeTruthy();
  await fs.writeFile(testInfo.outputPath("subscribe-evidence.json"), JSON.stringify({ outputs: rendered.map((output) => ({ ...output, stateFrames: undefined, offCycleFrame: undefined })), disabled: disabledOutputs.map((output) => ({ ...output, stateFrames: undefined, offCycleFrame: undefined })), bboxRatios: rendered.map((output, index) => ({ aspect: output.aspect, stateRatios: output.stateFrames.map((frame, state) => differenceBox(frame, disabledOutputs[index].stateFrames[state]).width / frame.width) })) }, null, 2));
});

function meanDifference(a: Frame, b: Frame) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let index = 0; index < a.pixels.length; index += 4) sum += Math.abs(a.pixels[index] - b.pixels[index]) + Math.abs(a.pixels[index + 1] - b.pixels[index + 1]) + Math.abs(a.pixels[index + 2] - b.pixels[index + 2]);
  return sum / (a.width * a.height * 3);
}
