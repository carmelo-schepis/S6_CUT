import { expect, test } from "@playwright/test";
import { requireIsolatedTarget, watchErrors } from "./support/recent-clips";
import { createClipProject, waitForProjectReady } from "./support/workspace";

test("Projects stays free of Recent projects after restart while creation and navigation still work", async ({ page }) => {
  const isolated = requireIsolatedTarget();
  const browserErrors = watchErrors(page);
  const emptyBefore = await page.request.get(`${isolated.base}/api/v1/library/recent-clips?search=&page=1&page_size=12`);
  expect(emptyBefore.ok()).toBeTruthy();
  expect(await emptyBefore.json()).toMatchObject({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 });

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent projects", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("recent-project-count")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search projects", exact: true })).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination, .project-progress, .progress-wrap, [role=progressbar]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /refresh projects/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(1);
  await expect(page.locator(".recent-clips-section").getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /delete project/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Show all \d+ projects$/ })).toHaveCount(0);
  await expect(page.locator(".projects-page .inline-empty, .projects-page .skeleton-card")).toHaveCount(0);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a project", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent projects", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("recent-project-count")).toHaveCount(0);
  await expect(page.locator(".project-card, .project-pagination")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs & recovery", exact: true })).toBeVisible();
  // The fixture has a stopped partial import; verify retry is still available
  // without changing its state or touching any live data.
  await expect(page.getByRole("button", { name: "Retry import", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("main h1")).toBeVisible();

  const projectName = `RC disposable clip ${Date.now()}`;
  const source = process.env.S6_SCRIPT_REMOVAL_MP4 || process.env.S6_AUTHENTICITY_FIXTURE || "tests/fixtures/openrouter-fallback.mp4";
  await createClipProject(page, { name: projectName, count: 1, mode: "Fast", aspect: "9:16", min: 8, max: 20, captions: false, source: { kind: "file", path: source } });
  await waitForProjectReady(page, new Set());
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveAttribute("aria-current", "page");
  const projects = await page.request.get(`${isolated.base}/api/v1/projects`).then((response) => response.json()) as { id: string; name: string }[];
  const created = projects.filter((project) => project.name === projectName);
  expect(created, "the exact submitted clip project exists in the isolated engine").toHaveLength(1);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
