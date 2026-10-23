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

test("renders a stable centered Workspace progress ring at desktop and mobile sizes", async ({ context }) => {
  let remaining = 7;
  // The pinned sidebar labels each row; the folded rail and the phone bar show icons only.
  for (const { viewport, rail, labelled } of [
    { viewport: { width: 1440, height: 900 }, rail: "0", labelled: true },
    { viewport: { width: 1440, height: 900 }, rail: "1", labelled: false },
    { viewport: { width: 390, height: 844 }, rail: "0", labelled: false },
  ]) {
    remaining = 7;
    const page = await context.newPage();
    await page.addInitScript((value) => localStorage.setItem("s6.rail.collapsed", value), rail);
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith("/health") ? health
        : path.endsWith("/projects") ? [project()]
          : path.endsWith("/jobs") ? [job(remaining)]
            : [];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const progress = page.getByTestId("workspace-work-progress");
    const button = page.getByRole("button", { name: "Workspace", exact: true });
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
      const projects = document.querySelector<HTMLElement>(".nav-item[aria-label='Projects']")!;
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
        projectsIcon: rect(projects.querySelector("svg")!), projectsLabel: rect(projects.querySelector(".nav-label")!),
        iconVisibility: getComputedStyle(icon).visibility,
        button: rect(progress.closest("button")!), animationName: ringStyle.animationName,
        animationDuration: ringStyle.animationDuration, transform: ringStyle.transform,
        stroke: indicatorStyle.stroke, linecap: indicator.getAttribute("stroke-linecap"),
        strokeWidth: indicator.getAttribute("stroke-width"), background: getComputedStyle(progress).backgroundImage,
        boxShadow: getComputedStyle(progress).boxShadow,
      };
    });
    // On the sidebar the ring sits on whole pixels; a half-pixel position blurs its strokes on a 1x display.
    if (viewport.width > 820) {
      expect(initial.progress.x % 1).toBeCloseTo(0, 2);
      expect(initial.progress.y % 1).toBeCloseTo(0, 2);
    }
    expect(initial.progress.width).toBe(28);
    expect(initial.progress.height).toBe(28);
    expect(initial.value.width).toBe(28);
    expect(initial.value.height).toBe(28);
    // The ring never moves the Workspace icon off the line the other destinations share:
    // a column in the sidebar, a row in the phone's bottom bar.
    const centre = (box: { x: number; y: number; width: number; height: number }) => viewport.width > 820 ? box.x + box.width / 2 : box.y + box.height / 2;
    expect(Math.abs(centre(initial.icon) - centre(initial.projectsIcon))).toBeLessThanOrEqual(1);
    expect(initial.progress.x).toBeGreaterThanOrEqual(initial.button.x);
    expect(initial.progress.x + initial.progress.width).toBeLessThanOrEqual(initial.button.x + initial.button.width);
    // Whatever the rail shows, the ring replaces the Workspace icon: hidden icon, ring centred on it.
    expect(initial.iconVisibility).toBe("hidden");
    expect(Math.abs((initial.progress.x + initial.progress.width / 2) - (initial.icon.x + initial.icon.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs((initial.progress.y + initial.progress.height / 2) - (initial.icon.y + initial.icon.height / 2))).toBeLessThanOrEqual(1);
    if (labelled) {
      // A labelled row keeps its caption in the column the other rows share, clear of the ring.
      expect(Math.abs(initial.label.x - initial.projectsLabel.x)).toBeLessThanOrEqual(1);
      expect(initial.label.x - (initial.progress.x + initial.progress.width)).toBeGreaterThanOrEqual(8);
    }
    expect(initial.animationName).toBe("workspace-nav-progress-spin");
    expect(initial.animationDuration).not.toBe("0s");
    expect(initial.stroke).toBe("rgb(76, 183, 130)");
    expect(initial.linecap).toBe("round");
    expect(initial.strokeWidth).toBe("2");
    expect(initial.background).toBe("none");
    expect(initial.boxShadow).toBe("none");
    // WebKit can take a few hundred ms to start the first frame of the animation, so poll for movement.
    await expect.poll(() => page.getByTestId("workspace-work-spinner").evaluate((element) => getComputedStyle(element).transform), { timeout: 5000 }).not.toBe(initial.transform);

    // The number is centred on its drawn digits: measure the rendered pixels, with the arc hidden,
    // so the gaps either side of "100" (and above and below) match whatever the font's side bearings are.
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The production CSP forbids injected stylesheets, so hide the arc through the CSSOM instead.
    const hideArc = () => page.evaluate(() => document.querySelectorAll<SVGElement>(".nav-work-progress-ring").forEach((ring) => { ring.style.visibility = "hidden"; }));
    for (const value of [7, 42, 100]) {
      remaining = value;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workspace-work-count")).toHaveText(String(value));
      await hideArc();
      await page.evaluate(() => document.fonts.ready);
      // A reload shows the startup splash over the sidebar for a moment; wait until the ring is what's on top.
      await expect.poll(() => page.evaluate(() => {
        const ring = document.querySelector("[data-testid='workspace-work-progress']")!;
        const box = ring.getBoundingClientRect();
        return ring.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      const shot = await page.getByTestId("workspace-work-progress").screenshot({ scale: "device" });
      const gaps = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
        for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
          // The number is the only bright thing left in the ring.
          if (data[(y * canvas.width + x) * 4] > 70 && data[(y * canvas.width + x) * 4 + 3] > 0) {
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        const scale = canvas.width / 28;
        return { found: right >= 0, left: left / scale, right: (canvas.width - 1 - right) / scale, top: top / scale, bottom: (canvas.height - 1 - bottom) / scale };
      }, shot.toString("base64"));
      // With no digits drawn both gaps come out equal, so insist that something was found.
      expect(gaps.found, `digits of ${value} are drawn`).toBe(true);
      // On a 1x display the digits snap to whole pixels, so allow a pixel and a half of difference.
      expect(Math.abs(gaps.left - gaps.right), `digits of ${value} centred left to right`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(gaps.top - gaps.bottom), `digits of ${value} centred top to bottom`).toBeLessThanOrEqual(1.5);
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });

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
    await page.close();
  }
});
