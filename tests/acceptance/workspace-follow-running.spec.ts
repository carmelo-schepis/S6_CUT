import { expect, test } from "@playwright/test";

type ProjectRecord = {
  schemaVersion: 1; id: string; name: string; mode: "clip"; style: "educational"; state: "active" | "queued" | "complete";
  sourceName: string; sourceKind: "upload"; requestedCount: number; latestJobId: string; createdAt: string; updatedAt: string;
};

type JobRecord = {
  schemaVersion: 1; id: string; projectId: string; mode: "clip"; state: "active" | "queued" | "complete" | "paused";
  stage: string; stageLabel: string; progress: number; currentItem: number; totalItems: number; style: "educational";
  processingMode: "fast"; warnings: string[]; clips: unknown[]; beats: unknown[]; steps: unknown[];
  createdAt: string; updatedAt: string; queuePosition?: number | null;
};

const project = (id: string, name: string, updatedAt: string, latestJobId = `${id}-job`): ProjectRecord => ({
  schemaVersion: 1, id, name, mode: "clip", style: "educational", state: "active", sourceName: `${name}.mp4`, sourceKind: "upload",
  requestedCount: 5, latestJobId, createdAt: "2026-01-01T00:00:00Z", updatedAt,
});

const job = (id: string, projectId: string, state: JobRecord["state"], createdAt: string, stageLabel: string): JobRecord => ({
  schemaVersion: 1, id, projectId, mode: "clip", state, stage: state === "complete" ? "ready" : "render", stageLabel,
  progress: state === "complete" ? 100 : 20, currentItem: 1, totalItems: 5, style: "educational", processingMode: "fast",
  warnings: [], clips: [], beats: [], steps: [], createdAt, updatedAt: createdAt,
});

const projects = [
  project("project-b", "Next running project", "2026-10-23T09:00:00Z", "b-job-new"),
  project("project-a", "Stable running project", "2026-10-23T08:00:00Z", "a-job"),
];
let jobs: JobRecord[] = [];
let controlledPath: string | undefined;

async function mockApi(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/health") {
      await route.fulfill({ json: {
        status: "ready", version: "0.1.0", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true,
        dataPath: "/app/data", freeBytes: 1024, configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
      } });
    } else if (path === "/projects") {
      await route.fulfill({ json: projects });
    } else if (path === "/jobs") {
      await route.fulfill({ json: jobs });
    } else if (path.startsWith("/jobs/") && path.endsWith("/events")) {
      await route.fulfill({ status: 204, body: "" });
    } else if (path.startsWith("/jobs/") && path.includes("/control/")) {
      controlledPath = path;
      const current = jobs.find((item) => path.startsWith(`/jobs/${item.id}/`));
      await route.fulfill({ json: { ...(current || jobs[0]), state: "paused", stageLabel: "Paused" } });
    } else if (path.startsWith("/jobs/")) {
      const id = path.slice("/jobs/".length);
      await route.fulfill({ json: jobs.find((item) => item.id === id) || job(id, "project-b", "active", "2026-10-23T11:00:00Z", "Rendering newest job") });
    } else {
      await route.fulfill({ json: [] });
    }
  });
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "Android-sized", width: 390, height: 844 },
]) {
  test(`follows running workspace jobs and shows project plus status on ${viewport.label}`, async ({ page }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const browserErrors: string[] = [];
    const browserWarnings: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.text().includes("Cross-Origin-Opener-Policy header has been ignored")) browserWarnings.push(message.text());
      else if (message.type() === "error") browserErrors.push(message.text());
    });
    jobs = [
      job("a-job", "project-a", "active", "2026-10-23T08:00:00Z", "Rendering stable job"),
      job("b-job-old", "project-b", "complete", "2026-10-23T09:00:00Z", "Complete"),
      job("b-job-new", "project-b", "active", "2026-10-23T11:00:00Z", "Rendering newest job"),
      { ...job("c-job", "project-c", "queued", "2026-10-23T10:00:00Z", "Waiting in queue"), queuePosition: 1 },
    ];
    controlledPath = undefined;
    await mockApi(page);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".topbar-context")).toContainText("Stable running project");
    await expect(page.locator(".workspace-controls")).toContainText("Rendering stable job");
    await expect(page.locator(".workspace-controls")).not.toContainText("Waiting in queue");

    // When the selected job completes, its next active job is followed even
    // though project ordering still favors another updatedAt timestamp.
    jobs = [
      job("a-job", "project-a", "complete", "2026-10-23T12:00:00Z", "Complete"),
      job("b-job-old", "project-b", "complete", "2026-10-23T09:00:00Z", "Complete"),
      job("b-job-new", "project-b", "active", "2026-10-23T11:00:00Z", "Rendering newest job"),
      { ...job("c-job", "project-c", "queued", "2026-10-23T10:00:00Z", "Waiting in queue"), queuePosition: 1 },
    ];
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".topbar-context")).toContainText("Next running project");
    await expect(page.locator(".workspace-controls")).toContainText("Rendering newest job");

    // Opening a specific project from Jobs selects its latest same-project job;
    // the visible Pause control must target that job's identity.
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await page.locator('.job-card[data-job-id="b-job-new"]').getByRole("button", { name: "Open" }).click();
    await expect(page.locator(".workspace-controls")).toContainText("Rendering newest job");
    await page.getByRole("button", { name: "Pause", exact: false }).click();
    await expect.poll(() => controlledPath).toBe("/jobs/b-job-new/control/pause");
    await expect(page.locator(".topbar-context")).toContainText("Next running project");
    await expect(browserErrors).toEqual([]);
    if (browserWarnings.length) test.info().annotations.push({ type: "browser-warning", description: browserWarnings.join(" | ") });
    await page.screenshot({ path: test.info().outputPath(`workspace-follow-${viewport.label}.png`), fullPage: true });
  });
}
