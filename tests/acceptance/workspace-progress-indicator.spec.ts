import { expect, test } from "@playwright/test";

const health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: false, dataPath: "/app/data", freeBytes: 1,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
};

function project() {
  return {
    schemaVersion: 1, id: "progress-project", name: "Progress indicator test", mode: "clip", style: "educational",
    state: "active", sourceName: "source.mp4", sourceKind: "upload", requestedCount: 100,
    latestJobId: "progress-job", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

function job(remaining: number) {
  return {
    schemaVersion: 1, id: "progress-job", projectId: "progress-project", mode: "clip", state: "active",
    stage: "render", stageLabel: "Rendering", progress: 20, currentItem: 0, totalItems: remaining,
    style: "educational", processingMode: "fast", warnings: [], clips: [], beats: [],
    steps: [{ id: "render", label: "Clips rendered", status: "active", currentItem: 0, totalItems: remaining }],
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

test("renders a stable centered Workspace progress ring at desktop and mobile sizes", async ({ page }) => {
  let remaining = 7;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/health") ? health
      : path.endsWith("/projects") ? [project()]
        : path.endsWith("/jobs") ? [job(remaining)]
          : [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    remaining = 7;
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const progress = page.getByTestId("workspace-work-progress");
    const button = page.getByRole("button", { name: "Workspace", exact: true });
    const icon = page.getByTestId("workspace-nav-icon");
    const label = page.locator(".nav-label", { hasText: "Workspace" });
    await expect(progress).toBeVisible();
    await expect(button).toHaveAccessibleDescription(/Loading progress: 7 clips remaining across 1 active job/);
    await expect(progress).toHaveAttribute("role", "img");
    await expect(progress).toHaveAttribute("aria-label", "Loading progress: 7 clips remaining across 1 active job");
    await expect(page.locator(".nav-work-count")).toHaveCount(0);

    const initial = await page.evaluate(() => {
      const progress = document.querySelector<HTMLElement>("[data-testid='workspace-work-progress']")!;
      const value = document.querySelector<HTMLElement>("[data-testid='workspace-work-count']")!;
      const icon = document.querySelector<SVGElement>("[data-testid='workspace-nav-icon']")!;
      const label = [...document.querySelectorAll<HTMLElement>(".nav-label")].find((item) => item.textContent === "Workspace")!;
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const indicator = progress.querySelector<SVGElement>(".nav-work-progress-indicator")!;
      const ring = progress.querySelector<SVGElement>(".nav-work-progress-ring")!;
      const indicatorStyle = getComputedStyle(indicator);
      const ringStyle = getComputedStyle(ring);
      return {
        progress: rect(progress), value: rect(value), icon: rect(icon), label: rect(label),
        button: rect(progress.closest("button")!), animationName: ringStyle.animationName,
        animationDuration: ringStyle.animationDuration, transform: ringStyle.transform,
        stroke: indicatorStyle.stroke, linecap: indicator.getAttribute("stroke-linecap"),
        strokeWidth: indicator.getAttribute("stroke-width"), background: getComputedStyle(progress).backgroundImage,
        boxShadow: getComputedStyle(progress).boxShadow,
      };
    });
    expect(initial.progress.width).toBe(28);
    expect(initial.progress.height).toBe(28);
    expect(initial.value.width).toBe(28);
    expect(initial.value.height).toBe(28);
    expect(initial.progress.x).toBeGreaterThan(initial.icon.x + initial.icon.width);
    expect(initial.progress.x - (initial.icon.x + initial.icon.width)).toBeLessThanOrEqual(5);
    expect(Math.abs((initial.progress.x + initial.progress.width / 2) - (initial.value.x + initial.value.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs((initial.progress.y + initial.progress.height / 2) - (initial.value.y + initial.value.height / 2))).toBeLessThanOrEqual(1);
    if (viewport.width > 600) expect(initial.label.y).toBeGreaterThan(initial.progress.y + initial.progress.height);
    expect(initial.animationName).toBe("workspace-nav-progress-spin");
    expect(initial.animationDuration).not.toBe("0s");
    expect(initial.stroke).toBe("rgb(76, 183, 130)");
    expect(initial.linecap).toBe("round");
    expect(initial.strokeWidth).toBe("2");
    expect(initial.background).toBe("none");
    expect(initial.boxShadow).toBe("none");
    await page.waitForTimeout(180);
    const laterTransform = await page.getByTestId("workspace-work-spinner").evaluate((element) => getComputedStyle(element).transform);
    expect(laterTransform).not.toBe(initial.transform);

    for (const value of [7, 42, 100]) {
      remaining = value;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workspace-work-count")).toHaveText(String(value));
      await expect(page.getByTestId("workspace-work-progress")).toHaveAttribute("data-progress-value", String(value));
      const current = await page.evaluate(() => {
        const progress = document.querySelector<HTMLElement>("[data-testid='workspace-work-progress']")!;
        const value = document.querySelector<HTMLElement>("[data-testid='workspace-work-count']")!;
        const button = progress.closest("button")!;
        const box = (element: Element) => element.getBoundingClientRect();
        return {
          progress: box(progress), value: box(value), button: box(button),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(current.progress.width).toBe(28);
      expect(current.progress.height).toBe(28);
      expect(current.value.width).toBe(28);
      expect(current.value.height).toBe(28);
      expect(current.button.width).toBe(initial.button.width);
      expect(current.button.height).toBe(initial.button.height);
      expect(current.overflow).toBeFalsy();
      expect(Math.abs((current.progress.x + current.progress.width / 2) - (current.value.x + current.value.width / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs((current.progress.y + current.progress.height / 2) - (current.value.y + current.value.height / 2))).toBeLessThanOrEqual(1);
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("workspace-work-progress")).toBeVisible();
    const reducedMotion = await page.getByTestId("workspace-work-spinner").evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration };
    });
    expect(reducedMotion.name).toBe("none");
    expect(Number.parseFloat(reducedMotion.duration)).toBeLessThan(0.001);
  }
});
