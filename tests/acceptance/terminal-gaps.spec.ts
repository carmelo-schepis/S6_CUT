import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const artifacts = path.join(root, "test-artifacts");
const projectName = "Codex Final Browser Retest 20260826T062538111Z";
const viewports = [
  ["desktop", 1440, 1000],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;

async function measure(page: Page, name: string, viewport: { width: number; height: number }) {
  const result = await page.evaluate(({ name, viewport }) => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll("button,input,select,textarea,a,[role=button],[role=dialog]")]
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
        if (rect.left >= -1 && rect.right <= innerWidth + 1) return [];
        return [{
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

test("terminal exact viewport, screenshot, and ZIP evidence", async ({ browser }) => {
  await fs.mkdir(artifacts, { recursive: true });
  const base = `http://100.108.250.42:8080/?terminal-responsive-retest=${new Date().toISOString()}`;
  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], failedRequests: [] as string[], measurements: [] as unknown[] };

  for (const [name, width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(message.text())) diagnostics.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
    page.on("requestfailed", (request) => { if (request.failure()?.errorText !== "net::ERR_ABORTED") diagnostics.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`); });

    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Make the first cut" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "projects", { width, height }));
    await assertFocusedControlVisible(page);
    await page.screenshot({ path: path.join(artifacts, `${name}-projects.png`), fullPage: true });

    await page.getByRole("button", { name: projectName, exact: false }).first().click();
    await page.waitForTimeout(400);
    diagnostics.measurements.push(await measure(page, "workspace", { width, height }));
    await open(page, "Shorts Editor");
    await expect(page.getByRole("heading", { name: "Shorts Editor" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "shorts-editor", { width, height }));
    await page.screenshot({ path: path.join(artifacts, `${name}-shorts-editor.png`), fullPage: true });
    await open(page, "AI Video");
    await expect(page.getByRole("heading", { name: "Topic to Video" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "ai-assistant", { width, height }));
    await open(page, "Jobs");
    await expect(page.getByRole("heading", { name: "Jobs & recovery" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "jobs", { width, height }));
    await open(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    diagnostics.measurements.push(await measure(page, "settings", { width, height }));
    if (name !== "desktop") await page.screenshot({ path: path.join(artifacts, `${name}-settings.png`), fullPage: true });
    await page.getByRole("button", { name: /New profile/ }).click();
    await expect(page.locator('input[type="password"]')).toHaveCount(2);
    diagnostics.measurements.push(await measure(page, "settings-dialog", { width, height }));
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Make the first cut" })).toBeVisible();
  await page.getByRole("button", { name: projectName, exact: false }).first().click();
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
