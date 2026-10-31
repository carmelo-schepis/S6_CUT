/**
 * Smart planning on an imported YouTube source while OpenRouter fails.
 *
 * The main YouTube suite runs Smart mode with no provider configured, which
 * exercises the "OpenRouter planning: skipped" path. This one connects a
 * provider profile and makes the provider fail *at runtime*, proving the
 * deterministic local planner takes over on a real YouTube import rather than
 * only on a bundled fixture.
 *
 * The failure is injected by the isolated harness
 * (`scripts/qa/youtube-openrouter-fallback.mjs`) through `S6_TEST_MODE` on a
 * throwaway stack with its own dataset and ports — never in production. The
 * import itself is the application's own constrained yt-dlp integration:
 * nothing here bypasses authentication, age or geographic restrictions, rate
 * limits, bot protection, or signatures, and no cookies, signed CDN URLs, or
 * request headers are recorded.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPlayback, checkPlayback, collectClips, createClipProject, gateway,
  openWorkspaceForProject, waitForProjectReady, writeManifest as writeManifestTo,
} from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.resolve(root, process.env.S6_YOUTUBE_ROOT || "test-artifacts/youtube-openrouter");

const url = process.env.S6_YOUTUBE_URL;
const profileKey = process.env.S6_E2E_PROFILE_KEY;
test.skip(!url || !profileKey, "requires S6_YOUTUBE_URL and S6_E2E_PROFILE_KEY for the authorised provider-fallback test");
const match = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(url);
const videoId = match?.[1] || match?.[2] || "";

const IMPORT_DEADLINE_MS = 25 * 60_000;

if (process.env.S6_LOW_MEMORY_BROWSER) {
  test.use({
    launchOptions: {
      args: ["--disable-dev-shm-usage", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256"],
    },
  });
}

/** Wait until the engine has finished acquiring the source, or the job fails. */
async function waitForSource(page: Page) {
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const received = await page.locator(".process-checklist li").filter({ hasText: "Source received" })
      .evaluateAll((rows) => rows.some((row) => /status-complete/.test(row.className)));
    if (received) return true;
    if (await page.getByText("Project failed", { exact: true }).count()) {
      const detail = (await page.locator(".failure-strip").textContent())?.trim() || "";
      throw new Error(`the YouTube import failed before the source was received: ${detail}`);
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`the source was not received within ${IMPORT_DEADLINE_MS}ms`);
}

test.describe("Smart planning survives an OpenRouter failure on a YouTube import", () => {
  test("falls back to local planning and still renders a real Short", async ({ page }) => {
    test.setTimeout(IMPORT_DEADLINE_MS + 20 * 60_000);
    const outputDir = path.join(artifacts, "openrouter-fallback");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `YouTube OpenRouter fallback ${Date.now()}`;
    const observed = new Set<string>();
    const startedAt = Date.now();

    // Seed the connected profile through the gateway API so no password-field
    // value is ever recorded in a Playwright trace. The browser still confirms
    // the profile is connected in Settings before any job is created.
    const profileResponse = await fetch(`${gateway}/api/v1/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "E2E OpenRouter failure", textModelId: "openai/gpt-4.1-mini",
        openrouterKey: profileKey, persistence: "encrypted", selected: true,
      }),
    });
    expect(profileResponse.ok, "the failure profile was created").toBeTruthy();
    const profile = await profileResponse.json();
    expect((await fetch(`${gateway}/api/v1/profiles/${profile.id}/test`, { method: "POST" })).ok).toBeTruthy();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: "E2E OpenRouter failure" }).first())
      .toContainText("Connected; isolated provider failure test is ready", { timeout: 30_000 });

    await createClipProject(page, {
      name: projectName, count: 1, mode: "Smart", aspect: "9:16", style: "Educational",
      min: 15, max: 45, captions: true, source: { kind: "url", url: url! },
    });

    // The import must not be blamed on the provider: it happens before planning.
    await waitForSource(page);
    await waitForProjectReady(page, observed, IMPORT_DEADLINE_MS);
    const processingSeconds = (Date.now() - startedAt) / 1000;

    // --- The provider failed, and the application said so --------------------
    const notes = page.getByRole("region", { name: "Processing notes" });
    await expect(notes.getByText(/OpenRouter API failed|API failed/i),
      "the UI reports the provider failure").toHaveCount(1, { timeout: 30_000 });
    await expect(notes.getByText(/Continuing with deterministic local planning/i),
      "local planning takes over automatically").toBeVisible();
    await expect(page.locator(".process-checklist li").filter({ hasText: "OpenRouter planning" }))
      .toHaveClass(/status-failed/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Local planning fallback" }))
      .toHaveClass(/status-complete/);

    // --- ...and the project did not fail because of it -----------------------
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);
    for (const label of ["Source received", "Video validated", "Audio prepared", "Speech transcribed",
      "Complete moments selected", "Clip boundaries verified", "Clips rendered and saved",
      "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "a real clip was rendered from the YouTube source").toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.savedToLibrary, `clip ${clip.index} saved to Library`).toBeTruthy();
      expect(clip.sizeBytes).toBeGreaterThan(50_000);
      expect(clip.reportedDuration).toBeGreaterThan(0);
    }
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    // The outcome has to survive a reload like any other completed project.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await expect(notes.getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "youtube openrouter fallback after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifestTo(artifacts, "openrouter-fallback", {
      mode: "openrouter-fallback", projectName, videoId, requestedCount: 1,
      actualCount: clips.length, processingSeconds, observedStages: [...observed].sort(), clips,
    });
  });
});
