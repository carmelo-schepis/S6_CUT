import { expect, test } from "@playwright/test";
import path from "node:path";
import { createClipProject, jobBoundaries, openProjects, root, waitForProjectReady } from "./support/workspace";

const isExpectedBrowserWarning = (text: string) => /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(text);

test.use({ storageState: { cookies: [], origins: [] } });

test("repaired installation has no orphaned Library projects", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !isExpectedBrowserWarning(message.text())) consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()}`);
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /^All media\s*0$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("button", { name: /^All media\s*0$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build your private resolver" })).toBeVisible();

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByTestId("recent-project-count")).toHaveText("0");
  await expect(page.locator(".project-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Show all \d+ projects$/ })).toHaveCount(0);
  for (const name of ["YouTube import", "Short — test-video", "Browser acceptance"]) {
    await page.getByRole("searchbox", { name: "Search projects" }).fill(name);
    await expect(page.getByRole("button", { name: new RegExp(`^Open project ${name}`) })).toHaveCount(0);
    await expect(page.getByText(`No project matches “${name}”.`)).toBeVisible();
  }
  await page.getByRole("searchbox", { name: "Search projects" }).fill("");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("recent-project-count")).toHaveText("0");
  await expect(page.locator(".project-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Show all \d+ projects$/ })).toHaveCount(0);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
});

test("deleting project source videos removes their projects and generated media", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !isExpectedBrowserWarning(message.text())) consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()}`);
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const fixture = path.join(root, "test-video.mp4");
  const projectNames = [`Library deletion live A ${Date.now()}`, `Library deletion live B ${Date.now() + 1}`];
  const projectIds: string[] = [];
  try {
    for (const name of projectNames) {
      const observed = new Set<string>();
      await createClipProject(page, { name, count: 1, mode: "Fast", aspect: "9:16", min: 8, max: 10, captions: false, source: { kind: "file", path: fixture } });
      await waitForProjectReady(page, observed);
      projectIds.push((await jobBoundaries(name)).project.id);
    }

    await openProjects(page);
    await expect(page.getByRole("button", { name: `Open project ${projectNames[0]}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Open project ${projectNames[1]}` })).toBeVisible();
    await expect(page.getByTestId("recent-project-count")).toHaveText("2");

    await page.getByRole("button", { name: "Library", exact: true }).click();
    for (const [index, name] of projectNames.entries()) {
      await page.getByLabel("Asset origin").selectOption("project-source");
      await page.getByLabel("Search media").fill(name);
      await expect(page.getByRole("checkbox", { name: `Select ${name}` })).toBeVisible();
      await page.getByRole("checkbox", { name: `Select ${name}` }).check();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete media", exact: true }).click();

      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(page.getByRole("button", { name: `Open project ${name}` })).toHaveCount(0);
      const otherName = projectNames[1 - index];
      if (index === 0) {
        await expect(page.getByRole("button", { name: `Open project ${otherName}` })).toBeVisible();
        await expect(page.getByTestId("recent-project-count")).toHaveText("1");
      } else {
        await expect(page.getByTestId("recent-project-count")).toHaveText("0");
        await expect(page.locator(".project-card")).toHaveCount(0);
      }
      if (index === 0) await page.getByRole("button", { name: "Library", exact: true }).click();
    }

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Build your private resolver" })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Build your private resolver" })).toBeVisible();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByTestId("recent-project-count")).toHaveText("0");
    await expect(page.locator(".project-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Show all \d+ projects$/ })).toHaveCount(0);
    for (const name of projectNames) {
      await page.getByRole("searchbox", { name: "Search projects" }).fill(name);
      await expect(page.getByRole("button", { name: new RegExp(`^Open project ${name}`) })).toHaveCount(0);
    }
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  } finally {
    for (const projectId of projectIds) {
      await page.request.delete(`/api/v1/projects/${projectId}?delete_assets=true`).catch(() => undefined);
    }
  }
});
