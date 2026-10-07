// Customer-facing control inventory: every interactive element on every screen,
// with the accessible name and state a customer would perceive.
import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const OUT = process.env.OUT || "test-artifacts/qa";
const SCREENS = ["Projects", "Library", "Workspace", "Shorts Editor", "Jobs", "Settings"];

const collect = () => {
  const rows = [];
  const sel = "button, a[href], input, select, textarea, [role=tab], [role=treeitem], [role=button], [tabindex]:not([tabindex='-1'])";
  for (const el of document.querySelectorAll(sel)) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.closest(".sr-only")) continue;
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.labels?.[0]?.textContent
      || el.textContent || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
    rows.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || el.getAttribute("role") || "",
      name: name.slice(0, 70),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      pressed: el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected") ?? null,
      // A form button with no explicit type submits the form implicitly.
      implicitSubmit: el.tagName === "BUTTON" && !el.getAttribute("type") && Boolean(el.closest("form")),
      w: Math.round(r.width), h: Math.round(r.height),
      cls: String(el.className).slice(0, 44),
    });
  }
  return rows;
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(`${m.text().slice(0, 160)}`); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));

await page.goto(BASE); await page.waitForTimeout(3000);
const report = {};
let total = 0, unnamed = 0, tinyTarget = 0, implicit = 0;
for (const s of SCREENS) {
  await page.getByRole("button", { name: s, exact: true }).first().click();
  await page.waitForTimeout(3200);
  const rows = await page.evaluate(collect);
  report[s] = rows;
  total += rows.length;
  for (const r of rows) {
    if (!r.name) unnamed += 1;
    if (r.implicitSubmit) implicit += 1;
    if (r.w > 0 && (r.w < 24 || r.h < 24) && r.tag !== "input") tinyTarget += 1;
  }
  console.log(`\n=== ${s} (${rows.length} controls) ===`);
  for (const r of rows) {
    const flags = [r.disabled ? "DISABLED" : "", r.pressed === "true" ? "SELECTED" : "", !r.name ? "!!NO-NAME" : "", r.implicitSubmit ? "!!IMPLICIT-SUBMIT" : "", (r.w < 24 || r.h < 24) && r.tag === "button" ? `small(${r.w}x${r.h})` : ""].filter(Boolean).join(" ");
    console.log(`  ${r.tag}${r.type ? "[" + r.type + "]" : ""} "${r.name}" ${flags}`);
  }
}
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/inventory.json`, JSON.stringify(report, null, 2));
console.log(`\nTOTALS: ${total} controls | unnamed=${unnamed} | implicit-submit=${implicit} | small-targets=${tinyTarget}`);
console.log("CONSOLE ERRORS:", [...new Set(errs)].slice(0, 8));
await b.close();
