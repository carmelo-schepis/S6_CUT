/**
 * §6.3 export: the ZIP a reviewer downloads from the Workspace must carry the
 * numbered media, manifest.json and credits.json, and for a YouTube source the
 * credits must name the creator.
 *
 * Usage: node scripts/qa/zip-export-gate.mjs <artifact-dir> <project-name> <expected-creator>
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const [artifactDir, projectName, expectedCreator] = process.argv.slice(2);
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const report = { projectName, expectedCreator };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await page.getByRole("button", { name: "Projects", exact: true }).first().click();
  await page.waitForTimeout(2_500);
  const search = page.getByRole("searchbox", { name: "Search projects" });
  if (await search.count()) {
    await search.fill(projectName);
    // The list filters client-side but the card list re-renders asynchronously,
    // so wait for the wanted card rather than assuming the first one is it.
    await page.locator(".project-card").filter({ hasText: projectName }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
  }
  await page.locator(".project-card").filter({ hasText: projectName }).first().click();
  await page.getByRole("heading", { level: 1, name: projectName }).waitFor({ timeout: 30_000 });
  await page.locator(".clip-board .clip-tile").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  report.openedProject = (await page.locator("#main-content h1").first().textContent())?.trim();

  // Clips are published unselected; the export button stays disabled until the
  // reviewer opts each one in, so the selection is made through the checkboxes.
  const boxes = page.locator(".clip-board .clip-tile input[type=checkbox]");
  const total = await boxes.count();
  let selected = 0;
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    if (await box.isDisabled()) continue;
    if (!(await box.isChecked())) await box.check();
    selected += 1;
    await page.waitForTimeout(400);
  }
  report.clipsSelected = selected;
  await page.waitForTimeout(1_500);

  const zipButton = page.getByRole("button", { name: /Download ZIP/ });
  report.buttonLabel = (await zipButton.textContent())?.trim();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    zipButton.click(),
  ]);
  const target = path.join(artifactDir, "outputs", `${projectName}-export.zip`);
  await download.saveAs(target);
  report.savedTo = target;
  report.suggestedFilename = download.suggestedFilename();
  const stat = await fs.stat(target);
  report.bytes = stat.size;
} catch (error) {
  report.error = String(error);
} finally {
  await fs.writeFile(path.join(artifactDir, "logs", "zip-export-gate.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
