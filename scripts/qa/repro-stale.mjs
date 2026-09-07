// Customer flow: create a job, watch it finish, go back to Projects.
// The card must show the finished state, not the state at creation time.
import { chromium } from "@playwright/test";
import path from "node:path";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto(BASE); await page.waitForTimeout(3500);

const name = `QA stale-state ${Date.now()}`;
await page.getByRole("tab", { name: /Local file/ }).click();
await page.locator('input[aria-label="Choose video file"]').setInputFiles(path.resolve("test-video.mp4"));
await page.getByLabel("Project name").fill(name);
await page.getByRole("button", { name: "Fast", exact: true }).click();
for (let i = 0; i < 4; i += 1) await page.getByRole("button", { name: "Fewer clips" }).click();
console.log("creating:", await page.getByRole("button", { name: /Create 1 short clip/ }).innerText());
await page.getByRole("button", { name: /Create 1 short clip/ }).click();

// Wait for the workspace to report a terminal state.
const deadline = Date.now() + 180000;
let status = "";
while (Date.now() < deadline) {
  status = (await page.locator(".workspace-commandbar .status").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/ready|failed|complete|stopped|cancelled/i.test(status)) break;
  await page.waitForTimeout(1500);
}
console.log("workspace terminal status:", status);

// Now the customer goes back to Projects.
await page.getByRole("button", { name: "Projects", exact: true }).first().click();
for (const wait of [1000, 3000, 5000, 8000, 12000]) {
  await page.waitForTimeout(wait === 1000 ? 1000 : 3000);
  const card = await page.locator(".project-card").filter({ hasText: name }).innerText().catch(() => "(card not found)");
  const bar = await page.locator(".project-card").filter({ hasText: name }).locator(".progress-wrap").getAttribute("aria-label").catch(() => "(none)");
  console.log(`after ~${wait}ms: card="${card.replace(/\n/g, " | ")}" progress="${bar}"`);
}
await page.screenshot({ path: "test-artifacts/qa/repro-stale.png" });
await b.close();
