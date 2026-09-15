import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipProject, gateway, root } from "./support/workspace";

const approvedUrl = "https://www.youtube.com/watch?v=KNVr5pHAygI";
const screenshots = path.join(root, "test-artifacts");
const deadlineMs = 45 * 60_000;

test("keeps the Workspace activity indicator live for a real YouTube import", async ({ page }) => {
  test.setTimeout(deadlineMs + 30_000);
  await fs.mkdir(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const projectName = `Workspace indicator ${Date.now()}`;
  let projectId: string | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    // Workspace event streams are deliberately aborted when navigating away.
    if (!/\/api\/v1\/jobs\/[^/]+\/events(?:\?|$)/.test(request.url())) {
      failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText || "failed"}`);
    }
  });

  const workspaceGeometry = async () => {
    const button = page.getByRole("button", { name: "Workspace", exact: true });
    const badge = page.getByTestId("workspace-work-count");
    const icon = button.locator("svg").first();
    const buttonBox = await button.boundingBox();
    const badgeBox = await badge.boundingBox();
    const iconBox = await icon.boundingBox();
    expect(buttonBox).toBeTruthy();
    expect(badgeBox).toBeTruthy();
    expect(iconBox).toBeTruthy();
    expect(badgeBox!.x).toBeGreaterThanOrEqual(buttonBox!.x);
    expect(badgeBox!.y).toBeGreaterThanOrEqual(buttonBox!.y);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(buttonBox!.x + buttonBox!.width);
    expect(badgeBox!.y + badgeBox!.height).toBeLessThanOrEqual(buttonBox!.y + buttonBox!.height);
    const intersects = badgeBox!.x < iconBox!.x + iconBox!.width && badgeBox!.x + badgeBox!.width > iconBox!.x
      && badgeBox!.y < iconBox!.y + iconBox!.height && badgeBox!.y + badgeBox!.height > iconBox!.y;
    expect(intersects, "the badge must not cover the Workspace icon").toBeFalsy();
    for (const other of await page.locator(".nav-item").all()) {
      if (await other.getAttribute("aria-label") === "Workspace") continue;
      const otherBox = await other.boundingBox();
      if (!otherBox) continue;
      const overlaps = badgeBox!.x < otherBox.x + otherBox.width && badgeBox!.x + badgeBox!.width > otherBox.x
        && badgeBox!.y < otherBox.y + otherBox.height && badgeBox!.y + badgeBox!.height > otherBox.y;
      expect(overlaps, "the badge must not cover an adjacent navigation item").toBeFalsy();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBeTruthy();
    return buttonBox;
  };

  const fetchProjectJob = async () => {
    const projects = await (await fetch(`${gateway}/api/v1/projects`)).json() as { id: string; name: string }[];
    const project = projects.find((item) => item.name === projectName);
    if (!project) return null;
    const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json() as {
      id: string; projectId: string; state: string; mode: string; clips: { state: string }[];
      steps: { id: string; currentItem?: number | null; totalItems?: number | null }[];
    }[];
    return { project, job: jobs.find((item) => item.projectId === project.id) || null };
  };

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    const beforeCreate = await page.getByRole("button", { name: "Workspace", exact: true }).boundingBox();

    const creationPost = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/jobs/clip"));
    await createClipProject(page, {
      name: projectName,
      count: 5,
      mode: "Fast",
      aspect: "9:16",
      style: "Educational",
      min: 15,
      max: 45,
      captions: false,
      source: { kind: "url", url: approvedUrl },
    });
    const createdResponse = await creationPost;
    expect(createdResponse.ok(), "the clip job was created").toBeTruthy();
    const created = await fetchProjectJob();
    projectId = created?.project.id;
    expect(created?.job, "the created project has a job").toBeTruthy();
    expect(created?.job?.mode).toBe("clip");
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

    // The creation callback triggers the shell's guarded jobs poll immediately;
    // wait for that authoritative snapshot rather than sleeping for its idle
    // cadence.
    const badge = page.getByTestId("workspace-work-count");
    await expect(badge).toBeVisible({ timeout: 30_000 });
    const initialCount = Number(await badge.textContent());
    expect(Number.isInteger(initialCount)).toBeTruthy();
    expect(initialCount).toBeGreaterThanOrEqual(0);
    expect(initialCount).toBeLessThanOrEqual(5);
    await workspaceGeometry();
    expect(await page.getByRole("button", { name: "Workspace", exact: true }).boundingBox()).toEqual(beforeCreate);
    await page.screenshot({ path: path.join(screenshots, "workspace-indicator-desktop.png"), fullPage: true });

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(badge).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "workspace-indicator-library.png"), fullPage: true });
    const describedBy = await page.getByRole("button", { name: "Workspace", exact: true }).getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveAccessibleDescription(new RegExp(`${initialCount} clip${initialCount === 1 ? "" : "s"} remaining across 1 active job`));

    // Exercise other shell pages before waiting: the same shell badge must stay
    // attached to Workspace while the workspace view is unmounted.
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await expect(page.getByTestId("workspace-work-count")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("workspace-work-count")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByTestId("workspace-work-count")).toBeVisible();
    await workspaceGeometry();
    await page.screenshot({ path: path.join(screenshots, "workspace-indicator-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const observedCounts: number[] = [initialCount];
    let sawDecrease = false;
    let completed = false;
    const observeUntilTerminal = async () => {
      const end = Date.now() + deadlineMs;
      while (Date.now() < end) {
        const state = await fetchProjectJob();
        const job = state?.job;
        if (!job || job.mode !== "clip" || !["queued", "active", "paused", "recovered", "stalled"].includes(job.state)) {
          completed = true;
          await expect(page.getByTestId("workspace-work-count")).toHaveCount(0, { timeout: 30_000 });
          return;
        }
        const current = Number(await page.getByTestId("workspace-work-count").textContent());
        expect(Number.isInteger(current)).toBeTruthy();
        expect(current).toBeGreaterThanOrEqual(0);
        expect(current).toBeLessThanOrEqual(5);
        if (current < observedCounts.at(-1)!) sawDecrease = true;
        expect(current, "count must not increase during one job").toBeLessThanOrEqual(observedCounts.at(-1)!);
        observedCounts.push(current);
        await page.waitForTimeout(1_000);
      }
      throw new Error("YouTube clip job did not reach a terminal state before the deadline");
    };
    await observeUntilTerminal();
    expect(completed).toBeTruthy();
    expect(sawDecrease || observedCounts.at(-1) === 0, "observed genuine progress or completion").toBeTruthy();

    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible({ timeout: 30_000 });
    const finalState = await fetchProjectJob();
    const finalJob = finalState?.job;
    if (finalJob && ["queued", "active", "paused", "recovered", "stalled"].includes(finalJob.state)) {
      const render = finalJob.steps.find((step) => step.id === "render");
      const expected = Number.isInteger(render?.currentItem) && Number.isInteger(render?.totalItems)
        ? Math.max(0, (render?.totalItems || 0) - (render?.currentItem || 0))
        : finalJob.clips.filter((clip) => clip.state !== "complete").length;
      expect(Number(await page.getByTestId("workspace-work-count").textContent())).toBe(expected);
    } else {
      await expect(page.getByTestId("workspace-work-count")).toHaveCount(0);
    }

    await page.screenshot({ path: path.join(screenshots, "workspace-indicator-complete.png"), fullPage: true });

    expect(consoleErrors, "unexpected console errors").toEqual([]);
    expect(pageErrors, "unexpected page errors").toEqual([]);
    expect(failedRequests, "unexpected failed requests").toEqual([]);
  } finally {
    if (!projectId) projectId = (await fetchProjectJob())?.project.id;
    if (projectId) {
      await page.request.delete(`${gateway}/api/v1/projects/${encodeURIComponent(projectId)}?delete_assets=true`, { timeout: 30_000 }).catch(() => undefined);
    }
  }
});
