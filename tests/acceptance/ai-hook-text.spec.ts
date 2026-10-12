import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyHookTextMedia } from "./support/ai-hook-text-media";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_AUTHENTICITY_FIXTURE || path.join(root, "tests/fixtures/youtube-credit-known.mp4");
const artifacts = path.resolve(root, process.env.S6_AI_HOOK_TEXT_ARTIFACTS || "test-artifacts/ai-hook-text");
// Public English TED talk, 263 seconds, reported public by yt-dlp in the
// project engine image. Metadata reachability was checked without touching any
// running stack; a real import remains an opt-in acceptance run.
const liveUrl = process.env.S6_AI_HOOK_TEXT_YOUTUBE_URL || "https://www.youtube.com/watch?v=NiKtZgImdlY";
const failureMode = process.env.S6_TEST_MODE === "1" && process.env.S6_TEST_OPENROUTER_FAILURE === "timeout";

async function verifyStoredHooksAndManifest(page, jobId: string, prefix: string) {
  const baseUrl = page.url();
  const response = await page.request.get(new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}`, baseUrl).toString());
  expect(response.ok()).toBeTruthy();
  const job = await response.json();
  expect(job.hookTextEnabled).toBe(true);
  expect(job.clips).toHaveLength(2);
  for (const clip of job.clips) {
    const hook = (clip.hookText || "").trim();
    expect(hook.length, `clip ${clip.id} hook length`).toBeGreaterThanOrEqual(20);
    expect(hook.length, `clip ${clip.id} hook length`).toBeLessThanOrEqual(150);
    expect(hook.toLocaleLowerCase()).not.toBe((clip.openingLine || "").trim().toLocaleLowerCase());
    expect(hook).not.toMatch(/#|@|https?:\/\/|www\.|\p{Extended_Pictographic}/u);
  }
  const exportResponse = await page.request.post(new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}/export`, baseUrl).toString(), {
    data: { clipIds: job.clips.map((clip) => clip.id) },
  });
  expect(exportResponse.ok()).toBeTruthy();
  const archive = await exportResponse.json();
  const downloadUrl = new URL(archive.downloadUrl, baseUrl).toString();
  const zipResponse = await page.request.get(downloadUrl);
  expect(zipResponse.ok()).toBeTruthy();
  await fs.mkdir(artifacts, { recursive: true });
  const zipPath = path.join(artifacts, `${prefix}.zip`);
  await fs.writeFile(zipPath, await zipResponse.body());
  const manifest = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read('manifest.json').decode())", zipPath], { encoding: "utf8" }));
  expect(manifest.outputs).toHaveLength(2);
  expect(manifest.outputs.map((output) => output.hook_text)).toEqual(job.clips.map((clip) => clip.hookText));
  return { job, manifest, zipPath };
}

async function openCreation(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const hook = page.getByRole("checkbox", { name: /Generate AI hook text/i });
  await expect(hook).toBeVisible();
  await expect.poll(() => hook.locator("xpath=.. span small").textContent(), { timeout: 30_000 })
    .not.toBe("Checking connected providers…");
}

async function chooseSpeechSource(page, source: "fixture" | "youtube" = "fixture") {
  if (source === "fixture") {
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(fixture);
    await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  } else {
    await page.getByRole("tab", { name: "YouTube" }).click();
    await page.locator("#source-youtube-url").fill(liveUrl);
  }
}

async function waitForReady(page, expectedClips = 2) {
  await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" }))
    .toHaveClass(/status-complete/, { timeout: 25 * 60_000 });
  await expect(page.locator(".clip-tile.complete")).toHaveCount(expectedClips, { timeout: 30_000 });
}

async function startEligibleProject(page, name: string, source: "fixture" | "youtube", {
  style = "Serious", countTarget = 2, subscribeAnimation = false,
} = {}) {
  await openCreation(page);
  await chooseSpeechSource(page, source);
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: style, exact: true }).click();
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  const count = page.locator(".count-control strong");
  for (let attempts = 0; attempts < 30 && Number(await count.textContent()) > countTarget; attempts += 1) {
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  }
  await expect(count).toHaveText(String(countTarget));
  const hookToggle = page.getByRole("checkbox", { name: /Generate AI hook text/i });
  await expect(hookToggle).toBeEnabled();
  await expect(hookToggle).toBeChecked();
  if (subscribeAnimation) {
    await page.getByLabel("Enable Subscribe animation").check();
    await page.getByLabel("Subscribe animation timing").selectOption("5");
  }
  const createdResponse = page.waitForResponse((response) => response.url().includes("/api/v1/jobs/clip") && response.status() === 202);
  await page.getByRole("button", { name: new RegExp(`^Create ${countTarget} short clips?$`) }).click();
  const created = await (await createdResponse).json();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 60_000 });
  return created;
}

