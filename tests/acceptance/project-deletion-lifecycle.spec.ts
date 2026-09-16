import { expect, test } from "@playwright/test";

const now = "2026-08-13T00:00:00Z";
const project = {
  schemaVersion: 1,
  id: "project-deletion-fixture",
  name: "Delete everywhere fixture",
  mode: "clip",
  style: "educational",
  state: "complete",
  sourceName: "fixture.mp4",
  sourceKind: "upload",
  requestedCount: 2,
  latestJobId: "project-deletion-fixture-job",
  createdAt: now,
  updatedAt: now,
};
const job = {
  schemaVersion: 1,
  id: "project-deletion-fixture-job",
  projectId: project.id,
  mode: "clip",
  state: "complete",
  stage: "complete",
  stageLabel: "2 fast cuts ready",
  progress: 100,
  currentItem: 2,
  totalItems: 2,
  style: "educational",
  processingMode: "fast",
  warnings: [],
  error: null,
  clips: [],
  beats: [],
  steps: [],
  createdAt: now,
  updatedAt: now,
};

test("Delete project everywhere confirms before removing a project card", async ({ page }) => {
  let deletes = 0;
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([project]) });
  });
  await page.route("**/api/v1/jobs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([job]) });
  });
  await page.route(`**/api/v1/projects/${project.id}?delete_assets=true`, async (route) => {
    deletes += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/library/assets**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const deleteButton = page.getByRole("button", { name: `Delete project ${project.name} everywhere` });
  await expect(deleteButton).toBeVisible();
  await expect(page.getByRole("button", { name: `Open project ${project.name}` })).toBeVisible();
  await deleteButton.click();
  const dialog = page.getByRole("dialog", { name: `Delete “${project.name}” everywhere?` });
  await expect(dialog).toContainText("all associated jobs and clip history");
  await expect(dialog).toContainText("Shared content-addressed blobs remain");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => deletes).toBe(0);
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  await page.getByRole("button", { name: "Delete project everywhere" }).click();
  await expect.poll(() => deletes).toBe(1);
  await expect(deleteButton).toBeHidden();
});
