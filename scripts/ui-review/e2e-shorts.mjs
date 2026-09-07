// Real YouTube -> Shorts run driven entirely through the UI.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const URL = process.env.TEST_URL || "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const NAME = process.env.TEST_NAME || "UI review — YouTube shorts test";
const DIR = "test-artifacts/ui-review/e2e";
await mkdir(DIR, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [], netFailures = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) netFailures.push(`${r.status()} ${r.url().split("?")[0].slice(-70)}`); });

const shot = (n) => page.screenshot({ path: `${DIR}/${n}.png` });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

await page.goto(BASE); await page.waitForTimeout(2000);
await page.getByRole("button", { name: "Projects", exact: true }).first().click();
await page.waitForTimeout(1200);

// 1. YouTube source
await page.getByRole("tab", { name: /YouTube/ }).click();
await page.getByLabel("YouTube URL").fill(URL);
// 2. Short form 9:16 (explicit)
await page.getByRole("button", { name: /Short form · 9:16/ }).click();
// 3. Style
await page.getByRole("button", { name: /Educational/ }).click();
// 4. One clip
for (let i = 0; i < 4; i += 1) await page.getByRole("button", { name: "Fewer clips" }).click();
// 5. Fast local mode — deterministic, no provider needed
await page.getByRole("button", { name: "Fast", exact: true }).click();
// 6. Name
await page.getByLabel("Project name").fill(NAME);
// 7. Advanced: allow a short source
await page.getByRole("button", { name: /Advanced controls/ }).click();
await page.getByLabel("Minimum seconds").fill("8");
await page.getByLabel("Maximum seconds").fill("20");
await shot("01-form-filled");
log("form filled:", await page.getByRole("button", { name: /^Create 1 short clip$/ }).innerText());

// 8. Submit
await page.getByRole("button", { name: /^Create 1 short clip$/ }).click();
await page.waitForTimeout(2500);
await shot("02-submitted");
log("submitted, page:", (await page.locator(".topbar-context").innerText()).replace(/\n/g, " "));

// 9. Watch the progress UI, capturing coherence samples.
const seen = [];
const deadline = Date.now() + 12 * 60 * 1000;
let shots = 0, terminal = null;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => {
    const t = (s) => document.querySelector(s)?.innerText?.replace(/\s+/g, " ").trim() || null;
    const badge = t(".workspace-commandbar .status");
    return {
      badge,
      strip: t(".job-strip"),
      steps: [...document.querySelectorAll(".checklist-step")].map((el) => el.className.replace("checklist-step ", "") + ":" + (el.querySelector(".checklist-label")?.textContent || "")),
      notes: t(".notice-panel"),
      processing: t(".processing-state"),
      board: t(".board-header"),
      failure: t(".failure-strip"),
    };
  });
  const key = JSON.stringify([state.badge, state.strip, state.steps.join("|")]);
  if (!seen.length || seen[seen.length - 1] !== key) {
    seen.push(key);
    log("STATE", state.badge, "|", state.strip, "|", state.board);
    if (state.notes) log("   notes:", state.notes.replace(/\n/g, " ").slice(0, 160));
    if (state.failure) log("   FAILURE:", state.failure.replace(/\n/g, " ").slice(0, 200));
    if (shots < 8) { await shot(`03-progress-${String(++shots).padStart(2, "0")}`); }
  }
  if (state.badge && /COMPLETE|FAILED|PARTIAL|STOPPED/i.test(state.badge)) { terminal = state.badge; break; }
  await page.waitForTimeout(3000);
}
log("terminal:", terminal);
await page.waitForTimeout(2500);
await shot("04-terminal");

// 10. Exercise the result: clip tile, details tabs, preview.
const board = await page.locator(".board-header").innerText().catch(() => "");
log("board:", board.replace(/\n/g, " | "));
const tile = page.locator(".clip-tile").first();
if (await tile.count()) {
  await tile.click(); await page.waitForTimeout(1500);
  for (const tab of ["score", "captions", "asset", "info"]) {
    await page.getByRole("button", { name: tab, exact: true }).click().catch(() => {});
    await page.waitForTimeout(700);
    await shot(`05-tab-${tab}`);
    log(`tab ${tab}:`, (await page.locator(".inspector-content").innerText()).replace(/\s+/g, " ").slice(0, 130));
  }
  const media = await page.evaluate(() => {
    const v = document.querySelector(".viewer-frame video");
    return v ? { src: v.getAttribute("src")?.split("?")[0], readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight } : null;
  });
  log("preview media:", JSON.stringify(media));
  const dl = page.locator('.clip-tile a[download]').first();
  log("download link:", await dl.count() ? (await dl.getAttribute("href"))?.split("?")[0] : "none");
}
await shot("06-final");
console.log("CONSOLE ERRORS:", [...new Set(consoleErrors)].slice(0, 6));
console.log("API FAILURES:", [...new Set(netFailures)].slice(0, 6));
await b.close();
