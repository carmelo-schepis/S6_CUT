/*
 * Live model dropdowns for OpenRouter and Ollama. Runs ONLY against the disposable isolated stack
 * described in ollama-endpoint.spec.ts (S6_RUN_OLLAMA=1, the Ollama mock reachable as the engine sees it).
 * The OpenRouter test also needs the isolated OpenRouter mock behind the engine (S6_TEST_MODE=1).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

const run = promisify(execFile);
const enabled = process.env.S6_RUN_OLLAMA === "1";
const gateway = (process.env.S6_ACCEPTANCE_URL || "").replace(/\/$/, "");
const ollamaUrl = process.env.S6_OLLAMA_ENGINE_URL || "";
const ollamaMock = process.env.S6_OLLAMA_MOCK_CONTAINER || "";
// Unique per run so profiles from earlier runs on the same disposable stack never match.
const runId = Date.now().toString(36);
const DEFAULT_SERVER_MODELS = [{ name: "llama3.2:latest" }, { name: "qwen2.5:0.5b:latest" }];

test.skip(!enabled || !gateway || !ollamaUrl || !ollamaMock, "requires an isolated stack; see ollama-endpoint.spec.ts");
test.skip(({ browserName, isMobile }) => browserName !== "chromium" && isMobile, "iOS loads the mobile app, which has no settings form");

/** Replace what the Ollama mock advertises; null restores the defaults. The mock rereads this on every request. */
async function setServerModels(models: { name: string }[] | null) {
  const body = JSON.stringify(models ?? DEFAULT_SERVER_MODELS);
  await run("docker", ["exec", ollamaMock, "sh", "-c", `printf '%s' '${body}' > /tmp/mock-ollama-models.json`]);
}

function watchPage(page: Page) {
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400 && !/provider-models\/scan/.test(response.url())) failed.push(`${response.status()} ${response.url()}`); });
  return { consoleErrors, failed };
}

async function openSettings(page: Page) {
  await page.goto(gateway, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

/** Creates an Ollama-only profile through the New profile form. The model is left for the dropdown. */
async function createOllamaProfile(page: Page, name: string) {
  await page.getByRole("button", { name: "New profile" }).first().click();
  const form = page.locator(".profile-form");
  await form.getByLabel("Profile name").fill(name);
  await form.getByLabel("Ollama endpoint").fill(ollamaUrl);
  await form.getByRole("button", { name: "Save and test connection" }).click();
  const row = page.getByRole("article").filter({ hasText: name });
  await expect(row).toContainText("Connected; Ollama text generation succeeded");
  return row;
}

test("the Ollama dropdown scans when it opens, shows the live list, and saves only when asked", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const seen = watchPage(page);
  const name = `Dropdown ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });

  // Hold the scan so the loading state is visible before the list arrives.
  await page.route("**/api/v1/provider-models/scan", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await field.click();
  await expect(box.getByRole("status")).toContainText("Scanning models…");
  await expect(box.getByRole("option", { name: /llama3\.2/ })).toBeVisible();
  await expect(box.getByRole("status")).toContainText("2 models found");
  await page.unroute("**/api/v1/provider-models/scan");

  await box.getByRole("option", { name: /qwen2\.5:0\.5b/ }).click();
  await expect(field).toHaveValue("qwen2.5:0.5b");
  const save = box.getByRole("button", { name: "Save and test" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(row).toContainText("Connected; Ollama text generation succeeded");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const reloaded = page.getByRole("article").filter({ hasText: name }).getByRole("region", { name: "Ollama" });
  await expect(reloaded.getByRole("combobox", { name: "Ollama model" })).toHaveValue("qwen2.5:0.5b");
  expect(seen.consoleErrors).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("a model added on the server appears at the next open, with no reload or save", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const seen = watchPage(page);
  const name = `Fresh ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await field.click();
  await expect(box.getByRole("option", { name: /qwen2\.5:0\.5b/ })).toBeVisible();
  await field.press("Escape");
  try {
    await setServerModels([{ name: "llama3.2:latest" }, { name: "phi4-mini:latest" }]);
    await field.click();
    await expect(box.getByRole("option", { name: /phi4-mini/ })).toBeVisible();
    await expect(box.getByRole("option", { name: /qwen2\.5:0\.5b/ })).toHaveCount(0);
  } finally {
    await field.press("Escape");
    await setServerModels(null);
  }
  expect(seen.consoleErrors).toEqual([]);
  expect(seen.failed).toEqual([]);
});

test("a stopped Ollama server shows the reason, keeps the typed value, and Try again works once it is back", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const name = `Stopped ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await run("docker", ["stop", "-t", "0", ollamaMock]);
  try {
    await field.fill("typed-model");
    await expect(box.getByRole("alert")).toContainText("Could not reach Ollama");
    await expect(field).toHaveValue("typed-model");
  } finally {
    await run("docker", ["start", ollamaMock]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  await box.getByRole("button", { name: "Try again" }).click();
  await expect(box.getByRole("option", { name: /llama3\.2/ })).toBeVisible();
  await expect(field).toHaveValue("typed-model");
});

test("a switched-off Ollama box cannot open and sends no scan", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const name = `Off ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  await box.getByRole("switch", { name: "Use Ollama" }).click();
  await expect(box.getByRole("switch", { name: "Use Ollama" })).not.toBeChecked();
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await expect(field).toBeDisabled();
  let scans = 0;
  page.on("request", (request) => { if (request.url().includes("/provider-models/scan")) scans += 1; });
  await field.click({ force: true });
  await page.waitForTimeout(500);
  expect(scans).toBe(0);
  await expect(box.getByRole("listbox")).toHaveCount(0);
});

