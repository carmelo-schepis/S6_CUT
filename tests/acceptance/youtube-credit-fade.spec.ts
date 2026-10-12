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
  openWorkspaceForProject,
  createClipProject,
  waitForProjectReady,
} from "./support/workspace";

const approvedUrls = [
  "https://www.youtube.com/watch?v=srVPLrmlBJY",
  "https://www.youtube.com/watch?v=KNVr5pHAygI",
];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const artifacts = path.join(root, "test-artifacts/youtube-credit-fade");
const ownerDataRoot = "/home/linuxpc/Git_projects/S6_CUT/data";
const dataRoot = process.env.S6_DATA_PATH ? path.resolve(process.env.S6_DATA_PATH) : "";

// This spec creates real projects and reads the engine's data directory, so it
// must only ever run against an explicitly named, isolated stack.
function isolatedStackProblem() {
  const url = process.env.S6_ACCEPTANCE_URL;
  if (!url || !dataRoot) return "set S6_ACCEPTANCE_URL and S6_DATA_PATH to an isolated stack";
  if (new URL(url).port === "8080") return "refusing to run against the owner stack on port 8080";
  if (dataRoot === ownerDataRoot || dataRoot === path.join(root, "data")) return "refusing to use a shared checkout data directory";
  return null;
}
const deadlineMs = 30 * 60_000;
const mediaImage = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";
const workPath = (value: string) => `/work/${path.relative(root, value)}`;
const runMediaTool = (tool: string, args: string[], encoding?: BufferEncoding) => execFileSync("docker", [
  "run", "--rm", "--network", "none", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  "-v", `${root}:/work`, "--entrypoint", tool, mediaImage, ...args,
], encoding ? { encoding } : undefined);

function meanAbsoluteDifference(left: Buffer, right: Buffer) {
  expect(left.length).toBe(right.length);
  return left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0) / left.length;
}

