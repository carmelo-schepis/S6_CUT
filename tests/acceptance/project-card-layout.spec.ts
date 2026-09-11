import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Job, Project } from "../../web/src/types";

const artifacts = path.join(process.cwd(), "test-artifacts", "project-card-layout");
const now = "2026-08-13T00:00:00Z";
const statuses = [
  { state: "complete", label: "1 fast cut ready" },
  { state: "complete", label: "2 fast cuts ready" },
  { state: "complete", label: "5 clips ready" },
  { state: "failed", label: "Rendering failed" },
  { state: "active", label: "Rendering clip 2" },
] as const;

const projects: Project[] = statuses.map((_, index) => ({
  schemaVersion: 1,
  id: `project-card-layout-${index}`,
  name: `A deliberately long project title that must always leave its full status badge visible in the Recent Projects card ${index + 1}`,
  mode: "clip",
  style: "educational",
  state: "queued",
  sourceName: "layout-fixture.mp4",
  sourceKind: "upload",
  requestedCount: index + 1,
  latestJobId: `project-card-layout-job-${index}`,
  createdAt: now,
  updatedAt: now,
}));

const jobs: Job[] = statuses.map((status, index) => ({
  schemaVersion: 1,
  id: `project-card-layout-job-${index}`,
  projectId: `project-card-layout-${index}`,
  mode: "clip",
  state: status.state,
  stage: status.state === "failed" ? "failed" : status.state === "active" ? "render" : "complete",
  stageLabel: status.label,
  progress: status.state === "complete" ? 100 : status.state === "active" ? 55 : 0,
  currentItem: 0,
  totalItems: 0,
  style: "educational",
  processingMode: "fast",
  warnings: [],
  error: status.state === "failed" ? "Fixture failure" : null,
  clips: [],
  beats: [],
  steps: [],
  createdAt: now,
  updatedAt: now,
}));

async function installProjectFixtures(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects) });
  });
  await page.route("**/api/v1/jobs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobs) });
  });
  await page.route("**/api/v1/library/assets**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

test("Recent Project status badges stay entirely visible at desktop and mobile widths", async ({ page }) => {
  await fs.mkdir(artifacts, { recursive: true });
  await installProjectFixtures(page);

  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Recent projects" })).toBeVisible();
    await expect(page.locator(".project-card")).toHaveCount(projects.length);

    const layout = await page.locator(".project-card").evaluateAll((cards) => cards.map((card) => {
      const cardRect = card.getBoundingClientRect();
      const badges = [...card.querySelectorAll<HTMLElement>(".project-card-title .status")];
      return {
        badgeCount: badges.length,
        badges: badges.map((badge) => {
          const rect = badge.getBoundingClientRect();
          return {
            text: badge.textContent?.trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            scrollWidth: badge.scrollWidth,
            clientWidth: badge.clientWidth,
            scrollHeight: badge.scrollHeight,
            clientHeight: badge.clientHeight,
          };
        }),
        card: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom },
      };
    }));

    expect(layout).toHaveLength(projects.length);
    for (const card of layout) {
      expect(card.badgeCount).toBe(1);
      for (const badge of card.badges) {
        expect(badge.left, `${name}: ${badge.text} left edge`).toBeGreaterThanOrEqual(card.card.left - 1);
        expect(badge.right, `${name}: ${badge.text} right edge`).toBeLessThanOrEqual(card.card.right + 1);
        expect(badge.top, `${name}: ${badge.text} top edge`).toBeGreaterThanOrEqual(card.card.top - 1);
        expect(badge.bottom, `${name}: ${badge.text} bottom edge`).toBeLessThanOrEqual(card.card.bottom + 1);
        expect(badge.scrollWidth, `${name}: ${badge.text} horizontal clipping`).toBeLessThanOrEqual(badge.clientWidth + 1);
        expect(badge.scrollHeight, `${name}: ${badge.text} vertical clipping`).toBeLessThanOrEqual(badge.clientHeight + 1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}: page horizontal overflow`).toBe(true);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
  }
});
