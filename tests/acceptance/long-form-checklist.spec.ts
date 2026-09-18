/**
 * A long-form project renders through the fast pipeline whatever processing
 * mode was chosen. When its checklist was built for the smart pipeline instead,
 * the renderer asked for a 'plan' step the checklist lacked and the customer
 * got "Job <uuid> has no processing step 'plan'" — attached to an unrelated row
 * of an eleven-step panel still headed "Short creation progress".
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { OVERALL_DEADLINE_MS, gateway, openProjects, root, waitForProjectReady } from "./support/workspace";

const INTERNAL_ERROR = /has no processing step/i;

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(OVERALL_DEADLINE_MS + 10 * 60_000);

test("a long-form Smart project builds the checklist its pipeline asks for", async ({ page }) => {
  const projectName = `Long form smart ${Date.now()}`;

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjects(page);
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(path.join(root, "test-video.mp4"));
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(projectName);

  // Long form plus Smart is the combination that used to disagree with itself:
  // the route builds one checklist, the renderer wants another.
  await page.getByRole("button", { name: "Long form · 16:9", exact: true }).click();
  await page.getByRole("button", { name: "Smart", exact: true }).click();
  await page.getByRole("button", { name: /^Create \d+ landscape clips?$/ }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });

  const observed = new Set<string>();
  await waitForProjectReady(page, observed);

  // The failure surfaced in the checklist panel, so read the panel itself.
  const panel = page.getByTestId("short-creation-progress");
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText(INTERNAL_ERROR);
  await expect(page.locator("body")).not.toContainText(INTERNAL_ERROR);

  // A landscape project is not a short, and its panel should not claim to be.
  await expect(panel.getByRole("heading", { name: "Short creation progress" })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Long-form creation progress" })).toBeVisible();

  // The persisted checklist is the fast one the renderer actually walks.
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json() as { projectId: string; steps?: { id: string }[] }[];
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json() as { id: string; name: string }[];
  const project = projects.find((item) => item.name === projectName);
  expect(project, "the created project is in the engine record").toBeTruthy();
  const job = jobs.find((item) => item.projectId === project!.id);
  expect(new Set((job?.steps ?? []).map((step) => step.id))).toEqual(new Set(["source", "probe", "plan", "render", "verify", "ready"]));
});
