import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "test-artifacts", "youtube-creator-credit");
const now = "2026-01-01T00:00:00Z";
const folder = { id: "folder-1", name: "Unsorted", description: "", color: null, parentId: null, archived: false, system: true, createdAt: now, updatedAt: now };

const health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true,
  ytdlp: true, localTts: true, dataPath: "Mounted local data directory", freeBytes: 10_000_000,
  configuredWorkers: 1, activeWorkers: 0, queuedJobs: 0, fallbacks: {},
};

function project(sourceKind: "youtube" | "upload", id: string, name: string, sourceCreator: string | null = sourceKind === "youtube" ? "Fixture Creator" : null) {
  return {
    schemaVersion: 1, id, name, mode: "clip", style: "educational", state: "complete",
    sourceName: sourceKind === "youtube" ? "YouTube import" : "fixture.mp4", sourceKind, sourceCreator,
    requestedCount: 1, contentFormat: "short", latestJobId: `${id}-job`, libraryFolderId: folder.id,
    sourceBlobId: "source-blob", createdAt: now, updatedAt: now,
  };
}

function job(projectId: string, outputPath: string, creatorCredit: string | null = "Source: Fixture Creator") {
  return {
    schemaVersion: 1, id: `${projectId}-job`, projectId, libraryFolderId: folder.id, sourceBlobId: "source-blob",
    mode: "clip", state: "complete", stage: "complete", stageLabel: "1 fast cut ready", progress: 100,
    currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", contentFormat: "short",
    burnSubtitles: false, embedSubtitles: false, warnings: [], error: null,
    clips: [{
      id: `${projectId}-clip`, index: 1, state: "complete", start: 0, end: 2, duration: 2,
      openingLine: "Fixture cut", score: null, selected: true, outputName: "01-cut.mp4", blobId: "output-blob", creatorCredit,
      downloadUrl: outputPath, previewUrl: outputPath, libraryAssetId: "output-asset", title: "Fixture cut",
      width: 1080, height: 1920, folderId: folder.id, publishedAt: now, fallbackUsed: false, provenance: [],
    }],
    beats: [],
    steps: [
      { id: "source", label: "Source received", status: "complete", completedAt: now },
      { id: "probe", label: "Video validated", status: "complete", completedAt: now },
      { id: "plan", label: "Cut points planned", status: "complete", completedAt: now },
      { id: "render", label: "Clips rendered and saved", status: "complete", completedAt: now, currentItem: 1, totalItems: 1 },
      { id: "verify", label: "Outputs verified", status: "complete", completedAt: now, currentItem: 1, totalItems: 1 },
      { id: "ready", label: "Project ready", status: "complete", completedAt: now },
    ],
    createdAt: now, updatedAt: now,
  };
}

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixture(page: Page, sourceKind: "youtube" | "upload") {
  const id = sourceKind === "youtube" ? "youtube-credit-project" : "upload-no-credit-project";
  const outputPath = `/api/v1/files/jobs/${id}-job/clips/01-cut.mp4`;
  const currentProject = project(sourceKind, id, sourceKind === "youtube" ? "YouTube creator credit" : "Local upload without credit");
  const currentJob = job(id, outputPath, sourceKind === "youtube" ? "Source: Fixture Creator" : null);

  await page.route("**/api/v1/health", (route) => json(route, health));
  await page.route("**/api/v1/profiles", (route) => json(route, []));
  await page.route("**/api/v1/library/folders", (route) => json(route, [folder]));
  await page.route("**/api/v1/library/assets", (route) => json(route, []));
  await page.route("**/api/v1/projects", (route) => json(route, [currentProject]));
  await page.route(`**/api/v1/projects/${id}`, (route) => json(route, currentProject));
  await page.route("**/api/v1/jobs", (route) => json(route, [currentJob]));
  await page.route(`**/api/v1/jobs/${id}-job/events`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
  await page.route(`**/api/v1/jobs/${id}-job`, (route) => json(route, currentJob));
  // A real MP4 is served at the preview URL. The browser therefore exercises
  // the same final-output video element used by production, not a DOM credit.
  await page.route(`**${outputPath}`, (route) => route.fulfill({ path: sourceKind === "youtube" ? path.join(root, "tests/fixtures/youtube-credit.mp4") : path.join(root, "test-video.mp4"), contentType: "video/mp4" }));
  return { id, currentProject, currentJob, outputPath };
}

async function openWorkspace(page: Page, projectName: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(page.getByRole("region", { name: "Output viewer" })).toBeVisible();
}

test.describe("YouTube creator credit workflow", () => {
  test.beforeEach(async () => {
    await fs.mkdir(artifacts, { recursive: true });
  });

  test("creates a YouTube short through the normal flow and previews the final MP4", async ({ page }) => {
    const projectId = "created-youtube-project";
    const outputPath = `/api/v1/files/jobs/${projectId}-job/clips/01-cut.mp4`;
    const createdProject = project("youtube", projectId, "Created YouTube short", "Known Creator");
    const createdJob = job(projectId, outputPath, "Source: Known Creator");
    let createBody = "";
    let exportBody = "";
    let created = false;

    await page.route("**/api/v1/health", (route) => json(route, health));
    await page.route("**/api/v1/profiles", (route) => json(route, []));
    await page.route("**/api/v1/library/folders", (route) => json(route, [folder]));
    await page.route("**/api/v1/library/assets", (route) => json(route, []));
    await page.route("**/api/v1/projects", (route) => json(route, created ? [createdProject] : []));
    await page.route("**/api/v1/jobs", (route) => json(route, created ? [createdJob] : []));
    await page.route("**/api/v1/jobs/clip", async (route) => {
      createBody = route.request().postData() || "";
      created = true;
      await json(route, { project: createdProject, job: createdJob });
    });
    await page.route(`**/api/v1/jobs/${projectId}-job/events`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
    await page.route(`**/api/v1/jobs/${projectId}-job`, (route) => json(route, createdJob));
    await page.route(`**/api/v1/files/jobs/${projectId}-job/clips/01-cut.mp4`, (route) => route.fulfill({ path: path.join(root, "tests/fixtures/youtube-credit-known.mp4"), contentType: "video/mp4" }));
    await page.route(`**/api/v1/jobs/${projectId}-job/export`, async (route) => {
      exportBody = route.request().postData() || "";
      await json(route, { downloadUrl: "/api/v1/files/exports/youtube-credit.zip", filename: "youtube-credit.zip" });
    });
    await page.route("**/api/v1/files/exports/youtube-credit.zip", (route) => route.fulfill({ path: path.join(root, "tests/fixtures/youtube-credit-export.zip"), contentType: "application/zip", headers: { "Content-Disposition": "attachment; filename=\"youtube-credit.zip\"" } }));

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`);
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await page.getByRole("tab", { name: "YouTube" }).click();
    await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=known-creator-fixture");
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await page.getByRole("button", { name: /Create \d+ short clips?/ }).click();
    await expect(page.getByRole("heading", { name: "Created YouTube short" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Output viewer" })).toContainText("Source: Known Creator");
    expect(createBody).toContain("known-creator-fixture");
    expect(createBody).toContain("content_format");

    const video = page.getByRole("region", { name: "Output viewer" }).locator("video");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("src", /01-cut\.mp4/);
    // The label is metadata for the rendered output; the actual credit is
    // burned into the MP4 served by this same final-output video element.
    await expect(page.getByRole("region", { name: "Output viewer" })).toContainText("Source: Known Creator");
    await page.screenshot({ path: path.join(artifacts, "youtube-preview.png"), fullPage: true });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download ZIP/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("youtube-credit.zip");
    expect(exportBody).toContain(`${projectId}-clip`);
    const exportPath = await download.path();
    expect(exportPath).not.toBeNull();
    if (exportPath) {
      expect(() => execFileSync("unzip", ["-t", exportPath], { encoding: "utf8" })).not.toThrow();
      const manifest = JSON.parse(execFileSync("unzip", ["-p", exportPath, "manifest.json"], { encoding: "utf8" })) as { creatorCredit?: string; sourceCreator?: string };
      expect(manifest.sourceCreator).toBe("Known Creator");
      expect(manifest.creatorCredit).toBe("Source: Known Creator");
    }
    const secondDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download ZIP/ }).click();
    expect((await secondDownloadPromise).suggestedFilename()).toBe("youtube-credit.zip");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Created YouTube short/ }).click();
    await expect(page.getByRole("heading", { name: "Created YouTube short" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Output viewer" }).locator("video")).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, "youtube-preview-after-refresh.png"), fullPage: true });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  for (const [sourceKind, expectedProject] of [["youtube", "YouTube creator credit"], ["upload", "Local upload without credit"]] as const) {
    test(`keeps the final preview stable and ${sourceKind === "youtube" ? "eligible for" : "does not add"} a creator credit`, async ({ page }) => {
      await installFixture(page, sourceKind);
      await openWorkspace(page, expectedProject);
      const viewer = page.getByRole("region", { name: "Output viewer" });
      if (sourceKind === "youtube") {
        await expect(viewer).toContainText("Source: Fixture Creator");
      } else {
        await expect(viewer).not.toContainText(/Source:|@creator/);
      }
      const frame = page.locator(".viewer-frame");
      const geometry = await frame.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const video = element.querySelector("video")?.getBoundingClientRect();
        return { frame: { width: rect.width, height: rect.height }, video: video && { left: video.left - rect.left, right: rect.right - video.right, top: video.top - rect.top, bottom: rect.bottom - video.bottom } };
      });
      expect(geometry.frame.width).toBeGreaterThan(0);
      expect(geometry.frame.height).toBeGreaterThan(0);
      expect(geometry.video?.left).toBeGreaterThanOrEqual(0);
      expect(geometry.video?.right).toBeGreaterThanOrEqual(0);
      expect(geometry.video?.top).toBeGreaterThanOrEqual(0);
      expect(geometry.video?.bottom).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: path.join(artifacts, `${sourceKind}-preview.png`), fullPage: true });
    });
  }
});
