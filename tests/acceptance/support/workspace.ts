/**
 * Shared workspace helpers for S6_cut acceptance suites.
 *
 * These drive the application through visible UI controls only. The job API is
 * read in one place — `jobBoundaries` — to recover clip source boundaries the
 * workspace does not display numerically and which media forensics needs to
 * prove source correspondence; nothing is created or driven through it.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
export const OVERALL_DEADLINE_MS = 15 * 60_000;

/**
 * ZIP inspection through python3's standard library, the way `bulk-export`
 * already reads exports. The host is not assumed to carry an `unzip` binary —
 * `extractZip` below goes to the same lengths, borrowing the engine image.
 */
function zipPython<T>(zipPath: string, body: string): T {
  const script = `import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n${body}`;
  return JSON.parse(execFileSync("python3", ["-c", script, zipPath], { encoding: "utf8" }).trim()) as T;
}

/** Entry names inside the archive, in stored order. */
export function zipNames(zipPath: string): string[] {
  return zipPython<string[]>(zipPath, "    print(json.dumps(archive.namelist()))");
}

/** One entry's bytes decoded as UTF-8 text. */
export function zipEntry(zipPath: string, name: string): string {
  return zipPython<string>(zipPath, `    print(json.dumps(archive.read(${JSON.stringify(name)}).decode()))`);
}

/** Throws when any entry fails its CRC, the check `unzip -t` performs. */
export function assertZipIntact(zipPath: string): void {
  const damaged = zipPython<string | null>(zipPath, "    print(json.dumps(archive.testzip()))");
  expect(damaged, `${path.basename(zipPath)} has a corrupt entry`).toBeNull();
}

export type ClipRecord = {
  index: number;
  id: string;
  title: string;
  metaText: string;
  reportedDuration: number;
  reportedWidth: number | null;
  reportedHeight: number | null;
  sourceStart: number;
  sourceEnd: number;
  savedToLibrary: boolean;
  libraryAssetId: string | null;
  downloadPath: string;
  sha256: string;
  sizeBytes: number;
  playback: PlaybackResult;
};

export type PlaybackResult = {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  played: boolean;
  currentTimeAdvanced: boolean;
  advancedBy: number;
  seekMiddleOk: boolean;
  seekNearEndOk: boolean;
  mediaError: string | null;
};

export async function checklist(page: Page) {
  return page.locator(".process-checklist li").evaluateAll((rows) => rows.map((row) => ({
    label: row.querySelector(".checklist-label")?.textContent?.trim() || "",
    status: /status-(active|complete|failed|skipped|pending)/.exec(row.className)?.[1] || "unknown",
  })));
}

/**
 * Poll the workspace until the job reaches a terminal, ready state.
 *
 * Clip projects publish one tile per output; Script projects publish a single
 * rendered video that the viewer auto-selects and a storyboard of beats, with
 * no clip tiles at all — so readiness is mode-aware.
 */