test.describe("AI hook text acceptance", () => {
  test("shows eligibility reasons without enabling unsupported configurations", async ({ page }) => {
    await openCreation(page);
    const hook = page.getByRole("checkbox", { name: /Generate AI hook text/i });
    await expect(hook).toBeVisible();
    await expect(hook).toHaveAttribute("type", "checkbox");

    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(hook).toBeDisabled();
    await expect(page.getByText("Fast mode does not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Smart", exact: true }).click();
    if (await hook.isDisabled()) {
      await expect(page.getByText("No connected provider; AI hook text is unavailable.")).toBeVisible();
    } else {
      await expect(hook).toBeChecked();
    }
    await page.getByRole("button", { name: "Long form · 16:9" }).click();
    await expect(hook).toBeDisabled();
    await expect(page.getByText("Long form does not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Short form · 9:16" }).click();
    await page.getByRole("button", { name: "High-volume · up to 500" }).click();
    await expect(hook).toBeDisabled();
    await expect(page.getByText("High-volume batches do not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Standard · up to 30" }).click();
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    await expect(hook).toBeDisabled();
    await expect(page.getByText("Music mode does not support AI hook text.")).toBeVisible();
  });

  test("Serious style generates two transcript-grounded YouTube hooks, burn-in text, and an export manifest", async ({ page }, testInfo) => {
    test.skip(process.env.S6_RUN_LIVE_AI_HOOK_TEXT !== "1", "set S6_RUN_LIVE_AI_HOOK_TEXT=1 for the opt-in public YouTube workflow");
    test.skip(testInfo.project.name !== "Desktop Chromium", "live YouTube ingestion runs only on Desktop Chromium");
    test.skip(failureMode, "run the provider-timeout case separately");
    test.setTimeout(35 * 60_000);
    await openCreation(page);
    const eligible = page.getByRole("checkbox", { name: /Generate AI hook text/i });
    if (await eligible.isDisabled()) test.skip(true, "requires a connected selected OpenRouter provider");
    const projectName = `AI hook Serious ${Date.now()}`;
    const created = await startEligibleProject(page, projectName, "youtube", { style: "Serious", countTarget: 2 });
    await waitForReady(page, 2);
    const jobId = created.job.id;
    await expect(page.locator(".process-checklist li").filter({ hasText: "Hook text written" }))
      .toHaveClass(/status-complete/, { timeout: 180_000 });
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const panel = page.locator(".inspector-section").filter({ has: page.getByText("Hook text · OpenRouter", { exact: true }) });
    await expect(panel).not.toContainText("Not generated");
    const evidence = await verifyHookTextMedia(page, artifacts, `${testInfo.project.name}-serious-ai-hook-text`, jobId);
    const persistence = await verifyStoredHooksAndManifest(page, jobId, "serious-ai-hook-text");
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, `serious-${Date.now()}.json`), JSON.stringify({ projectName, media: evidence, persistence }, null, 2));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    const jobCard = page.locator(".job-card").filter({ hasText: projectName }).first();
    await expect(jobCard).toBeVisible({ timeout: 60_000 });
    await jobCard.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.locator(".clip-tile.complete")).toHaveCount(2, { timeout: 60_000 });
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    await expect(page.locator(".inspector-section").filter({ has: page.getByText("Hook text · OpenRouter", { exact: true }) }))
      .toContainText(persistence.job.clips[0].hookText);
  });

  test("Educational style animates two YouTube hooks away from the five-second Subscribe animation", async ({ page }, testInfo) => {
    test.skip(process.env.S6_RUN_LIVE_AI_HOOK_TEXT !== "1", "set S6_RUN_LIVE_AI_HOOK_TEXT=1 for the opt-in public YouTube workflow");
    test.skip(testInfo.project.name !== "Desktop Chromium", "live YouTube ingestion runs only on Desktop Chromium");
    test.skip(failureMode, "run the provider-timeout case separately");
    test.setTimeout(35 * 60_000);
    await openCreation(page);
    const eligible = page.getByRole("checkbox", { name: /Generate AI hook text/i });
    if (await eligible.isDisabled()) test.skip(true, "requires a connected selected OpenRouter provider");
    const projectName = `AI hook Educational ${Date.now()}`;
    const created = await startEligibleProject(page, projectName, "youtube", {
      style: "Educational", countTarget: 2, subscribeAnimation: true,
    });
    await waitForReady(page, 2);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Hook text written" }))
      .toHaveClass(/status-complete/, { timeout: 180_000 });
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const panel = page.locator(".inspector-section").filter({ has: page.getByText("Hook text · OpenRouter", { exact: true }) });
    await expect(panel).not.toContainText("Not generated");
    const evidence = await verifyHookTextMedia(page, artifacts, `${testInfo.project.name}-educational-ai-hook-text`, created.job.id);
    const persistence = await verifyStoredHooksAndManifest(page, created.job.id, "educational-ai-hook-text");
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, `educational-${Date.now()}.json`), JSON.stringify({ projectName, media: evidence, persistence }, null, 2));
  });

  test("provider timeout falls back without exposing provider credentials", async ({ page }, testInfo) => {
    test.skip(!failureMode, "requires an isolated deployment with S6_TEST_MODE=1 and S6_TEST_OPENROUTER_FAILURE=timeout");
    test.skip(testInfo.project.name !== "Desktop Chromium", "provider-timeout media check runs only on Desktop Chromium");
    await openCreation(page);
    const eligible = page.getByRole("checkbox", { name: /Generate AI hook text/i });
    if (await eligible.isDisabled()) test.skip(true, "requires a selected provider profile provisioned in the isolated stack");
    const projectName = `AI hook text timeout ${Date.now()}`;
    const created = await startEligibleProject(page, projectName, "fixture");
    await waitForReady(page);
    await expect(page.getByRole("region", { name: "Processing notes" })).toContainText(/AI hook text unavailable|timed out/i, { timeout: 120_000 });
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Hook text written" }))
      .toHaveClass(/status-failed/);
    await expect(page.getByText(/sk-or-v1-|openrouterKey|API key:/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const hookPanel = page.locator(".inspector-section").filter({ has: page.getByText("Hook text · OpenRouter", { exact: true }) });
    await expect(hookPanel).toContainText("Not generated");
    await expect(hookPanel).toContainText(/unavailable|timed out/i);
    const evidence = await verifyHookTextMedia(page, artifacts, `${testInfo.project.name}-ai-hook-text-timeout`, created.job.id, false);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, `timeout-${Date.now()}.json`), JSON.stringify({ projectName, media: evidence }, null, 2));
  });
});
