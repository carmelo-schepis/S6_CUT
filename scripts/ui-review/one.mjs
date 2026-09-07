import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const [nav, w, h, out] = process.argv.slice(2);
await mkdir("test-artifacts/ui-review/iter", { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +w, height: +h } });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 200)));
await page.goto(BASE); await page.waitForTimeout(1800);
if (nav !== "-") { await page.getByRole("button", { name: nav, exact: true }).first().click(); await page.waitForTimeout(Number(process.env.WAIT || 3500)); }
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(600);
const board = await page.locator(".board-header").innerText().catch(() => "");
await page.screenshot({ path: `test-artifacts/ui-review/iter/${out}.png`, fullPage: process.env.FULL === "1" });
const m = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    const st = getComputedStyle(el); if (st.display === "none" || st.position === "fixed") continue;
    let p = el.parentElement, scroller = false;
    while (p) { const ps = getComputedStyle(p); if (/(auto|scroll)/.test(ps.overflowX)) { scroller = true; break; } p = p.parentElement; }
    if (scroller) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (r.right > vw + 1) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0,40)} right=${Math.round(r.right)}`);
  }
  return { vw, sw: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
});
console.log(JSON.stringify({ ...m, board: board.replace(/\n/g, " | "), errs: [...new Set(errs)] }, null, 1));
await b.close();
