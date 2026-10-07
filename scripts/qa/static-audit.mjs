/**
 * Static audit pass: walks every rail destination against the live Docker
 * gateway and dumps the control inventory plus every console/network error.
 * No jobs are queued — this is the cheap pass that runs before the render
 * matrix so a dead control cannot corrupt a case result.
 *
 * Usage: node scripts/qa/static-audit.mjs <artifact-dir> [viewport]
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const artifactDir = process.argv[2];
if (!artifactDir) throw new Error("usage: static-audit.mjs <artifact-dir> [WxH]");
const [vw, vh] = (process.argv[3] || "1440x1000").split("x").map(Number);
const label = `${vw}x${vh}`;
const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

const RAIL = ["Projects", "Library", "Workspace", "Shorts Editor", "Jobs", "Settings"];

// The COOP notice is emitted by Chromium for any non-https origin and is not a
// product error; every other console error is recorded.
const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

const report = { viewport: label, base, screens: {}, consoleErrors: [], pageErrors: [], httpErrors: [] };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: vw, height: vh } });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) report.consoleErrors.push(m.text()); });
page.on("pageerror", (e) => report.pageErrors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) report.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#main-content", { timeout: 30_000 });
// Let the async health/projects fetches settle so the inventory is not a skeleton.
await page.waitForTimeout(4_000);

async function inventory(name) {
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const main = document.querySelector("#main-content") || document.body;
    const q = (sel) => Array.from(main.querySelectorAll(sel)).filter(vis);
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 70),
      type: el.getAttribute("type") || undefined,
      role: el.getAttribute("role") || undefined,
      disabled: el.disabled || undefined,
      pressed: el.getAttribute("aria-pressed") || undefined,
      selected: el.getAttribute("aria-selected") || undefined,
      cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 60) || undefined,
    });
    return {
      h1: Array.from(document.querySelectorAll("h1")).map((h) => h.textContent.trim()),
      buttons: q("button").map(describe),
      inputs: q("input,textarea,select").map(describe),
      links: q("a").map((a) => ({ text: (a.textContent || "").trim().slice(0, 50), href: a.getAttribute("href") })),
      tabs: q('[role="tab"]').map(describe),
      // A button with no listener cannot be actuated; React attaches at the
      // root so this only flags the obvious inline case, but the class/handler
      // audit in the spec files is the authority.
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  report.screens[name] = data;
  await page.screenshot({ path: path.join(artifactDir, "screenshots", `static-${label}-${name.replace(/\s+/g, "-").toLowerCase()}.png`), fullPage: true });
}

for (const dest of RAIL) {
  const btn = page.getByRole("button", { name: dest, exact: true }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(2_500);
  }
  await inventory(dest);
}

// Help is a dialog, not a rail destination.
const help = page.getByRole("button", { name: /S6 Cut Help|Help/i }).first();
if (await help.count()) {
  await help.click();
  await page.waitForTimeout(1_500);
  await inventory("Help");
  await page.keyboard.press("Escape");
}

await fs.writeFile(path.join(artifactDir, "logs", `static-audit-${label}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  viewport: label,
  consoleErrors: report.consoleErrors.length,
  pageErrors: report.pageErrors.length,
  httpErrors: report.httpErrors.length,
  screens: Object.fromEntries(Object.entries(report.screens).map(([k, v]) => [k, { buttons: v.buttons.length, inputs: v.inputs.length, overflow: v.scrollWidth > v.clientWidth }])),
}, null, 2));
await browser.close();
