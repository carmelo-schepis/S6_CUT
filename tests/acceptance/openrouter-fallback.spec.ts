import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "tests/fixtures/openrouter-fallback.mp4");
const artifacts = path.join(root, "test-artifacts/openrouter-fallback");

async function checklistStatuses(page: import("@playwright/test").Page) {
  return page.locator(".process-checklist li").evaluateAll((rows) => rows.map((row) => ({
    label: row.querySelector(".checklist-label")?.textContent?.trim() || "",
    className: row.className,
    text: row.textContent?.trim() || "",
  })));
}

test.describe("OpenRouter Smart fallback", () => {
  test("continues through local planning after a real provider failure", async ({ page }) => {
    test.setTimeout(300_000);
    await fs.mkdir(artifacts, { recursive: true });

    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const failedResponses: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText || "unknown request failure";
      // Navigating away can abort an in-flight video preview request; it is not
      // an application failure. Every other failed request remains actionable.
      if (errorText !== "net::ERR_ABORTED") failedRequests.push(`${errorText} ${request.url()}`);
    });
    page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

    // Seed the connected profile through the real gateway API so Playwright's
    // trace never records a password-field value. The browser still verifies
    // the connected profile in Settings before creating the job.
    const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
    const profileKey = process.env.S6_E2E_PROFILE_KEY;
    if (!profileKey) throw new Error("The isolated acceptance harness did not provide a profile key");
    const profileResponse = await fetch(`${gateway}/api/v1/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      name: "E2E OpenRouter failure", modelId: "openai/gpt-4.1-mini", openrouterKey: profileKey, persistence: "encrypted", selected: true,
    }) });
    expect(profileResponse.ok).toBeTruthy();
    const profile = await profileResponse.json();
    const testResponse = await fetch(`${gateway}/api/v1/profiles/${profile.id}/test`, { method: "POST" });
    expect(testResponse.ok).toBeTruthy();

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/S6_cut/i);
    await expect(page.getByText("All local tools ready")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const providerRow = page.getByRole("article").filter({ hasText: "E2E OpenRouter failure" }).first();
    await expect(providerRow).toContainText("Connected; isolated provider failure test is ready", { timeout: 30_000 });

    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Make the first cut" })).toBeVisible();
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(fixture);
    const projectName = `OpenRouter fallback ${Date.now()}`;
    await page.getByLabel("Project name").fill(projectName);
    for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
    await page.getByLabel("Minimum seconds").fill("8");
    await page.getByLabel("Maximum seconds").fill("13");
    await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();

    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 30_000 });
    const observed = new Set<string>();
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      for (const step of await checklistStatuses(page)) {
        if (/status-(active|complete|failed|skipped)/.test(step.className)) observed.add(`${step.label}:${step.className.match(/status-(active|complete|failed|skipped)/)?.[1]}`);
      }
      const ready = await page.locator(".process-checklist li").filter({ hasText: "Project ready" }).count();
      const completeClip = await page.locator(".clip-tile.complete").count();
      if (ready && completeClip) break;
      await page.waitForTimeout(500);
    }

    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
    const processingNotes = page.getByRole("region", { name: "Processing notes" });
    await expect(processingNotes.getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1, { timeout: 30_000 });
    await expect(processingNotes.getByText(/Continuing with deterministic local planning/i)).toBeVisible();
    await expect(page.locator(".process-checklist li").filter({ hasText: "OpenRouter planning" })).toHaveClass(/status-failed/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Local planning fallback" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Complete moments selected" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Clip boundaries verified" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Clips rendered and saved" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Outputs verified" })).toHaveClass(/status-complete/);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" })).toHaveClass(/status-complete/);
    await expect(page.locator(".failure-strip")).toHaveCount(0);
    await expect(page.getByText("Project failed", { exact: true })).toHaveCount(0);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    await expect(page.locator('a[download]').first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Preview/ }).first()).toBeEnabled();

    const download = await page.request.get(await page.locator('a[download]').first().getAttribute("href") || "");
    expect(download.ok()).toBeTruthy();
    expect(download.headers()["content-type"] || "").toMatch(/^video\//);
    const outputPath = path.join(artifacts, "fallback-output.mp4");
    await fs.writeFile(outputPath, await download.body());
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(1024);
    await page.screenshot({ path: path.join(artifacts, "complete-fallback.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Make the first cut" })).toBeVisible({ timeout: 30_000 });
    const projectCard = page.locator(".project-card").filter({ hasText: projectName }).first();
    await expect(projectCard).toBeVisible({ timeout: 30_000 });
    await projectCard.click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Processing notes" }).getByText(/OpenRouter API failed|API failed/i)).toHaveCount(1);
    await expect(page.locator(".process-checklist li").filter({ hasText: "Project ready" })).toHaveClass(/status-complete/);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(failedResponses).toEqual([]);
    await page.screenshot({ path: path.join(artifacts, "reload-persistent-fallback.png"), fullPage: true });

    await fs.writeFile(path.join(artifacts, "observed-checklist-states.json"), JSON.stringify([...observed].sort(), null, 2));
    expect([...observed]).toContain("OpenRouter planning:failed");
    expect([...observed]).toContain("Local planning fallback:complete");
  });
});
