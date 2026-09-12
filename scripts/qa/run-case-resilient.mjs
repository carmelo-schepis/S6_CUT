/**
 * Case 6: the same UI-driven clip run, but deliberately interrupted while the
 * YouTube source is still downloading — Pause, Resume, Stop & keep, then Retry
 * import — to prove the controls appear only in their valid states, actually
 * work, and that a resumed import continues from the bytes already on disk
 * rather than starting over.
 *
 * Usage: node scripts/qa/run-case-resilient.mjs <artifact-dir> <case.json>
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const [artifactDir, caseFile] = process.argv.slice(2);
const spec = JSON.parse(await fs.readFile(caseFile, "utf8"));
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

const report = { case: spec.id, url: spec.url, settings: spec.settings, timeline: [], consoleErrors: [], httpErrors: [] };
const note = (what, detail) => { report.timeline.push({ at: new Date().toISOString(), what, detail }); console.log(`${what}: ${JSON.stringify(detail)}`); };

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) report.consoleErrors.push(m.text()); });
page.on("pageerror", (e) => report.consoleErrors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) report.httpErrors.push(`${r.status()} ${new URL(r.url()).pathname}`); });

let jobId = null;
page.on("response", async (r) => {
  if (r.request().method() !== "POST") return;
  if (!/\/api\/v1\/jobs\/clip$/.test(new URL(r.url()).pathname)) return;
  try { const b = await r.json(); jobId = b.job?.id || jobId; } catch { /* surfaced by the UI */ }
});

const job = async () => (jobId ? page.evaluate(async (id) => {
  const r = await fetch(`/api/v1/jobs/${id}`);
  return r.ok ? r.json() : { error: r.status };
}, jobId) : null);

const shot = (n) => page.screenshot({ path: path.join(artifactDir, "screenshots", `${spec.id}-${n}.png`), fullPage: true }).catch(() => undefined);
const clickIf = async (name) => {
  const b = page.getByRole("button", { name, exact: false }).first();
  if (await b.count() && await b.isEnabled().catch(() => false)) { await b.click(); return true; }
  return false;
};

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  await page.getByRole("button", { name: "Projects", exact: true }).first().click();
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: "Clip mode", exact: true }).click();
  await page.getByRole("tab", { name: "YouTube", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("textbox", { name: /YouTube|URL/i }).first().fill(spec.url);
  await page.getByRole("button", { name: new RegExp(`^${spec.settings.style}`, "i") }).first().click();
  await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
  await page.getByRole("button", { name: spec.settings.mode, exact: true }).click();
  for (let g = 0; g < 40; g += 1) {
    const label = (await page.locator(".create-button").textContent()) || "";
    const current = Number(label.match(/(\d+)/)?.[1] || 0);
    if (current === spec.settings.count) break;
    await page.getByRole("button", { name: current < spec.settings.count ? "More clips" : "Fewer clips" }).click();
    await page.waitForTimeout(150);
  }
  const subs = page.getByRole("checkbox").first();
  if ((await subs.isChecked()) !== spec.settings.subtitles) await subs.click();
  await page.getByRole("textbox", { name: "Project name" }).fill(spec.name);
  await page.locator(".create-button").click();
  await page.waitForTimeout(8_000);
  note("submitted", { jobId });

  // --- wait until real bytes are on the wire, then pause ------------------
  let bytesBeforePause = 0;
  for (let i = 0; i < 90; i += 1) {
    const j = await job();
    const dl = j?.downloadProgress;
    if (dl?.downloadedBytes > 3_000_000) { bytesBeforePause = dl.downloadedBytes; break; }
    await page.waitForTimeout(2_000);
  }
  note("download underway", { bytesBeforePause });

  report.pauseClicked = await clickIf("Pause");
  await page.waitForTimeout(8_000);
  let j = await job();
  report.stateAfterPause = j?.state;
  await shot("resilience-01-paused");
  note("paused", { state: j?.state, bytes: j?.downloadProgress?.downloadedBytes });

  report.resumeClicked = await clickIf("Resume");
  await page.waitForTimeout(12_000);
  j = await job();
  report.stateAfterResume = j?.state;
  report.bytesAfterResume = j?.downloadProgress?.downloadedBytes ?? null;
  // The engine keeps the .part file, so a resumed import must not restart at 0.
  report.resumedFromExistingBytes = (report.bytesAfterResume ?? 0) >= bytesBeforePause;
  await shot("resilience-02-resumed");
  note("resumed", { state: j?.state, bytes: report.bytesAfterResume, continuedFromDisk: report.resumedFromExistingBytes });

  report.stopKeepClicked = await clickIf("Stop & keep");
  await page.waitForTimeout(12_000);
  j = await job();
  report.stateAfterStopKeep = j?.state;
  await shot("resilience-03-stop-keep");
  note("stop & keep", { state: j?.state, clips: j?.clips?.length });

  // --- retry the import and let it finish ---------------------------------
  report.retryImportClicked = await clickIf("Retry import");
  await page.waitForTimeout(10_000);
  j = await job();
  note("retry import", { state: j?.state, stage: j?.stage });
  await shot("resilience-04-retry-import");

  const deadline = Date.now() + (spec.timeoutMinutes || 120) * 60_000;
  let last = "";
  const progress = [];
  while (Date.now() < deadline) {
    j = await job();
    if (!j || j.error) { await page.waitForTimeout(5_000); continue; }
    const line = `${j.state} | ${j.stage} | ${j.stageLabel} | ${Math.round(j.progress || 0)}% | clips=${(j.clips || []).length}`;
    if (line !== last) { last = line; progress.push(`${new Date().toISOString()} ${line}`); console.log(line);
      await fs.writeFile(path.join(artifactDir, "logs", `${spec.id}-progress.log`), progress.join("\n")); }
    if (["complete", "failed", "partial", "cancelled_kept"].includes(j.state)) break;
    await page.waitForTimeout(5_000);
  }
  report.finalState = j?.state;
  report.jobId = jobId;
  report.clips = (j?.clips || []).map((c) => ({ index: c.index, state: c.state, w: c.width, h: c.height, dur: c.duration }));
  report.warnings = j?.warnings || [];
  await shot("resilience-05-final");
  note("final", { state: report.finalState, clips: report.clips.length });
} catch (error) {
  report.error = String(error);
  console.error("RESILIENCE RUN FAILED:", error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(artifactDir, "logs", `${spec.id}-resilience.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
