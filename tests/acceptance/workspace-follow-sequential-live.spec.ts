import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openProjects } from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const fixture = path.join(root, "tests/fixtures/openrouter-fallback.mp4");

async function snapshot() {
  const [projectsResponse, jobsResponse] = await Promise.all([
    fetch(`${gateway}/api/v1/projects`),
    fetch(`${gateway}/api/v1/jobs`),
  ]);
  expect(projectsResponse.ok).toBeTruthy();
  expect(jobsResponse.ok).toBeTruthy();
  return {
    projects: await projectsResponse.json() as Array<{ id: string; name: string }>,
    jobs: await jobsResponse.json() as Array<{ id: string; projectId: string; state: string; stageLabel: string }>,
  };
}

async function createViaUi(page: import("@playwright/test").Page, name: string) {
  await openProjects(page);
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(fixture);
  await expect(page.locator(".drop-zone.has-file")).toBeVisible();
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  await page.getByLabel("Aspect").selectOption("9:16");
  await page.getByLabel("Minimum seconds").fill("8");
  await page.getByLabel("Maximum seconds").fill("20");
  await page.getByRole("button", { name: /^Create 5 short clips/ }).click();
}

test("follows actual one-worker sequential processing after a second UI-submitted video queues", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const errors: string[] = [];
  const browserWarnings: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("Cross-Origin-Opener-Policy header has been ignored")) browserWarnings.push(message.text());
    else if (message.type() === "error") errors.push(message.text());
  });
  const firstName = `Follow queue first ${Date.now()}`;
  const secondName = `Follow queue second ${Date.now()}`;

  await page.goto("/");
  await createViaUi(page, firstName);
  await expect(page.locator(".topbar-context")).toContainText(firstName);
  let state: Awaited<ReturnType<typeof snapshot>> | undefined;
  await expect.poll(async () => {
    state = await snapshot();
    const first = state.projects.find((item) => item.name === firstName);
    return first ? state.jobs.find((job) => job.projectId === first.id)?.state : undefined;
  }, { timeout: 90_000 }).toBe("active");

  await createViaUi(page, secondName);
  // onCreated must leave the first run selected while the second is genuinely queued.
  await expect(page.locator(".topbar-context")).toContainText(firstName);
  await expect.poll(async () => {
    state = await snapshot();
    const first = state.projects.find((item) => item.name === firstName);
    const second = state.projects.find((item) => item.name === secondName);
    const firstJob = first && state.jobs.find((job) => job.projectId === first.id);
    const secondJob = second && state.jobs.find((job) => job.projectId === second.id);
    return firstJob?.state === "active" && secondJob?.state === "queued" ? "queued-behind-first" : `${firstJob?.state ?? "missing"} / ${secondJob?.state ?? "missing"}`;
  }, { timeout: 60_000 }).toBe("queued-behind-first");

  await expect.poll(async () => {
    state = await snapshot();
    const second = state.projects.find((item) => item.name === secondName);
    return second && state.jobs.find((job) => job.projectId === second.id)?.state;
  }, { timeout: 10 * 60_000, intervals: [1000, 2500, 5000] }).toBe("active");

  state = await snapshot();
  const first = state.projects.find((item) => item.name === firstName);
  const second = state.projects.find((item) => item.name === secondName);
  const firstJob = first && state.jobs.find((job) => job.projectId === first.id);
  const secondJob = second && state.jobs.find((job) => job.projectId === second.id);
  expect(firstJob?.state).toBe("complete");
  expect(secondJob?.state).toBe("active");
  await expect(page.locator(".topbar-context")).toContainText(secondName, { timeout: 30_000 });
  await expect(page.locator(".workspace-controls")).toContainText(secondJob!.stageLabel);
  await expect(errors).toEqual([]);
  if (browserWarnings.length) test.info().annotations.push({ type: "browser-warning", description: browserWarnings.join(" | ") });
  await page.screenshot({ path: test.info().outputPath("workspace-follow-sequential-live.png"), fullPage: true });
});
