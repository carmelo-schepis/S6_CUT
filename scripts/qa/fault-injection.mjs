/**
 * Cross-cutting resilience checks that need the engine taken away underneath a
 * live browser session:
 *   1. Engine offline  -> the shell must say so and offer a way back.
 *   2. Engine restored -> the alert clears without a manual reload.
 *   3. Restart survival -> a completed job stays accessible on the mounted
 *      data path after the container is recreated.
 *
 * Only stop/start of the engine service is used; no data is touched.
 *
 * Usage: node scripts/qa/fault-injection.mjs <artifact-dir>
 */
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const artifactDir = process.argv[2];
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";
const compose = (...args) => run("docker", ["compose", ...args], {
  cwd: "/Users/dummy/Documents/S6_CUT",
  env: { ...process.env, DOCKER_HOST: `unix://${process.env.HOME}/.docker/run/docker.sock`, PATH: `/usr/local/bin:${process.env.PATH}` },
  maxBuffer: 10 * 1024 * 1024,
});

const report = { steps: [] };
const note = (name, detail) => { report.steps.push({ name, detail, at: new Date().toISOString() }); console.log(`${name}: ${detail}`); };

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  // Record a completed job to re-check after the restart.
  const before = await page.evaluate(async () => {
    const jobs = await (await fetch("/api/v1/jobs")).json();
    const done = jobs.filter((j) => j.state === "complete" && (j.clips || []).some((c) => c.state === "complete"));
    return done.length ? { id: done[0].id, clips: done[0].clips.length } : null;
  });
  note("baseline", `tracking completed job ${before?.id?.slice(0, 8)} with ${before?.clips} clip(s)`);

  // --- 1. engine offline --------------------------------------------------
  await compose("stop", "engine");
  note("engine stopped", "docker compose stop engine");
  await page.getByRole("button", { name: "Projects", exact: true }).first().click();
  await page.waitForTimeout(12_000);
  const offlineText = (await page.locator("body").textContent()) || "";
  report.offlineBannerSeen = /engine offline|cannot reach|unreachable|retry|reconnect/i.test(offlineText);
  report.retryControlSeen = await page.getByRole("button", { name: /Retry|Reconnect/i }).count() > 0;
  await page.screenshot({ path: path.join(artifactDir, "screenshots", "fault-01-engine-offline.png"), fullPage: true });
  note("offline surface", `banner=${report.offlineBannerSeen} retryControl=${report.retryControlSeen}`);

  // --- 2. engine restored -------------------------------------------------
  await compose("start", "engine");
  note("engine started", "docker compose start engine");
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i += 1) {
    await page.waitForTimeout(5_000);
    healthy = await page.evaluate(async () => {
      try { return (await fetch("/api/health")).ok; } catch { return false; }
    });
  }
  note("engine health", healthy ? "gateway reports ready again" : "engine did not return in time");

  const retry = page.getByRole("button", { name: /Retry|Reconnect/i }).first();
  if (await retry.count()) await retry.click();
  await page.waitForTimeout(10_000);
  const recoveredText = (await page.locator("body").textContent()) || "";
  report.alertClearedWithoutReload = !/engine offline|cannot reach|unreachable/i.test(recoveredText);
  await page.screenshot({ path: path.join(artifactDir, "screenshots", "fault-02-engine-restored.png"), fullPage: true });
  note("recovery", `alertCleared=${report.alertClearedWithoutReload}`);

  // --- 3. completed job survives a container recreate ---------------------
  await compose("up", "-d", "--force-recreate", "engine");
  note("engine recreated", "docker compose up -d --force-recreate engine");
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(5_000);
    const ok = await page.evaluate(async () => { try { return (await fetch("/api/health")).ok; } catch { return false; } });
    if (ok) break;
  }
  const after = before ? await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/jobs/${id}`);
    if (!r.ok) return { error: r.status };
    const j = await r.json();
    return { id: j.id, state: j.state, clips: (j.clips || []).filter((c) => c.state === "complete").length };
  }, before.id) : null;
  report.jobBefore = before;
  report.jobAfter = after;
  report.jobSurvivedRestart = Boolean(after && !after.error && after.state === "complete" && after.clips === before.clips);
  note("restart survival", JSON.stringify(after));

  report.verdict = (report.offlineBannerSeen || report.retryControlSeen)
    && report.alertClearedWithoutReload && report.jobSurvivedRestart ? "PASS" : "REVIEW";
} catch (error) {
  report.verdict = "ERROR";
  report.error = String(error);
  console.error(error);
} finally {
  await fs.writeFile(path.join(artifactDir, "logs", "fault-injection.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, offlineBannerSeen: report.offlineBannerSeen, retryControlSeen: report.retryControlSeen, alertClearedWithoutReload: report.alertClearedWithoutReload, jobSurvivedRestart: report.jobSurvivedRestart }, null, 2));
  await browser.close();
}
