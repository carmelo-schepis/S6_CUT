import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDir = path.join(root, "test-artifacts");

async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

async function open(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator("#main-content")).toBeVisible();
}

async function waitForJob(page: Page, terminal = true) {
  const status = page.locator(".workspace-commandbar .status");
  const observed: string[] = [];
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const value = (await status.textContent())?.trim() || "";
    if (value && observed.at(-1) !== value) observed.push(value);
    if (!terminal || /ready|failed|stopped|complete|cancelled/i.test(value)) break;
    await page.waitForTimeout(1_500);
  }
  await fs.appendFile(path.join(artifactDir, "progress.log"), `${new Date().toISOString()} ${JSON.stringify(observed)}\n`);
  return observed;
}

test("Docker-served studio acceptance workflow", async ({ page, request }) => {
  await fs.mkdir(artifactDir, { recursive: true });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const abortedRequests: string[] = [];
  const jobEvidence: Array<{ method: string; url: string; body: unknown }> = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", error => pageErrors.push(String(error)));
  page.on("requestfailed", requestEvent => {
    const detail = `${requestEvent.method()} ${requestEvent.url()} ${requestEvent.failure()?.errorText || ""}`;
    if (requestEvent.failure()?.errorText === "net::ERR_ABORTED") abortedRequests.push(detail);
    else failedRequests.push(detail);
  });
  page.on("response", async response => {
    if (response.request().method() !== "POST" || !/\/api\/v1\/jobs(?:\/[^/]+\/control\/[^/]+)?$/.test(new URL(response.url()).pathname)) return;
    try {
      const body = await response.json();
      jobEvidence.push({ method: response.request().method(), url: response.url(), body: body.job || body });
    } catch { /* Non-JSON responses are covered by the normal request assertions. */ }
  });

  const endpoints = ["/", "/healthz", "/api/health", "/api/v1/projects", "/api/v1/jobs", "/api/v1/library/assets", "/api/v1/storage"];
  for (const endpoint of endpoints) expect((await request.get(endpoint)).ok(), endpoint).toBeTruthy();

  await page.goto("/");
  await expect(page).toHaveTitle(/S6_cut/i);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 60_000 });
  await capture(page, "desktop-projects");

  // Basic keyboard/focus and responsive evidence.
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await page.setViewportSize({ width: 768, height: 1024 });
  await capture(page, "tablet-projects");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "mobile-projects");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Create a real local Fast job through the UI using the supplied disposable fixture.
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(path.join(root, "test-video.mp4"));
  const browserProjectName = `Browser acceptance ${Date.now()}`;
  await page.getByLabel("Project name").fill(browserProjectName);
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: /Create 5 (?:short )?clips/ }).click();
  await expect(page.getByText(/Local engine ready|Preparing project|fast/i).first()).toBeVisible();
  const progress = await waitForJob(page);
  expect(progress.length).toBeGreaterThan(0);
  await expect(page.getByText(/ready|cut.*ready/i).first()).toBeVisible({ timeout: 150_000 });
  await capture(page, "workspace-complete");

  // The durable Jobs queue retains terminal state and progress for the completed project.
  const projects = await (await page.request.get("/api/v1/projects")).json() as { id: string; name: string }[];
  const browserProject = projects.find((project) => project.name === browserProjectName);
  expect(browserProject, "created project is persisted").toBeTruthy();
  await open(page, "Jobs");
  const completedJobCard = page.locator(`.job-card[data-project-id="${browserProject!.id}"]`);
  await expect(completedJobCard).toContainText(/complete/i);
  await expect(completedJobCard).toContainText(/5 outputs ready/);
  await open(page, "Workspace");
  await page.getByRole("tab", { name: "Media" }).click();
  await expect(page.getByRole("tabpanel", { name: "Media" })).toBeVisible();
  await capture(page, "workspace-media");
  await page.getByRole("tab", { name: "Transcript" }).click();
  // The inspector tabs were relabelled to sentence case (987dddb); this asserts
  // the label a reader sees, not the state key behind it.
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await expect(page.getByText(/Caption style and timing are fixed when the job is created/)).toBeVisible();

  const selected = page.locator('input[type="checkbox"]:checked');
  if (await selected.count()) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download ZIP/ }).click();
    const download = await downloadPromise;
    const exportPath = path.join(artifactDir, await download.suggestedFilename());
    await download.saveAs(exportPath);
    expect((await fs.stat(exportPath)).size).toBeGreaterThan(0);
    await capture(page, "export-ready");
  }

  // Shorts Editor: real source preview, local assistant proposal, and output list.
  await open(page, "Shorts Editor");
  await expect(page.getByRole("heading", { name: "Shorts Editor" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
  await expect(page.getByText("Trim an authorised video into a social-ready clip. Choose the section, output shape, and subtitles, then queue the render.")).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 1024 });
  const tabletMeasure = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, innerWidth: window.innerWidth }));
  await fs.writeFile(path.join(artifactDir, "responsive-measurements.json"), JSON.stringify(tabletMeasure, null, 2));
  expect(tabletMeasure.scrollWidth).toBeLessThanOrEqual(tabletMeasure.clientWidth);
  await expect(page.getByRole("heading", { name: "AI editing assistant" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue short" })).toBeVisible();
  await capture(page, "shorts-editor-tablet");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('input[aria-label="Choose video file"]').setInputFiles(path.join(root, "test-video.mp4"));
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  await page.locator('input[aria-label="Editing request"]').fill("Propose changing the aspect ratio to 1:1 without applying it.");
  await page.getByRole("button", { name: "Send editing request" }).click();
  await expect(page.getByText(/Nothing changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply proposal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  await expect(page.getByText("Unsaved edits")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).not.toBeVisible();
  await capture(page, "proposal-pending");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  await expect(page.getByText("All changes saved")).toBeVisible();
  await capture(page, "proposal-rejected");
  await page.locator('input[aria-label="Editing request"]').fill("Propose changing the aspect ratio to 1:1 without applying it.");
  await page.getByRole("button", { name: "Send editing request" }).click();
  await page.getByRole("button", { name: "Apply proposal" }).click();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("1:1");
  await expect(page.getByText("Unsaved edits")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await capture(page, "proposal-applied");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
  await expect(page.getByText("All changes saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).not.toBeVisible();
  await capture(page, "proposal-undone");
  await page.locator('input[aria-label="Editing request"]').fill("Change the aspect ratio to 1:1 now.");
  await page.getByRole("button", { name: "Send editing request" }).click();
  await expect(page.locator(".assistant-messages").getByText(/Applied locally/).last()).toBeVisible();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("1:1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
  const shortResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/jobs/shorts/source");
  await page.getByRole("button", { name: "Queue short" }).click();
  expect((await shortResponse).status()).toBe(202);
  await expect(page.getByText("Short queued successfully.")).toBeVisible();
  await capture(page, "shorts-editor");

  // Settings: inspect capabilities and verify secret fields are password inputs and masked text is used.
  await open(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Secrets", { exact: true })).toBeVisible();
  await expect(page.getByText(/Trusted LAN only by default/)).toBeVisible();
  // Empty installs may open setup inline; existing installs keep the form
  // closed until requested. Either way, the API key remains masked.
  if (await page.locator('input[type="password"]').count() === 0) {
    await page.getByRole("button", { name: /New profile/ }).click();
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await capture(page, "settings-security");

  // Jobs navigation and API-backed job list remain usable after the workflow.
  await open(page, "Jobs");
  await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
  await capture(page, "jobs");

  // Exercise a real YouTube URL submission, then stop it through the user-facing UI.
  await open(page, "Projects");
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: /Create 5 (?:short )?clips/ }).click();
  await expect(page.getByRole("button", { name: /Stop & keep/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/download|import|source/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Stop & keep/ }).click();
  await expect(page.getByText(/Stopped|cancelled|partial/i).first()).toBeVisible({ timeout: 30_000 });
  const retryImport = page.getByRole("button", { name: /Retry import/ }).first();
  await expect(retryImport).toBeVisible({ timeout: 30_000 });
  if (await retryImport.isVisible()) {
    await retryImport.click();
    // The response itself is the durable retry evidence: the same job must
    // immediately leave cancelled_kept and expose a new queued/active phase.
    await expect(page.locator(".workspace-commandbar .status")).toContainText(/Retrying YouTube import|Downloading YouTube source|ready|failed/i, { timeout: 30_000 });
    await expect(retryImport).not.toBeVisible();
    await expect(page.getByText(/Retrying YouTube import|Downloading YouTube source/).first()).toBeVisible({ timeout: 30_000 });
  }
  await capture(page, "youtube-retry-active");
  const stopAfterRetry = page.getByRole("button", { name: /Stop & keep/ }).first();
  await expect(stopAfterRetry).toBeVisible({ timeout: 30_000 });
  await stopAfterRetry.click();
  await expect(page.getByText(/Stopped|cancelled|partial/i).first()).toBeVisible({ timeout: 30_000 });
  await capture(page, "youtube-stop");

  await fs.writeFile(path.join(artifactDir, "browser-diagnostics.json"), JSON.stringify({ consoleErrors, pageErrors, failedRequests, abortedRequests, note: "Chromium may emit a COOP warning when testing the HTTP IP origin; that known browser limitation is intentionally excluded from consoleErrors." }, null, 2));
  await fs.writeFile(path.join(artifactDir, "job-evidence.json"), JSON.stringify(jobEvidence, null, 2));
  expect(consoleErrors, "browser console errors").toEqual([]);
  expect(pageErrors, "browser page errors").toEqual([]);
  expect(failedRequests, "failed network requests").toEqual([]);
});
