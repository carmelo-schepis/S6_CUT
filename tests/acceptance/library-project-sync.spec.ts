import { expect, test } from "@playwright/test";

const now = "2026-01-01T00:00:00Z";
const importedNames = ["Library sync target A", "Library sync target B"];

function makeProject(id: string, name: string) {
  return {
    schemaVersion: 1, id, name, mode: "clip", style: "educational", state: "complete",
    sourceName: `${name}.mp4`, sourceKind: "upload", requestedCount: 1,
    latestJobId: `${id}-job`, createdAt: now, updatedAt: now,
  };
}

function makeAsset(id: string, title: string, sourceProjectId: string) {
  return {
    id, title, description: "", mediaType: "video/mp4", filename: `${id}.mp4`,
    tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false,
    minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Test fixture", attribution: "",
    contentHash: `${id}-hash`, folderId: "unsorted", origin: "project-source", blobId: `${id}-blob`,
    sourceProjectId, sourceJobId: `${sourceProjectId}-job`, sourceClipId: null,
    durationSeconds: 1, width: 640, height: 360, aspectRatio: "16:9", publishedAt: now, createdAt: now,
    brands: [], people: [],
  };
}

function makeJob(projectId: string) {
  return {
    schemaVersion: 1, id: `${projectId}-job`, projectId, mode: "clip", state: "complete",
    stage: "complete", stageLabel: "Project ready", progress: 100, currentItem: 1, totalItems: 1,
    style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: false,
    embedSubtitles: false, warnings: [], error: null, clips: [], beats: [], steps: [], createdAt: now, updatedAt: now,
  };
}

test("Library deletion preserves Library behavior without restoring Projects list UI", async ({ page }) => {
  const targetProjects = [
    makeProject("project-a", importedNames[0]),
    makeProject("project-b", importedNames[1]),
  ];
  const fillerProjects = Array.from({ length: 12 }, (_, index) => makeProject(`filler-${index}`, `Unrelated project ${index}`));
  let projects = [...targetProjects, ...fillerProjects];
  let assets: ReturnType<typeof makeAsset>[] = [];
  let importIndex = 0;
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/v1/health") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
        whisper: true, ytdlp: true, localTts: false, dataPath: "Test database", freeBytes: 1_000_000,
        configuredWorkers: 0, activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "local" },
      }) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/profiles") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/projects") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/jobs") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects.map((project) => makeJob(project.id))) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/library/folders") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: now, updatedAt: now }]) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/library/assets") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(assets) });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/v1/library/assets") {
      const project = targetProjects[importIndex];
      if (!project) throw new Error("fixture imported more than two assets");
      const imported = makeAsset(`asset-${importIndex}`, importedNames[importIndex], project.id);
      importIndex += 1;
      assets = [...assets, imported];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(imported) });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/v1/library/assets/bulk-delete") {
      const body = JSON.parse(request.postData() || "{}");
      const requestedIds = new Set<string>(body.assetIds || []);
      const removed = assets.filter((asset) => requestedIds.has(asset.id));
      assets = assets.filter((asset) => !requestedIds.has(asset.id));
      const remainingProjectIds = new Set(assets.map((asset) => asset.sourceProjectId).filter(Boolean));
      projects = projects.filter((project) => !removed.some((asset) => asset.sourceProjectId === project.id) || remainingProjectIds.has(project.id));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: removed.map((asset) => asset.id), failed: {} }) });
      return;
    }
    await route.fallback();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  for (const name of importedNames) {
    await page.getByRole("button", { name: "Import asset" }).click();
    const importPanel = page.locator(".import-panel");
    await importPanel.getByLabel("File").setInputFiles({ name: `${name}.mp4`, mimeType: "video/mp4", buffer: Buffer.from("test-video") });
    await importPanel.getByLabel("Title").fill(name);
    await importPanel.getByRole("button", { name: "Import asset", exact: true }).click();
    await expect(page.getByRole("button", { name: `Select ${name} for Rule Inspector` })).toBeVisible();
  }
  await expect(page.getByRole("checkbox", { name: `Select ${importedNames[0]}` })).toBeVisible();
  await page.getByLabel("Media type").selectOption("video");
  await page.getByLabel("Asset origin").selectOption("project-source");
  await page.getByLabel("Search media").fill(importedNames[0]);
  await expect(page.getByRole("button", { name: `Select ${importedNames[0]} for Rule Inspector` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Select ${importedNames[1]} for Rule Inspector` })).toHaveCount(0);
  await page.getByLabel("Search media").fill("");

  await page.getByRole("checkbox", { name: `Select ${importedNames[0]}` }).check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete media", exact: true }).click();
  await expect(page.getByRole("button", { name: `Select ${importedNames[0]} for Rule Inspector` })).toHaveCount(0);

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Select ${importedNames[1]}` })).toBeVisible();
  await page.getByRole("checkbox", { name: `Select ${importedNames[1]}` }).check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete media", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Build your private resolver" })).toBeVisible();

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);

  expect(consoleErrors, "unexpected browser console errors").toEqual([]);
  expect(requestFailures, "unexpected failed network requests").toEqual([]);
});
