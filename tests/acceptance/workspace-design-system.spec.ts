/**
 * Workspace design-system acceptance — spacing and text.
 *
 * The workspace is the densest route in the product and the one where a layout
 * regression is hardest to see by eye: twelve progress rows, three panels, a
 * viewer and a film strip all competing for one fold. These assertions encode
 * the geometry the redesign established so it cannot erode a rule at a time.
 *
 * Every number is measured from the rendered page, never read from the
 * stylesheet, so a token that stops being applied fails here.
 *
 * What is locked, and why each one was a real defect before it was locked:
 *
 *   SPACING
 *   1. One measure. `.workspace-page` opted out of the 1540px guide `.page`
 *      uses and `.topbar` mirrors, so above a ~1600px viewport the content ran
 *      ~200px wider than the bar directly above it.
 *   2. One vertical rhythm. The bands between the command bar and the film
 *      strip separated by 24 / 8 / 2px depending on which one it was.
 *   3. Whole pixels. The three panels measured 310.612 / 751.487 / 350.7px
 *      because the grid used fractional `fr` tracks; every hairline inside them
 *      then landed on a different subpixel column.
 *   4. One inline padding for panel chrome, and one height for a chrome row.
 *   5. The progress ledger's status words share a single left edge. They used
 *      to end ragged against the right margin, twelve rows deep.
 *
 *   TEXT
 *   6. Section captions, the page title and the status vocabulary are exact.
 *   7. No first-party text is clipped by its own box.
 *   8. Text stays white — hierarchy comes from weight, spacing and surfaces.
 *
 * The progress panel's 280-340px height contract is owned by
 * vertical-progress.spec.ts; it is re-asserted here only because this suite's
 * ledger rules (hairline rows, no gap) are what spend that budget.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const gateway = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

/** The 4px grid every spacing token in styles.css is a multiple of. */
const GRID = 4;
/** `--space-6`: the separation between two major bands of the page. */
const BAND_GAP = 24;
/** `--space-4`: the inline padding of every panel chrome row. */
const PANEL_INSET = 16;
/** The height of a panel's chrome row — tabs, title, toolbar, transport. */
const CHROME_HEIGHT = 40;
/** `--ws-measure`, shared with `.page` and mirrored by `.topbar`. */
const MEASURE = 1540;
/** `--ws-rail-left` / `--ws-rail-right` above the 1180px breakpoint. */
const RAIL_LEFT = 300;
const RAIL_RIGHT = 340;

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

/** Every status word the progress ledger is allowed to print. */
const STATUS_WORDS = new Set(["Complete", "Skipped", "In progress", "Pending", "Failed", "Paused"]);

/**
 * Open whatever finished project the instance actually has.
 *
 * Naming a fixture project would tie this suite to one dataset; rendering a new
 * one would put a 15-minute encode in front of a layout check. It skips cleanly
 * when the instance has nothing finished, the same way the FFmpeg-gated suites
 * skip when the tools are absent.
 */
async function findCompletedProject(request: APIRequestContext): Promise<string | null> {
  const projectsResponse = await request.get(`${gateway}/api/v1/projects`);
  if (!projectsResponse.ok()) return null;
  const projects = await projectsResponse.json() as { id: string; name: string }[];
  const jobsResponse = await request.get(`${gateway}/api/v1/jobs`);
  if (!jobsResponse.ok()) return null;
  const jobs = await jobsResponse.json() as { projectId: string; state: string }[];
  const complete = new Set(jobs.filter((job) => job.state === "complete").map((job) => job.projectId));
  return projects.find((project) => complete.has(project.id))?.name ?? null;
}

async function openWorkspace(page: Page, projectName: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator('.app-rail nav button[aria-label="Projects"]').click();
  const open = page.getByRole("button", { name: `Open project ${projectName}`, exact: true }).first();
  await expect(open).toBeVisible({ timeout: 60_000 });
  await open.click();
  await expect(page.locator(".workspace-page")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 60_000 });
  // The viewer resolves its source after the job read settles; measuring before
  // that reads a placeholder frame rather than the real one.
  await page.waitForTimeout(1_200);
}

