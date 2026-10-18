import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const fixture = path.resolve("tests/fixtures/openrouter-fallback.mp4");
test.use({ serviceWorkers: "block" });

async function openEditor(page: Page) {
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
  await page.getByRole("tab", { name: "Local file", exact: true }).click();
  await page.getByLabel("Choose video file").setInputFiles(fixture);

  const player = page.getByLabel("Source video preview");
  await expect(player).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("tablist", { name: "Editor tools" })).toBeVisible();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
}

const undo = (page: Page) => page.getByRole("button", { name: "Undo", exact: true });
const redo = (page: Page) => page.getByRole("button", { name: "Redo", exact: true });
const mediaTools = (page: Page) => page.getByRole("tablist", { name: "Editor tools" });

async function postMultipartFields(page: Page, status = 201) {
  let body = "";
  let requestCount = 0;
  const now = "2026-10-18T00:00:00Z";
  const success = {
    project: { schemaVersion: 1, id: "history-project", name: "History fixture", mode: "clip", style: "educational", state: "queued", sourceName: "openrouter-fallback.mp4", sourceKind: "upload", requestedCount: 1, createdAt: now, updatedAt: now },
    job: { schemaVersion: 1, id: "history-job", projectId: "history-project", mode: "clip", state: "queued", stage: "queued", stageLabel: "Queued", progress: 0, style: "educational", processingMode: "fast", warnings: [], clips: [], beats: [], steps: [], createdAt: now, updatedAt: now },
  };
  await page.route("**/api/v1/jobs/shorts/source", async (route) => {
    requestCount += 1;
    body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    await route.fulfill({ status, contentType: "application/json", body: status < 300 ? JSON.stringify(success) : JSON.stringify({ detail: "Queue fixture rejected" }) });
  });
  return { getBody: () => body, getRequestCount: () => requestCount };
}

