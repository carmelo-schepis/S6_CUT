import { expect, test } from "@playwright/test";

const health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "/app/data", freeBytes: 1_000_000,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: {},
};

const folder = {
  id: "folder-1", name: "Unsorted", description: "", color: null, parentId: null,
  archived: false, system: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const outputFormats = [
  { aspect: "9:16", contentFormat: "short", width: 9, height: 16 },
  { aspect: "16:9", contentFormat: "long", width: 16, height: 9 },
  { aspect: "1:1", contentFormat: "short", width: 1, height: 1 },
  { aspect: "4:5", contentFormat: "short", width: 4, height: 5 },
] as const;

type OutputFixture = (typeof outputFormats)[number];

function project(fixture: OutputFixture) {
  return {
    schemaVersion: 1, id: "ratio-project", name: `${fixture.contentFormat} ${fixture.aspect} processing ratio`, mode: "clip", style: "educational",
    state: "active", sourceName: "YouTube source", sourceKind: "youtube", requestedCount: 3,
    contentFormat: fixture.contentFormat, latestJobId: "ratio-job", libraryFolderId: folder.id,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function job(fixture: OutputFixture) {
  return {
    schemaVersion: 1, id: "ratio-job", projectId: "ratio-project", mode: "clip", state: "active",
    stage: "downloading", stageLabel: "Downloading YouTube source", progress: 12,
    currentItem: 0, totalItems: 0, style: "educational", processingMode: "fast", contentFormat: fixture.contentFormat,
    downloadProgress: {
      downloadedBytes: 7_340_032, totalBytes: 50_000_000, percent: 14.68, phase: "downloading",
      lastProgressAt: "2026-01-01T00:00:20Z", speedBytesPerSecond: 1_200_000, etaSeconds: 36,
      message: "Receiving the authorised source…", resumable: true,
    },
    warnings: [], error: null, clips: fixture.aspect === "9:16" || fixture.aspect === "16:9" ? [] : [{
      id: "ratio-clip", index: 1, state: "complete", start: 0, end: 10, duration: 10,
      openingLine: "A ratio fixture clip", score: null, selected: true,
      width: fixture.width * 100, height: fixture.height * 100, previewUrl: null,
    }], beats: [], steps: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:20Z",
  };
}

test("keeps queued YouTube processing inside the declared output ratio", async ({ page }) => {
  let fixture: OutputFixture = outputFormats[0];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`);
  });

  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/health") ? health
      : path.endsWith("/profiles") ? []
        : path.endsWith("/library/folders") ? [folder]
          : path.endsWith("/library/assets") ? []
            : path.endsWith("/projects") ? [project(fixture)]
              : path.endsWith("/events") ? ": keep-alive\n\n"
                : path.endsWith("/jobs") ? [job(fixture)]
                  : path.endsWith("/ratio-job") ? job(fixture)
                    : [];
    if (path.endsWith("/events")) await route.fulfill({ status: 200, contentType: "text/event-stream", body: String(body) });
    else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  for (const output of outputFormats) {
    fixture = output;
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: `Open project ${output.contentFormat} ${output.aspect} processing ratio`, exact: true }).click();
      await expect(page.locator(".workspace-page")).toBeVisible();
      await expect(page.getByText(`Output · ${output.aspect}`, { exact: true })).toBeVisible();
      await expect(page.locator(".job-strip")).toContainText("Downloading");
      await expect(page.getByRole("region", { name: "Download status" })).toContainText("Receiving the authorised source");

      const shape = await page.locator(".viewer-frame").evaluate((frame) => {
        const rect = frame.getBoundingClientRect();
        const processing = frame.querySelector<HTMLElement>(".processing-state")!;
        return {
          ratio: rect.width / rect.height,
          frameScrollWidth: frame.scrollWidth,
          frameClientWidth: frame.clientWidth,
          processingScrollWidth: processing.scrollWidth,
          processingClientWidth: processing.clientWidth,
          processingScrollHeight: processing.scrollHeight,
          processingClientHeight: processing.clientHeight,
        };
      });
      expect(shape.ratio, `${width}x${height}: ${output.aspect} frame ratio`).toBeCloseTo(output.width / output.height, 2);
      expect(shape.frameScrollWidth, `${width}x${height}: ${output.aspect} frame horizontal overflow`).toBeLessThanOrEqual(shape.frameClientWidth + 1);
      expect(shape.processingScrollWidth, `${width}x${height}: ${output.aspect} processing card horizontal overflow`).toBeLessThanOrEqual(shape.processingClientWidth + 1);
      expect(shape.processingClientWidth, `${width}x${height}: ${output.aspect} processing card widened the frame`).toBeLessThanOrEqual(shape.frameClientWidth);
      expect(shape.processingScrollHeight, `${width}x${height}: ${output.aspect} processing card must scroll vertically, not horizontally`).toBeGreaterThanOrEqual(shape.processingClientHeight);
      await page.screenshot({ path: `test-artifacts/workspace-processing-ratio-${output.aspect.replace(":", "-")}-${width}.png`, fullPage: true });
    }
  }

  expect(consoleErrors, "browser console errors").toEqual([]);
  expect(pageErrors, "browser page errors").toEqual([]);
  expect(failedRequests, "failed browser requests").toEqual([]);
});
