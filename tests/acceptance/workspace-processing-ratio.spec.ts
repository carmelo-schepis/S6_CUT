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

let hasDownload = true;

function job(fixture: OutputFixture) {
  return {
    schemaVersion: 1, id: "ratio-job", projectId: "ratio-project", mode: "clip", state: "active",
    stage: hasDownload ? "downloading" : "transcribing", stageLabel: hasDownload ? "Downloading YouTube source" : "Transcribing audio", progress: 12,
    currentItem: 0, totalItems: 0, style: "educational", processingMode: "fast", contentFormat: fixture.contentFormat,
    downloadProgress: hasDownload ? {
      downloadedBytes: 7_340_032, totalBytes: 50_000_000, percent: 14.68, phase: "downloading",
      lastProgressAt: "2026-01-01T00:00:20Z", speedBytesPerSecond: 1_200_000, etaSeconds: 36,
      message: "Receiving the authorised source…", resumable: true,
    } : undefined,
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
      await page.getByRole("button", { name: "Jobs", exact: true }).click();
      await page.locator('.job-card[data-job-id="ratio-job"]')
        .getByRole("button", { name: "Open", exact: true }).click();
      await expect(page.locator(".workspace-page")).toBeVisible();
      await expect(page.getByText(`Output · ${output.aspect}`, { exact: true })).toBeVisible();
      await expect(page.locator(".job-strip")).toContainText("Downloading");
      await expect(page.getByRole("region", { name: "Download status" })).toContainText("Receiving the authorised source");

      const shape = await page.locator(".viewer-frame").evaluate((frame) => {
        const rect = frame.getBoundingClientRect();
        const processing = frame.querySelector<HTMLElement>(".processing-state")!;
        const sections = [...processing.querySelectorAll<HTMLElement>(".processing-section")];
        return {
          ratio: rect.width / rect.height,
          frameScrollWidth: frame.scrollWidth,
          frameClientWidth: frame.clientWidth,
          processingScrollWidth: processing.scrollWidth,
          processingClientWidth: processing.clientWidth,
          processingScrollHeight: processing.scrollHeight,
          processingClientHeight: processing.clientHeight,
          sectionCount: sections.length,
          sectionLefts: sections.map((section) => Math.round(section.getBoundingClientRect().left)),
          sectionGaps: sections.slice(1).map((section, index) => Math.round(section.getBoundingClientRect().top - sections[index].getBoundingClientRect().bottom)),
          downloadColumns: getComputedStyle(processing.querySelector<HTMLElement>(".download-detail-values") || processing).gridTemplateColumns,
        };
      });
      expect(shape.ratio, `${width}x${height}: ${output.aspect} frame ratio`).toBeCloseTo(output.width / output.height, 2);
      expect(shape.frameScrollWidth, `${width}x${height}: ${output.aspect} frame horizontal overflow`).toBeLessThanOrEqual(shape.frameClientWidth + 1);
      expect(shape.processingScrollWidth, `${width}x${height}: ${output.aspect} processing card horizontal overflow`).toBeLessThanOrEqual(shape.processingClientWidth + 1);
      expect(shape.processingClientWidth, `${width}x${height}: ${output.aspect} processing card widened the frame`).toBeLessThanOrEqual(shape.frameClientWidth);
      expect(shape.processingScrollHeight, `${width}x${height}: ${output.aspect} processing card must scroll vertically, not horizontally`).toBeGreaterThanOrEqual(shape.processingClientHeight);
      expect(shape.sectionCount, `${width}x${height}: ${output.aspect} processing sections`).toBe(3);
      expect(new Set(shape.sectionLefts).size, `${width}x${height}: ${output.aspect} section left edges`).toBe(1);
      expect(shape.sectionGaps.every((gap) => gap > 0), `${width}x${height}: ${output.aspect} major sections need separation`).toBe(true);
      expect(shape.downloadColumns.split(" ")).toHaveLength(2);
      await page.screenshot({ path: `test-artifacts/workspace-processing-ratio-${output.aspect.replace(":", "-")}-${width}.png`, fullPage: true });
    }
  }

  // Ordinary processing has no download panel. It should use the same frame,
  // keep the footer within the frame, and avoid creating a scroll container for content
  // that already fits.
  hasDownload = false;
  fixture = outputFormats[0];
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await page.locator('.job-card[data-job-id="ratio-job"]')
      .getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.locator(".processing-state")).toBeVisible();
    await expect(page.getByRole("region", { name: "Download status" })).toBeHidden();
    const ordinary = await page.locator(".viewer-frame").evaluate((frame) => {
      const frameBox = frame.getBoundingClientRect();
      const processing = frame.querySelector<HTMLElement>(".processing-state")!;
      const footer = processing.querySelector<HTMLElement>(".processing-help")!.getBoundingClientRect();
      const sections = [...processing.querySelectorAll<HTMLElement>(".processing-section")];
      return {
        frameRatio: frameBox.width / frameBox.height,
        frameBottom: frameBox.bottom,
        footerBottom: footer.bottom,
        processingScrollHeight: processing.scrollHeight,
        processingClientHeight: processing.clientHeight,
        sectionGaps: sections.slice(1).map((section, index) => section.getBoundingClientRect().top - sections[index].getBoundingClientRect().bottom),
      };
    });
    expect(ordinary.frameRatio).toBeCloseTo(9 / 16, 2);
    expect(ordinary.footerBottom).toBeLessThanOrEqual(ordinary.frameBottom + 1);
    expect(ordinary.processingScrollHeight).toBe(ordinary.processingClientHeight);
    expect(ordinary.sectionGaps.every((gap) => gap > 0)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-artifacts/workspace-processing-ordinary-${width}.png`, fullPage: true });
  }

  expect(consoleErrors, "browser console errors").toEqual([]);
  expect(pageErrors, "browser page errors").toEqual([]);
  expect(failedRequests, "failed browser requests").toEqual([]);
});