test.describe("Shorts Editor complete undo and redo", () => {
  test("undoes and redoes a sequence of distinct edits and reports saved state", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();

    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await page.getByLabel("Subtitles").uncheck();
    await mediaTools(page).getByRole("tab", { name: "Filters", exact: true }).click();
    await page.getByLabel("Preset").selectOption("warm");
    await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();

    await undo(page).click();
    await expect(page.getByLabel("Preset")).toHaveValue("none");
    await mediaTools(page).getByRole("tab", { name: "Media", exact: true }).click();
    await undo(page).click();
    await expect(page.getByLabel("Subtitles")).toBeChecked();
    await undo(page).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(undo(page)).toBeDisabled();

    await redo(page).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
    await redo(page).click();
    await expect(page.getByLabel("Subtitles")).not.toBeChecked();
    await redo(page).click();
    await mediaTools(page).getByRole("tab", { name: "Filters", exact: true }).click();
    await expect(page.getByLabel("Preset")).toHaveValue("warm");
    await expect(redo(page)).toBeDisabled();
    await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
  });

  test("one slider adjustment is one undoable step", async ({ page }) => {
    await openEditor(page);
    await mediaTools(page).getByRole("tab", { name: "Filters", exact: true }).click();
    await page.getByLabel("Preset").selectOption("warm");
    const intensity = page.getByLabel("Intensity");
    await expect(intensity).toHaveValue("1");
    const bounds = await intensity.boundingBox();
    if (!bounds) throw new Error("Filter intensity slider is not visible");
    await page.mouse.click(bounds.x + bounds.width * 0.42, bounds.y + bounds.height / 2);
    await expect(intensity).not.toHaveValue("1");

    await undo(page).click();
    await expect(intensity).toHaveValue("1");
    await redo(page).click();
    await expect(intensity).not.toHaveValue("1");
  });

  test("one text overlay drag is one undoable step", async ({ page }) => {
    await openEditor(page);
    await mediaTools(page).getByRole("tab", { name: "Text", exact: true }).click();
    await page.getByRole("button", { name: "Add text overlay" }).click();
    const horizontal = page.getByLabel("Horizontal position");
    const vertical = page.getByLabel("Vertical position");
    const before = { x: await horizontal.inputValue(), y: await vertical.inputValue() };
    const overlay = page.getByRole("button", { name: "Text overlay: Your text" });
    await expect(overlay).toBeVisible();
    await overlay.scrollIntoViewIfNeeded();
    const box = await overlay.boundingBox();
    if (!box) throw new Error("Text overlay preview is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 42, box.y + box.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await expect(horizontal).not.toHaveValue(before.x);
    await expect(vertical).not.toHaveValue(before.y);

    await undo(page).click();
    await expect(horizontal).toHaveValue(before.x);
    await expect(vertical).toHaveValue(before.y);
    await redo(page).click();
    await expect(horizontal).not.toHaveValue(before.x);
  });

  test("creates, edits, and deletes text overlays through undo and redo", async ({ page }, testInfo) => {
    await openEditor(page);
    await mediaTools(page).getByRole("tab", { name: "Text", exact: true }).click();
    await page.getByRole("button", { name: "Add text overlay" }).click();
    const overlay = page.getByRole("group", { name: "Text overlay 1" });
    await expect(overlay.getByLabel("Overlay text")).toHaveValue("Your text");
    await overlay.getByLabel("Overlay text").fill("Opening line");
    await expect(overlay.getByLabel("Overlay text")).toHaveValue("Opening line");

    await undo(page).click();
    await expect(overlay.getByLabel("Overlay text")).toHaveValue("Your text");
    await redo(page).click();
    await expect(overlay.getByLabel("Overlay text")).toHaveValue("Opening line");
    await page.screenshot({ path: testInfo.outputPath("shorts-editor-history-overlay.png"), fullPage: true });
    await page.getByRole("button", { name: "Delete text overlay 1" }).click();
    await expect(page.getByRole("group", { name: "Text overlay 1" })).toHaveCount(0);
    await undo(page).click();
    await expect(page.getByRole("group", { name: "Text overlay 1" }).getByLabel("Overlay text")).toHaveValue("Opening line");
    await redo(page).click();
    await expect(page.getByRole("group", { name: "Text overlay 1" })).toHaveCount(0);
  });

  test("keyboard shortcuts undo editor edits outside inputs while native text undo stays in editable fields", async ({ page }) => {
    await openEditor(page);
    const aspect = page.getByLabel("Aspect ratio");
    await aspect.selectOption("4:5");
    await page.getByRole("heading", { level: 1, name: "Editor" }).click();
    await page.keyboard.press("Control+z");
    await expect(aspect).toHaveValue("9:16");
    await page.keyboard.press("Control+Shift+z");
    await expect(aspect).toHaveValue("4:5");

    const name = page.getByLabel("Project name");
    await name.fill("Base title");
    await name.focus();
    await name.press("End");
    await page.keyboard.type("x");
    await name.press("Control+z");
    await expect(name).toHaveValue("Base title");
    await expect(aspect).toHaveValue("4:5");
  });

  test("does not create history for no-op edits and clears redo after a new edit", async ({ page }) => {
    await openEditor(page);
    await expect(undo(page)).toBeDisabled();
    await expect(redo(page)).toBeDisabled();
    await page.getByLabel("Aspect ratio").selectOption("9:16");
    await expect(undo(page)).toBeDisabled();

    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await undo(page).click();
    await expect(redo(page)).toBeEnabled();
    await page.getByLabel("Subtitles").uncheck();
    await expect(redo(page)).toBeDisabled();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(page.getByLabel("Subtitles")).not.toBeChecked();
  });

  test("canceling a source change preserves the current edit and its history", async ({ page }) => {
    await openEditor(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByText("Choose another source", { exact: true }).click();
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Local file", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
    await expect(undo(page)).toBeEnabled();
    await undo(page).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  });

  test("a failed Library source switch preserves the loaded source, edit, and history", async ({ page }) => {
    const now = "2026-10-18T00:00:00Z";
    const assets = [
      { id: "asset-history-a", title: "Copper sunrise", description: "", mediaType: "video/mp4", filename: "sunrise.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "history-a", folderId: "folder", origin: "generated-clip", blobId: "blob-history-a", sourceProjectId: "project-history-a", sourceJobId: "job-history-a", sourceClipId: "clip-history-a", durationSeconds: 4, width: 1080, height: 1920, previewUrl: "/api/v1/library/assets/asset-history-a/preview?sig=fixture-a", aspectRatio: "9:16", publishedAt: now, brands: [], people: [], createdAt: now },
      { id: "asset-history-b", title: "Blue city", description: "", mediaType: "video/mp4", filename: "city.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "history-b", folderId: "folder", origin: "generated-clip", blobId: "blob-history-b", sourceProjectId: "project-history-b", sourceJobId: "job-history-b", sourceClipId: "clip-history-b", durationSeconds: 4, width: 1080, height: 1920, previewUrl: "/api/v1/library/assets/asset-history-b/preview?sig=fixture-b", aspectRatio: "9:16", publishedAt: now, brands: [], people: [], createdAt: now },
    ];
    let assetReads = 0;
    await page.route("**/api/v1/library/assets", async (route) => {
      assetReads += 1;
      if (assetReads >= 3) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Library fixture unavailable" }) });
        return;
      }
      await route.fulfill({ json: assets });
    });
    await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/v1/library/assets/asset-history-*/preview**", (route) => route.fulfill({ path: fixture, contentType: "video/mp4" }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(page.getByLabel("Library video")).toBeEnabled();
    await page.getByLabel("Library video").selectOption("asset-history-a");
    await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");

    await page.getByLabel("Aspect ratio").selectOption("4:5");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("Choose another source", { exact: true }).click();
    await page.locator("#shorts-source-loaded").selectOption("asset-history-b");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("#editor-panel-title")).toHaveText("Copper sunrise");
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
    await expect(undo(page)).toBeEnabled();
    await undo(page).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  });

  test("a failed queue preserves edited values and undo history", async ({ page }) => {
    await openEditor(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    const queue = await postMultipartFields(page, 500);
    await page.getByRole("button", { name: "Queue short", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Queue fixture rejected");
    await expect.poll(queue.getRequestCount).toBe(1);
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
    await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
    await expect(undo(page)).toBeEnabled();
    await undo(page).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  });

  test("successful queue sends the final edit selected through undo and redo and marks it saved", async ({ page }) => {
    await openEditor(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await page.getByLabel("Subtitles").uncheck();
    await undo(page).click();
    await expect(page.getByLabel("Subtitles")).toBeChecked();
    await redo(page).click();
    await expect(page.getByLabel("Subtitles")).not.toBeChecked();
    const queue = await postMultipartFields(page);
    await page.getByRole("button", { name: "Queue short", exact: true }).click();
    await expect(page.locator(".shorts-inline-status")).toContainText("Short queued successfully.");
    await expect.poll(queue.getRequestCount).toBe(1);
    expect(queue.getBody()).toContain('name="aspect_ratio"\r\n\r\n4:5');
    expect(queue.getBody()).toContain('name="burn_subtitles"\r\n\r\nfalse');
    await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
    await expect(undo(page)).toBeDisabled();
    await expect(redo(page)).toBeDisabled();
  });

  test("real stack queues the undone and redone trim and audio state and completes the render", async ({ page }, testInfo) => {
    test.skip(process.env.S6_HISTORY_INTEGRATION !== "1", "Opt in with S6_HISTORY_INTEGRATION=1 against the isolated QA stack.");
    test.skip(testInfo.project.name !== "Desktop Chromium", "The real-stack render integration runs once on Desktop Chromium to avoid duplicate jobs across device projects.");
    test.setTimeout(300_000);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
    await page.getByRole("tab", { name: "Local file", exact: true }).click();
    await page.getByLabel("Choose video file").setInputFiles(fixture);
    const player = page.getByLabel("Source video preview");
    await expect(player).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0)).toBe(true);

    await page.getByRole("row", { name: "Video" }).getByRole("button", { name: "Video", exact: true }).click();
    const start = page.getByLabel("Video trim start seconds");
    await start.fill("0.4");
    await undo(page).click();
    await expect(start).toHaveValue("0");
    await redo(page).click();
    await expect(start).toHaveValue("0.4");

    await page.getByLabel("Subtitles").uncheck();

    await page.getByRole("row", { name: "Audio" }).getByRole("button", { name: "Audio", exact: true }).click();
    const mute = page.getByRole("checkbox", { name: "Mute export" });
    await expect(mute).toBeVisible();
    await mute.check();
    await undo(page).click();
    await expect(mute).not.toBeChecked();
    await redo(page).click();
    await expect(mute).toBeChecked();

    const queueResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/shorts/source"));
    await page.getByRole("button", { name: "Queue short", exact: true }).click();
    const createdResponse = await queueResponse;
    expect(createdResponse.status()).toBe(202);
    const created = await createdResponse.json() as { job: { id: string } };
    expect(created.job.id).toBeTruthy();

    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/jobs/${encodeURIComponent(created.job.id)}`);
      expect(response.ok()).toBeTruthy();
      const job = await response.json() as { state: string; error?: string | null };
      if (["failed", "partial", "cancelled_kept"].includes(job.state)) throw new Error(`Real render ended ${job.state}: ${job.error ?? "no error detail"}`);
      return job.state;
    }, { timeout: 240_000, intervals: [1_000, 3_000, 8_000] }).toBe("complete");
    const completedResponse = await page.request.get(`/api/v1/jobs/${encodeURIComponent(created.job.id)}`);
    const completed = await completedResponse.json() as { burnSubtitles: boolean; clips: Array<{ state: string; start: number; duration: number; outputName?: string | null }> };
    const renderedClip = completed.clips.find((clip) => clip.state === "complete");
    expect(renderedClip?.outputName).toBeTruthy();
    expect(renderedClip?.start).toBe(0.4);
    expect(renderedClip?.duration).toBeCloseTo(12.975, 2);
    expect(completed.burnSubtitles).toBe(false);
  });
});
