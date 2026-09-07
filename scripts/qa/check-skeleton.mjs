import { chromium } from "@playwright/test";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8080", { waitUntil: "domcontentloaded" });
for (const t of [1000, 2000, 3000, 4000, 6000, 9000]) {
  await page.waitForTimeout(t === 1000 ? 1000 : 1000 * (t / 1000 - (t === 2000 ? 1 : t === 3000 ? 2 : t === 4000 ? 3 : t === 6000 ? 4 : 6)));
  const s = await page.evaluate(() => ({
    skeletons: document.querySelectorAll(".skeleton").length,
    cards: document.querySelectorAll(".project-card").length,
    where: [...document.querySelectorAll(".skeleton")].map((e) => e.parentElement?.className || "?").slice(0, 3),
  }));
  console.log(`~${t}ms: skeletons=${s.skeletons} cards=${s.cards} in=${JSON.stringify(s.where)}`);
}
await b.close();
