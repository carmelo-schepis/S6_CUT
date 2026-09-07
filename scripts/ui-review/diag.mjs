import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:8080";
const browser = await chromium.launch();
for (const vp of [{w:1024,h:768},{w:768,h:1024},{w:390,h:844}]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(1500);
  for (const nav of ["Workspace","Library","Jobs"]) {
    await page.getByRole("button", { name: nav, exact: true }).first().click();
    await page.waitForTimeout(800);
    const res = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.position === "fixed") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right > vw + 1) out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,60), right: Math.round(r.right), w: Math.round(r.width), text: (el.textContent||"").trim().slice(0,40) });
      }
      return { vw, sw: document.documentElement.scrollWidth, out: out.slice(0,12) };
    });
    console.log(`\n== ${vp.w}x${vp.h} ${nav}: vw=${res.vw} scrollWidth=${res.sw}`);
    for (const o of res.out) console.log(`   ${o.tag}.${o.cls} w=${o.w} right=${o.right} :: ${o.text}`);
  }
  await ctx.close();
}
await browser.close();
