/**
 * The §5.10 browser-side content gate: disk validity is not enough, the stream
 * served through nginx must actually decode and advance in the page. Runs the
 * same probe against all three players — the Workspace viewer, the Library
 * preview dialog, and the Shorts Editor clip browser — so one working player
 * cannot stand in for the other two.
 *
 * Usage: node scripts/qa/browser-gate.mjs <artifact-dir> <case-id> <project-name>
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const [artifactDir, caseId, projectName] = process.argv.slice(2);
if (!artifactDir || !caseId || !projectName) throw new Error("usage: browser-gate.mjs <artifact-dir> <case-id> <project-name>");
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

/** Plays the element and reports whether real, changing frames reach the canvas. */
const PROBE = async (selector) => {
  const v = document.querySelector(selector);
  if (!v) return { error: "no video element for " + selector };
  v.muted = true;
  try { await v.play(); } catch (e) { return { error: "play rejected: " + e.message }; }
  const snap = () => {
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, 160, 90);
    return ctx.getImageData(0, 0, 160, 90).data;
  };
  await new Promise((r) => setTimeout(r, 1200));
  const t0 = v.currentTime;
  let a;
  try { a = snap(); } catch (e) { return { error: "getImageData threw (tainted canvas): " + e.message }; }
  await new Promise((r) => setTimeout(r, 3000));
  const t1 = v.currentTime, b = snap();
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
  return {
    readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
    advanced: +(t1 - t0).toFixed(3), meanDiff: +(diff / (a.length / 4)).toFixed(3),
    err: v.error?.message || null,
  };
};

const verdict = (r) => (!r.error && r.readyState >= 3 && r.advanced >= 1.5 && r.meanDiff >= 3.0 && !r.err ? "PASS" : "FAIL");

const report = { case: caseId, project: projectName, surfaces: {}, consoleErrors: [], httpErrors: [] };
const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) report.consoleErrors.push(m.text()); });
page.on("pageerror", (e) => report.consoleErrors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) report.httpErrors.push(`${r.status()} ${new URL(r.url()).pathname}`); });

const rail = async (name) => { await page.getByRole("button", { name, exact: true }).first().click(); await page.waitForTimeout(2500); };

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4000);

  // --- Workspace viewer -----------------------------------------------------
  await rail("Projects");
  const search = page.getByRole("searchbox", { name: "Search projects" });
  if (await search.count()) { await search.fill(projectName); await page.waitForTimeout(1200); }
  await page.locator(".project-card").first().click();
  await page.waitForTimeout(3000);

  const tiles = page.locator(".clip-board .clip-tile");
  const count = await tiles.count();
  report.surfaces.workspace = [];
  for (let i = 0; i < count; i += 1) {
    const preview = tiles.nth(i).getByRole("button", { name: "Preview", exact: true });
    if (!(await preview.count())) continue;
    await preview.click();
    await page.waitForTimeout(2500);
    const result = await page.evaluate(PROBE, ".viewer-frame video");
    result.clip = i + 1;
    result.verdict = verdict(result);
    report.surfaces.workspace.push(result);
    await page.screenshot({ path: path.join(artifactDir, "screenshots", `${caseId}-workspace-clip${i + 1}.png`) });
  }

  // --- Library preview dialog ----------------------------------------------
  await rail("Library");
  await page.getByLabel("Search media").fill(projectName);
  await page.waitForTimeout(2000);
  const trigger = page.locator(".asset-preview-trigger").first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForSelector(".video-preview-dialog video", { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const result = await page.evaluate(PROBE, ".video-preview-dialog video");
    result.verdict = verdict(result);
    report.surfaces.libraryDialog = result;
    await page.screenshot({ path: path.join(artifactDir, "screenshots", `${caseId}-library-dialog.png`) });
    await page.keyboard.press("Escape");
  } else {
    report.surfaces.libraryDialog = { error: "no previewable Library asset matched the project name" };
  }

  // --- Shorts Editor clip browser ------------------------------------------
  await rail("Shorts Editor");
  const row = page.locator(".clip-browser-item").filter({ hasText: projectName }).first();
  if (await row.count()) {
    await row.locator(".clip-select-button").click();
    await page.waitForTimeout(3000);
    const result = await page.evaluate(PROBE, ".shorts-video-frame video");
    result.verdict = verdict(result);
    report.surfaces.shortsEditor = result;
    await page.screenshot({ path: path.join(artifactDir, "screenshots", `${caseId}-shorts-preview.png`) });
  } else {
    report.surfaces.shortsEditor = { error: "clip row not found in the Shorts Editor browser" };
  }
} catch (error) {
  report.error = String(error);
} finally {
  await fs.writeFile(path.join(artifactDir, "media-validation", caseId, "browser-gate.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
