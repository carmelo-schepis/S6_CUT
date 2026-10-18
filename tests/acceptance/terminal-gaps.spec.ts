import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspaceForProject } from "./support/workspace";

const root = process.cwd();
const gateway = process.env.S6_ACCEPTANCE_URL || "http://localhost:8080";
const artifacts = path.join(root, "test-artifacts");
/**
 * The project this walkthrough opens.
 *
 * This used to name one specific project created by a one-off manual session in
 * August 2026. That project is long gone, so the test could never pass again on
 * any dataset. It now takes whatever completed project the instance actually
 * has — the walkthrough is about viewport geometry, screenshots and the export
 * ZIP, not about one particular project — and skips cleanly when there is none
 * to open, the same way the FFmpeg-gated tests skip when the tools are absent.
 */
async function findCompletedProject(request: APIRequestContext): Promise<string | null> {
  const projectsResponse = await request.get(`${gateway}/api/v1/projects`);
  if (!projectsResponse.ok()) return null;
  const projects = await projectsResponse.json() as { id: string; name: string }[];
  const jobsResponse = await request.get(`${gateway}/api/v1/jobs`);
  if (!jobsResponse.ok()) return null;
  const jobs = await jobsResponse.json() as { projectId: string; state: string; clips?: { state: string }[] }[];
  const exportable = new Set(jobs
    .filter((job) => job.state === "complete" && (job.clips ?? []).some((clip) => clip.state === "complete"))
    .map((job) => job.projectId));
  return projects.find((project) => exportable.has(project.id))?.name ?? null;
}
const viewports = [
  ["desktop", 1440, 1000],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;

async function measure(page: Page, name: string, viewport: { width: number; height: number }) {
  const result = await page.evaluate(({ name, viewport }) => {
    const root = document.documentElement;
    /**
     * The nearest ancestor that scrolls horizontally on purpose.
     *
     * The clip board is a film strip (`overflow-x: auto`): with enough clips its
     * later tiles sit beyond the right edge by design, and the user reaches them
     * by scrolling the strip. Those controls are not "off screen" in the sense
     * this check guards against — that sense is a control pushed out by page
     * layout, which the `scrollWidth`/`bodyScrollWidth` assertions below still
     * cover for the document itself.
     */
    const horizontalScroller = (element: Element): HTMLElement | null => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 1) return node;
      }
      return null;
    };
    const offenders = [...document.querySelectorAll("button,input,select,textarea,a,[role=button],[role=dialog]")]
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
        if (rect.left >= -1 && rect.right <= innerWidth + 1) return [];
        const scroller = horizontalScroller(element);
        if (scroller) {
          // Reachable only if the strip itself is on screen and the control lies
          // inside the strip's scrollable content.
          const box = scroller.getBoundingClientRect();
          const offsetLeft = rect.left - box.left + scroller.scrollLeft;
          const stripOnScreen = box.left >= -1 && box.right <= innerWidth + 1;
          const insideContent = offsetLeft >= -1 && offsetLeft + rect.width <= scroller.scrollWidth + 1;
          if (stripOnScreen && insideContent) return [];
        }
        return [{
          scroller: scroller ? scroller.className : null,
          description: (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 120),
          tag: element.tagName,
          className: element.className,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          computed: { width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth, overflow: style.overflowX },
          containingWidth: element.parentElement?.getBoundingClientRect().width,
        }];
      });
    return {
      name,
      viewport,
      innerWidth,
      innerHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      scrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      devicePixelRatio,
      offenders,
    };
  }, { name, viewport });
  expect(result.innerWidth).toBe(viewport.width);
  expect(result.innerHeight).toBe(viewport.height);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
  expect(result.bodyScrollWidth).toBeLessThanOrEqual(viewport.width);
  expect(result.offenders).toEqual([]);
  return result;
}

async function open(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(250);
}

async function assertFocusedControlVisible(page: Page) {
  await page.getByRole("button", { name: "Projects", exact: true }).focus();
  expect(await page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBeTruthy();
}

async function openProjectByName(page: Page, name: string) {
  await openWorkspaceForProject(page, name);
}

test("terminal exact viewport, screenshot, and ZIP evidence", async ({ browser, request }) => {
  await fs.mkdir(artifacts, { recursive: true });
  const projectName = await findCompletedProject(request);
  test.skip(!projectName, "no completed project with an exportable clip is present on this instance");
  const base = `${process.env.S6_ACCEPTANCE_URL || "http://localhost:8080"}/?terminal-responsive-retest=${new Date().toISOString()}`;
  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], failedRequests: [] as string[], measurements: [] as unknown[] };

  for (const [name, width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(message.text())) diagnostics.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
    page.on("requestfailed", (request) => { if (request.failure()?.errorText !== "net::ERR_ABORTED") diagnostics.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`); });

    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "projects", { width, height }));
    await assertFocusedControlVisible(page);
    await page.screenshot({ path: path.join(artifacts, `${name}-projects.png`), fullPage: true });

    await openProjectByName(page, projectName!);
    await page.waitForTimeout(400);
    diagnostics.measurements.push(await measure(page, "workspace", { width, height }));
    await open(page, "Shorts Editor");
    await expect(page.getByRole("heading", { name: "Editor" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "shorts-editor", { width, height }));
    await page.screenshot({ path: path.join(artifacts, `${name}-shorts-editor.png`), fullPage: true });
    await open(page, "Jobs");
    await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "jobs", { width, height }));
    await open(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "settings", { width, height }));
    if (name !== "desktop") await page.screenshot({ path: path.join(artifacts, `${name}-settings.png`), fullPage: true });
    await page.getByRole("button", { name: /New profile/ }).click();
    // One secret field: the OpenRouter key. The second key input belonged to
    // ElevenLabs, retired when text and speech moved to OpenRouter (aad9837).
    await expect(page.locator('input[type="password"]')).toHaveCount(1);
    diagnostics.measurements.push(await measure(page, "settings-dialog", { width, height }));
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await openProjectByName(page, projectName!);
  const downloadButton = page.getByRole("button", { name: /Download ZIP/ }).first();
  await expect(downloadButton).toBeEnabled();
  const downloadWait = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadWait;
  const filename = download.suggestedFilename();
  const zipPath = path.join(artifacts, filename);
  await download.saveAs(zipPath);
  const stat = await fs.stat(zipPath);
  expect(stat.size).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(artifacts, "export-ready.png"), fullPage: true });
  await fs.writeFile(path.join(artifacts, "zip-download-evidence.json"), JSON.stringify({ filename, bytes: stat.size, failure: await download.failure() }, null, 2));
  await fs.writeFile(path.join(artifacts, "terminal-responsive-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.failedRequests).toEqual([]);
  await context.close();
});
