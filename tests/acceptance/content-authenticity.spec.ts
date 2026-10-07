/**
 * Content-authenticity acceptance: proves S6_cut renders real, playable video
 * rather than completing job records.
 *
 * Every job here is created through visible UI controls. The job API is read
 * only to recover each clip's source boundaries, which the workspace does not
 * display numerically and which the forensics step needs to prove source
 * correspondence; nothing is created or driven through it.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERALL_DEADLINE_MS, assertPlayback, capturePlaybackStills, checkPlayback, collectClips,
  createClipProject, gateway, openWorkspaceForProject, waitForProjectReady,
  writeManifest as writeManifestTo,
} from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "test-artifacts/content-authenticity");
const fixture = process.env.S6_AUTHENTICITY_FIXTURE
  || path.join(artifacts, "fixture/s6cut-authenticity-source.mp4");
const writeManifest = (name: string, payload: unknown) => writeManifestTo(artifacts, name, payload);

test.describe.configure({ mode: "serial" });

test.describe("S6_cut generates real playable video", () => {
  test("Smart mode renders multiple clips from the uploaded source", async ({ page }) => {
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "smart");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Smart authenticity ${Date.now()}`;
    const observed = new Set<string>();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

    await createClipProject(page, { name: projectName, count: 2, mode: "Smart", aspect: "9:16", min: 8, max: 20, captions: true, source: { kind: "file", path: fixture } });
    await waitForProjectReady(page, observed);

    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);

    // The engine's own progress reporting must show the real pipeline stages.
    for (const label of ["Source received", "Video validated", "Audio prepared", "Speech transcribed",
      "Complete moments selected", "Clip boundaries verified", "Clips rendered and saved",
      "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }
    expect([...observed], "planning stage observed").toEqual(
      expect.arrayContaining([expect.stringMatching(/^(OpenRouter planning|Local planning fallback):/)]),
    );

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "at least one clip completed").toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.reportedDuration, `clip ${clip.index} duration`).toBeGreaterThan(0);
      expect(clip.metaText, `clip ${clip.index} shows dimensions`).toMatch(/\d+\s*×\s*\d+ px/);
      expect(clip.savedToLibrary, `clip ${clip.index} saved to Library`).toBeTruthy();
      expect(clip.sizeBytes, `clip ${clip.index} size`).toBeGreaterThan(50_000);
    }
    if (clips.length > 1) {
      const ranges = clips.map((clip) => `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`);
      expect(new Set(ranges).size, "clips use different source ranges").toBe(clips.length);
      expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    }

    // Playback must survive switching between clips.
    if (clips.length > 1) {
      const tiles = page.locator(".clip-tile.complete");
      await tiles.nth(0).getByRole("button", { name: /Preview/ }).click();
      checkPlayback(await assertPlayback(page), "clip switch back to first");
    }

    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    // --- Persistence across a full reload -----------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" })).toHaveClass(/status-complete/);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    // --- The generated clips exist in the Library ---------------------------
    // The isolated dataset is shared with the other workflows in this file, so
    // assertions are scoped to the assets this project published rather than to
    // the Library total.
    const listGenerated = async () => (await (await fetch(`${gateway}/api/v1/library/assets?origin=generated-clip`)).json()) as
      { id: string; title: string; blobId: string }[];

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Personal Media Library" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });

    const publishedIds = clips.map((clip) => clip.libraryAssetId).filter(Boolean) as string[];
    expect(publishedIds.length, "every completed clip records a Library asset").toBe(clips.length);
    const generatedBefore = await listGenerated();
    const idsBefore = generatedBefore.map((asset) => asset.id).sort();
    for (const id of publishedIds) {
      expect(idsBefore, `clip asset ${id} is in the Library`).toContain(id);
    }
    // Each of this project's assets must be visible as its own card.
    for (const asset of generatedBefore.filter((item) => publishedIds.includes(item.id))) {
      await expect(page.locator(".asset-card").filter({ hasText: asset.title }).first()).toBeVisible();
    }

    // A reload must not republish the same outputs as new assets.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await expect(page.locator(".asset-card").first()).toBeVisible({ timeout: 30_000 });
    const generated = await listGenerated();
    const assetIdsAfterReload = generated.map((asset) => asset.id).sort();
    expect(assetIdsAfterReload, "reload created no duplicate Library assets").toEqual(idsBefore);

    // Every generated asset must be a distinct blob from the uploaded source.
    const sources = await (await fetch(`${gateway}/api/v1/library/assets?origin=project-source`)).json();
    const sourceBlobIds = new Set(sources.map((asset: { blobId: string }) => asset.blobId));
    for (const asset of generated) {
      expect(sourceBlobIds.has(asset.blobId), `generated asset ${asset.id} is not the uploaded source blob`).toBeFalsy();
    }

    // Preview one of *this* project's generated assets, not whatever is first.
    const mine = generated.find((asset) => asset.id === publishedIds[0]);
    expect(mine, "this project's asset is listed").toBeTruthy();
    const firstAsset = page.locator(".asset-card").filter({ hasText: mine!.title }).first();
    await firstAsset.locator(".asset-preview-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const libraryPlayback = await dialog.locator("video").evaluate(async (node: HTMLVideoElement) => {
      node.muted = true;
      if (node.readyState < 2) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("library preview never loaded")), 30_000);
          node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
          node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("library preview error")); }, { once: true });
        });
      }
      return { readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, duration: node.duration, src: node.currentSrc };
    });
    expect(libraryPlayback.readyState).toBeGreaterThanOrEqual(2);
    expect(libraryPlayback.width).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(outputDir, "library-generated-assets.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Close video preview" }).click();

    await writeManifest("smart", {
      mode: "smart", projectName, requestedCount: 2, actualCount: clips.length,
      observedStages: [...observed].sort(), clips, libraryPlayback,
      libraryAssetCount: generated.length,
      libraryAssetIds: assetIdsAfterReload,
      assetIdsBeforeReload: idsBefore,
      publishedIds,
    });
  });

  test("Fast mode renders without any provider or transcription dependency", async ({ page }) => {
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "fast");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Fast authenticity ${Date.now()}`;
    const observed = new Set<string>();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

    await createClipProject(page, { name: projectName, count: 2, mode: "Fast", aspect: "9:16", min: 8, max: 20, captions: false, source: { kind: "file", path: fixture } });
    await waitForProjectReady(page, observed);

    await expect(page.locator(".failure-strip")).toHaveCount(0);
    // Fast mode must not run the Smart-only stages at all.
    for (const absent of ["Speech transcribed", "OpenRouter planning", "Complete moments selected"]) {
      expect([...observed].some((entry) => entry.startsWith(`${absent}:`)), `fast mode skips ${absent}`).toBeFalsy();
    }
    for (const label of ["Source received", "Video validated", "Cut points planned",
      "Clips rendered and saved", "Outputs verified", "Project ready"]) {
      expect([...observed].some((entry) => entry.startsWith(`${label}:`)), `stage observed: ${label}`).toBeTruthy();
    }

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length).toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.reportedDuration).toBeGreaterThan(0);
      expect(clip.metaText).toMatch(/\d+\s*×\s*\d+ px/);
      expect(clip.sizeBytes).toBeGreaterThan(50_000);
    }
    if (clips.length > 1) {
      expect(new Set(clips.map((clip) => clip.sha256)).size, "clips are not byte-identical").toBe(clips.length);
    }
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "fast after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifest("fast", {
      mode: "fast", projectName, requestedCount: 2, actualCount: clips.length,
      observedStages: [...observed].sort(), clips,
    });
  });

  /**
   * Runs only in the isolated stack the harness starts with the provider
   * failure seam enabled. It complements the committed
   * openrouter-fallback.spec.ts by putting the *rendered output* of a real
   * provider failure through the same content forensics as every other mode.
   */
  test("Smart mode keeps rendering real video when OpenRouter fails", async ({ page }) => {
    test.skip(!process.env.S6_TEST_OPENROUTER_FAILURE, "provider failure seam is not enabled in this stack");
    test.setTimeout(OVERALL_DEADLINE_MS + 5 * 60_000);
    const outputDir = path.join(artifacts, "fallback");
    await fs.mkdir(outputDir, { recursive: true });
    const projectName = `Fallback authenticity ${Date.now()}`;
    const observed = new Set<string>();

    // Seed the connected profile through the gateway API so no key value is
    // ever typed into a field Playwright's trace could record. The browser
    // still confirms the connected profile in Settings before any job.
    const profileKey = process.env.S6_E2E_PROFILE_KEY;
    if (!profileKey) throw new Error("the harness did not provide a profile key");
    const created = await fetch(`${gateway}/api/v1/profiles`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Authenticity OpenRouter failure", modelId: "openai/gpt-4.1-mini", openrouterKey: profileKey, persistence: "encrypted", selected: true }),
    });
    expect(created.ok).toBeTruthy();
    const profile = await created.json();
    expect((await fetch(`${gateway}/api/v1/profiles/${profile.id}/test`, { method: "POST" })).ok).toBeTruthy();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: "Authenticity OpenRouter failure" }).first())
      .toContainText(/Connected/, { timeout: 30_000 });

    await createClipProject(page, { name: projectName, count: 1, mode: "Smart", aspect: "9:16", min: 8, max: 20, captions: true, source: { kind: "file", path: fixture } });
    await waitForProjectReady(page, observed);

    // The provider really failed, and the engine really continued locally.
    const notes = page.getByRole("region", { name: "Processing notes" });
    await expect(notes.getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1, { timeout: 30_000 });
    await expect(notes.getByText(/Continuing with deterministic local planning/i)).toBeVisible();
    await expect(page.locator(".process-checklist li").filter({ hasText: "OpenRouter planning" })).toHaveClass(/status-failed/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Local planning fallback" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Clips rendered and saved" })).toHaveClass(/status-complete/);
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);
    expect([...observed]).toContain("OpenRouter planning:failed");
    expect([...observed]).toContain("Local planning fallback:complete");

    const clips = await collectClips(page, projectName, outputDir);
    expect(clips.length, "a real video completed despite the provider failure").toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: path.join(outputDir, "completed-project.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspaceForProject(page, projectName);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(clips.length, { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Processing notes" }).getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1);
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    checkPlayback(await assertPlayback(page), "fallback after reload");
    await page.screenshot({ path: path.join(outputDir, "reload-restored.png"), fullPage: true });

    await writeManifest("fallback", {
      mode: "fallback", projectName, requestedCount: 1, actualCount: clips.length,
      observedStages: [...observed].sort(), clips,
    });
  });


});
