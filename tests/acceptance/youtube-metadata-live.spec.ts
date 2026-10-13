import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { Job, Project } from "../../web/src/types";

type MetadataClip = Job["clips"][number] & {
  title?: string | null;
  youtubeDescription?: string | null;
  youtubeMetadataRevision?: number;
};
type MetadataJob = Job & { youtubeMetadataEnabled?: boolean; clips: MetadataClip[] };

/**
 * Live acceptance contract for YouTube metadata. This suite deliberately has
 * no provider routes/mocks: generation must go through the configured provider
 * and persisted engine job data. It is opt-in because it imports a real source,
 * creates durable data, and may incur provider charges.
 *
 * Contract under test:
 * - The independent metadata model selection persists across reload.
 * - Metadata is explicitly opt-in, unavailable for Fast, and absent when off.
 * - An opted-in Smart job permits real-provider per-clip title/description generation and revisioned edits.
 * - The Workspace inspector can edit and copy these fields; edits survive reload.
 * - Export includes metadata for selected clips and does not invent metadata for
 *   clips/jobs where the feature was disabled.
 *
 * No API interception is installed. Exact copy/control labels below are the
 * customer-facing selectors; response assertions bind the UI to durable API
 * data instead of trusting optimistic rendering.
 */
const enabled = process.env.S6_RUN_LIVE_YOUTUBE_METADATA === "1";
const isolated = process.env.S6_ACCEPTANCE_ISOLATED === "1";
const sourceUrl = process.env.S6_YOUTUBE_METADATA_URL;