test("burns a legible YouTube creator credit for eight seconds, fades it out, and keeps captions separate", async ({ page }) => {
  const problem = isolatedStackProblem();
  if (problem) throw new Error(problem);
  test.setTimeout(deadlineMs + 60_000);
  await fs.mkdir(artifacts, { recursive: true });
  const projectName = `YouTube creator credit fade ${Date.now()}`;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  let created: Awaited<ReturnType<typeof jobBoundaries>> | undefined;
  let activeProjectName: string | undefined;
  let lastError: unknown;
  for (const [index, url] of approvedUrls.entries()) {
    const candidateName = index === 0 ? projectName : `${projectName} fallback`;
    try {
      await createClipProject(page, {
        name: candidateName,
        count: 1,
        mode: "Fast",
        aspect: "9:16",
        style: "Educational",
        min: 20,
        max: 60,
        captions: false,
        source: { kind: "url", url },
      });
      await waitForProjectReady(page, new Set(), deadlineMs);
      created = await jobBoundaries(candidateName);
      if (created.project.sourceCreator) {
        activeProjectName = candidateName;
        break;
      }
      lastError = new Error(`${url} completed without creator metadata`);
    } catch (error) {
      lastError = error;
      if (index === approvedUrls.length - 1) throw error;
    }
    if (index === approvedUrls.length - 1) throw lastError;
  }
  expect(created).toBeTruthy();
  expect(activeProjectName).toBeTruthy();
  const successfulProject = created!;
  const successfulProjectName = activeProjectName!;
  expect(successfulProject.project.sourceKind).toBe("youtube");
  expect(successfulProject.project.sourceCreator).toBeTruthy();
  expect(successfulProject.job.processingMode).toBe("fast");
  const clips = await collectClips(page, successfulProjectName, path.join(artifacts, "output"));
  expect(clips).toHaveLength(1);
  const clip = clips[0];
  checkPlayback(clip.playback, "Fast YouTube creator-credit output");
  expect(clip.playback.videoWidth).toBe(1080);
  expect(clip.playback.videoHeight).toBe(1920);

  const { job } = await jobBoundaries(successfulProjectName);
  const apiClip = job.clips.find((item: { id: string }) => item.id === clip.id);
  expect(apiClip?.creatorCredit).toMatch(/^Source: /);
  expect(apiClip?.duration).toBeGreaterThanOrEqual(15);

  await openWorkspaceForProject(page, successfulProjectName);
  await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 60_000 });
  await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
  const toolbarCredit = page.locator(".viewer-credit");
  await expect(toolbarCredit).toHaveText(/^Source: /);
  expect(await toolbarCredit.textContent()).toBe(apiClip?.creatorCredit);

  const clipDir = path.join(dataRoot, "jobs", job.id, "clips");
  const names = await fs.readdir(clipDir);
  const burnName = names.find((name) => name.endsWith(".burn.ass"));
  expect(burnName, "the real burned ASS script exists").toBeTruthy();
  const burnPath = path.join(clipDir, burnName!);
  const burnArtifact = path.join(artifacts, path.basename(burnPath));
  await fs.copyFile(burnPath, burnArtifact);
  const burnAss = await fs.readFile(burnPath, "utf8");
  const matchingCredits = burnAss.match(/^Dialogue: 2,0,0:00:09\.00,Credit,,0,0,0,,\{\\fad\(0,1000\)\}Source: /gm) ?? [];
  expect(matchingCredits).toHaveLength(1);
  expect((burnAss.match(/^Dialogue: \d+,\d+,\d+:[^\r\n]*,Credit,/gm) ?? [])).toHaveLength(1);
  const captionSidecar = names.find((name) => /\.(?:ass|srt|vtt)$/.test(name) && !name.endsWith(".burn.ass"));
  if (captionSidecar) {
    const sidecar = await fs.readFile(path.join(clipDir, captionSidecar), "utf8");
    expect(sidecar).not.toMatch(/^Dialogue: .*Credit,/m);
    expect(sidecar).not.toMatch(/Source:\s/);
  }

  const realCreditStyle = burnAss.split("\n").find((line) => line.startsWith("Style: Credit,"));
  expect(realCreditStyle).toBeTruthy();
  const alignment = Number(realCreditStyle!.slice("Style: ".length).split(",")[18]);
  expect([1, 3]).toContain(alignment);
  const duration = Number(apiClip.duration);
  expect(duration).toBeGreaterThanOrEqual(15);
  const withoutCreditPath = path.join(artifacts, "without-credit.ass");
  const withoutCredit = burnAss.replace(/^Dialogue: 2,0,[^\r\n]*,Credit,[^\r\n]*\r?\n?/m, "");
  expect(withoutCredit).not.toBe(burnAss);
  await fs.writeFile(withoutCreditPath, withoutCredit);
  const crop = alignment === 3 ? "crop=540:160:540:1760" : "crop=540:160:0:1760";
  const differences = new Map<number, number>();
  for (const timestamp of [2, 7.5, 8, 8.25, 8.5, 8.75, 9, 10, duration - 0.5]) {
    const rendered = [];
    for (const assPath of [burnArtifact, withoutCreditPath]) {
      const raw = runMediaTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        `color=c=gray:s=1080x1920:r=30:d=${duration}`, "-vf", `trim=start=${timestamp},setpts=PTS-STARTPTS+${timestamp}/TB,subtitles=${workPath(assPath)},${crop},format=gray`,
        "-frames:v", "1", "-f", "rawvideo", "pipe:1",
      ]) as Buffer;
      expect(raw.length).toBe(540 * 160);
      rendered.push(raw);
    }
    differences.set(timestamp, meanAbsoluteDifference(rendered[0], rendered[1]));
  }
  const full = Math.min(differences.get(2)!, differences.get(7.5)!, differences.get(8)!);
  const table = Object.fromEntries(differences);
  await fs.writeFile(path.join(artifacts, "real-script-differences.json"), JSON.stringify({ alignment, full, differences: table }, null, 2));
  expect(full, `fully-visible mean gray difference: ${JSON.stringify(table)}`).toBeGreaterThan(3.0);
  expect(differences.get(8.25)!, `quarter-fade mean gray difference: ${JSON.stringify(table)}`).toBeGreaterThan(0.65 * full);
  expect(differences.get(8.25)!, `quarter-fade mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.85 * full);
  expect(differences.get(8.5)!, `half-fade mean gray difference: ${JSON.stringify(table)}`).toBeGreaterThan(0.4 * full);
  expect(differences.get(8.5)!, `half-fade mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.6 * full);
  expect(differences.get(8.75)!, `three-quarter-fade mean gray difference: ${JSON.stringify(table)}`).toBeGreaterThan(0.15 * full);
  expect(differences.get(8.75)!, `three-quarter-fade mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.35 * full);
  expect(differences.get(8.25)!).toBeGreaterThan(differences.get(8.5)!);
  expect(differences.get(8.5)!).toBeGreaterThan(differences.get(8.75)!);
  expect(differences.get(9)!, `fade endpoint mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.1 * full);
  expect(differences.get(10)!, `post-fade mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.1 * full);
  expect(differences.get(duration - 0.5)!, `end mean gray difference: ${JSON.stringify(table)}`).toBeLessThan(0.1 * full);

  const probe = JSON.parse(runMediaTool("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", workPath(clip.downloadPath),
  ], "utf8")) as { streams: { codec_name?: string; codec_type?: string; width?: number; height?: number }[]; format: { duration?: string } };
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  expect(video?.codec_name).toBe("h264");
  expect(video?.width).toBe(1080);
  expect(video?.height).toBe(1920);
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(15);

  const framePaths: string[] = [];
  const contactTimes = [2, 7.5, 8.5, 10, duration - 0.5];
  for (const [index, timestamp] of contactTimes.entries()) {
    const frame = path.join(artifacts, `frame-${index + 1}-${timestamp}.png`);
    runMediaTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(timestamp), "-i", workPath(clip.downloadPath), "-frames:v", "1", workPath(frame)]);
    expect((await fs.stat(frame)).size).toBeGreaterThan(1_000);
    framePaths.push(frame);
  }
  const contactSheet = path.join(artifacts, "contact-sheet.png");
  runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", ...framePaths.flatMap((frame) => ["-i", workPath(frame)]),
    "-filter_complex", "[0:v]scale=270:480[a];[1:v]scale=270:480[b];[2:v]scale=270:480[c];[3:v]scale=270:480[d];[4:v]scale=270:480[e];[a][b][c][d][e]hstack=inputs=5[outv]",
    "-map", "[outv]", workPath(contactSheet),
  ]);
  expect((await fs.stat(contactSheet)).size).toBeGreaterThan(1_000);

  const player = page.locator(".viewer-frame video");
  await expect(player).toBeVisible();
  const seekPreview = (timestamp: number) => player.evaluate((video: HTMLVideoElement, target) => new Promise<void>((resolve, reject) => {
    if (video.error) { reject(new Error(`video error ${video.error.code}`)); return; }
    const timer = setTimeout(() => reject(new Error(`seek to ${target}s timed out`)), 15_000);
    video.addEventListener("seeked", () => {
      clearTimeout(timer);
      if (video.readyState < 2 || video.error) reject(new Error(`seeked without ready media at ${target}s`));
      else resolve();
    }, { once: true });
    video.currentTime = target;
  }), timestamp);
  for (const timestamp of [2, 10]) {
    await seekPreview(timestamp);
    expect(await player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    expect(await player.evaluate((video: HTMLVideoElement) => video.error)).toBeNull();
    await page.locator(".viewer-frame").screenshot({ path: path.join(artifacts, `seek-${timestamp}.png`) });
  }
  await seekPreview(7);
  await player.evaluate((video: HTMLVideoElement) => {
    video.muted = true;
    return video.play();
  });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 10_000 }).toBeGreaterThan(9.5);
  expect(await player.evaluate((video: HTMLVideoElement) => video.error)).toBeNull();

  // What the user actually sees: with the pointer away from the player and
  // playback started from the app's own transport, nothing in the UI may
  // cover the credit while it is on screen.
  await player.evaluate((video: HTMLVideoElement) => { video.pause(); video.currentTime = 0; });
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.mouse.move(0, 0);
  // A paused player always shows the native control bar over the bottom of the
  // video, so capture while playing, once the bar has auto-hidden.
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 15_000 }).toBeGreaterThanOrEqual(4.5);
  expect(await player.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  const fields = realCreditStyle!.slice("Style: ".length).split(",");
  const [fontSize, marginLeft, marginRight, marginBottom] = [Number(fields[2]), Number(fields[19]), Number(fields[20]), Number(fields[21])];
  expect(fontSize).toBe(44);
  const box = (await player.boundingBox())!;
  const scale = box.width / 1080;
  // The panel spans the corner half of the frame, from the bottom inset up to
  // roughly two text lines high.
  const cssRegion = {
    x: alignment === 3 ? box.x + box.width / 2 : box.x + marginLeft * scale,
    y: box.y + box.height - (marginBottom + fontSize * 1.6) * scale,
    width: box.width / 2 - (alignment === 3 ? marginRight : marginLeft) * scale,
    height: fontSize * 1.6 * scale,
  };
  // No page element may sit on top of the credit panel.
  const topElement = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null,
    { x: cssRegion.x + cssRegion.width * 0.75, y: cssRegion.y + cssRegion.height * 0.5 });
  expect(topElement).toBe("VIDEO");

  // Compare on-screen pixels with the decoded MP4 at the same moment. Browser
  // scaling can shift content by a pixel or two, so decode a padded area and
  // keep the best alignment within a few CSS pixels.
  const pad = 4;
  const [shotWidth, shotHeight] = [Math.round(cssRegion.width), Math.round(cssRegion.height)];
  const [paddedWidth, paddedHeight] = [shotWidth + 2 * pad, shotHeight + 2 * pad];
  const sourceX = Math.round((cssRegion.x - box.x - pad) / scale);
  const sourceY = Math.round((cssRegion.y - box.y - pad) / scale);
  const sourceWidth = Math.min(1080 - sourceX, Math.round(paddedWidth / scale));
  const sourceHeight = Math.min(1920 - sourceY, Math.round(paddedHeight / scale));
  const toGray = (file: string, width: number, height: number) => runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", workPath(file), "-vf", `scale=${width}:${height},format=gray`,
    "-frames:v", "1", "-f", "rawvideo", "pipe:1",
  ]) as Buffer;
  const screenDifference = async (label: string) => {
    const before = await player.evaluate((video: HTMLVideoElement) => video.currentTime);
    const screenshotPath = path.join(artifacts, `workspace-credit-${label}.png`);
    await page.screenshot({ path: screenshotPath, clip: cssRegion });
    const after = await player.evaluate((video: HTMLVideoElement) => video.currentTime);
    const at = (before + after) / 2;
    const decodedPath = path.join(artifacts, `decoded-credit-${label}.png`);
    runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(3), "-i", workPath(clip.downloadPath), "-frames:v", "1",
      "-vf", `crop=${sourceWidth}:${sourceHeight}:${sourceX}:${sourceY}`, workPath(decodedPath),
    ]);
    const shot = toGray(screenshotPath, shotWidth, shotHeight);
    const decoded = toGray(decodedPath, paddedWidth, paddedHeight);
    let best = Number.POSITIVE_INFINITY;
    for (let dy = 0; dy <= 2 * pad; dy += 1) {
      for (let dx = 0; dx <= 2 * pad; dx += 1) {
        let total = 0;
        for (let y = 0; y < shotHeight; y += 1) {
          for (let x = 0; x < shotWidth; x += 1) total += Math.abs(shot[y * shotWidth + x] - decoded[(y + dy) * paddedWidth + x + dx]);
        }
        best = Math.min(best, total / (shotWidth * shotHeight));
      }
    }
    return { at, before, after, difference: best };
  };

  // While playing with the pointer away, the credit must match the MP4.
  const playing = await screenDifference("playing");
  expect(playing.after, "credit captured inside its fully-visible window").toBeLessThan(8);
  // Calibration: paused with the pointer over the player, the native control
  // bar covers the same strip. The playing view must be far closer to the MP4.
  await player.evaluate((video: HTMLVideoElement) => video.pause());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10 * scale);
  // The bar fades in; re-measure (bounded) until it has fully appeared.
  let covered = await screenDifference("paused-hovered");
  for (let attempt = 0; attempt < 10 && covered.difference < 2 * playing.difference; attempt += 1) {
    await page.mouse.move(box.x + box.width / 2 + (attempt % 2 ? 2 : -2), box.y + box.height - 10 * scale);
    covered = await screenDifference("paused-hovered");
  }
  await fs.writeFile(path.join(artifacts, "workspace-visibility.json"), JSON.stringify({ cssRegion, topElement, playing, covered }, null, 2));
  expect(playing.difference, "the Workspace player shows the credit uncovered").toBeLessThan(0.5 * covered.difference);
  expect(playing.difference).toBeLessThan(30);

  await assertPlayback(page).then((result) => checkPlayback(result, "YouTube creator-credit fade preview"));
  expect(consoleErrors, "unexpected console errors").toEqual([]);
  expect(pageErrors, "unexpected page errors").toEqual([]);
  expect(serverErrors, "unexpected HTTP 5xx responses").toEqual([]);
});
