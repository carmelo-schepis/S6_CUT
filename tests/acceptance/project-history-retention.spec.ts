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

test("Projects no longer exposes project-wide deletion while Jobs retains history", async ({ page }) => {
  let deleteRequests = 0;
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([project]) });
  });
  await page.route("**/api/v1/jobs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([job]) });
  });
  await page.route(`**/api/v1/projects/${project.id}?delete_assets=true`, async (route) => {
    deleteRequests += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/library/assets**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete project .* everywhere/ })).toHaveCount(0);
  expect(deleteRequests).toBe(0);

  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
  const jobCard = page.locator(`.job-card[data-project-id="${project.id}"]`);
  await expect(jobCard).toBeVisible();
  await expect(jobCard.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  expect(deleteRequests).toBe(0);
});
