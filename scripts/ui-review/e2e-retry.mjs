// Exercise the failure-recovery path and then the full run, through the UI.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const DIR = "test-artifacts/ui-review/e2e";
await mkdir(DIR, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [], netFailures = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) netFailures.push(`${r.status()} ${r.url().split("?")[0].slice(-60)}`); });
const shot = (n) => page.screenshot({ path: `${DIR}/${n}.png` });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

await page.goto(BASE); await page.waitForTimeout(2500);
await page.getByRole("button", { name: "Workspace", exact: true }).first().click();
await page.waitForTimeout(3000);
log("workspace:", (await page.locator(".topbar-context").innerText()).replace(/\n/g, " "));
await shot("10-stalled-state");
const strip = await page.locator(".failure-strip").innerText().catch(() => "(none)");
log("failure strip:", strip.replace(/\n/g, " | "));

const retry = page.getByRole("button", { name: /Retry import/ }).first();
if (await retry.count()) {
  log("clicking Retry import");
  await retry.click();
  await page.waitForTimeout(2000);
  await shot("11-after-retry");
} else { log("NO retry button found"); }

const deadline = Date.now() + 13 * 60 * 1000;
let last = "", shots = 0, terminal = null;
while (Date.now() < deadline) {
  const s = await page.evaluate(() => {
    const t = (q) => document.querySelector(q)?.innerText?.replace(/\s+/g, " ").trim() || null;
    return { badge: t(".workspace-commandbar .status"), strip: t(".job-strip"), proc: t(".processing-state"),
      steps: [...document.querySelectorAll(".checklist-step")].map((e) => (e.className.match(/status-(\w+)/)||[])[1] + ":" + (e.querySelector(".checklist-label")?.textContent||"")).join(", "),
      board: t(".board-header"), fail: t(".failure-strip"), notes: t(".notice-panel") };
  });
  const key = `${s.badge}||${s.strip}||${s.steps}`;
  if (key !== last) {
    last = key;
    log("STATE", s.badge, "|", s.strip);
    log("   steps:", s.steps);
    if (s.proc) log("   card:", s.proc.replace(/\n/g, " ").slice(0, 200));
    if (s.fail) log("   FAIL:", s.fail.replace(/\n/g, " ").slice(0, 200));
    if (shots < 10) await shot(`12-run-${String(++shots).padStart(2, "0")}`);
  }
  if (s.badge && /COMPLETE|FAILED|PARTIAL|CANCELLED/i.test(s.badge)) { terminal = s.badge; break; }
  await page.waitForTimeout(3000);
}
log("TERMINAL:", terminal);
await page.waitForTimeout(3000);
await shot("13-final");
log("board:", (await page.locator(".board-header").innerText().catch(() => "")).replace(/\n/g, " | "));
console.log("CONSOLE:", [...new Set(consoleErrors)].slice(0, 5));
console.log("API FAIL:", [...new Set(netFailures)].slice(0, 5));
await b.close();
