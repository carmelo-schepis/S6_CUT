import { test, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-artifacts/helper-copy-removal");
const health = { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: false, dataPath: "Local mounted data", freeBytes: 1_000_000_000, configuredWorkers: 1, activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "Deterministic" } };
const disconnectedProfile = { id: "provider-1", name: "Studio", textModelId: "vendor/model", selected: false, persistence: "encrypted", openrouterConfigured: false, openrouterMasked: "••••1234", textStatus: "not_configured", textMessage: null, textLastCheckedAt: null, status: "connected", capabilities: ["OpenRouter text generation"], fallbacks: { planning: "Deterministic" } };
const connectedProfile = { ...disconnectedProfile, selected: true, openrouterConfigured: true, textStatus: "connected", textMessage: "Connected", status: "connected" };
const initialAsset = { id: "asset-1", title: "Fixture video", description: "", mediaType: "video/mp4", filename: "fixture.mp4", tags: [], brands: [], people: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 3, licence: "User", attribution: "", contentHash: "fixture", folderId: "folder-1", origin: "manual-import", blobId: "fixture", createdAt: "2026-01-01T00:00:00Z" };
const folder = { id: "folder-1", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const activeJob = { schemaVersion: 1, id: "job-running", projectId: "project-1", mode: "clip", state: "active", stage: "render", stageLabel: "Rendering clips", progress: 35, currentItem: 1, totalItems: 3, style: "educational", processingMode: "fast", warnings: [], error: null, clips: [], beats: [], steps: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const completedJob = { ...activeJob, id: "job-complete", state: "complete", stage: "complete", stageLabel: "Completed", progress: 100 };
const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

async function mockEngine(page: Page, { profiles = [disconnectedProfile], jobs = [] }: { profiles?: unknown[]; jobs?: unknown[] } = {}) {
  let currentAsset = initialAsset;
  let updateCount = 0;
  await page.route("**/api/v1/health", route => json(route, health));
  await page.route("**/api/v1/projects", route => json(route, []));
  await page.route("**/api/v1/jobs**", route => json(route, jobs));
  await page.route("**/api/v1/profiles", route => json(route, profiles));
  await page.route("**/api/v1/openrouter/models**", route => json(route, [{ id: "vendor/model", name: "Vendor Model", contextLength: 32000 }]));
  await page.route("**/api/v1/library/folders**", route => json(route, [folder]));
  await page.route("**/api/v1/library/recent-clips**", route => json(route, { items: [], page: 1, pageSize: 12, hasMore: false, total: 0 }));
  await page.route("**/api/v1/library/assets**", async route => {
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      currentAsset = { ...currentAsset, ...patch };
      updateCount += 1;
      await json(route, currentAsset);
      return;
    }
    await json(route, [currentAsset]);
  });
  return { get updateCount() { return updateCount; } };
}

async function openClips(page: Page) {
  const toggle = page.getByRole("button", { name: /^Clips & assistant/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: "Clips and editing assistant" })).toBeVisible();
}

async function navigate(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator("#main-content")).toBeVisible();
}

const removedCopy = [
  "Only process content you own or are authorised to use.",
  "Vertical clips are selected for short-form viewing.",
  "Landscape scenes are selected across the whole source.",
  "Fast and Smart remain available. Smart searches the full local word-timed transcript deterministically; provider ordering is bypassed for this larger batch.",
  "Fast runs deterministically on this machine. It skips transcription and captions.",
  "Checking connected providers… Smart uses one when available, otherwise local Whisper and deterministic planning.",
  "Smart uses the selected provider for enhanced planning.",
  "No provider is connected, so Smart runs on local Whisper and deterministic planning.",
  "Checking connected providers… Auto uses one when available, otherwise a fast local cut.",
  "Auto uses a connected provider, otherwise a fast local cut.",
  "No provider is connected, so Auto runs as a fast local cut.",
  "Comma-separated. Used by deterministic selection.",
  "Trim an authorised video into a social-ready clip. Choose the section, output shape, and subtitles, then queue the render.",
  "Requests are parsed into bounded edits; shell commands and secret configuration are never exposed.",
  "Turn a topic",
  "Live stages and partial results stay available here while completed history remains below.",
  "No job history yet. Create a Clip project to start a durable local render.",
  "No jobs are currently running. Completed history and recovery controls remain available here.",
  "Configure OpenRouter for text generation",
  "Configure an optional OpenRouter text-planning profile",
];

