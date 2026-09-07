import { chromium } from "@playwright/test";
const b = await chromium.launch();
for (const w of [390, 430, 768]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173"); await page.waitForTimeout(1500);
  console.log(w, await page.evaluate(() => [...document.querySelectorAll(".nav-item span")].map((s) => `${s.textContent}:${s.scrollWidth}/${s.clientWidth}@${getComputedStyle(s).fontSize}`)));
  await ctx.close();
}
await b.close();
