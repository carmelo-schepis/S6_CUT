// Keyboard reachability, focus visibility and accessible names on key flows.
import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE); await page.waitForTimeout(1800);

// 1. Tab order through the create flow; every stop must have an accessible name.
const order = [];
for (let i = 0; i < 34; i += 1) {
  await page.keyboard.press("Tab");
  order.push(await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "BODY";
    const name = el.getAttribute("aria-label") || el.getAttribute("title") || (el.labels?.[0]?.textContent) || el.textContent?.trim().slice(0, 34) || el.getAttribute("placeholder") || "";
    const st = getComputedStyle(el);
    const ring = st.outlineStyle !== "none" && st.outlineWidth !== "0px";
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""} | "${name.replace(/\s+/g, " ")}" | ring=${ring}`;
  }));
}
console.log("--- TAB ORDER (Projects) ---");
order.forEach((o, i) => console.log(String(i + 1).padStart(2), o));

// 2. Unnamed interactive controls anywhere in the app.
for (const nav of ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"]) {
  await page.getByRole("button", { name: nav, exact: true }).first().click();
  await page.waitForTimeout(1500);
  const unnamed = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=tab], [role=treeitem]")) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.labels?.[0]?.textContent || el.textContent || el.getAttribute("placeholder") || "").trim();
      if (!name) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    }
    return [...new Set(out)];
  });
  console.log(`${nav}: unnamed controls =`, unnamed.length ? unnamed : "none");
}
await b.close();
