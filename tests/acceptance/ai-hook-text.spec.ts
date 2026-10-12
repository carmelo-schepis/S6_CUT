import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyHookTextMedia } from "./support/ai-hook-text-media";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.env.S6_AUTHENTICITY_FIXTURE || path.join(root, "tests/fixtures/youtube-credit-known.mp4");
const artifacts = path.resolve(root, process.env.S6_AI_HOOK_TEXT_ARTIFACTS || "test-artifacts/ai-hook-text");
// Public English 16:9 tutorial, 6:13, reported public/non-live by yt-dlp in
// the isolated engine container. Metadata reachability is not an import; the
// live acceptance remains opt-in.
const liveUrl = process.env.S6_AI_HOOK_TEXT_YOUTUBE_URL || "https://www.youtube.com/watch?v=g99k86QzyDk";
const failureMode = process.env.S6_TEST_MODE === "1" && process.env.S6_TEST_OPENROUTER_FAILURE === "timeout";
const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
let liveProfileId: string | undefined;

async function ensureConnectedProvider() {
  if (liveProfileId) return;
  const profileKey = process.env.S6_E2E_PROFILE_KEY;
  if (!profileKey) throw new Error("Live AI hook acceptance requires S6_E2E_PROFILE_KEY; inject it through the secure environment, never a file or chat.");
  const createdResponse = await fetch(`${gateway}/api/v1/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "AI hook acceptance provider", modelId: "openai/gpt-4.1-mini", openrouterKey: profileKey, persistence: "encrypted", selected: true }),
  });
  expect(createdResponse.ok(), "the isolated OpenRouter profile should be created").toBeTruthy();
  const created = await createdResponse.json();
  liveProfileId = created.id;
  const testedResponse = await fetch(`${gateway}/api/v1/profiles/${encodeURIComponent(liveProfileId)}/test`, { method: "POST" });
  expect(testedResponse.ok(), "the OpenRouter profile should connect before live jobs").toBeTruthy();
  const tested = await testedResponse.json();
  expect(tested.textStatus).toBe("connected");
}


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

async function mockConnectedProvider(page: Page) {
  await page.route("**/api/v1/profiles", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        id: "ui-only-connected-provider",
        name: "UI-only connected profile",
        textModelId: "openai/gpt-4.1-mini",
        selected: true,
        persistence: "encrypted",
        openrouterConfigured: true,
        textStatus: "connected",
        status: "connected",
        capabilities: [],
        fallbacks: {},
      }]),
    });
  });
}

async function openCreation(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const hook = page.getByRole("checkbox", { name: /AI hook text/i });
  await expect(hook).toBeVisible();
  await expect(hook, "AI hook text must start unchecked for every new project").not.toBeChecked();
  await expect.poll(() => hook.locator("xpath=..").locator("small").textContent(), { timeout: 30_000 })
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
  await ensureConnectedProvider();
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
  const hookToggle = page.getByRole("checkbox", { name: /AI hook text/i });
  await expect(hookToggle, "AI hook text must be available before a live job is submitted").toBeEnabled();
  await hookToggle.check();
  await expect(hookToggle, "Live AI hook text acceptance must explicitly enable the checkbox").toBeChecked();
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
  test.afterAll(async () => {
    if (!liveProfileId) return;
    await fetch(`${gateway}/api/v1/profiles/${encodeURIComponent(liveProfileId)}`, { method: "DELETE" });
    liveProfileId = undefined;
  });

  test("submits hook_text=true only after the checkbox is ticked", async ({ page }) => {
    await mockConnectedProvider(page);
    const submittedBodies: string[] = [];
    await page.route("**/api/v1/jobs/clip", async (route) => {
      submittedBodies.push(route.request().postData() || "");
      await route.fulfill({ status: 400, json: { detail: "Acceptance payload capture" } });
    });
    await openCreation(page);
    await chooseSpeechSource(page);
    await page.getByLabel("Project name").fill("AI hook payload acceptance");
    const hook = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(hook).toBeEnabled();
    await expect(hook).not.toBeChecked();

    const create = page.getByRole("button", { name: /Create \d+ short clips?/ });
    await create.click();
    await expect.poll(() => submittedBodies.length).toBe(1);
    expect(submittedBodies[0]).not.toMatch(/name="hook_text"\s+true/i);

    await hook.check();
    await expect(hook).toBeChecked();
    await create.click();
    await expect.poll(() => submittedBodies.length).toBe(2);
    expect(submittedBodies[1]).toMatch(/name="hook_text"\s+true/i);
  });

  test("shows eligibility reasons without enabling unsupported configurations", async ({ page }) => {
    await mockConnectedProvider(page);
    await openCreation(page);
    const hook = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(hook).toBeVisible();
    await expect(hook).toHaveAttribute("type", "checkbox");
    await expect(hook, "AI hook text must be unchecked initially").not.toBeChecked();

    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(hook).toBeDisabled();
    await expect(hook).not.toBeChecked();
    await expect(page.getByText("Fast mode does not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Smart", exact: true }).click();
    await expect(hook).not.toBeChecked();
    if (await hook.isDisabled()) {
      await expect(page.getByText("No connected provider; AI hook text is unavailable.")).toBeVisible();
    }
    await page.getByRole("button", { name: "Long form · 16:9" }).click();
    await expect(hook).toBeDisabled();
    await expect(hook).not.toBeChecked();
    await expect(page.getByText("Long form does not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Short form · 9:16" }).click();
    await page.getByRole("button", { name: "High-volume · up to 500" }).click();
    await expect(hook).toBeDisabled();
    await expect(hook).not.toBeChecked();
    await expect(page.getByText("High-volume batches do not support AI hook text.")).toBeVisible();

    await page.getByRole("button", { name: "Standard · up to 30" }).click();
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    await expect(hook).toBeDisabled();
    await expect(hook).not.toBeChecked();
    await expect(page.getByText("Music mode does not support AI hook text; Music keeps its manual Top text.", { exact: true })).toBeVisible();
  });

  test("an unticked Smart job creates no hook step or hook output", async ({ page }, testInfo) => {
    test.skip(process.env.S6_RUN_LIVE_AI_HOOK_TEXT !== "1", "set S6_RUN_LIVE_AI_HOOK_TEXT=1 for live hook acceptance");
    test.skip(testInfo.project.name !== "Desktop Chromium", "live ingestion runs only on Desktop Chromium");
    test.skip(failureMode, "run the provider-timeout case separately");
    test.setTimeout(35 * 60_000);
    await ensureConnectedProvider();
    await openCreation(page);
    const hook = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(hook, "Live opt-out verification requires an enabled connected provider").toBeEnabled();
    await expect(hook).not.toBeChecked();
    await chooseSpeechSource(page, "fixture");
    const projectName = `AI hook opt-out ${Date.now()}`;
    await page.getByLabel("Project name").fill(projectName);
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    const count = page.locator(".count-control strong");
    while (Number(await count.textContent()) > 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
    await expect(hook).not.toBeChecked();
    const createdResponse = page.waitForResponse((response) => response.url().includes("/api/v1/jobs/clip") && response.status() === 202);
    await page.getByRole("button", { name: /^Create 1 short clip$/ }).click();
    const created = await (await createdResponse).json();
    await waitForReady(page, 1);
    const response = await page.request.get(new URL(`/api/v1/jobs/${encodeURIComponent(created.job.id)}`, page.url()).toString());
    expect(response.ok()).toBeTruthy();
    const job = await response.json();
    expect(job.hookTextEnabled).toBe(false);
    expect(job.steps.map((step) => step.id)).not.toContain("hook_text");
    expect(job.clips.every((clip) => !clip.hookText)).toBe(true);
    expect(job.warnings.some((warning: string) => warning.startsWith("AI hook text unavailable:"))).toBe(false);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, `opt-out-${Date.now()}.json`), JSON.stringify({ projectName, jobId: job.id, hookTextEnabled: job.hookTextEnabled, steps: job.steps.map((step) => step.id), clips: job.clips.map((clip) => ({ id: clip.id, hookText: clip.hookText || null })) }, null, 2));
  });

  test("Serious style generates two transcript-grounded YouTube hooks, burn-in text, and an export manifest", async ({ page }, testInfo) => {
    test.skip(process.env.S6_RUN_LIVE_AI_HOOK_TEXT !== "1", "set S6_RUN_LIVE_AI_HOOK_TEXT=1 for the opt-in public YouTube workflow");
    test.skip(testInfo.project.name !== "Desktop Chromium", "live YouTube ingestion runs only on Desktop Chromium");
    test.skip(failureMode, "run the provider-timeout case separately");
    test.setTimeout(35 * 60_000);
    await openCreation(page);
    const eligible = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(eligible, "Live AI hook text acceptance requires an enabled checkbox and connected selected provider").toBeEnabled();
    const projectName = `AI hook Serious ${Date.now()}`;
    const created = await startEligibleProject(page, projectName, "youtube", { style: "Serious", countTarget: 2 });
    await waitForReady(page, 2);
    const jobId = created.job.id;
    await expect(page.locator(".process-checklist li").filter({ hasText: "Hook text written" }))
      .toHaveClass(/status-complete/, { timeout: 180_000 });
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const panel = page.locator(".inspector-section").filter({ hasText: "AI hook text" });
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
    await expect(page.locator(".inspector-section").filter({ hasText: "AI hook text" }))
      .toContainText(persistence.job.clips[0].hookText);
  });

  test("Educational style animates two YouTube hooks away from the five-second Subscribe animation", async ({ page }, testInfo) => {
    test.skip(process.env.S6_RUN_LIVE_AI_HOOK_TEXT !== "1", "set S6_RUN_LIVE_AI_HOOK_TEXT=1 for the opt-in public YouTube workflow");
    test.skip(testInfo.project.name !== "Desktop Chromium", "live YouTube ingestion runs only on Desktop Chromium");
    test.skip(failureMode, "run the provider-timeout case separately");
    test.setTimeout(35 * 60_000);
    await openCreation(page);
    const eligible = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(eligible, "Live AI hook text acceptance requires an enabled checkbox and connected selected provider").toBeEnabled();
    const projectName = `AI hook Educational ${Date.now()}`;
    const created = await startEligibleProject(page, projectName, "youtube", {
      style: "Educational", countTarget: 2, subscribeAnimation: true,
    });
    await waitForReady(page, 2);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Hook text written" }))
      .toHaveClass(/status-complete/, { timeout: 180_000 });
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    const panel = page.locator(".inspector-section").filter({ hasText: "AI hook text" });
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
    const eligible = page.getByRole("checkbox", { name: /AI hook text/i });
    await expect(eligible, "Provider-timeout acceptance requires an enabled checkbox and provisioned selected provider").toBeEnabled();
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
    const hookPanel = page.locator(".inspector-section").filter({ hasText: "AI hook text" });
    await expect(hookPanel).toContainText("Not generated");
    await expect(hookPanel).toContainText(/unavailable|timed out/i);
    const evidence = await verifyHookTextMedia(page, artifacts, `${testInfo.project.name}-ai-hook-text-timeout`, created.job.id, false);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, `timeout-${Date.now()}.json`), JSON.stringify({ projectName, media: evidence }, null, 2));
  });
});