test("the dropdown works by keyboard: Tab reaches it, ArrowDown opens and picks, Escape closes", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const name = `Keys ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await field.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(field).toBeFocused();
  await expect(page.locator(".model-picker-control input:focus-visible")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(box.getByRole("option", { name: /llama3\.2/ })).toBeVisible();
  // Rows: auto-detect first, then the live models in order.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Row 0 is the auto option, so two ArrowDowns after opening land on the first live model (row 1).
  await expect(field).toHaveAttribute("aria-activedescendant", /-option-1$/);
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("llama3.2");
  await page.keyboard.press("ArrowDown");
  await expect(box.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box.getByRole("listbox")).toHaveCount(0);
  await expect(field).toHaveValue("llama3.2");
});

test("a new profile can scan both providers from typed values before anything is saved", async ({ page }) => {
  test.setTimeout(300_000);
  await setServerModels(null);
  await openSettings(page);
  await page.getByRole("button", { name: "New profile" }).first().click();
  const form = page.locator(".profile-form");
  await form.getByLabel("Ollama endpoint").fill(ollamaUrl);
  await form.getByRole("combobox", { name: "Ollama model" }).click();
  await expect(form.getByRole("option", { name: /qwen2\.5:0\.5b/ })).toBeVisible();
  await form.getByRole("combobox", { name: "Ollama model" }).press("Escape");
  await form.getByLabel(/^OpenRouter API key/).fill("sk-or-v1-mock");
  await form.getByRole("combobox", { name: "Text-generation model" }).click();
  const plain = form.getByRole("option", { name: /Plain text \(mock\)/ });
  await expect(plain).toBeVisible();
  await expect(plain).toContainText("May not support structured output");
  await form.getByRole("combobox", { name: "Text-generation model" }).press("Escape");
});

test("the dropdown fits 390px and keeps its list inside the screen", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const name = `Narrow ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await expect(box.getByRole("option", { name: /llama3\.2/ })).toBeVisible();
  const popup = await page.locator(".model-picker-popup").first().boundingBox();
  expect((popup?.x ?? 0) + (popup?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("ollama-dropdown-open-390.png") });
  await field.press("Escape");
});

test("the dropdown captures each state for review at 1440px", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const name = `Look ${runId}-${testInfo.project.name.split(" ")[0]}`;
  await setServerModels(null);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSettings(page);
  const row = await createOllamaProfile(page, name);
  const box = row.getByRole("region", { name: "Ollama" });
  const field = box.getByRole("combobox", { name: "Ollama model" });
  await field.click();
  await expect(box.getByRole("option", { name: /llama3\.2/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("ollama-dropdown-open-1440.png") });
  await field.press("Escape");
});
