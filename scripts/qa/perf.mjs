import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE); await page.waitForTimeout(3000);
for (const s of ["Library", "Jobs", "Shorts Editor", "Workspace", "Projects"]) {
  const t0 = Date.now();
  await page.getByRole("button", { name: s, exact: true }).first().click();
  // Wait until the DOM stops growing (render settled).
  await page.waitForLoadState("networkidle").catch(() => {});
  let prev = -1, stable = 0;
  while (stable < 4 && Date.now() - t0 < 40000) {
    await page.waitForTimeout(400);
    const n = await page.evaluate(() => document.querySelectorAll("*").length);
    if (n === prev) stable += 1; else { stable = 0; prev = n; }
  }
  const settle = Date.now() - t0;
  const m = await page.evaluate(() => ({
    nodes: document.querySelectorAll("*").length,
    media: document.querySelectorAll("video,img,audio").length,
    height: document.documentElement.scrollHeight,
  }));
  // Responsiveness: time a simple interaction after render.
  const t1 = Date.now();
  await page.mouse.move(700, 400); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  console.log(`${s.padEnd(14)} settle=${String(settle).padStart(6)}ms nodes=${String(m.nodes).padStart(6)} media=${String(m.media).padStart(4)} pageHeight=${m.height}px frame=${Date.now() - t1}ms`);
}
await b.close();