async function expectRemovedCopyAbsent(page: Page) {
  const content = await page.locator("body").innerText();
  for (const phrase of removedCopy) expect(content, `removed copy: ${phrase}`).not.toContain(phrase);
}

async function checkProcessingModes(page: Page) {
  for (const mode of ["Auto", "Fast", "Smart"]) {
    const button = page.getByRole("button", { name: mode, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expectRemovedCopyAbsent(page);
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const directory = path.join(artifactRoot, testInfo.project.name.replaceAll(/[^a-z0-9-]/gi, "-"));
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

test.describe("removed helper copy", () => {
  test("provider callout follows pending, disconnected, and connected profile states", async ({ page }, testInfo) => {
    let releaseProfiles!: () => void;
    let profilesPayload: unknown[] = [];
    const profilesPending = new Promise<void>(resolve => { releaseProfiles = resolve; });
    await mockEngine(page, { profiles: [] });
    await page.unroute("**/api/v1/profiles");
    await page.route("**/api/v1/profiles", async route => {
      await profilesPending;
      await json(route, profilesPayload);
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Processing mode" })).toBeVisible();
    await expect(page.getByText("Add optional AI providers")).toHaveCount(0);
    await checkProcessingModes(page);
    await capture(page, testInfo, "providers-pending");

    profilesPayload = [disconnectedProfile];
    releaseProfiles();
    await expect(page.getByText("Add optional AI providers")).toBeVisible();
    await checkProcessingModes(page);
    await capture(page, testInfo, "providers-disconnected");

    await page.unroute("**/api/v1/profiles");
    await page.route("**/api/v1/profiles", route => json(route, [connectedProfile]));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Processing mode" })).toBeVisible();
    await expect(page.getByText("Add optional AI providers")).toHaveCount(0);
    await checkProcessingModes(page);
    await capture(page, testInfo, "providers-connected");
  });

  test("Projects controls work across standard, high-volume, format, and Music states", async ({ page }, testInfo) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Format" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Processing mode" })).toBeVisible();

    const processing = page.locator(".processing-mode-tabs");
    for (const mode of ["Auto", "Fast", "Smart"]) {
      const button = page.getByRole("button", { name: mode, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      const createButton = page.getByRole("button", { name: /Create 5 short clips/i });
      await expect(createButton).toBeVisible();
      await expect(createButton).toBeEnabled();
      await expectRemovedCopyAbsent(page);
    }

    await page.getByRole("button", { name: "Long form · 16:9" }).click();
    const landscapeCreateButton = page.getByRole("button", { name: /Create 5 landscape clips/i });
    await expect(landscapeCreateButton).toBeVisible();
    await expect(landscapeCreateButton).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Format" })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "projects-speech-long");
    await page.getByRole("button", { name: "Short form · 9:16" }).click();

    await page.getByRole("button", { name: "High-volume · up to 500" }).click();
    await expect(page.getByRole("button", { name: "High-volume · up to 500" })).toHaveAttribute("aria-pressed", "true");
    await expect(processing).toBeVisible();
    await expect(page.getByRole("button", { name: /Create 5 short clips/i })).toBeEnabled();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "projects-high-volume");

    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    await expect(page.getByRole("heading", { name: "Lyrics presentation" })).toBeVisible();
    await expect(page.getByText(/Music \/ sung vocals always uses Smart transcription locally\. VAD disabled; word timestamps retained\./)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Format" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create 5 short clips/i })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "projects-music");

    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await expect(processing).toBeVisible();
    await expect(page.getByRole("button", { name: /Create 5 short clips/i })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "projects-speech-short");

    const modeBox = await processing.boundingBox();
    const createBox = await page.getByRole("button", { name: /Create 5 short clips/i }).boundingBox();
    expect(modeBox).not.toBeNull();
    expect(createBox).not.toBeNull();
    if (testInfo.project.name.includes("Desktop")) {
      expect(Math.abs(modeBox!.y + modeBox!.height - (createBox!.y + createBox!.height))).toBeLessThanOrEqual(8);
    }
  });

  test("Library Matching details remain editable and save", async ({ page }, testInfo) => {
    const engine = await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Library");
    await page.getByRole("button", { name: "Select Fixture video for Rule Inspector" }).click();
    await expect(page.getByRole("heading", { name: "Matching" })).toBeVisible();
    for (const label of ["Trigger phrases", "Tags", "Brands", "People"]) await expect(page.getByLabel(label)).toBeVisible();
    await expectRemovedCopyAbsent(page);

    await page.getByLabel("Trigger phrases").fill("launch, teaser");
    await page.getByLabel("Trigger phrases").press("Tab");
    await page.getByLabel("Tags").fill("campaign");
    await page.getByLabel("Tags").press("Tab");
    await page.getByLabel("Brands").fill("Studio");
    await page.getByLabel("Brands").press("Tab");
    await page.getByLabel("People").fill("Alex");
    await page.getByLabel("People").press("Tab");
    await expect.poll(() => engine.updateCount).toBe(4);
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "library-matching");
  });

  test("Shorts Editor h1, assistant input, and Send control remain", async ({ page }, testInfo) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Shorts Editor");
    await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
    await openClips(page);
    const assistantInput = page.getByRole("textbox", { name: "Editing request" });
    await expect(assistantInput).toBeVisible();
    await assistantInput.fill("Make the clip tighter");
    await expect(page.getByRole("button", { name: "Send editing request" })).toBeEnabled();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "shorts-editor");
  });

  test("Jobs empty, running, and idle states remain usable and copy-free", async ({ page }, testInfo) => {
    let currentJobs: unknown[] = [];
    await mockEngine(page, { jobs: currentJobs });
    await page.unroute("**/api/v1/jobs**");
    await page.route("**/api/v1/jobs**", route => json(route, currentJobs));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Jobs");
    await expect(page.getByRole("heading", { level: 1, name: "Jobs & recovery" })).toBeVisible();
    await expect(page.getByText("No jobs yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "jobs-empty");

    currentJobs = [activeJob];
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigate(page, "Jobs");
    await expect(page.getByText("Rendering clips")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "jobs-running");

    currentJobs = [completedJob];
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigate(page, "Jobs");
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expectRemovedCopyAbsent(page);
    await capture(page, testInfo, "jobs-idle");
  });

  test("Settings and each top-level screen stay copy-free", async ({ page }, testInfo) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    for (const [screen, heading] of [["Projects", "Projects"], ["Library", "Personal Media Library"], ["Shorts Editor", "Shorts Editor"], ["Jobs", "Jobs & recovery"], ["Settings", "Settings"]] as const) {
      if (screen !== "Projects") await navigate(page, screen);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expectRemovedCopyAbsent(page);
      await capture(page, testInfo, `screen-${screen.toLowerCase().replaceAll(" ", "-")}`);
      if (screen === "Settings") {
        await page.getByRole("button", { name: "New profile", exact: false }).first().click();
        await expect(page.getByText("New OpenRouter profile")).toBeVisible();
        await expectRemovedCopyAbsent(page);
        await capture(page, testInfo, "settings-new-profile");
      }
    }
  });

  test("each touched screen has no horizontal overflow at the configured viewport", async ({ page }, testInfo) => {
    await mockEngine(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    for (const screen of ["Projects", "Library", "Shorts Editor", "Jobs", "Settings"]) {
      if (screen !== "Projects") await navigate(page, screen);
      const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(dimensions.scrollWidth, `${screen} on ${testInfo.project.name}`).toBeLessThanOrEqual(dimensions.clientWidth);
      await expectRemovedCopyAbsent(page);
    }
  });
});
