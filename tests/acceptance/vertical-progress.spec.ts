import { expect, test } from "@playwright/test";
import type { Job, ProcessingStep, Project } from "../../web/src/types";

const isExpectedBrowserWarning = (text: string) => /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(text);
const workflowLabels = [
  "Source received", "Video validated", "Audio prepared", "Speech transcribed",
  "OpenRouter planning", "Local planning fallback", "Complete moments selected",
  "Clip boundaries verified", "Clips rendered and saved", "Outputs verified", "Project ready",
];

test.describe("vertical creation progress", () => {
  test("keeps authoritative steps vertical, ordered, full-width, and retryable", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    let projectId = "";
    let jobId = "";
    let sourceJob: Job | undefined;
    let phase: "active" | "next" | "complete" | "failed" | "retry" = "active";

    page.on("console", (message) => {
      if (message.type() === "error" && !isExpectedBrowserWarning(message.text())) consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText !== "net::ERR_ABORTED" && !request.url().includes("/events")) failedRequests.push(`${request.method()} ${request.url()}`);
    });

    const fixtureForPhase = (): Job => {
      if (!sourceJob) throw new Error("The creation response did not provide a job fixture");
      const now = new Date().toISOString();
      const steps = sourceJob.steps.length ? sourceJob.steps : [
        { id: "source", label: "Source received", status: "pending" as const },
        { id: "validated", label: "Video validated", status: "pending" as const },
        { id: "render", label: "Clips rendered and saved", status: "pending" as const },
        { id: "ready", label: "Project ready", status: "pending" as const },
      ];
      const activeIndex = phase === "next" ? Math.min(2, steps.length - 1) : 1;
      const failedIndex = Math.min(1, steps.length - 1);
      const mappedSteps: ProcessingStep[] = steps.map((step, index) => {
        const status = phase === "complete"
          ? "complete"
          : phase === "failed"
            ? index < failedIndex ? "complete" : index === failedIndex ? "failed" : "pending"
            : index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending";
        return {
          ...step,
          status,
          detail: status === "failed" ? "Deterministic test failure: provider unavailable." : status === "active" ? "Working from saved project state." : step.detail,
          startedAt: status === "active" ? now : undefined,
          completedAt: ["complete", "failed"].includes(status) ? now : undefined,
          currentItem: status === "active" ? 1 : step.currentItem,
          totalItems: status === "active" ? 5 : step.totalItems,
        };
      });
      const failed = phase === "failed";
      const complete = phase === "complete";
      return {
        ...sourceJob,
        state: complete ? "complete" : failed ? "failed" : "active",
        stage: complete ? "done" : failed ? "failed" : "processing",
        stageLabel: complete ? "Project ready" : failed ? "Failed at processing" : "Processing locally",
        progress: complete ? 100 : failed ? 30 : phase === "next" ? 60 : 30,
        error: failed ? "Deterministic test failure: provider unavailable." : null,
        steps: mappedSteps,
        updatedAt: now,
      };
    };

    await page.route("**/api/v1/jobs/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (request.method() === "POST" && path.endsWith("/jobs/clip")) {
        await route.continue();
        return;
      }
      if (!jobId || !path.includes(`/jobs/${jobId}`)) {
        await route.continue();
        return;
      }
      if (path.endsWith(`/jobs/${jobId}/events`)) {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": test stream\n\n" });
        return;
      }
      if (request.method() === "POST" && path.includes(`/jobs/${jobId}/control/`)) {
        phase = "retry";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureForPhase()) });
        return;
      }
      if (request.method() === "GET" && path.endsWith(`/jobs/${jobId}`)) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureForPhase()) });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
      const projectName = `Vertical progress ${Date.now()}`;
      await page.locator('input[type="file"]').setInputFiles("test-video.mp4");
      await page.getByRole("textbox", { name: "Project name" }).fill(projectName);
      await page.getByRole("button", { name: "Fast", exact: true }).click();
      for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Fewer clips" }).click();
      const createResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/jobs/clip") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Create 1 short clip" }).click();
      const createResponse = await createResponsePromise;
      const created = await createResponse.json() as { project: Project; job: Job };
      projectId = created.project.id;
      sourceJob = {
        ...created.job,
        steps: workflowLabels.map((label, index) => ({ id: `workflow-${index}`, label, status: "pending" as const })),
      };
      jobId = created.job.id;

      const progress = page.getByRole("region", { name: "Short creation progress" });
      await expect(progress).toBeVisible({ timeout: 120_000 });
      const expectedLabels = sourceJob?.steps.map((step) => step.label) || workflowLabels;
      const items = progress.getByRole("listitem");
      await expect(items).toHaveCount(expectedLabels.length);
      expect(await items.allTextContents()).toEqual(expectedLabels.map((label) => expect.stringContaining(label)));
      await expect(progress.getByRole("list")).toBeVisible();
      await expect(progress.locator("[aria-current=\"step\"]")).toContainText("In progress");
      await expect(progress.locator(".checklist-step.status-pending").first()).toContainText("Pending");
      await expect(progress.locator(".checklist-step.status-complete").first()).toContainText("Complete");

      const assertVerticalLayout = async () => {
        const list = progress.getByRole("list");
        const listBox = await list.boundingBox();
        const listContentWidth = await list.evaluate((element) => {
          const style = getComputedStyle(element);
          return element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        });
        const boxes = await Promise.all((await items.all()).map((item) => item.boundingBox()));
        expect(listBox).not.toBeNull();
        expect(boxes.every((box) => box !== null)).toBe(true);
        for (let index = 1; index < boxes.length; index += 1) {
          expect(boxes[index]!.y).toBeGreaterThan(boxes[index - 1]!.y);
          expect(boxes[index]!.x).toBe(boxes[index - 1]!.x);
        }
        expect(boxes.every((box) => box!.width >= listContentWidth - 2)).toBe(true);
        expect(await list.evaluate((element) => {
          const style = getComputedStyle(element);
          return { display: style.display, flexDirection: style.flexDirection, gridColumns: style.gridTemplateColumns };
        })).toEqual({ display: "flex", flexDirection: "column", gridColumns: "none" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const checklistBox = await progress.boundingBox();
        const lowerWorkspaceBox = await page.locator("[data-testid=\"lower-workspace\"]").boundingBox();
        expect(checklistBox && lowerWorkspaceBox && lowerWorkspaceBox.y >= checklistBox.y + checklistBox.height).toBe(true);
        const banners = page.locator(".workspace-offline, .workspace-alert, .failure-strip, .warning-strip, .job-strip");
        const progressTop = checklistBox?.y || 0;
        for (const banner of await banners.all()) {
          const bannerBox = await banner.boundingBox();
          if (bannerBox) expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(progressTop + 1);
        }
      };

      await page.setViewportSize({ width: 1920, height: 1080 });
      await assertVerticalLayout();
      const activeMeta = progress.locator("[aria-current=\"step\"] .checklist-step-meta");
      const activeLabelBox = await progress.locator("[aria-current=\"step\"] .checklist-label").boundingBox();
      const activeMetaBox = await activeMeta.boundingBox();
      expect(activeLabelBox && activeMetaBox && activeMetaBox.x > activeLabelBox.x).toBeTruthy();
      await page.screenshot({ path: "test-artifacts/progress-list-desktop.png", fullPage: true });
      await page.screenshot({ path: "test-artifacts/progress-list-active.png", fullPage: true });

      await page.setViewportSize({ width: 1440, height: 900 });
      await assertVerticalLayout();

      await page.setViewportSize({ width: 768, height: 1024 });
      await assertVerticalLayout();
      await page.setViewportSize({ width: 390, height: 844 });
      await assertVerticalLayout();
      const mobileLabelBox = await progress.locator("[aria-current=\"step\"] .checklist-label").boundingBox();
      const mobileMetaBox = await activeMeta.boundingBox();
      expect(mobileLabelBox && mobileMetaBox && mobileMetaBox.y >= mobileLabelBox.y).toBeTruthy();
      expect(await progress.locator("[aria-current=\"step\"] .checklist-step-body").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
      await page.screenshot({ path: "test-artifacts/progress-list-mobile.png", fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });

      phase = "next";
      await expect.poll(() => progress.locator("[aria-current=\"step\"]").textContent(), { timeout: 15_000 }).toContain(expectedLabels[Math.min(2, expectedLabels.length - 1)]);
      await expect(progress.locator(".checklist-step.status-complete")).toHaveCount(Math.min(2, expectedLabels.length));

      phase = "active";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: new RegExp(`Open project ${projectName}`) })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: new RegExp(`Open project ${projectName}`) }).click();
      const restoredProgress = page.getByRole("region", { name: "Short creation progress" });
      await expect(restoredProgress).toBeVisible({ timeout: 30_000 });
      await expect(restoredProgress.locator("[aria-current=\"step\"]")).toContainText(expectedLabels[1] || expectedLabels[0]);

      phase = "complete";
      await expect.poll(() => restoredProgress.locator(".checklist-step.status-complete").count(), { timeout: 15_000 }).toBe(expectedLabels.length);
      await expect(restoredProgress.getByText("Project ready", { exact: true })).toBeVisible();
      await page.screenshot({ path: "test-artifacts/progress-list-complete.png", fullPage: true });

      phase = "failed";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: new RegExp(`Open project ${projectName}`) })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: new RegExp(`Open project ${projectName}`) }).click();
      const failedProgress = page.getByRole("region", { name: "Short creation progress" });
      await expect(failedProgress).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => failedProgress.locator(".checklist-step.status-failed").count(), { timeout: 15_000 }).toBe(1);
      await expect(failedProgress.getByText("Failed", { exact: true })).toBeVisible();
      await expect(failedProgress.getByText("Deterministic test failure: provider unavailable.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry failed work" })).toBeVisible();
      await page.screenshot({ path: "test-artifacts/progress-list-failed.png", fullPage: true });

      await page.getByRole("button", { name: "Retry failed work" }).click();
      await expect.poll(() => failedProgress.locator("[aria-current=\"step\"]").count(), { timeout: 15_000 }).toBe(1);
      await expect(failedProgress.locator("[aria-current=\"step\"]")).toContainText(expectedLabels[1] || expectedLabels[0]);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(failedProgress).toBeVisible();
      await expect(failedProgress.locator(".process-checklist")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: "test-artifacts/progress-list-mobile-failed.png", fullPage: true });
      for (const item of await failedProgress.getByRole("listitem").all()) {
        const box = await item.boundingBox();
        expect(box?.width).toBeLessThanOrEqual(390);
      }
      expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
      expect(pageErrors, pageErrors.join("\n")).toEqual([]);
      expect(failedRequests, failedRequests.join("\n")).toEqual([]);
    } finally {
      if (projectId) await page.request.delete(`/api/v1/projects/${projectId}?delete_assets=true`).catch(() => undefined);
    }
  });
});