test.describe("live YouTube metadata", () => {
  test.skip(!enabled, "blocked: live provider verification requires S6_RUN_LIVE_YOUTUBE_METADATA=1");
  test.skip(!sourceUrl, "blocked: set S6_YOUTUBE_METADATA_URL to an authorised public YouTube URL");

  test.beforeAll(() => {
    if (!isolated) {
      throw new Error("Refusing live metadata work without S6_ACCEPTANCE_ISOLATED=1 and a disposable deployment/data root");
    }
  });

  test("persists model choice and metadata edits through reload and export", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chromium", "live generation runs once; responsive widths are checked in-page");
    test.setTimeout(30 * 60_000);
    const profilesResponse = await request.get("/api/v1/profiles");
    expect(profilesResponse.ok(), "live API must return configured provider profiles").toBeTruthy();
    const profiles = await profilesResponse.json() as { id: string; selected: boolean; textModelId: string; textStatus: string }[];
    const activeProfile = profiles.find((profile) => profile.selected && profile.textStatus === "connected");
    test.skip(!activeProfile, "blocked: securely configure and verify a live OpenRouter profile before this check");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const modelPicker = page.getByRole("combobox", { name: "Title and description model" });
    await expect.poll(() => modelPicker.locator("option").evaluateAll((options) => options.length), { timeout: 60_000 }).toBeGreaterThan(1);
    const chosenModel = await modelPicker.inputValue();
    await expect(modelPicker).toHaveValue(chosenModel);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Title and description model" })).toHaveValue(chosenModel);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("tab", { name: /YouTube/ }).click();
    await page.getByRole("textbox", { name: "YouTube URL" }).fill(sourceUrl!);
    const projectName = `Metadata live ${Date.now()}`;
    await page.getByLabel("Project name").fill(projectName);
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    const metadataOption = page.getByRole("checkbox", { name: /YouTube metadata/i });
    // The opt-in is never available in Fast, even if a user has previously
    // selected a separate metadata model.
    await expect(metadataOption).toBeDisabled();
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    await expect(metadataOption).toBeEnabled();
    await metadataOption.check();
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /YouTube metadata/i })).toBeDisabled();
    await page.getByRole("button", { name: "Smart", exact: true }).click();

    // Prove opt-out creates a job without metadata; then create a separate
    // opted-in job on the same authorised URL so the two paths are comparable.
    await metadataOption.uncheck();
    await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 60_000 });
    const firstProject = await findProject(request, projectName);
    if (!firstProject.latestJobId) throw new Error("Opt-out project has no latest job ID");
    const firstJob = await waitForJob(request, firstProject.latestJobId);
    expect(firstJob.youtubeMetadataEnabled).toBe(false);
    expect(firstJob.clips.every((clip) => clip.youtubeDescription == null)).toBeTruthy();

    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("tab", { name: /YouTube/ }).click();
    const optInName = `${projectName} opted in`;
    await page.getByRole("textbox", { name: "YouTube URL" }).fill(sourceUrl!);
    await page.getByLabel("Project name").fill(optInName);
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    await page.getByRole("checkbox", { name: /YouTube metadata/i }).check();
    await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();
    await expect(page.getByRole("heading", { name: optInName })).toBeVisible({ timeout: 60_000 });
    const project = await findProject(request, optInName);
    if (!project.latestJobId) throw new Error("Opt-in project has no latest job ID");
    const job = await waitForJob(request, project.latestJobId);
    expect(job.processingMode).toBe("smart");
    expect(job.clips.length).toBeGreaterThan(0);
    const metadataClip = job.clips.find((clip) => clip.state === "complete");
    expect(metadataClip, "the opted-in job must have a completed clip").toBeTruthy();
    const inspectorTab = page.getByRole("button", { name: "YouTube", exact: true });
    await expect(inspectorTab).toBeVisible();
    await inspectorTab.click();
    const inspector = page.getByRole("region", { name: "YouTube metadata editor" });
    await expect(inspector).toBeVisible();
    await inspector.getByRole("button", { name: /Generate metadata|Regenerate/ }).click();
    await expect.poll(async () => {
      const response = await request.get(`/api/v1/jobs/${job.id}`);
      const updated = await response.json() as MetadataJob;
      const clip = updated.clips.find((item) => item.id === metadataClip!.id);
      return Boolean(clip?.title && clip.youtubeDescription);
    }, { timeout: 60_000 }).toBe(true);
    const generatedResponse = await request.get(`/api/v1/jobs/${job.id}`);
    const generatedJob = await generatedResponse.json() as MetadataJob;
    const generatedClip = generatedJob.clips.find((clip) => clip.id === metadataClip!.id)!;
    const originalTitle = generatedClip.title!;
    const originalDescription = generatedClip.youtubeDescription!;
    expect(originalTitle.trim().length).toBeGreaterThan(0);
    expect(originalDescription.trim().length).toBeGreaterThan(0);
    expect(generatedClip.youtubeMetadataRevision).toBeGreaterThanOrEqual(1);
    await expect(inspector).toContainText(originalTitle);
    for (const width of [390, 810, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(inspector).toBeVisible();
    }
    await inspector.getByLabel("YouTube title").fill(`${originalTitle} reviewed`);
    await inspector.getByLabel("YouTube short description").fill(`${originalDescription}\nAcceptance edit`);
    await inspector.getByRole("button", { name: "Save edits", exact: true }).click();
    await expect.poll(async () => {
      const response = await request.get(`/api/v1/jobs/${job.id}`);
      const updated = await response.json() as MetadataJob;
      return updated.clips.find((clip) => clip.id === metadataClip!.id)?.title;
    }, { timeout: 30_000 }).toBe(`${originalTitle} reviewed`);
    await inspector.getByRole("button", { name: "Copy title", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/copied/i);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: optInName }).click();
    await page.getByRole("button", { name: "YouTube", exact: true }).click();
    await expect(page.getByLabel("YouTube title")).toHaveValue(`${originalTitle} reviewed`);
    const exportButton = page.getByRole("button", { name: /Export selected|Download ZIP/i });
    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;
    const zipPath = testInfo.outputPath("metadata-export.zip");
    await download.saveAs(zipPath);
    expect(download.suggestedFilename()).toMatch(/\.zip$/i);
    const manifestJson = execFileSync("python3", ["-c", "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.read(n).decode('utf-8') for n in z.namelist() if n.endswith('.json')))" , zipPath], { encoding: "utf8" });
    expect(manifestJson, "the ZIP metadata/manifest must include the edited selected clip metadata").toContain(`${originalTitle} reviewed`);
    expect(manifestJson).toContain("Acceptance edit");

    await expect.poll(async () => {
      const response = await request.get(`/api/v1/jobs/${job.id}`);
      const reloaded = await response.json() as MetadataJob;
      return reloaded.clips.find((clip) => clip.id === metadataClip!.id)?.title;
    }).toBe(`${originalTitle} reviewed`);
  });
});

async function findProject(request: import("@playwright/test").APIRequestContext, name: string) {
  let project: Project | undefined;
  await expect.poll(async () => {
    const response = await request.get("/api/v1/projects");
    const projects = await response.json() as Project[];
    project = projects.find((item) => item.name === name);
    return Boolean(project);
  }, { timeout: 30_000 }).toBe(true);
  return project!;
}

async function waitForJob(request: import("@playwright/test").APIRequestContext, id: string) {
  let job: MetadataJob | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/v1/jobs/${id}`);
    expect(response.ok()).toBeTruthy();
    job = await response.json() as MetadataJob;
    return job.state;
  }, { timeout: 20 * 60_000, intervals: [1000, 3000, 8000] }).toBe("complete");
  return job!;
}
