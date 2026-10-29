import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:8080";
const TARGET = "Final Browser Retest 20260826T062538111Z";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE); await page.waitForTimeout(3500);
await page.getByLabel("Search projects").fill(TARGET);
await page.waitForTimeout(1200);
await page.locator(".project-card").filter({ hasText: TARGET }).first().click();
await page.waitForTimeout(6000);
console.log("overlay on arrival (no interaction):", await page.locator(".viewer-error").count());
// Force the stall the way the earlier probe did.
await page.evaluate(async () => { const v = document.querySelector(".viewer-frame video"); await v?.play().catch(() => {}); });
await page.waitForTimeout(4000);
console.log("overlay after a stalled play:", await page.locator(".viewer-error").count());
const muted = page.getByRole("button", { name: "Play muted" });
if (await muted.count()) {
  await muted.click();
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => { const v = document.querySelector(".viewer-frame video"); return { t: v.currentTime, paused: v.paused, muted: v.muted }; });
  console.log("after 'Play muted':", JSON.stringify(state), "overlay now:", await page.locator(".viewer-error").count());
}
await page.screenshot({ path: "test-artifacts/qa/stall-recovery.png" });
await b.close();