/** Geometry of one element, with its padding box resolved. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight),
      paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
      radius: parseFloat(style.borderTopLeftRadius),
      background: style.backgroundColor,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      gap: style.rowGap,
    };
  });
}

test.describe("workspace design system", () => {
  let projectName: string | null = null;

  test.beforeAll(async ({ request }) => {
    projectName = await findCompletedProject(request);
  });

  test.beforeEach(async () => {
    test.skip(!projectName, "no completed project on this instance to measure");
  });

  // ---------------------------------------------------------------- SPACING

  test("the page, the topbar and every band share one horizontal guide", async ({ page }) => {
    test.setTimeout(180_000);
    // Deliberately includes widths above the 1540px measure: that is exactly
    // where the workspace used to drift away from the bar above it.
    for (const [width, height] of [[1920, 1080], [1680, 1050], [1440, 900], [1280, 800], [1024, 768]] as const) {
      await page.setViewportSize({ width, height });
      await openWorkspace(page, projectName!);

      const guides = await page.evaluate(() => {
        const read = (element: HTMLElement | null) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            left: rect.left + parseFloat(style.paddingLeft),
            right: rect.right - parseFloat(style.paddingRight),
            maxWidth: style.maxWidth,
          };
        };
        return {
          container: read(document.querySelector<HTMLElement>(".workspace-page")),
          topbar: read(document.querySelector<HTMLElement>(".topbar")),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      const where = `${width}x${height}`;
      expect(guides.container, `${where}: workspace container`).not.toBeNull();
      expect(guides.container!.maxWidth, `${where}: the workspace uses the shared measure`).toBe(`${MEASURE}px`);
      expect(Math.abs(guides.container!.left - guides.topbar!.left), `${where}: page and topbar start on different columns`).toBeLessThanOrEqual(1);
      expect(Math.abs(guides.container!.right - guides.topbar!.right), `${where}: page and topbar end on different columns`).toBeLessThanOrEqual(1);
      expect(guides.overflow, `${where}: the document scrolls horizontally`).toBeLessThanOrEqual(0);
    }
  });

  test("every band of the page separates by exactly one 24px gap", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const bands = await page.locator(".workspace-page > *").evaluateAll((elements) => elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { cls: String(element.className).split(" ")[0], top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
      }));

    expect(bands.length, "expected the command bar, the progress panel, the grid and the board").toBeGreaterThanOrEqual(4);

    for (let index = 1; index < bands.length; index += 1) {
      const gap = bands[index].top - bands[index - 1].bottom;
      expect(gap, `gap between .${bands[index - 1].cls} and .${bands[index].cls}`).toBeCloseTo(BAND_GAP, 0);
    }
    // Every band starts on the same column and runs the full measure.
    expect(spread(bands.map((band) => band.left)), "bands start on different columns").toBeLessThanOrEqual(1);
    expect(spread(bands.map((band) => band.width)), "bands are different widths").toBeLessThanOrEqual(1);
  });

  test("the three-panel grid resolves to whole pixels", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const grid = await page.locator(".workspace-grid").evaluate((element) => {
      const columns = getComputedStyle(element).gridTemplateColumns.split(" ").map(parseFloat);
      const panels = [...element.querySelectorAll<HTMLElement>(":scope > .panel")].map((panel) => {
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        return {
          cls: String(panel.className).split(" ")[0],
          left: rect.left, right: rect.right, width: rect.width, height: rect.height,
          radius: style.borderRadius,
        };
      });
      return { columns, panels };
    });

    expect(grid.panels.length, "three panels").toBe(3);
    expect(grid.columns[0], "left rail width").toBeCloseTo(RAIL_LEFT, 1);
    expect(grid.columns[2], "right rail width").toBeCloseTo(RAIL_RIGHT, 1);
    for (const [index, column] of grid.columns.entries()) {
      // Sub-pixel column edges are what put each panel's hairlines on a
      // different physical column; a fractional track is the defect itself.
      expect(Math.abs(column - Math.round(column)), `column ${index} (${column}px) is fractional`).toBeLessThanOrEqual(0.5);
    }

    // One framed slab: the panels butt against each other with no seam, and
    // only the outer corners are rounded.
    for (let index = 1; index < grid.panels.length; index += 1) {
      expect(grid.panels[index].left - grid.panels[index - 1].right, `seam between panel ${index - 1} and ${index}`).toBeLessThanOrEqual(1);
    }
    expect(spread(grid.panels.map((panel) => panel.height)), "panels are different heights").toBeLessThanOrEqual(1);
    expect(grid.panels[0].radius, "left panel rounds only its outer corners").toBe("12px 0px 0px 12px");
    expect(grid.panels[2].radius, "right panel rounds only its outer corners").toBe("0px 12px 12px 0px");
  });

  test("panel chrome shares one inline padding and one height", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const chrome = await page.evaluate((inset) => {
      const selectors = [".panel-tabs", ".inspector-tabs", ".panel-title", ".viewer-toolbar", ".transport", ".board-header", ".checklist-heading"];
      return selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            selector,
            height: element.getBoundingClientRect().height,
            paddingLeft: parseFloat(style.paddingLeft),
            paddingRight: parseFloat(style.paddingRight),
            inset,
          };
        }));
    }, PANEL_INSET);

    expect(chrome.length, "expected panel chrome rows").toBeGreaterThanOrEqual(6);
    for (const row of chrome) {
      expect(row.paddingLeft, `${row.selector}: left inset`).toBeCloseTo(PANEL_INSET, 0);
      expect(row.paddingRight, `${row.selector}: right inset`).toBeCloseTo(PANEL_INSET, 0);
      // The progress heading is deliberately 36px — it spends its four spare
      // pixels on the 280-340px panel-height contract below it.
      const expected = row.selector === ".checklist-heading" ? 36 : CHROME_HEIGHT;
      expect(row.height, `${row.selector}: chrome height`).toBeCloseTo(expected, 0);
      expect(expected % GRID, `${row.selector}: height is off the 4px grid`).toBe(0);
    }

    // Panel bodies use the same inset as the chrome above them, so a card's
    // left edge continues the tab's text column rather than stepping in.
    for (const selector of [".source-content", ".inspector-content"]) {
      const body = await box(page, selector);
      expect(body.paddingLeft, `${selector}: left inset`).toBeCloseTo(PANEL_INSET, 0);
      expect(body.paddingRight, `${selector}: right inset`).toBeCloseTo(PANEL_INSET, 0);
    }
  });

  test("a status chip is one component at one height, wherever it appears", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const chips = await page.locator(".status").evaluateAll((elements) => elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        text: (element.textContent || "").trim().slice(0, 24),
        parent: String((element.parentElement as HTMLElement).className).slice(0, 24),
        height: element.getBoundingClientRect().height,
      })));
    const chipHeight = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chip-height")));

    expect(chips.length, "expected status chips").toBeGreaterThan(0);
    // The chip in a beat tile lives in a grid row of its own and used to
    // stretch to it — 24px in the topbar, 40.5px on a tile whose text wrapped.
    for (const chip of chips) {
      expect(chip.height, `chip "${chip.text}" in .${chip.parent}`).toBeCloseTo(chipHeight, 0);
    }
    expect(spread(chips.map((chip) => chip.height)), "chip heights differ").toBeLessThanOrEqual(0.5);
  });

  test("the progress ledger is one hairline-ruled list with an aligned status column", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const panel = await box(page, ".checklist-panel");
    // Owned by vertical-progress.spec.ts; restated because the ledger rules
    // below are what spend this budget.
    expect(panel.height, "progress panel height").toBeGreaterThanOrEqual(280);
    expect(panel.height, "progress panel height").toBeLessThanOrEqual(340);
    expect(panel.radius, "progress panel radius").toBeCloseTo(12, 0);

    const rows = await page.locator(".checklist-step").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const status = element.querySelector(".checklist-status-text");
      const label = element.querySelector(".checklist-label");
      return {
        top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height,
        background: style.backgroundColor,
        active: element.classList.contains("status-active"),
        statusX: status ? status.getBoundingClientRect().left : null,
        statusText: status?.textContent?.trim() || "",
        labelX: label ? label.getBoundingClientRect().left : null,
      };
    }));

    expect(rows.length, "progress rows").toBeGreaterThan(1);

    // Rows are a ledger: same height, same left edge, same width, and they meet
    // on a hairline rather than floating apart as separate chips.
    expect(spread(rows.map((row) => row.height)), "rows are different heights").toBeLessThanOrEqual(1);
    expect(spread(rows.map((row) => row.left)), "rows start on different columns").toBeLessThanOrEqual(1);
    expect(spread(rows.map((row) => row.width)), "rows are different widths").toBeLessThanOrEqual(1);
    for (const row of rows) {
      expect(row.height, "a progress row is taller than its contract").toBeLessThanOrEqual(28);
    }
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].top - rows[index - 1].bottom, `rows ${index - 1}/${index} do not meet`).toBeCloseTo(0, 0);
    }

    // The headline spacing fix: every status word starts on one column.
    const statusXs = rows.map((row) => row.statusX).filter((value): value is number => value !== null);
    expect(statusXs.length, "every row prints a status").toBe(rows.length);
    expect(spread(statusXs), "status words do not share a left edge").toBeLessThanOrEqual(1);
    // …and to the right of every label, which is what makes it a column.
    for (const row of rows) expect(row.statusX!, "status sits left of its label").toBeGreaterThan(row.labelX!);

    // Only the in-flight row lifts. A tint on every finished row made twelve
    // completed steps louder than the one actually happening.
    for (const row of rows.filter((candidate) => !candidate.active)) {
      expect(row.background, "a finished row paints a fill").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    }
  });

  test("the output frame is the largest object in the viewer and is centred", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const frame = await box(page, ".viewer-frame");
    const stage = await box(page, ".viewer-stage");

    expect(frame.height, "the output frame is smaller than its floor").toBeGreaterThanOrEqual(360);
    expect(frame.height, "the output frame overflows its stage").toBeLessThanOrEqual(stage.height);
    // Centred on the stage in both axes; the dark surround is a deliberate
    // letterbox, not an accident of `place-items`.
    const frameCentre = frame.left + frame.width / 2;
    const stageCentre = stage.left + stage.width / 2;
    expect(Math.abs(frameCentre - stageCentre), "the output frame is off-centre").toBeLessThanOrEqual(1);
    expect(stage.paddingLeft, "stage inset").toBeCloseTo(BAND_GAP, 0);
    expect(stage.paddingTop, "stage inset").toBeCloseTo(BAND_GAP, 0);

    // The declared output ratio in the toolbar is the ratio actually drawn.
    const ratioText = (await page.locator(".viewer-toolbar > span").first().textContent())?.trim() || "";
    const parsed = /Output\s*·\s*(\d+):(\d+)/.exec(ratioText);
    expect(parsed, `viewer toolbar reads "${ratioText}"`).not.toBeNull();
    const declared = Number(parsed![1]) / Number(parsed![2]);
    expect(frame.width / frame.height, `frame ratio does not match the declared ${parsed![1]}:${parsed![2]}`).toBeCloseTo(declared, 2);
  });

  test("the film strip scrolls in whole tiles on one gap", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    const strip = page.locator(".clip-board, .beat-board").first();
    await expect(strip).toBeVisible();
    const measured = await strip.evaluate((element) => {
      const style = getComputedStyle(element);
      const tiles = [...element.querySelectorAll<HTMLElement>(".clip-tile, .beat-tile")].map((tile) => {
        const rect = tile.getBoundingClientRect();
        return { width: rect.width, height: rect.height, snap: getComputedStyle(tile).scrollSnapAlign };
      });
      return {
        gap: parseFloat(style.columnGap),
        paddingLeft: parseFloat(style.paddingLeft),
        snapType: style.scrollSnapType,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        tiles,
      };
    });

    expect(measured.tiles.length, "expected tiles in the strip").toBeGreaterThan(0);
    expect(measured.gap, "tile gap").toBeCloseTo(12, 0);
    expect(measured.paddingLeft, "strip inset").toBeCloseTo(PANEL_INSET, 0);
    expect(spread(measured.tiles.map((tile) => tile.width)), "tiles are different widths").toBeLessThanOrEqual(1);
    expect(spread(measured.tiles.map((tile) => tile.height)), "tiles are different heights").toBeLessThanOrEqual(1);
    // A tile cut in half at the right edge reads as a bug unless the strip says
    // it is a scroller; snap points make the overflow deliberate.
    if (measured.scrollWidth > measured.clientWidth) {
      expect(measured.snapType, "an overflowing strip has no snap points").toContain("x");
      expect(measured.tiles[0].snap, "tiles do not snap").toBe("start");
    }
  });

  // ------------------------------------------------------------------- TEXT

  test("the page names itself, its sections and its statuses exactly", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, projectName!);

    // The page title is the project's own name, at the title role — not at the
    // same 12px every panel caption beside it uses.
    const title = page.locator(".workspace-project-name");
    await expect(title).toHaveText(projectName!);
    const titleStyle = await box(page, ".workspace-project-name");
    expect(titleStyle.fontSize, "page title size").toBe(18);
    expect(titleStyle.fontWeight, "page title weight").toBe("600");

    const panelCaption = await box(page, ".panel-title strong");
    expect(titleStyle.fontSize, "the page title does not outrank a panel caption")
      .toBeGreaterThan(panelCaption.fontSize);

    // Section captions, verbatim.
    await expect(page.getByRole("region", { name: "Short creation progress" })).toBeVisible();
    await expect(page.locator(".checklist-heading h2")).toHaveText("Short creation progress");
    await expect(page.locator(".inspector-panel .panel-title strong")).toHaveText("Details");
    await expect(page.locator(".board-header strong")).toHaveText(/^(Clip board|Beat board)$/);
    await expect(page.locator(".viewer-toolbar > span").first()).toHaveText(/^Output · \d+:\d+$/);

    // The inspector's tab set, in order.
    expect(await page.locator(".inspector-tabs button").allTextContents()).toEqual(["Score", "Captions", "Asset", "Info"]);
    // The board's filter set, in order.
    expect(await page.locator(".board-filters button").allTextContents()).toEqual(["All", "Selected", "Failed"]);

    // The status vocabulary is closed: a new word here is a new state the rest
    // of the UI has not been taught.
    const statuses = await page.locator(".checklist-status-text").allTextContents();
    expect(statuses.length, "expected statuses").toBeGreaterThan(0);
    for (const status of statuses) {
      expect(STATUS_WORDS.has(status.trim()), `unexpected status word "${status.trim()}"`).toBe(true);
    }
  });

  test("no first-party text is clipped by its own box, and all of it is white", async ({ page }) => {
    test.setTimeout(120_000);
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await openWorkspace(page, projectName!);

      const problems = await page.evaluate(() => {
        const clipped: { text: string; cls: string; overflowBy: number }[] = [];
        const coloured: { text: string; cls: string; colour: string }[] = [];
        const SKIP = new Set(["SVG", "CANVAS", "VIDEO", "IMG", "SCRIPT", "STYLE", "AUDIO", "SOURCE", "IFRAME", "SELECT", "OPTION"]);
        for (const element of document.querySelectorAll<HTMLElement>(".workspace-page *")) {
          if (SKIP.has(element.tagName)) continue;
          if (element.closest("svg,canvas,video,img,iframe,.sr-only,.caption-preview")) continue;
          let own = "";
          for (const node of element.childNodes) if (node.nodeType === 3) own += node.nodeValue;
          const text = own.trim();
          if (!text) continue;
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          // An element that deliberately truncates says so with an ellipsis or
          // a line clamp; anything else overflowing is losing content silently.
          const truncates = style.textOverflow === "ellipsis"
            || style.webkitLineClamp !== "none"
            || style.overflow === "auto" || style.overflow === "scroll"
            || style.overflowX === "auto" || style.overflowX === "scroll";
          const overflowBy = Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight);
          if (!truncates && overflowBy > 1) clipped.push({ text: text.slice(0, 48), cls: String(element.className).slice(0, 40), overflowBy });

          if (!/^rgba?\(255, 255, 255/.test(style.color)) {
            coloured.push({ text: text.slice(0, 48), cls: String(element.className).slice(0, 40), colour: style.color });
          }
        }
        return { clipped, coloured };
      });

      expect(problems.clipped, `${width}px: text clipped by its own box: ${JSON.stringify(problems.clipped, null, 1)}`).toEqual([]);
      expect(problems.coloured, `${width}px: non-white text: ${JSON.stringify(problems.coloured, null, 1)}`).toEqual([]);
    }
  });

  test("the layout holds from a 4K desktop down to a phone", async ({ page }) => {
    test.setTimeout(180_000);
    for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await openWorkspace(page, projectName!);

      const state = await page.evaluate(() => {
        const page_ = document.querySelector<HTMLElement>(".workspace-page")!;
        const offenders: string[] = [];
        // Nothing first-party may sit outside the viewport horizontally. The
        // film strips are scrollers by design and are read separately.
        for (const element of page_.querySelectorAll<HTMLElement>("*")) {
          if (element.closest(".clip-board, .beat-board, .workspace-media-list")) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.left < -1 || rect.right > window.innerWidth + 1) {
            offenders.push(`${element.tagName}.${String(element.className).slice(0, 30)} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
          }
        }
        // Counted from where the panels actually landed, not from the
        // declared track list: below 820px the grid is `display: block` and
        // Chromium still echoes the specified `grid-template-columns` there,
        // so reading the declaration reports three columns on a phone.
        const grid = document.querySelector<HTMLElement>(".workspace-grid")!;
        const visible = [...grid.querySelectorAll<HTMLElement>(":scope > .panel")]
          .filter((panel) => panel.getClientRects().length > 0)
          .map((panel) => panel.getBoundingClientRect());
        const firstRowTop = Math.min(...visible.map((rect) => rect.top));
        return {
          offenders: offenders.slice(0, 6),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          gridColumns: visible.filter((rect) => Math.abs(rect.top - firstRowTop) <= 1).length,
        };
      });

      expect(state.offenders, `${width}px: content outside the viewport`).toEqual([]);
      expect(state.overflow, `${width}px: the document scrolls horizontally`).toBeLessThanOrEqual(0);
      // Three columns on a desktop, two once the source rail is dropped, one
      // stacked column on a phone.
      const expectedColumns = width >= 1181 ? 3 : width >= 821 ? 2 : 1;
      expect(state.gridColumns, `${width}px: grid columns`).toBe(expectedColumns);
    }
  });
});
