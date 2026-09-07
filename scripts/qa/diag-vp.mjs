import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:8080";
const vps = [[1440,900],[1024,768],[768,1024],[430,932],[390,844],[360,800],[320,568],[720,450]];
const b = await chromium.launch();
for (const [w,h] of vps) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.waitForTimeout(800);
  let note = "";
  try {
    await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
    for (let i = 0; i < 7; i += 1) await page.getByRole("button", { name: "More clips", exact: true }).click();
    const count = await page.locator(".count-control strong").innerText();
    const exact = await page.getByRole("button", { name: "Create 12 short clips", exact: true }).count();
    note = `count=${count} exactMatch=${exact}`;
    if (!exact) note += ` cta="${(await page.getByRole("button", { name: /^Create/ }).innerText()).replace(/\n/g," ")}"`;
  } catch (e) { note = "ERR " + String(e).split("\n")[0].slice(0,110); }
  console.log(`${w}x${h}: ${note}`);
  await ctx.close();
}
await b.close();
