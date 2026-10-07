import { test, expect } from "@playwright/test";

test.describe("responsive layout regressions", () => {
  test("keeps mobile navigation labels inside their cells", async ({ page }) => {
    // The rail caption is General text (14px) at every breakpoint — there is no
    // mobile-only type size. Seven captions cannot fit a seven-column bottom bar
    // below ~600px, so the caption is dropped there and the item becomes the
    // icon alone; `aria-label` still carries the accessible name.
    const ICON_ONLY_MAX_WIDTH = 600;
    for (const width of [320, 390, 400, 420, 440, 768, 820]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();
      const nav = page.locator(".app-rail nav");
      const measurement = await nav.evaluate((element) => {
        const items = [...element.querySelectorAll<HTMLElement>(".nav-item")];
        const labelNodes = items.map((item) => item.querySelector<HTMLElement>(".nav-label")!);
        const labels = labelNodes.map((label) => label.getBoundingClientRect());
        const icons = items.map((item) => item.querySelector<HTMLElement>(".nav-icon-wrap")!.getBoundingClientRect());
        const itemRects = items.map((item) => item.getBoundingClientRect());
        const style = getComputedStyle(element);
        return {
          gap: style.columnGap,
          widths: itemRects.map((item) => item.width),
          labelsRendered: labelNodes.every((label) => getComputedStyle(label).display !== "none"),
          labelsInside: labels.every((label, index) => label.left >= itemRects[index].left - 0.5 && label.right <= itemRects[index].right + 0.5),
          labelsUntruncated: labelNodes.every((label) => label.scrollWidth <= label.clientWidth + 1),
          adjacentLabelsDoNotOverlap: labels.every((label, index) => index === 0 || label.left >= labels[index - 1].right - 0.5),
          iconsCentred: icons.every((icon, index) => Math.abs((icon.left + icon.width / 2) - (itemRects[index].left + itemRects[index].width / 2)) <= 0.5),
          accessibleNames: items.map((item) => item.getAttribute("aria-label") || ""),
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(measurement.gap, `${width}px navigation gap`).toBe("0px");
      expect(measurement.widths.every((itemWidth) => itemWidth >= 44), `${width}px target width`).toBe(true);
      expect(Math.max(...measurement.widths) - Math.min(...measurement.widths), `${width}px equal widths`).toBeLessThanOrEqual(1);
      expect(measurement.pageOverflow, `${width}px page overflow`).toBe(false);
      expect(measurement.iconsCentred, `${width}px icon centring`).toBe(true);
      // Every item stays reachable by name whether or not the caption renders.
      expect(measurement.accessibleNames.every((name) => name.length > 0), `${width}px accessible names`).toBe(true);
      if (width <= ICON_ONLY_MAX_WIDTH) {
        expect(measurement.labelsRendered, `${width}px icon-only navigation`).toBe(false);
      } else {
        expect(measurement.labelsRendered, `${width}px captioned navigation`).toBe(true);
        expect(measurement.labelsInside, `${width}px label containment`).toBe(true);
        expect(measurement.labelsUntruncated, `${width}px label truncation`).toBe(true);
        expect(measurement.adjacentLabelsDoNotOverlap, `${width}px adjacent label overlap`).toBe(true);
      }

      const items = nav.locator(".nav-item");
      for (const index of [0, 6]) {
        await items.nth(index).focus();
        const focusStyle = await items.nth(index).evaluate((item) => {
          const style = getComputedStyle(item);
          const rect = item.getBoundingClientRect();
          return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, viewport: { width: innerWidth, height: innerHeight } };
        });
        expect(focusStyle.outlineStyle, `${width}px focus style`).not.toBe("none");
        expect(Number.parseFloat(focusStyle.outlineWidth), `${width}px focus width`).toBeGreaterThanOrEqual(2);
        expect(Number.parseFloat(focusStyle.outlineOffset), `${width}px inward focus offset`).toBeLessThanOrEqual(0);
        expect(focusStyle.rect.left, `${width}px left focus edge`).toBeGreaterThanOrEqual(0);
        expect(focusStyle.rect.right, `${width}px right focus edge`).toBeLessThanOrEqual(focusStyle.viewport.width);
        expect(focusStyle.rect.top, `${width}px top focus edge`).toBeGreaterThanOrEqual(0);
        expect(focusStyle.rect.bottom, `${width}px bottom focus edge`).toBeLessThanOrEqual(focusStyle.viewport.height);
      }
      await items.nth(6).press("Enter");
      await expect(items.nth(6)).toHaveClass(/active/);
    }

    await page.setViewportSize({ width: 1440, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const desktop = await page.locator(".app-rail").evaluate((rail) => ({
      width: rail.getBoundingClientRect().width,
      navGap: getComputedStyle(rail.querySelector("nav")!).columnGap,
    }));
    expect(desktop.width, "desktop rail width").toBe(108);
    expect(desktop.navGap, "desktop navigation gap").toBe("5px");
  });

  test("keeps completed Workspace clip boards contained at narrow widths", async ({ page }) => {
    const now = new Date().toISOString();
    const project = {
      schemaVersion: 1 as const,
      id: "responsive-workspace-project",
      name: "Responsive Workspace fixture",
      mode: "clip" as const,
      style: "educational" as const,
      state: "complete" as const,
      sourceName: "responsive-fixture.mp4",
      sourceKind: "upload" as const,
      requestedCount: 3,
      contentFormat: "long" as const,
      latestJobId: "responsive-workspace-job",
      libraryFolderId: "00000000-0000-0000-0000-000000000001",
      sourceBlobId: null,
      createdAt: now,
      updatedAt: now,
    };
    const job = {
      schemaVersion: 1 as const,
      id: "responsive-workspace-job",
      projectId: project.id,
      libraryFolderId: project.libraryFolderId,
      sourceBlobId: null,
      mode: "clip" as const,
      state: "complete" as const,
      stage: "complete",
      stageLabel: "3 landscape clips ready",
      progress: 100,
      currentItem: 3,
      totalItems: 3,
      style: "educational" as const,
      processingMode: "fast" as const,
      contentFormat: "long" as const,
      burnSubtitles: false,
      embedSubtitles: false,
      warnings: [],
      error: null,
      clips: [1, 2, 3].map((index) => ({
        id: `responsive-clip-${index}`,
        index,
        state: "complete" as const,
        start: (index - 1) * 25,
        end: (index - 1) * 25 + 20,
        duration: 20,
        openingLine: `Responsive scene ${index}`,
        score: null,
        selected: true,
        outputName: `0${index}-cut.mp4`,
        blobId: `responsive-blob-${index}`,
        downloadUrl: "/api/v1/files/jobs/responsive-workspace-job/clips/01-cut.mp4",
        previewUrl: "/api/v1/files/jobs/responsive-workspace-job/clips/01-cut.mp4",
        libraryAssetId: `responsive-asset-${index}`,
        title: `Responsive scene ${index}`,
        width: 1920,
        height: 1080,
        folderId: project.libraryFolderId,
        publishedAt: now,
        fallbackUsed: false,
        provenance: [],
      })),
      beats: [],
      steps: [
        { id: "source", label: "Source received", status: "complete" as const, completedAt: now },
        { id: "probe", label: "Video validated", status: "complete" as const, completedAt: now },
        { id: "plan", label: "Cut points planned", status: "complete" as const, completedAt: now },
        { id: "render", label: "Clips rendered and saved", status: "complete" as const, completedAt: now, currentItem: 3, totalItems: 3 },
        { id: "verify", label: "Outputs verified", status: "complete" as const, completedAt: now, currentItem: 3, totalItems: 3 },
        { id: "ready", label: "Project ready", status: "complete" as const, completedAt: now },
      ],
      createdAt: now,
      updatedAt: now,
    };
    let currentJob = job;
    await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [project] }));
    // Keep the SSE fixture silent: a stale event must not overwrite a selection response.
    await page.route("**/api/v1/jobs/responsive-workspace-job/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\\n\\n" }));
    await page.route("**/api/v1/jobs/responsive-workspace-job", (route) => route.fulfill({ json: currentJob }));
    // Registered after the exact GET route and guarded by method/path so it cannot be shadowed.
    await page.route("**/api/v1/jobs/responsive-workspace-job/selection", (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      const body = JSON.parse(route.request().postData() || "{}") as { clipIds?: string[] };
      const selectedIds = new Set(body.clipIds || []);
      currentJob = { ...currentJob, clips: currentJob.clips.map((clip) => ({ ...clip, selected: selectedIds.has(clip.id) })) };
      return route.fulfill({ json: currentJob });
    });

    for (const [width, height] of [[320, 844], [360, 800], [375, 812], [390, 844], [768, 1024], [1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button").filter({ hasText: "Responsive Workspace fixture" }).click();
      await expect(page.locator(".clip-board")).toBeVisible();
      const measurement = await page.locator(".clip-board").evaluate((board) => {
        const boardRect = board.getBoundingClientRect();
        const tiles = [...board.querySelectorAll<HTMLElement>(".clip-tile")];
        const tileRects = tiles.map((tile) => {
          const rect = tile.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, scrollWidth: tile.scrollWidth, clientWidth: tile.clientWidth };
        });
        return {
          document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
          board: { left: boardRect.left, right: boardRect.right, scrollWidth: board.scrollWidth, clientWidth: board.clientWidth, display: getComputedStyle(board).display },
          tiles: tileRects,
          actionsVisible: tiles.every((tile) => Boolean(tile.querySelector<HTMLElement>(".clip-actions")?.getBoundingClientRect().height)),
        };
      });
      expect(measurement.document.scrollWidth, `${width}px document overflow`).toBeLessThanOrEqual(measurement.document.clientWidth);
      expect(measurement.board.right, `${width}px board right edge`).toBeLessThanOrEqual(width + 0.5);
      expect(measurement.actionsVisible, `${width}px clip actions`).toBe(true);
      expect(measurement.tiles.every((tile) => tile.scrollWidth <= tile.clientWidth), `${width}px card content containment`).toBe(true);
      if (width <= 375) {
        expect(measurement.tiles.every((tile) => tile.left >= measurement.board.left - 0.5 && tile.right <= measurement.board.right + 0.5 && tile.right <= width + 0.5), `${width}px tile containment`).toBe(true);
      }
      expect(Math.max(...measurement.tiles.map((tile) => tile.width)) - Math.min(...measurement.tiles.map((tile) => tile.width)), `${width}px equal card widths`).toBeLessThanOrEqual(0.5);
      if (width <= 375) {
        expect(measurement.board.scrollWidth, `${width}px board overflow`).toBeLessThanOrEqual(measurement.board.clientWidth);
        expect(measurement.board.display, `${width}px stacked board`).toBe("grid");
        expect(measurement.tiles[1].top, `${width}px stacked cards`).toBeGreaterThan(measurement.tiles[0].bottom);
        expect(measurement.tiles[2].top, `${width}px stacked cards`).toBeGreaterThan(measurement.tiles[1].bottom);
      } else {
        expect(measurement.board.display, `${width}px board layout`).toBe("flex");
      }
      if (width === 390) {
        await page.locator(".clip-actions .clip-action").nth(2).click();
        await expect(page.locator(".clip-tile").nth(1)).toHaveClass(/active/);
        const inspectorSelection = page.locator(".panel-title span");
        await expect(inspectorSelection).toHaveText("Clip 2");
        const exportCheckbox = page.getByRole("checkbox", { name: "Include in export" }).nth(1);
        await expect(exportCheckbox).toBeChecked();
        const uncheckResponse = page.waitForResponse((response) => response.url().includes("/api/v1/jobs/responsive-workspace-job/selection") && response.request().method() === "PUT");
        await exportCheckbox.click();
        expect((await uncheckResponse).status()).toBe(200);
        await expect(exportCheckbox).not.toBeChecked();
        await expect(inspectorSelection).toHaveText("Clip 2");
        await expect(page.locator(".video-preview-dialog")).toHaveCount(0);
        const checkResponse = page.waitForResponse((response) => response.url().includes("/api/v1/jobs/responsive-workspace-job/selection") && response.request().method() === "PUT");
        await exportCheckbox.click();
        expect((await checkResponse).status()).toBe(200);
        await expect(exportCheckbox).toBeChecked();
        await expect(inspectorSelection).toHaveText("Clip 2");
        await expect(page.locator(".video-preview-dialog")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
      const focused = page.locator(".clip-actions .clip-action").first();
      await focused.focus();
      // Establish keyboard modality before focusing the control so :focus-visible is applied.
      await page.keyboard.press("Tab");
      await focused.focus();
      const focusRect = await focused.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, outline: style.outlineStyle };
      });
      expect(focusRect.outline, `${width}px focus outline`).not.toBe("none");
      expect(focusRect.left, `${width}px focused control left`).toBeGreaterThanOrEqual(0);
      expect(focusRect.right, `${width}px focused control right`).toBeLessThanOrEqual(width);
      expect(focusRect.top, `${width}px focused control top`).toBeGreaterThanOrEqual(0);
      expect(focusRect.bottom, `${width}px focused control bottom`).toBeLessThanOrEqual(height);
    }
  });

  test("keeps library controls visible without a horizontal strip", async ({ page }) => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const sidebar = page.locator(".library-sidebar");
      await expect(sidebar).toBeVisible();
      for (const label of ["Required", "Preferred", "Neutral", "Never", "Show archived"]) {
        const control = label === "Show archived"
          ? page.getByLabel(label)
          : sidebar.locator(":scope > button").filter({ hasText: label });
        await expect(control).toBeVisible();
        const withinSidebar = await control.first().evaluate((element) => {
          const controlRect = element.getBoundingClientRect();
          const sidebarRect = element.closest(".library-sidebar")!.getBoundingClientRect();
          return controlRect.left >= sidebarRect.left - 0.5 && controlRect.right <= sidebarRect.right + 0.5 && controlRect.top >= sidebarRect.top - 0.5 && controlRect.bottom <= sidebarRect.bottom + 0.5;
        });
        expect(withinSidebar, `${width}px ${label} containment`).toBe(true);
      }
      const layout = await sidebar.evaluate((element) => ({
        overflowX: getComputedStyle(element).overflowX,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      expect(layout.overflowX, `${width}px sidebar overflow mode`).not.toMatch(/auto|scroll/);
      expect(layout.scrollWidth, `${width}px sidebar scroll width`).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.pageOverflow, `${width}px page overflow`).toBe(false);
    }
  });
});
