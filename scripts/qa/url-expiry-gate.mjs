/**
 * §5.11: S6_MEDIA_URL_TTL_SECONDS is 900, and a real editing session idles past
 * that. After the signed preview link has expired, pressing Play must either
 * recover on its own or offer a visible way back — never leave a dead player.
 *
 * Usage: node scripts/qa/url-expiry-gate.mjs <artifact-dir> [idle-seconds]
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const artifactDir = process.argv[2];
const idleSeconds = Number(process.argv[3] || 960);
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

const report = { idleSeconds, startedAt: new Date().toISOString() };
const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
const mediaResponses = [];
page.on("response", (r) => {
  const url = new URL(r.url());
  if (/\/api\/v1\/(library\/assets|jobs)\//.test(url.pathname) && url.searchParams.has("signature")) {
    mediaResponses.push({ status: r.status(), path: url.pathname, at: new Date().toISOString() });
  }
});

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content", { timeout: 30_000 });
  await page.waitForTimeout(4_000);
  // Open a project that already has finished clips: the Workspace otherwise
  // lands on the most recent project, which may still be rendering.
  const projectName = process.argv[4];
  await page.getByRole("button", { name: "Projects", exact: true }).first().click();
  await page.waitForTimeout(2_500);
  if (projectName) {
    const search = page.getByRole("searchbox", { name: "Search projects" });
    if (await search.count()) { await search.fill(projectName); await page.waitForTimeout(1_500); }
  }
  await page.locator(".project-card").first().click();
  await page.waitForTimeout(3_000);
  await page.getByRole("button", { name: "Preview", exact: true }).first().click();
  await page.waitForSelector(".viewer-frame video", { timeout: 30_000 });
  await page.waitForTimeout(3_000);

  report.initialSrc = await page.locator(".viewer-frame video").getAttribute("src");
  report.initialExpiry = Number(new URL(report.initialSrc, base).searchParams.get("expires")) || null;
  report.nowEpoch = Math.floor(Date.now() / 1000);
  await page.screenshot({ path: path.join(artifactDir, "screenshots", "expiry-01-before-idle.png") });

  // Idle deliberately: no clicks, no navigation — exactly what a reviewer does
  // while a long render finishes in another tab.
  const deadline = Date.now() + idleSeconds * 1000;
  while (Date.now() < deadline) await page.waitForTimeout(15_000);

  report.idledUntil = new Date().toISOString();
  report.linkExpiredDuringIdle = report.initialExpiry ? Math.floor(Date.now() / 1000) > report.initialExpiry : null;

  // Force a fresh fetch of the media the same way a viewer would: reload the
  // element and press play.
  const before = await page.locator(".viewer-frame video").evaluate((v) => ({ src: v.currentSrc, err: v.error?.code || null }));
  await page.locator(".play-button").click();
  await page.waitForTimeout(6_000);

  const after = await page.locator(".viewer-frame video").evaluate((v) => ({
    src: v.currentSrc, readyState: v.readyState, paused: v.paused, t: v.currentTime, err: v.error?.message || null,
  }));
  report.beforePlay = before;
  report.afterPlay = after;
  report.retryPreviewVisible = await page.getByRole("button", { name: /Retry preview|Retry playback|Play muted/ }).count() > 0;
  await page.screenshot({ path: path.join(artifactDir, "screenshots", "expiry-02-after-play.png") });

  if (report.retryPreviewVisible) {
    await page.getByRole("button", { name: /Retry preview/ }).first().click();
    await page.waitForTimeout(5_000);
    report.afterRetry = await page.locator(".viewer-frame video").evaluate((v) => ({
      src: v.currentSrc, readyState: v.readyState, t: v.currentTime, err: v.error?.message || null,
    }));
    await page.screenshot({ path: path.join(artifactDir, "screenshots", "expiry-03-after-retry.png") });
  }

  const recovered = (after.readyState >= 3 && !after.err) || report.retryPreviewVisible
    || (report.afterRetry && report.afterRetry.readyState >= 3);
  report.verdict = recovered ? "PASS" : "FAIL";
  report.signedResponses = mediaResponses.slice(-10);
} catch (error) {
  report.verdict = "ERROR";
  report.error = String(error);
} finally {
  await fs.writeFile(path.join(artifactDir, "logs", "url-expiry-gate.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
