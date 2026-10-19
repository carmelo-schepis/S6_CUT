import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const fixture = path.resolve("tests/fixtures/openrouter-fallback.mp4");
const alternateFixture = path.resolve("tests/fixtures/youtube-credit-known.mp4");
test.use({ serviceWorkers: "block" });

async function openEditor(page: Page) {
  await page.route("**/api/v1/library/assets", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Editor" })).toBeVisible();
}

async function loadLocalSource(page: Page, video = fixture) {
  await page.getByRole("tab", { name: "Local file", exact: true }).click();
  await page.getByLabel("Choose video file").setInputFiles(video);
  await expect(page.getByLabel("Source video preview")).toHaveAttribute("src", /^blob:/);
}

test.describe("Shorts Editor autosaved drafts", () => {
  test("autosaves edits, offers resume after reload, and restores local source after reselection", async ({ page }) => {
    await openEditor(page);
    await loadLocalSource(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await page.getByLabel("Project name").fill("Recovered edit");
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveText("Draft saved locally");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toContainText("Draft available");
    await page.getByRole("button", { name: "Resume draft", exact: true }).click();
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(page.getByLabel("Project name")).toHaveValue("");
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toContainText("Reselect openrouter-fallback.mp4 to resume");

    await page.getByLabel("Choose video file").setInputFiles(fixture);
    await expect(page.getByLabel("Source video preview")).toHaveAttribute("src", /^blob:/);
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("4:5");
    await expect(page.getByLabel("Project name")).toHaveValue("Recovered edit");
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveText("Draft saved locally");
  });

  test("rejects a different local file while keeping the saved draft available", async ({ page }) => {
    await openEditor(page);
    await loadLocalSource(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveText("Draft saved locally");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await page.getByRole("button", { name: "Resume draft", exact: true }).click();

    await page.getByLabel("Choose video file").setInputFiles(alternateFixture);
    await expect(page.getByRole("alert")).toContainText("This is a different file. Select the original video to resume this draft.");
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toContainText("Reselect openrouter-fallback.mp4 to resume");
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  });

  test("discard removes the available draft across reloads", async ({ page }) => {
    await openEditor(page);
    await loadLocalSource(page);
    await page.getByLabel("Project name").fill("Discard me");
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveText("Draft saved locally");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toContainText("Draft available");
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toHaveCount(0);
  });

  test("successful queue clears the local draft for the queued baseline", async ({ page }) => {
    await page.route("**/api/v1/jobs/shorts/source", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          project: { schemaVersion: 1, id: "draft-project", name: "Queued draft", mode: "clip", style: "educational", state: "queued", sourceName: "openrouter-fallback.mp4", sourceKind: "upload", requestedCount: 1, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" },
          job: { schemaVersion: 1, id: "draft-job", projectId: "draft-project", mode: "clip", state: "queued", stage: "queued", stageLabel: "Queued", progress: 0, style: "educational", processingMode: "fast", warnings: [], clips: [], beats: [], steps: [], createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" },
        }),
      });
    });
    await openEditor(page);
    await loadLocalSource(page);
    await page.getByLabel("Aspect ratio").selectOption("4:5");
    await page.getByLabel("Project name").fill("Queued draft");
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveText("Draft saved locally");
    await page.getByRole("button", { name: "Queue short", exact: true }).click();
    await expect(page.getByText("Short queued successfully.", { exact: true })).toBeVisible();
    await expect(page.locator(".sr-only").filter({ hasText: "Draft saved locally" })).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Shorts Editor", exact: true }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Draft available" })).toHaveCount(0);
  });

  test("keeps the editor usable and reports when browser draft storage is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        value: undefined,
      });
    });
    await openEditor(page);
    await loadLocalSource(page);
    await page.getByLabel("Project name").fill("Still editable");
    await expect(page.getByRole("alert")).toContainText("Local draft saving is unavailable");
    await expect(page.getByLabel("Project name")).toHaveValue("Still editable");
  });
});
