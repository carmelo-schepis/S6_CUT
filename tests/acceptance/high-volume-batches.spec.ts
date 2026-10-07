import { expect, test } from "@playwright/test";

// This is an API-mocked UI acceptance check. It verifies client interaction and
// serialization against deterministic fixtures; it does NOT render or encode 500
// real media files and must not be treated as a 500-output deployment test.
test.describe("high-volume batch controls (mocked UI/API)", () => {
  test("submits 500 directly, survives reload, and exports all mocked completed ids", async ({ page }) => {
    test.info().annotations.push({
      type: "scope",
      description: "Mocked UI/API only: the 500 clip records are fixtures, not rendered media outputs.",
    });
    const ids = Array.from({ length: 500 }, (_, index) => `mock-clip-${index + 1}`);
    const clips = ids.map((id, index) => ({
      id, index: index + 1, state: "complete", start: index, end: index + 10, duration: 10,
      openingLine: `Fixture output ${index + 1}`, score: null, selected: true, fallbackUsed: false,
      provenance: [], title: `Fixture ${index + 1}`, downloadUrl: `/mock/${id}.mp4`,
    }));
    const project = {
      schemaVersion: 1, id: "mock-project", name: "High-volume acceptance", mode: "clip", style: "serious",
      state: "complete", sourceName: "YouTube import", sourceKind: "youtube", requestedCount: 500,
      batchMode: "high_volume", effectiveTarget: 500, latestJobId: "mock-job",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const completedJob = {
      schemaVersion: 1, id: "mock-job", projectId: project.id, mode: "clip", state: "complete", stage: "done",
      stageLabel: "Complete", progress: 100, currentItem: 500, totalItems: 500, style: "serious",
      processingMode: "fast", batchMode: "high_volume", effectiveTarget: 500, plannedCount: 500,
      successfulCount: 500, warnings: [], error: null, clips, beats: [], steps: [],
      createdAt: project.createdAt, updatedAt: project.updatedAt,
    };
    let submittedBody: string | undefined;
    let exportedIds: string[] = [];
    let hasProject = false;

    await page.route("**/mock/batch.zip", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-disposition": 'attachment; filename="batch.zip"' },
        body: "mock archive",
      });
    });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path.endsWith("/health")) {
        await route.fulfill({ json: {
          status: "ready", version: "acceptance-mock", database: true, ffmpeg: true, ffprobe: true,
          whisper: true, ytdlp: true, localTts: false, dataPath: "Container data directory", freeBytes: 1_000_000,
          activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" },
        } });
      } else if (path.endsWith("/profiles")) {
        await route.fulfill({ json: [] });
      } else if (path.endsWith("/projects") && request.method() === "GET") {
        await route.fulfill({ json: hasProject ? [project] : [] });
      } else if (path.endsWith("/jobs") && request.method() === "GET") {
        await route.fulfill({ json: hasProject ? [completedJob] : [] });
      } else if (path.endsWith("/jobs/clip") && request.method() === "POST") {
        submittedBody = request.postData() || "";
        hasProject = true;
        await route.fulfill({ status: 202, json: { project, job: completedJob } });
      } else if (path.endsWith("/jobs/mock-job") && request.method() === "GET") {
        await route.fulfill({ json: completedJob });
      } else if (path.endsWith("/jobs/mock-job/events")) {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      } else if (path.endsWith("/jobs/mock-job/selection") && request.method() === "PUT") {
        const body = request.postDataJSON() as { clipIds: string[] };
        const selected = new Set(body.clipIds);
        completedJob.clips.forEach((clip) => { clip.selected = selected.has(clip.id); });
        await route.fulfill({ json: completedJob });
      } else if (path.endsWith("/jobs/mock-job/export") && request.method() === "POST") {
        const body = request.postDataJSON() as { clipIds: string[] };
        exportedIds = body.clipIds;
        await route.fulfill({ json: { downloadUrl: "/mock/batch.zip", filename: "batch.zip" } });
      } else {
        await route.fulfill({ status: 404, json: { detail: `Unhandled mock API: ${request.method()} ${path}` } });
      }
    });

    await page.goto("/");
    await page.getByRole("button", { name: /High-volume/ }).click();
    const requestedCount = page.getByLabel("Clips requested");
    await requestedCount.fill("501");
    await expect(requestedCount).toHaveValue("500");
    await page.getByRole("tab", { name: "YouTube" }).click();
    await page.getByRole("textbox", { name: "YouTube URL" }).fill("https://www.youtube.com/watch?v=mock-source");
    await page.getByRole("button", { name: /Create 500 short clips/i }).click();

    await expect.poll(() => submittedBody).toMatch(/name="batch_mode"[\s\S]*?high_volume/);
    await expect.poll(() => submittedBody).toMatch(/name="count"[\s\S]*?500/);
    await expect(page.getByText(/500 requested|500 planned|500 successful/i).first()).toBeVisible();
    await expect(page.getByText("Complete").first()).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("region", { name: "High-volume batch counts" })).toContainText("500");
    await expect(page.getByText(/500 planned|500 ready|500 successful/i).first()).toBeVisible();
    // This validates all 500 cards and selection/export requests against mocked
    // records; it does not render or encode 500 real media files.
    await expect(page.locator(".clip-board .clip-tile")).toHaveCount(500);
    const finalClipCheckbox = page.locator(".clip-board .clip-tile input[type=checkbox]").last();
    const deselection = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/jobs/mock-job/selection"));
    await finalClipCheckbox.click();
    await deselection;
    await expect(finalClipCheckbox).not.toBeChecked();
    await expect(page.getByRole("button", { name: /Download ZIP 499/ })).toBeVisible();
    await page.getByRole("button", { name: /Download ZIP 499/ }).click();
    await expect.poll(() => exportedIds.length).toBe(499);
    expect(exportedIds).toEqual(ids.slice(0, 499));

    // A mocked attachment may navigate the page as a browser download would;
    // re-enter Workspace and verify the persisted selection before reselecting.
    await page.getByRole("button", { name: "Workspace" }).click();
    await expect(page.locator(".clip-board .clip-tile")).toHaveCount(500);
    const finalClipCheckboxAfterExport = page.locator(".clip-board .clip-tile input[type=checkbox]").last();
    await expect(finalClipCheckboxAfterExport).not.toBeChecked();
    const reselection = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/jobs/mock-job/selection"));
    await finalClipCheckboxAfterExport.click();
    await reselection;
    await expect(finalClipCheckboxAfterExport).toBeChecked();
    await expect(page.getByRole("button", { name: /Download ZIP 500/ })).toBeVisible();
    await page.getByRole("button", { name: /Download ZIP 500/ }).click();
    await expect.poll(() => exportedIds.length).toBe(500);
    expect(exportedIds).toEqual(ids);
  });

  test("keeps the high-volume input usable across desktop and mobile layouts", async ({ page }, testInfo) => {
    test.info().annotations.push({
      type: "scope",
      description: "Responsive UI/input check only. No video rendering; API requests are mocked and this scenario does not submit a batch.",
    });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/health")) {
        await route.fulfill({ json: {
          status: "ready", version: "acceptance-mock", database: true, ffmpeg: true, ffprobe: true,
          whisper: true, ytdlp: true, localTts: false, dataPath: "Container data directory", freeBytes: 1_000_000,
          activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" },
        } });
      } else if (path.endsWith("/profiles")) await route.fulfill({ json: [] });
      else await route.fulfill({ status: 404, json: { detail: "No API used by this input-only check" } });
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page.getByRole("button", { name: /High-volume/ }).click();
    const count = page.getByLabel("Clips requested");
    for (const [value, label] of [["1", /Create 1 short clip/i], ["37", /Create 37 short clips/i], ["500", /Create 500 short clips/i]] as const) {
      await count.fill(value);
      await expect(count).toHaveValue(value);
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
    for (const value of ["501", "9999"]) {
      await count.fill(value);
      await expect(count).toHaveValue("500");
    }
    await page.screenshot({ path: testInfo.outputPath("high-volume-desktop.png"), fullPage: true });
    await expect(page.getByRole("button", { name: /Create 500 short clips/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "More clips" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fewer clips" })).toHaveCount(0);
    await expect(count).toHaveAttribute("type", "text");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(count).toBeVisible();
    await expect(count).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "More clips" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fewer clips" })).toHaveCount(0);
    await expect(count).toHaveValue("500");
    await count.focus();
    await count.press("Control+A");
    await count.pressSequentially("250");
    await expect(count).toHaveValue("250");
    await expect(count).toBeFocused();
    await expect(page.getByRole("button", { name: /Create 250 short clips/i })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await count.fill("500");
    await count.evaluate((input) => input.scrollIntoView({ block: "center", inline: "nearest" }));
    await expect(count).toBeInViewport();
    const mobileCountBounds = await count.evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width };
    });
    expect(mobileCountBounds.left).toBeGreaterThanOrEqual(0);
    expect(mobileCountBounds.right).toBeLessThanOrEqual(390);
    expect(mobileCountBounds.width).toBeGreaterThanOrEqual(100);
    expect(mobileCountBounds.bottom).toBeLessThan(760);
    await page.screenshot({ path: testInfo.outputPath("high-volume-mobile.png") });

    await page.getByRole("button", { name: "Standard · up to 30" }).click();
    await expect(page.getByText("30", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create 30 short clips/i })).toBeVisible();
    await page.getByRole("button", { name: /High-volume/ }).click();
    await count.fill("500");
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    await expect(page.getByText("30", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await page.getByRole("button", { name: "Long form · 16:9", exact: true }).click();
    await page.getByRole("button", { name: /High-volume/ }).click();
    const scenes = page.getByLabel("Scenes requested");
    await scenes.fill("501");
    await expect(scenes).toHaveValue("500");
    await expect(page.getByRole("button", { name: /Create 500 landscape clips/i })).toBeVisible();
  });
});
