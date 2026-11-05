/*
 * Ollama endpoint acceptance. Runs ONLY against a disposable isolated stack whose engine has
 * S6_TEST_MODE=1 and S6_TEST_OPENROUTER_BASE_URL pointing at tests/fixtures/mock-openrouter, and can
 * reach tests/fixtures/mock-ollama. Required environment:
 *   S6_RUN_OLLAMA=1, S6_ACCEPTANCE_URL, S6_DATA_PATH, S6_OLLAMA_ENGINE_URL (the mock as the engine sees it),
 *   S6_OLLAMA_MOCK_CONTAINER, S6_OPENROUTER_MOCK_CONTAINER.
 * Optional: S6_OLLAMA_YOUTUBE_URL (a speech video).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";

const run = promisify(execFile);
const enabled = process.env.S6_RUN_OLLAMA === "1";
const gateway = (process.env.S6_ACCEPTANCE_URL || "").replace(/\/$/, "");
const dataPath = process.env.S6_DATA_PATH || "";
const ollamaUrl = process.env.S6_OLLAMA_ENGINE_URL || "";
const ollamaMock = process.env.S6_OLLAMA_MOCK_CONTAINER || "";
const openRouterMock = process.env.S6_OPENROUTER_MOCK_CONTAINER || "";
// The repo's test video has no speech, so Smart clipping would stop at transcription.
const youtubeUrl = process.env.S6_OLLAMA_YOUTUBE_URL || "https://www.youtube.com/watch?v=3CAHMoyOZEA";
// Unique per run so rows and projects from earlier runs on the same disposable stack never match.
const runId = Date.now().toString(36);

test.skip(!enabled || !gateway || !dataPath || !ollamaUrl || !ollamaMock || !openRouterMock, "requires an isolated stack; see the header");
test.skip(({ browserName, isMobile }) => browserName !== "chromium" && isMobile, "iOS loads the mobile app, which has no create form");

type JobStep = { label: string; status: string };
type JobView = { state: string; warnings: string[]; steps: JobStep[]; clips: { title?: string | null; titleSource?: string | null; previewUrl?: string | null }[] };

async function ollamaCalls(): Promise<string[]> {
  const { stdout } = await run("docker", ["exec", ollamaMock, "sh", "-c", "cat /tmp/mock-ollama-calls.jsonl 2>/dev/null || true"]);
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line).required.join(","));
}

async function openRouterCalls(): Promise<number> {
  const { stdout } = await run("docker", ["exec", openRouterMock, "python", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:4010/__calls').read().decode())"]);
  return JSON.parse(stdout).length;
}

async function openSettings(page: Page) {
  await page.goto(gateway, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

// Fields live in the new-profile form and in each card's boxes, so every lookup is scoped to the form.
async function saveProfile(page: Page, name: string, fields: { key?: string; url?: string; model?: string }) {
  await page.getByRole("button", { name: "New profile" }).first().click();
  const form = page.locator(".profile-form");
  await form.getByLabel("Profile name").fill(name);
  if (fields.key) await form.getByLabel(/^OpenRouter API key/).fill(fields.key);
  if (fields.url !== undefined) await form.getByLabel("Ollama endpoint").fill(fields.url);
  // Typing opens the live dropdown; close it so it cannot cover the Save button.
  if (fields.model) {
    // Target the combobox, not the label: the open listbox shares the same accessible name.
    await form.getByRole("combobox", { name: "Ollama model" }).fill(fields.model);
    await form.getByRole("combobox", { name: "Ollama model" }).press("Escape");
  }
  await form.getByRole("button", { name: "Save and test connection" }).click();
}

// Input values are not text, so endpoint checks read the box's field value.
function endpointField(row: Locator) {
  return row.getByRole("region", { name: "Ollama" }).getByLabel("Ollama endpoint");
}

function watchPage(page: Page) {
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  return { consoleErrors, failed };
}

async function openProjectOptions(page: Page) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator('button.create-option-toggle[aria-expanded="false"]').evaluateAll((buttons) => buttons.forEach((button) => (button as HTMLButtonElement).click()));
}

async function createOllamaJob(page: Page, projectName: string) {
  await openProjectOptions(page);
  await page.getByRole("button", { name: "Ollama", exact: true }).click();
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  await page.getByRole("checkbox", { name: /Hook text/i }).check();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(youtubeUrl);
  await page.getByLabel("Project name", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: /Create \d+ short clips?/i }).click();
}

// Reads the engine rather than the page so a job's outcome is never taken from another project on screen.
async function waitForProjectJob(page: Page, projectName: string): Promise<JobView> {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const projects = await (await page.request.get(`${gateway}/api/v1/projects`)).json() as { name: string; latestJobId?: string | null }[];
    const project = projects.find((item) => item.name === projectName);
    if (project?.latestJobId) {
      const job = await (await page.request.get(`${gateway}/api/v1/jobs/${project.latestJobId}`)).json() as JobView;
      if (["complete", "partial", "failed"].includes(job.state)) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Job for project "${projectName}" did not finish in time`);
}

async function expectStepLabelOnScreen(page: Page, projectName: string, text: RegExp) {
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible({ timeout: 60_000 });
  const show = page.getByRole("button", { name: "Show steps" });
  if (await show.count()) await show.click();
  await expect(page.getByRole("list", { name: "Short creation progress" })).toContainText(text);
}

test("nothing about Ollama appears on Projects while the selected profile has no endpoint", async ({ page }) => {
  await openSettings(page);
  await saveProfile(page, `Plain ${runId}`, {});
  await expect(page.getByRole("article").filter({ hasText: `Plain ${runId}` })).toBeVisible();
  await openProjectOptions(page);
  await expect(page.getByRole("button", { name: "Engine only" })).toBeVisible();
  // Scoped to the create form: Recent clips can legitimately show names from earlier Ollama projects.
  await expect(page.locator(".create-step").getByText(/Ollama/)).toHaveCount(0);
});

test("an Ollama job uses only Ollama even with a connected OpenRouter profile", async ({ page }) => {
  test.setTimeout(1_200_000);
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });

  await openSettings(page);
  await saveProfile(page, `Ollama ${runId}`, { key: "sk-or-v1-mock", url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: `Ollama ${runId}` });
  await expect(row).toContainText("Connected; Ollama text generation succeeded");
  await expect(row).toContainText("Connected; text generation succeeded");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(endpointField(row)).toHaveValue(ollamaUrl);

  const openRouterBefore = await openRouterCalls();
  const ollamaBefore = (await ollamaCalls()).length;
  const projectName = `Ollama clip ${runId}`;
  await createOllamaJob(page, projectName);
  const job = await waitForProjectJob(page, projectName);

  expect(job.state).toBe("complete");
  expect(job.steps.find((step) => step.label === "Ollama planning")?.status).toBe("complete");
  expect(job.clips.filter((clip) => clip.titleSource === "ai").length).toBeGreaterThan(0);
  expect(JSON.stringify(job)).not.toMatch(/OpenRouter/);
  expect(new Set((await ollamaCalls()).slice(ollamaBefore))).toEqual(new Set(["indexes", "hooks", "clips"]));
  expect(await openRouterCalls()).toBe(openRouterBefore);

  const preview = job.clips.find((clip) => clip.previewUrl)?.previewUrl;
  expect((await page.request.get(`${gateway}${preview}`, { headers: { Range: "bytes=0-1023" } })).status()).toBeLessThan(300);
  await expectStepLabelOnScreen(page, projectName, /Ollama planning\s*Complete/);
  expect(consoleErrors.filter((text) => !/Cross-Origin-Opener-Policy/.test(text))).toEqual([]);
  expect(failed).toEqual([]);
});

test("an Ollama-only profile with no key completes a job", async ({ page, isMobile }) => {
  test.skip(isMobile, "the engine path is identical; one project keeps the run short");
  test.setTimeout(1_200_000);
  await openSettings(page);
  await saveProfile(page, `Only ${runId}`, { url: ollamaUrl, model: "llama3.2" });
  await expect(page.getByRole("article").filter({ hasText: `Only ${runId}` })).toContainText("Connected; Ollama text generation succeeded");
  const projectName = `Only clip ${runId}`;
  await createOllamaJob(page, projectName);
  const job = await waitForProjectJob(page, projectName);
  expect(job.state).toBe("complete");
  expect(job.steps.find((step) => step.label === "Ollama planning")?.status).toBe("complete");
});

test("Ollama going offline falls back locally with a warning that names Ollama", async ({ page }) => {
  test.setTimeout(1_200_000);
  await openSettings(page);
  await saveProfile(page, `Offline ${runId}`, { url: ollamaUrl, model: "llama3.2" });
  await expect(page.getByRole("article").filter({ hasText: `Offline ${runId}` })).toContainText("Connected; Ollama text generation succeeded");
  await run("docker", ["stop", "-t", "0", ollamaMock]);
  try {
    const projectName = `Offline clip ${runId}-${test.info().project.name.split(" ")[0]}`;
    await createOllamaJob(page, projectName);
    const job = await waitForProjectJob(page, projectName);
    expect(job.state).toBe("complete");
    expect(job.clips.length).toBeGreaterThan(0);
    expect(job.steps.find((step) => step.label === "Ollama planning")?.status).toBe("failed");
    expect(job.warnings.join(" ")).toMatch(/Ollama API failed: .*Continuing with deterministic local planning/);
    expect(job.warnings.join(" ")).not.toMatch(/OpenRouter|Traceback|httpx/);
    await expectStepLabelOnScreen(page, projectName, /Ollama API failed/);
  } finally {
    await run("docker", ["start", ollamaMock]);
  }
});

test("bad addresses are refused and a missing model says how to pull it", async ({ page }) => {
  const consoleCheck = `Bad ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  for (const url of ["ftp://x", "http://user:pw@host", "http://h/?a=1"]) {
    await page.getByRole("button", { name: "New profile" }).first().click();
    await page.getByLabel("Profile name").fill(consoleCheck);
    await page.locator(".profile-form").getByLabel("Ollama endpoint").fill(url);
    await page.getByRole("button", { name: "Save and test connection" }).click();
    await expect(page.locator(".profile-form .form-error")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("article").filter({ hasText: consoleCheck })).toHaveCount(0);
  }
  const name = `Missing ${runId}-${test.info().project.name.split(" ")[0]}`;
  await saveProfile(page, name, { url: ollamaUrl, model: "not-installed" });
  await expect(page.getByRole("article").filter({ hasText: name })).toContainText("ollama pull not-installed");
});

test("the choice is keyboard reachable, fits 390px, survives other saves and goes when cleared", async ({ page }) => {
  const name = `Clear ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  await expect(endpointField(row)).toHaveValue(ollamaUrl);

  // These saves send no Ollama fields; the endpoint must survive both.
  await page.getByTestId("auto-seo-titles").click();
  await expect(endpointField(row)).toHaveValue(ollamaUrl);
  await saveProfile(page, `Second ${runId}-${test.info().project.name.split(" ")[0]}`, {});
  await expect(row).not.toContainText("Active");
  await row.getByRole("button", { name: "Use profile" }).click();
  await expect(row).toContainText("Active");
  await expect(endpointField(row)).toHaveValue(ollamaUrl);

  await page.setViewportSize({ width: 390, height: 844 });
  await openProjectOptions(page);
  const engineOnly = page.getByRole("button", { name: "Engine only" });
  const ollama = page.getByRole("button", { name: "Ollama", exact: true });
  await engineOnly.focus();
  await page.keyboard.press("Tab");
  await expect(ollama).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ollama).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Uses your Ollama server for supported text features")).toBeVisible();
  const box = await ollama.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("execution-390.png") });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await endpointField(row).fill("");
  await row.getByRole("region", { name: "Ollama" }).getByRole("button", { name: "Save and test" }).click();
  await expect(endpointField(row)).toHaveValue("");
  await openProjectOptions(page);
  await expect(ollama).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProjectOptions(page);
  await expect(ollama).toHaveCount(0);
});

test("a very long endpoint does not break the profile row at 390px", async ({ page }) => {
  const name = `Long ${runId}-${test.info().project.name.split(" ")[0]}`;
  const longHost = `http://${Array.from({ length: 24 }, () => "segment").join(".")}.test:11434`;
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await saveProfile(page, name, { url: longHost, model: "llama3.2" });
  await expect(page.getByRole("article").filter({ hasText: name })).toContainText("Could not reach Ollama", { timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("an OpenRouter switch turned off survives a reload and stops every OpenRouter call", async ({ page }) => {
  test.setTimeout(600_000);
  const seen = watchPage(page);
  const name = `Switch ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { key: "sk-or-v1-mock", url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  await expect(row).toContainText("Connected; text generation succeeded");
  const openRouterBox = row.getByRole("region", { name: "OpenRouter" });
  await openRouterBox.getByRole("switch", { name: "Use OpenRouter" }).click();
  await expect(openRouterBox.getByRole("switch", { name: "Use OpenRouter" })).not.toBeChecked();
  await expect(openRouterBox).toContainText("Off. Not used for new jobs. Saved settings are kept.");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const reloaded = page.getByRole("article").filter({ hasText: name });
  const box = reloaded.getByRole("region", { name: "OpenRouter" });
  await expect(box.getByRole("switch", { name: "Use OpenRouter" })).not.toBeChecked();
  await expect(box.getByLabel(/^OpenRouter API key/)).toHaveValue("");
  await expect(box.getByLabel(/^OpenRouter API key/)).toBeDisabled();

  const openRouterBefore = await openRouterCalls();
  await reloaded.getByRole("button", { name: "Test", exact: true }).click();
  await expect(reloaded.getByRole("region", { name: "Ollama" })).toContainText("Connected; Ollama text generation succeeded", { timeout: 60_000 });
  expect(await openRouterCalls()).toBe(openRouterBefore);

  await box.getByRole("switch", { name: "Use OpenRouter" }).click();
  await expect(box.getByRole("switch", { name: "Use OpenRouter" })).toBeChecked();
  await expect(box).toContainText("Connected; text generation succeeded");
  expect(seen.consoleErrors.filter((text) => !/Cross-Origin-Opener-Policy/.test(text))).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("an Ollama switch hides the Projects choice, comes back with its endpoint, and works from the keyboard", async ({ page }) => {
  const seen = watchPage(page);
  const name = `OllamaSwitch ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  await expect(row).toContainText("Connected; Ollama text generation succeeded");
  await openProjectOptions(page);
  await expect(page.getByRole("button", { name: "Ollama", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const ollamaSwitch = row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" });
  // Reach the switch with the keyboard so the focus ring is the keyboard one, not a mouse-focus artefact.
  await ollamaSwitch.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(ollamaSwitch).toBeFocused();
  await page.keyboard.press("Space");
  await expect(ollamaSwitch).not.toBeChecked();
  await expect(page.locator(".provider-switch input:focus-visible + .provider-switch-track")).toHaveCount(1);
  await expect(row.getByRole("region", { name: "Ollama" })).toContainText("Off. Not used for new jobs. Saved settings are kept.");
  await openProjectOptions(page);
  await expect(page.getByRole("button", { name: "Ollama", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" }).click();
  await expect(row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" })).toBeChecked();
  await expect(endpointField(row)).toHaveValue(ollamaUrl);
  await expect(row).toContainText("Connected; Ollama text generation succeeded");
  await openProjectOptions(page);
  await expect(page.getByRole("button", { name: "Ollama", exact: true })).toBeVisible();
  expect(seen.consoleErrors.filter((text) => !/Cross-Origin-Opener-Policy/.test(text))).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("with both providers off, a Fast job still completes and no provider is called", async ({ page }) => {
  test.setTimeout(1_200_000);
  const seen = watchPage(page);
  const name = `Both ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { key: "sk-or-v1-mock", url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  await row.getByRole("region", { name: "OpenRouter" }).getByRole("switch", { name: "Use OpenRouter" }).click();
  await row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" }).click();
  await expect(row.getByRole("region", { name: "OpenRouter" }).getByRole("switch", { name: "Use OpenRouter" })).not.toBeChecked();
  await expect(row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" })).not.toBeChecked();

  const openRouterBefore = await openRouterCalls();
  const ollamaBefore = (await ollamaCalls()).length;
  const projectName = `Both off clip ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openProjectOptions(page);
  await expect(page.getByRole("button", { name: "Ollama", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(youtubeUrl);
  await page.getByLabel("Project name", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: /Create \d+ short clips?/i }).click();
  const job = await waitForProjectJob(page, projectName);
  expect(job.state).toBe("complete");
  expect(await openRouterCalls()).toBe(openRouterBefore);
  expect((await ollamaCalls()).length).toBe(ollamaBefore);
  expect(seen.consoleErrors.filter((text) => !/Cross-Origin-Opener-Policy/.test(text))).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("an Auto Smart job with OpenRouter switched off plans locally and never calls OpenRouter", async ({ page }) => {
  test.setTimeout(1_200_000);
  const seen = watchPage(page);
  const name = `AutoOff ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { key: "sk-or-v1-mock", url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  await row.getByRole("region", { name: "OpenRouter" }).getByRole("switch", { name: "Use OpenRouter" }).click();
  await expect(row.getByRole("region", { name: "OpenRouter" }).getByRole("switch", { name: "Use OpenRouter" })).not.toBeChecked();

  const openRouterBefore = await openRouterCalls();
  const projectName = `Auto off clip ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openProjectOptions(page);
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByRole("textbox", { name: "YouTube URL" }).fill(youtubeUrl);
  await page.getByLabel("Project name", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: /Create \d+ short clips?/i }).click();
  const job = await waitForProjectJob(page, projectName);
  expect(job.state).toBe("complete");
  expect(await openRouterCalls()).toBe(openRouterBefore);
  expect(seen.consoleErrors.filter((text) => !/Cross-Origin-Opener-Policy/.test(text))).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("provider boxes fit at 1440px and 390px in each switch state, and are screenshotted for review", async ({ page }) => {
  const name = `Look ${runId}-${test.info().project.name.split(" ")[0]}`;
  await openSettings(page);
  await saveProfile(page, name, { key: "sk-or-v1-mock", url: ollamaUrl, model: "llama3.2" });
  const row = page.getByRole("article").filter({ hasText: name });
  const openRouterSwitch = row.getByRole("region", { name: "OpenRouter" }).getByRole("switch", { name: "Use OpenRouter" });
  const ollamaSwitch = row.getByRole("region", { name: "Ollama" }).getByRole("switch", { name: "Use Ollama" });
  const states: [string, () => Promise<void>][] = [
    ["both-on", async () => undefined],
    ["openrouter-off", async () => { await openRouterSwitch.click(); await expect(openRouterSwitch).not.toBeChecked(); }],
    ["both-off", async () => { await ollamaSwitch.click(); await expect(ollamaSwitch).not.toBeChecked(); }],
  ];
  for (const [state, apply] of states) {
    await apply();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(row.getByRole("region", { name: "Ollama" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const box = await row.getByRole("region", { name: "Ollama" }).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: test.info().outputPath(`provider-boxes-${state}-${width}.png`), fullPage: true });
    }
  }
});
