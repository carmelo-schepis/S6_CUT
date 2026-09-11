import { test, expect, type Page } from "@playwright/test";
import type { Job, Project } from "../../web/src/types";

/**
 * Customer-facing control behaviour that regressed or was repaired during the
 * post-release acceptance pass. These cover intent, not implementation detail:
 * one click makes one job, long histories stay reachable, and a download
 * returns media rather than an error document.
 */

/** Replace the project/job lists with a large synthetic history. */
async function installLargeHistory(page: Page, count: number) {
  const [projectsResponse, jobsResponse] = await Promise.all([
    page.request.get("/api/v1/projects"),
    page.request.get("/api/v1/jobs"),
  ]);
  const realProjects = await projectsResponse.json() as Project[];
  const realJobs = await jobsResponse.json() as Job[];
  const template = realProjects[0];
  const templateJob = realJobs.find((job) => job.id === template?.latestJobId) || realJobs[0];
  if (!template || !templateJob) throw new Error("No seed project/job available");

  const projects: Project[] = Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `history-project-${index}`,
    latestJobId: `history-job-${index}`,
    name: `History project ${String(index).padStart(3, "0")}`,
    updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
  }));
  const jobs: Job[] = projects.map((project, index) => ({
    ...templateJob,
    id: `history-job-${index}`,
    projectId: project.id,
    state: "complete",
    stage: "complete",
    stageLabel: "1 fast cut ready",
    progress: 100,
  }));

  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects) });
  });
  await page.route("**/api/v1/jobs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobs) });
  });
  return { projects, jobs };
}

test.describe("customer controls", () => {
  test("one click on Create makes exactly one job even when double-clicked", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/v1/jobs/clip", async (route) => {
      posts += 1;
      // Hold the request open so the second click lands while the first is
      // still in flight — the situation a real double-click creates. Answer
      // without creating real work; the guard under test is client-side.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "QA guard probe" }) });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await page.getByRole("tab", { name: /Local file/ }).click();
    await page.locator('input[aria-label="Choose video file"]').setInputFiles({
      name: "double-click.mp4", mimeType: "video/mp4", buffer: Buffer.from("0".repeat(4096)),
    });
    const create = page.getByRole("button", { name: /Create \d+ short clip/ });
    await expect(create).toBeEnabled();
    // Both clicks in the same JavaScript tick: React has no chance to apply the
    // disabled state in between, so only the in-flight guard can stop the second.
    await create.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => posts, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(4_000);
    expect(posts, "double-click must not create two jobs").toBe(1);
    // After the failure resolves the customer can deliberately retry.
    await expect(page.locator(".form-error")).toBeVisible();
    await expect(create).toBeEnabled();
  });

  test("a long project history stays bounded and every project remains reachable", async ({ page }) => {
    const total = 40;
    await installLargeHistory(page, total);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await expect(page.locator(".project-card").first()).toBeVisible();

    // Bounded by default so a large history cannot produce an unusable page.
    await expect(page.locator(".project-card")).toHaveCount(12);
    const showAll = page.getByRole("button", { name: `Show all ${total} projects` });
    await expect(showAll).toBeVisible();

    // An older project, outside the visible window, is reachable by search.
    const buried = "History project 037";
    await expect(page.locator(".project-card").filter({ hasText: buried })).toHaveCount(0);
    await page.getByLabel("Search projects").fill(buried);
    await expect(page.locator(".project-card").filter({ hasText: buried })).toHaveCount(1);

    // A search with no matches says so and offers a way back.
    await page.getByLabel("Search projects").fill("no-such-project-xyz");
    await expect(page.getByText(/No project matches/)).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator(".project-card")).toHaveCount(12);

    // Show all reveals the complete history.
    await showAll.click();
    await expect(page.locator(".project-card")).toHaveCount(total);
  });

  test("recent project source previews use fresh Library URLs without replacing the open control", async ({ page }) => {
    const [projectsResponse, jobsResponse] = await Promise.all([
      page.request.get("/api/v1/projects"),
      page.request.get("/api/v1/jobs"),
    ]);
    const projects = await projectsResponse.json() as Project[];
    const jobs = await jobsResponse.json() as Job[];
    const project = projects[0];
    if (!project) { test.skip("no project is available in this environment"); return; }
    let sourceReads = 0;
    await page.route("**/api/v1/projects", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects) });
    });
    await page.route("**/api/v1/jobs", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobs) });
    });
    await page.route("**/api/v1/library/assets**", async (route) => {
      sourceReads += 1;
      const token = sourceReads > 1 ? "renewed" : "initial";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
        id: "recent-project-source", title: `${project.name} source`, description: "", mediaType: "video/mp4", filename: "source.mp4",
        tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false,
        minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "User supplied", attribution: "", contentHash: "source-hash",
        folderId: "00000000-0000-0000-0000-000000000001", origin: "project-source", blobId: "source-blob",
        sourceProjectId: project.id, previewUrl: `/preview.mp4?token=${token}`, brands: [], people: [], createdAt: new Date().toISOString(),
      }]) });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const preview = page.getByRole("button", { name: `Preview source video for ${project.name}` });
    await expect(preview).toBeVisible();
    await expect(page.getByRole("button", { name: `Open project ${project.name}` })).toBeVisible();
    await preview.click();
    const dialog = page.getByRole("dialog", { name: `${project.name} source video preview` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("video")).toHaveAttribute("src", /token=renewed/);
    await page.getByRole("button", { name: "Close video preview" }).click();
    await expect(preview).toBeFocused();
  });

  test("the jobs queue is bounded with the total kept visible", async ({ page }) => {
    await installLargeHistory(page, 40);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
    await expect(page.locator(".job-card")).toHaveCount(20);
    await expect(page.getByText("40 total")).toBeVisible();
    await page.getByRole("button", { name: "Show all 40 jobs" }).click();
    await expect(page.locator(".job-card")).toHaveCount(40);
  });

  test("a finished clip downloads real media rather than an error document", async ({ page, request }) => {
    const jobs = await (await request.get("/api/v1/jobs")).json() as Job[];
    const withClip = jobs.find((job) => job.clips?.some((clip) => clip.state === "complete" && clip.downloadUrl));
    test.skip(!withClip, "no completed clip available in this environment");
    const clip = withClip!.clips.find((item) => item.state === "complete" && item.downloadUrl)!;
    const response = await request.get(clip.downloadUrl!);
    expect(response.status(), "download must succeed").toBe(200);
    expect(response.headers()["content-type"] || "").toMatch(/^video\//);
    expect((await response.body()).length).toBeGreaterThan(1024);
    await page.goto("/", { waitUntil: "domcontentloaded" });
  });

  test("creation validation explains the problem without exposing backend detail", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    const create = page.getByRole("button", { name: /Create \d+ short clip/ });

    await page.getByRole("tab", { name: /Local file/ }).click();
    await create.click();
    await expect(page.locator(".form-error")).toContainText(/Choose a local video first/i);

    await page.locator('input[aria-label="Choose video file"]').setInputFiles({
      name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a video"),
    });
    await expect(page.locator(".form-error")).toContainText(/Unsupported video type/i);

    await page.getByRole("tab", { name: /YouTube/ }).click();
    await create.click();
    await expect(page.locator(".form-error")).toContainText(/YouTube URL first/i);

    await page.getByLabel("YouTube URL").fill("http://example.com/not-youtube");
    await create.click();
    const message = page.locator(".form-error");
    await expect(message).toBeVisible();
    await expect(message).not.toContainText(/Traceback|pydantic|\{"detail"|Internal Server Error/i);
  });
});