export async function waitForProjectReady(page: Page, observed: Set<string>, mode: "clip" | "script" = "clip", deadlineMs = OVERALL_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    for (const step of await checklist(page)) {
      if (step.label && step.status !== "pending") observed.add(`${step.label}:${step.status}`);
    }
    const ready = await page.locator(".process-checklist li").filter({ hasText: "Project ready" })
      .evaluateAll((rows) => rows.some((row) => /status-complete/.test(row.className)));
    const complete = mode === "clip"
      ? await page.locator(".clip-tile.complete").count()
      : await page.locator(".viewer-frame video").count();
    const failedBanner = await page.getByText("Project failed", { exact: true }).count();
    if (failedBanner) throw new Error("The project reported a global failure while waiting for outputs");
    if (ready && complete > 0) {
      // The snapshot above was taken before the readiness query, so the final
      // engine update — which can flip several steps at once — may not be in it
      // yet. Re-read once so the last transitions are recorded.
      for (const step of await checklist(page)) {
        if (step.label && step.status !== "pending") observed.add(`${step.label}:${step.status}`);
      }
      return { ready, complete };
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const active = (await checklist(page)).find((step) => step.status === "active");
      // eslint-disable-next-line no-console
      console.log(`  … waiting (${Math.round((Date.now() - (deadline - deadlineMs)) / 1000)}s) active=${active?.label || "none"} outputs=${complete}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`The project did not become ready within ${deadlineMs}ms`);
}

/**
 * Drive the real <video> element the workspace renders. The element is muted
 * first because headless Chromium refuses unmuted programmatic playback; audio
 * is proven separately by decoding the downloaded file.
 */
export async function assertPlayback(page: Page): Promise<PlaybackResult> {
  const player = page.locator(".viewer-frame video");
  await expect(player).toBeVisible({ timeout: 30_000 });
  await player.evaluate((node: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
    node.muted = true;
    if (node.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`readyState stayed ${node.readyState}`)), 30_000);
    node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("media element error")); }, { once: true });
  }));

  return await player.evaluate(async (node: HTMLVideoElement) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const seek = (target: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      node.addEventListener("seeked", () => { clearTimeout(timer); resolve(true); }, { once: true });
      try { node.currentTime = target; } catch { clearTimeout(timer); resolve(false); }
    });

    node.muted = true;
    node.currentTime = 0;
    const before = node.currentTime;
    let played = false;
    try { await node.play(); played = true; } catch { played = !node.paused; }
    await wait(1_200);
    const advancedBy = node.currentTime - before;
    node.pause();

    const seekMiddleOk = await seek(node.duration / 2);
    const seekNearEndOk = await seek(Math.max(0, node.duration - 0.35));

    return {
      readyState: node.readyState,
      videoWidth: node.videoWidth,
      videoHeight: node.videoHeight,
      duration: node.duration,
      played,
      currentTimeAdvanced: advancedBy > 0.05,
      advancedBy,
      seekMiddleOk,
      seekNearEndOk,
      mediaError: node.error ? `code ${node.error.code}: ${node.error.message}` : null,
    };
  });
}

export function checkPlayback(result: PlaybackResult, label: string) {
  expect(result.mediaError, `${label}: media element error`).toBeNull();
  expect(result.readyState, `${label}: readyState`).toBeGreaterThanOrEqual(2);
  expect(result.videoWidth, `${label}: videoWidth`).toBeGreaterThan(0);
  expect(result.videoHeight, `${label}: videoHeight`).toBeGreaterThan(0);
  expect(Number.isFinite(result.duration), `${label}: finite duration`).toBeTruthy();
  expect(result.duration, `${label}: duration`).toBeGreaterThan(0);
  expect(result.played, `${label}: play() reached a playing state`).toBeTruthy();
  expect(result.currentTimeAdvanced, `${label}: currentTime advanced (${result.advancedBy.toFixed(3)}s)`).toBeTruthy();
  expect(result.seekMiddleOk, `${label}: seek to middle`).toBeTruthy();
  expect(result.seekNearEndOk, `${label}: seek near end`).toBeTruthy();
}

/** Capture playback stills at three positions using the live video element. */
export async function capturePlaybackStills(page: Page, outputDir: string, prefix: string) {
  const player = page.locator(".viewer-frame video");
  const duration = await player.evaluate((node: HTMLVideoElement) => node.duration);
  const points: { name: string; at: number }[] = [
    { name: "early", at: Math.min(0.5, duration * 0.08) },
    { name: "midpoint", at: duration / 2 },
    { name: "near-end", at: Math.max(0, duration - 0.4) },
  ];
  for (const point of points) {
    await player.evaluate((node: HTMLVideoElement, target) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 8_000);
      node.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.currentTime = target;
    }), point.at);
    await page.waitForTimeout(250);
    await page.locator(".viewer-stage").screenshot({ path: path.join(outputDir, `${prefix}-${point.name}.png`) });
  }
}

export async function downloadTile(page: Page, tile: Locator, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    tile.locator('a[download]').click(),
  ]);
  await download.saveAs(target);
  const bytes = await fs.readFile(target);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

/**
 * Extract a ZIP with the engine image's unzip, so the host needs no archive
 * tooling. Returns the media files the archive contains.
 */
export async function extractZip(zipPath: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const mount = path.dirname(path.dirname(zipPath));
  const rel = (target: string) => `/work/${path.relative(mount, target)}`;
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", ["run", "--rm", "--network", "none", "--entrypoint", "unzip",
      "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-e", "HOME=/tmp",
      "-v", `${mount}:/work`, process.env.S6_FORENSICS_IMAGE || "s6-cut-engine",
      "-o", rel(zipPath), "-d", rel(destination)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`unzip failed: ${stderr.slice(-300)}`))));
  });
  const entries = await fs.readdir(destination, { recursive: true }) as string[];
  return entries.map((entry) => path.join(destination, entry));
}

/** Read clip boundaries from the job record; the workspace does not show them. */
export async function jobBoundaries(projectName: string) {
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json();
  const project = projects.find((item: { name: string }) => item.name === projectName);
  if (!project) throw new Error(`project ${projectName} not found in the engine record`);
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json();
  const job = jobs.find((item: { projectId: string }) => item.projectId === project.id);
  if (!job) throw new Error(`job for ${projectName} not found`);
  return { project, job };
}

export async function openProjects(page: Page) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  // The create panel's own heading. The page carried an introduction headed
  // "Make the first cut" until 7542e67 removed it; this helper kept waiting for
  // that heading, so every suite that creates a project timed out here.
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible({ timeout: 30_000 });
}

/** A project source chosen through the visible source picker. */
export type ProjectSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

/** Create a clip project entirely through visible controls. */
export async function createClipProject(page: Page, options: {
  name: string; count: number; mode: "Fast" | "Smart" | "Auto";
  aspect: string; min: number; max: number; captions: boolean;
  source: ProjectSource; style?: string;
}) {
  await openProjects(page);
  if (options.source.kind === "file") {
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(options.source.path);
    await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  } else {
    // Switch to the YouTube tab through its visible control, then type the URL.
    await page.getByRole("tab", { name: "YouTube" }).click();
    const field = page.locator("#source-youtube-url");
    await expect(field).toBeVisible();
    await field.fill(options.source.url);
    await expect(field).toHaveValue(options.source.url);
  }
  await page.getByLabel("Project name").fill(options.name);

  const countValue = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) > options.count; guard += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) < options.count; guard += 1) {
    await page.getByRole("button", { name: "More clips", exact: true }).click();
  }
  await expect(countValue).toHaveText(String(options.count));

  await page.getByRole("button", { name: options.mode, exact: true }).click();

  // Editorial style is chosen through its visible card, not left to the default.
  if (options.style) {
    const card = page.locator(".style-card").filter({ hasText: options.style }).first();
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }

  const subtitles = page.locator(".subtitle-toggle input");
  if ((await subtitles.isChecked()) !== options.captions) await subtitles.setChecked(options.captions);
  expect(await subtitles.isChecked()).toBe(options.captions);

  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption(options.aspect);
  await page.getByLabel("Minimum seconds").fill(String(options.min));
  await page.getByLabel("Maximum seconds").fill(String(options.max));

  await page.getByRole("button", { name: new RegExp(`^Create ${options.count} short clips?$`) }).click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible({ timeout: 60_000 });
}

/** Collect everything the workspace shows about each finished clip. */
export async function collectClips(page: Page, projectName: string, outputDir: string): Promise<ClipRecord[]> {
  const { job } = await jobBoundaries(projectName);
  const tiles = page.locator(".clip-tile.complete");
  const total = await tiles.count();
  const records: ClipRecord[] = [];
  for (let index = 0; index < total; index += 1) {
    const tile = tiles.nth(index);
    const number = Number((await tile.locator(".clip-number").textContent())?.trim());
    const engineClip = job.clips.find((clip: { index: number }) => clip.index === number);
    if (!engineClip) throw new Error(`no engine record for visible clip ${number}`);

    const metaText = (await tile.locator(".clip-meta").textContent())?.trim() || "";
    const savedToLibrary = await tile.locator(".saved-badge").count() > 0;
    await expect(tile.locator('a[download]')).toBeVisible();

    await tile.getByRole("button", { name: /Preview/ }).click();
    const playback = await assertPlayback(page);
    checkPlayback(playback, `clip ${number}`);
    await capturePlaybackStills(page, outputDir, `clip-${number}`);

    const downloadPath = path.join(outputDir, `clip-${number}.mp4`);
    const { sha256, sizeBytes } = await downloadTile(page, tile, downloadPath);

    records.push({
      index: number,
      id: engineClip.id,
      title: (await tile.locator(".clip-title").textContent())?.trim() || "",
      metaText,
      reportedDuration: engineClip.duration,
      reportedWidth: engineClip.width ?? null,
      reportedHeight: engineClip.height ?? null,
      sourceStart: engineClip.start,
      sourceEnd: engineClip.end,
      savedToLibrary,
      libraryAssetId: engineClip.libraryAssetId ?? null,
      downloadPath,
      sha256,
      sizeBytes,
      playback,
    });
  }
  return records;
}

export async function writeManifest(artifacts: string, name: string, payload: unknown) {
  await fs.mkdir(path.join(artifacts, "reports"), { recursive: true });
  await fs.writeFile(path.join(artifacts, "reports", `${name}.json`), JSON.stringify(payload, null, 2));
}

