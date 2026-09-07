// Long project names / long labels must wrap, never overflow or collide.
import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const b = await chromium.launch();
for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(2500);
  // Open the long-named project from the Projects grid.
  await page.getByRole("button", { name: /The Beatles changed popular music/ }).first().click();
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const name = document.querySelector(".workspace-project-name");
    const bar = document.querySelector(".workspace-commandbar");
    const bad = [];
    for (const el of document.querySelectorAll(".workspace-commandbar *, .topbar *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width && rect.right > vw + 1) bad.push(el.className || el.tagName);
    }
    return { hScroll: document.documentElement.scrollWidth > vw + 1, nameH: name ? Math.round(name.getBoundingClientRect().height) : null,
      barH: bar ? Math.round(bar.getBoundingClientRect().height) : null, crumb: document.querySelector(".topbar-context")?.innerText.replace(/\n/g," "), bad };
  });
  console.log(`${w}x${h}`, JSON.stringify(r));
  await page.screenshot({ path: `test-artifacts/ui-review/final-detail/longname-${w}.png` });
  await ctx.close();
}
await b.close();
