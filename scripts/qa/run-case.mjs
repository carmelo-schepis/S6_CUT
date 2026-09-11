/**
 * Drives one YouTube case end to end through the real UI at the nginx gateway.
 * Every setting is typed/clicked in the browser — nothing is posted to the API —
 * so a broken control fails the case rather than being bypassed.
 *
 * The ledger row is rewritten after every state change so a killed run resumes.
 *
 * Usage: node scripts/qa/run-case.mjs <artifact-dir> <case.json>
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const [artifactDir, caseFile] = process.argv.slice(2);
if (!artifactDir || !caseFile) throw new Error("usage: run-case.mjs <artifact-dir> <case.json>");
const spec = JSON.parse(await fs.readFile(caseFile, "utf8"));
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

const ledgerPath = path.join(artifactDir, "ledger", "cases.json");
async function ledgerWrite(row) {
  let rows = [];
  try { rows = JSON.parse(await fs.readFile(ledgerPath, "utf8")); } catch { rows = []; }
  const index = rows.findIndex((r) => r.case_id === row.case_id);
  if (index >= 0) rows[index] = { ...rows[index], ...row }; else rows.push(row);
  await fs.writeFile(ledgerPath, JSON.stringify(rows, null, 2));
}

const state = {
  case_id: spec.id, url: spec.url, settings: spec.settings, entry: spec.entry,
  project_id: null, job_id: null, clip_ids: [], state: "starting", attempts: 1,
  outcome: null, started_at: new Date().toISOString(), console_errors: [], http_errors: [],
};
await ledgerWrite(state);

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(artifactDir, "screenshots", `${spec.id}-${name}.png`), fullPage: true }).catch(() => undefined);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) state.console_errors.push(m.text()); });
page.on("pageerror", (e) => state.console_errors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) state.http_errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

// The create response is the only place the new project and job ids appear
// together; capturing it avoids guessing which record the UI just made.
page.on("response", async (r) => {
  if (r.request().method() !== "POST") return;
  if (!/\/api\/v1\/jobs\/(clip|shorts|shorts-source)$/.test(new URL(r.url()).pathname)) return;
  try {
    const body = await r.json();
    if (body.project?.id) state.project_id = body.project.id;
    if (body.job?.id) state.job_id = body.job.id;
    state.state = "submitted";
    await ledgerWrite(state);
  } catch { /* a non-JSON error body is surfaced by the UI assertions below */ }
});

