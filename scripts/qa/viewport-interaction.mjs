// Per-viewport interaction checks: controls must remain clickable, inside the
// viewport, and not covered by fixed chrome.
import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const VPS = [[1440,900],[1280,800],[1024,768],[768,1024],[390,844]];
const b = await chromium.launch();
let failures = 0;
for (const [w, h] of VPS) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(3000);
  const notes = [];

  // Every nav destination must be reachable by click at this size.
  for (const s of ["Library", "Jobs", "Settings", "Shorts Editor", "Projects"]) {
    try {
      await page.getByRole("button", { name: s, exact: true }).first().click({ timeout: 5000 });
      await page.waitForTimeout(700);
    } catch { notes.push(`nav:${s} UNCLICKABLE`); }
  }
  await page.waitForTimeout(1500);

  // Core creation controls must be operable.
  const ops = [
    ["style", () => page.getByRole("button", { name: /^Serious/ }).click()],
    ["format", () => page.getByRole("button", { name: /Long form/ }).click()],
    ["format-back", () => page.getByRole("button", { name: /Short form/ }).click()],
    ["count+", () => page.getByRole("button", { name: "More clips" }).click()],
    ["mode", () => page.getByRole("button", { name: "Fast", exact: true }).click()],
    ["name", () => page.getByLabel("Project name").fill("viewport probe")],
    ["advanced", () => page.getByRole("button", { name: /Advanced controls/ }).click()],
  ];
  for (const [label, fn] of ops) {
    try { await fn(); await page.waitForTimeout(200); } catch (e) { notes.push(`${label} FAILED`); }
  }

  // The primary action must be reachable and not hidden behind fixed chrome.
  const cta = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => /^\s*Create \d+/.test(b.textContent || ""));
    if (!el) return { missing: true };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      inside: r.left >= 0 && r.right <= innerWidth + 1 && r.height >= 36,
      // Whatever is at the button's centre must be the button (or inside it).
      topmostIsCta: Boolean(mid && (mid === el || el.contains(mid))),
      covering: mid && !el.contains(mid) ? (mid.className || mid.tagName).toString().slice(0, 40) : null,
      h: Math.round(r.height),
    };
  });
  if (cta.missing) notes.push("CTA missing");
  else {
    if (!cta.inside) notes.push(`CTA outside viewport (h=${cta.h})`);
    if (!cta.topmostIsCta) notes.push(`CTA covered by ${cta.covering}`);
  }

  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (hScroll) notes.push("HORIZONTAL SCROLL");

  console.log(`${w}x${h}: ${notes.length ? "ISSUES -> " + notes.join(" | ") : "ok"}`);
  failures += notes.length;
  await ctx.close();
}
await b.close();
console.log(failures ? `\n${failures} viewport issue(s)` : "\nAll viewports clean");
