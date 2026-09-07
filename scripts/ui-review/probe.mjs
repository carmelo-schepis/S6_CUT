import { chromium } from "@playwright/test";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:5173"); await page.waitForTimeout(1800);
await page.getByRole("button", { name: "Library", exact: true }).first().click();
await page.waitForTimeout(4000);
console.log(await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".asset-card")].slice(0, 4);
  return cards.map((c) => ({
    card: Math.round(c.getBoundingClientRect().height),
    kids: [...c.children].map((k) => `${k.className.split(" ")[0]}=${Math.round(k.getBoundingClientRect().height)}`),
    preview: (() => { const p = c.querySelector(".asset-preview"); return p ? Math.round(p.getBoundingClientRect().height) : null; })(),
    video: (() => { const v = c.querySelector("video"); return v ? `${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)} objectFit=${getComputedStyle(v).objectFit}` : null; })(),
    detailsH: (() => { const d = c.querySelector(".asset-card-details"); return d ? Math.round(d.getBoundingClientRect().height) : null; })(),
  }));
}));
await b.close();