async function rail(name) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(2_000);
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  if (spec.entry === "projects") {
    await rail("Projects");
    await page.getByRole("button", { name: "Clip mode", exact: true }).click();
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    await page.waitForTimeout(600);

    const urlField = page.getByRole("textbox", { name: /YouTube|URL/i }).first();
    await urlField.fill(spec.url);
    await shot(page, "01-url-entered");

    await page.getByRole("button", { name: new RegExp(`^${spec.settings.style}`, "i") }).first().click();
    await page.getByRole("button", { name: spec.settings.contentFormat === "long" ? "Long form · 16:9" : "Short form · 9:16", exact: true }).click();
    await page.getByRole("button", { name: spec.settings.mode, exact: true }).click();

    // Clip count is a stepper, so walk it from the current label to the target.
    for (let guard = 0; guard < 40; guard += 1) {
      const label = (await page.locator(".create-button").textContent()) || "";
      const current = Number(label.match(/(\d+)/)?.[1] || 0);
      if (current === spec.settings.count) break;
      await page.getByRole("button", { name: current < spec.settings.count ? "More clips" : "Fewer clips" }).click();
      await page.waitForTimeout(150);
    }

    const subtitles = page.getByRole("checkbox").first();
    if ((await subtitles.isChecked()) !== spec.settings.subtitles) await subtitles.click();

    if (spec.settings.aspect && spec.settings.aspect !== "9:16" && spec.settings.contentFormat !== "long") {
      await page.getByRole("button", { name: /Advanced controls/ }).click();
      await page.waitForTimeout(400);
      await page.getByLabel(/Aspect/i).first().selectOption(spec.settings.aspect);
    }

    await page.getByRole("textbox", { name: "Project name" }).fill(spec.name);
    await shot(page, "02-settings");

    state.state = "submitting";
    await ledgerWrite(state);
    await page.locator(".create-button").click();
  } else if (spec.entry === "shorts") {
    await rail("Shorts Editor");
    await page.getByRole("tab", { name: "YouTube", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("textbox", { name: /YouTube|URL/i }).first().fill(spec.url);
    await page.getByRole("spinbutton", { name: "Start seconds" }).first().fill(String(spec.settings.start));
    await page.getByRole("spinbutton", { name: "End seconds" }).first().fill(String(spec.settings.end));
    await shot(page, "01-source");
    const subtitles = page.getByRole("checkbox").first();
    if ((await subtitles.count()) && (await subtitles.isChecked()) !== spec.settings.subtitles) await subtitles.click();
    await shot(page, "02-settings");
    state.state = "submitting";
    await ledgerWrite(state);
    await page.getByRole("button", { name: "Queue short" }).click();
  }

  await page.waitForTimeout(6_000);
  await shot(page, "03-after-create");

  // Wait on the job through the API the UI itself polls, while keeping the
  // browser open so SSE/progress rendering is exercised for real.
  const deadline = Date.now() + (spec.timeoutMinutes || 60) * 60_000;
  let last = "";
  const progressLog = [];
  while (Date.now() < deadline) {
    if (!state.job_id) { await page.waitForTimeout(3_000); continue; }
    const job = await page.evaluate(async (id) => {
      const r = await fetch(`/api/v1/jobs/${id}`);
      if (!r.ok) return { error: r.status };
      return r.json();
    }, state.job_id);
    if (job.error) { await page.waitForTimeout(5_000); continue; }
    const line = `${job.state} | ${job.stage} | ${job.stageLabel} | ${Math.round((job.progress || 0) * 100)}% | clips=${(job.clips || []).length}` +
      (job.downloadProgress ? ` | dl=${job.downloadProgress.phase} ${job.downloadProgress.downloadedBytes || 0}/${job.downloadProgress.totalBytes || "?"} ${job.downloadProgress.percent ?? ""}%` : "");
    if (line !== last) {
      last = line;
      progressLog.push(`${new Date().toISOString()} ${line}`);
      console.log(line);
      await fs.writeFile(path.join(artifactDir, "logs", `${spec.id}-progress.log`), progressLog.join("\n"));
      state.state = job.state;
      state.clip_ids = (job.clips || []).map((c) => c.id);
      await ledgerWrite(state);
    }
    if (["complete", "failed", "partial", "cancelled_kept"].includes(job.state)) break;
    await page.waitForTimeout(5_000);
  }

  await shot(page, "04-final");
  const job = state.job_id ? await page.evaluate(async (id) => (await fetch(`/api/v1/jobs/${id}`)).json(), state.job_id) : null;
  state.state = job?.state || "unknown";
  state.outcome = job?.state === "complete" ? "job-complete" : `job-${job?.state || "unknown"}`;
  state.warnings = job?.warnings || [];
  state.clip_ids = (job?.clips || []).map((c) => c.id);
  state.finished_at = new Date().toISOString();
  await ledgerWrite(state);
  await fs.writeFile(path.join(artifactDir, "logs", `${spec.id}-job.json`), JSON.stringify(job, null, 2));
  console.log(JSON.stringify({ case: spec.id, project: state.project_id, job: state.job_id, state: state.state, clips: state.clip_ids.length, consoleErrors: state.console_errors.length, httpErrors: state.http_errors.length }, null, 2));
} catch (error) {
  state.state = "harness-error";
  state.outcome = String(error);
  await ledgerWrite(state);
  await shot(page, "99-error");
  console.error("CASE FAILED:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
