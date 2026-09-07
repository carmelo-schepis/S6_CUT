// Page-level overflow / clipping check that ignores deliberate scrollers.
import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const SCREENS = ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"];
const VPS = [[1440,900],[1280,800],[1024,768],[768,1024],[390,844]];
const b = await chromium.launch();
for (const [w, h] of VPS) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(1600);
  for (const nav of SCREENS) {
    try { await page.getByRole("button", { name: nav, exact: true }).first().click({ timeout: 4000 }); } catch { console.log(`${w}x${h} ${nav}: NAV FAIL`); continue; }
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [], truncated = [];
      for (const el of document.querySelectorAll("body *")) {
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;
        if (el.closest(".sr-only") || el.classList.contains("sr-only")) continue;
        let p = el.parentElement, inScroller = false;
        while (p && p !== document.body) { const ps = getComputedStyle(p); if (/(auto|scroll)/.test(ps.overflowX) || /(auto|scroll|hidden)/.test(ps.overflow)) { inScroller = true; break; } p = p.parentElement; }
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (!inScroller && (rect.right > vw + 1 || rect.left < -1)) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0,36)} [${Math.round(rect.left)},${Math.round(rect.right)}] "${(el.textContent||"").trim().slice(0,28)}"`);
        // Nav/label text truncated by ellipsis with no title fallback
        if (st.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !el.title && (el.textContent||"").trim()) truncated.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0,30)} "${(el.textContent||"").trim().slice(0,30)}"`);
      }
      return { hScroll: document.documentElement.scrollWidth > vw + 1, bad: bad.slice(0,6), truncated: [...new Set(truncated)].slice(0,6) };
    });
    const flags = [];
    if (r.hScroll) flags.push("H-SCROLL");
    if (r.bad.length) flags.push("overflow:" + r.bad.join(" ; "));
    if (r.truncated.length) flags.push("ellipsis:" + r.truncated.join(" ; "));
    console.log(`${w}x${h} ${nav}: ${flags.length ? flags.join(" | ") : "ok"}`);
  }
  await ctx.close();
}
await b.close();
