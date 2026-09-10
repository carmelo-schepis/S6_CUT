/**
 * S6 Cut UI audit: text colour, step-badge geometry and accent usage.
 *
 * Walks every primary route at four viewports, exercises the interactive
 * states, and reports:
 *   - every distinct computed text colour on visible, first-party DOM text
 *   - the geometry of every numbered workflow step badge
 *   - which accent colours are actually painted
 *
 * Usage: node scripts/qa/ui-audit.mjs <baseURL> <outDir> <label>
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:5173";
const OUT = process.argv[3] || "./out";
const LABEL = process.argv[4] || "run";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
];
const NAV = ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"];

// Media and third-party surfaces are out of scope for the text-colour rule.
const COLLECT = `(() => {
  const SKIP = new Set(["SVG","CANVAS","VIDEO","IMG","SCRIPT","STYLE","NOSCRIPT","AUDIO","SOURCE","TRACK","IFRAME","OBJECT","EMBED"]);
  const text = [];
  for (const el of document.querySelectorAll("*")) {
    if (SKIP.has(el.tagName)) continue;
    if (el.closest("svg,canvas,video,img,iframe")) continue;
    if (el.classList.contains("sr-only") || el.closest(".sr-only")) continue;
    // Caption preview simulates the burned-in video subtitle, not product chrome.
    if (el.closest(".caption-preview")) continue;
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
    if (!own.trim() && !isField) continue;
    const rect = el.getBoundingClientRect();
    if (!isField && (rect.width === 0 || rect.height === 0)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    const sample = (own.trim() || el.getAttribute("placeholder") || el.value || "").replace(/\\s+/g," ").slice(0,60);
    if (!sample) continue;
    const disabled = el.disabled === true || el.closest("[disabled],:disabled,.disabled") !== null
      || cs.cursor === "not-allowed";
    text.push({
      sample, tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").slice(0,60),
      color: cs.color, opacity: cs.opacity, disabled,
      size: cs.fontSize, weight: cs.fontWeight,
    });
  }

  // Numbered workflow step badges.
  const badges = [];
  // Only the shared component counts as a badge; any surviving ad-hoc badge
  // markup is reported separately as a regression.
  const legacyBadges = [...document.querySelectorAll(".step-label > span:not(.step-badge):not(.step-label-text), .help-steps article > span:not(.step-badge)")]
    .map((el) => el.textContent.trim());
  for (const el of document.querySelectorAll(".step-badge")) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const parentCS = el.parentElement ? getComputedStyle(el.parentElement) : null;
    badges.push({
      text: el.textContent.trim(),
      cls: (typeof el.className === "string" ? el.className : ""),
      w: +rect.width.toFixed(2), h: +rect.height.toFixed(2),
      square: Math.abs(rect.width - rect.height) < 0.5,
      boxSizing: cs.boxSizing, display: cs.display,
      alignItems: cs.alignItems, justifyContent: cs.justifyContent,
      flexGrow: cs.flexGrow, flexShrink: cs.flexShrink, flexBasis: cs.flexBasis,
      aspectRatio: cs.aspectRatio, borderRadius: cs.borderRadius,
      padding: cs.padding, overflow: cs.overflow,
      borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
      color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, numeric: cs.fontVariantNumeric,
      whiteSpace: cs.whiteSpace,
      parentDisplay: parentCS ? parentCS.display : null,
      clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
    });
  }

  // Painted accent colours (borders/backgrounds that are not surface/neutral).
  const accents = {};
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    for (const prop of ["backgroundColor","borderTopColor","outlineColor"]) {
      const v = cs[prop];
      const m = v && v.match(/^rgba?\\((\\d+), (\\d+), (\\d+)/);
      if (!m) continue;
      const [r,g,b] = [ +m[1], +m[2], +m[3] ];
      if (v.startsWith("rgba") && / 0\\)$/.test(v)) continue;
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      if (max - min < 24) continue;          // neutral / near-grey surfaces
      if (max < 60) continue;                // too dark to read as an accent
      accents[v] = (accents[v] || 0) + 1;
    }
  }
  return { text, badges, accents, legacyBadges };
})()`;

const textRows = [], badgeRows = [], accentTally = {}, legacy = [];

async function snap(page, vp, route, state) {
  const r = await page.evaluate(COLLECT);
  for (const t of r.text) textRows.push({ viewport: vp, route, state, ...t });
  for (const bdg of r.badges) badgeRows.push({ viewport: vp, route, state, ...bdg });
  for (const [k, v] of Object.entries(r.accents)) accentTally[k] = (accentTally[k] || 0) + v;
  if (r.legacyBadges.length) legacy.push({ viewport: vp, route, state, found: r.legacyBadges });
}
async function shot(page, vp, name) {
  const dir = resolve(OUT, "screens", vp);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${LABEL}-${name}.png`) });
}

async function run() {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    for (const label of NAV) {
      await page.locator(`.app-rail nav button[aria-label="${label}"]`).first().click();
      await page.waitForTimeout(800);
      const route = label.toLowerCase().replace(/\s+/g, "-");
      await snap(page, vp.name, route, "default");
      await shot(page, vp.name, route);

      if (label === "Projects") {
        // Script mode swaps the workflow steps; capture both.
        const script = page.locator(".mode-tabs button", { hasText: /^Script mode$/i });
        if (await script.count()) {
          await script.first().click(); await page.waitForTimeout(600);
          await snap(page, vp.name, "projects", "script-mode");
          await shot(page, vp.name, "projects-script-mode");
          const clip = page.locator(".mode-tabs button", { hasText: /^Clip mode$/i });
          if (await clip.count()) { await clip.first().click(); await page.waitForTimeout(500); }
        }
        // Selected vs unselected style cards.
        const cards = page.locator(".style-card");
        if (await cards.count() > 1) {
          await cards.nth(1).click(); await page.waitForTimeout(400);
          await snap(page, vp.name, "projects", "style-selected");
          await shot(page, vp.name, "projects-style-selected");
        }
        // Focus state on the first field.
        const field = page.locator(".create-panel input[type=text], .create-panel input:not([type])").first();
        if (await field.count()) {
          await field.focus(); await page.waitForTimeout(250);
          await snap(page, vp.name, "projects", "input-focus");
          await shot(page, vp.name, "projects-input-focus");
        }
        const card = page.locator(".project-card").first();
        if (await card.count()) {
          await card.click();
          await page.locator(".inspector-panel").waitFor({ state: "visible", timeout: 15000 });
          await page.waitForTimeout(1200);
          await snap(page, vp.name, "workspace", "project-open");
          await shot(page, vp.name, "workspace-open");
          for (const tab of ["score", "captions", "asset", "info"]) {
            const t = page.locator(".inspector-tabs button", { hasText: new RegExp(`^${tab}$`, "i") });
            if (await t.count()) {
              await t.first().click(); await page.waitForTimeout(400);
              await snap(page, vp.name, "workspace", `tab-${tab}`);
              await shot(page, vp.name, `workspace-tab-${tab}`);
            }
          }
        }
      }
    }

    // Help dialog: numbered step badges + modal text.
    const help = page.locator('button[aria-label*="Help" i], button:has-text("Help")').first();
    if (await help.count()) {
      await help.click(); await page.waitForTimeout(900);
      await snap(page, vp.name, "help-dialog", "open");
      await shot(page, vp.name, "help-dialog");
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    }
    await ctx.close();
  }
  await browser.close();

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${LABEL}-text.json`), JSON.stringify(textRows, null, 1));
  writeFileSync(resolve(OUT, `${LABEL}-badges.json`), JSON.stringify(badgeRows, null, 1));

  const byColour = {};
  for (const t of textRows) {
    const k = t.color + (t.disabled ? "  [disabled]" : "");
    (byColour[k] ||= { count: 0, samples: [], classes: new Set() });
    byColour[k].count++;
    if (byColour[k].samples.length < 3) byColour[k].samples.push(t.sample);
    if (t.cls) byColour[k].classes.add(t.cls.split(" ")[0]);
  }
  console.log(`\n=== ${LABEL}: ${textRows.length} text nodes ===`);
  for (const [k, v] of Object.entries(byColour).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${String(v.count).padStart(5)}  ${k}`);
    console.log(`        ${[...v.classes].slice(0, 5).join(", ") || "(no class)"}`);
    console.log(`        e.g. ${v.samples.map(s => JSON.stringify(s.slice(0, 40))).join(", ")}`);
  }
  const nonWhite = textRows.filter(t => t.color !== "rgb(255, 255, 255)" && !t.disabled);
  console.log(`\nNON-WHITE enabled text nodes: ${nonWhite.length}`);

  console.log(`\n=== step badges: ${badgeRows.length} observed ===`);
  const seen = new Map();
  for (const b of badgeRows) {
    const k = [b.text, b.w, b.h, b.flexShrink, b.flexBasis, b.display, b.aspectRatio, b.fontSize, b.fontWeight, b.lineHeight, b.numeric, b.padding, b.overflow, b.boxSizing, b.color].join("|");
    if (!seen.has(k)) seen.set(k, { ...b, n: 0 });
    seen.get(k).n++;
  }
  for (const b of seen.values()) {
    const bad = [];
    if (!b.square) bad.push("NOT SQUARE");
    if (b.w !== 24 || b.h !== 24) bad.push(`size ${b.w}x${b.h}`);
    if (b.flexShrink !== "0") bad.push(`flex-shrink ${b.flexShrink}`);
    if (b.boxSizing !== "border-box") bad.push(`box-sizing ${b.boxSizing}`);
    if (b.aspectRatio !== "1 / 1") bad.push(`aspect-ratio ${b.aspectRatio}`);
    if (b.padding !== "0px") bad.push(`padding ${b.padding}`);
    if (b.overflow !== "hidden") bad.push(`overflow ${b.overflow}`);
    if (b.fontSize !== "14px") bad.push(`font-size ${b.fontSize}`);
    if (b.fontWeight !== "500") bad.push(`weight ${b.fontWeight}`);
    if (b.lineHeight !== "14px") bad.push(`line-height ${b.lineHeight}`);
    if (!/tabular-nums/.test(b.numeric)) bad.push(`numeric ${b.numeric}`);
    if (b.color !== "rgb(255, 255, 255)") bad.push(`colour ${b.color}`);
    if (b.clipped) bad.push("CLIPPED");
    console.log(`  x${String(b.n).padStart(3)} "${b.text}" ${b.w}x${b.h} ${b.cls || "(no class)"} -> ${bad.length ? bad.join("; ") : "OK"}`);
  }

  console.log(`\nLegacy (non-shared) step-badge markup: ${legacy.length ? JSON.stringify(legacy) : "none"}`);
  console.log(`\n=== painted accent colours ===`);
  for (const [k, v] of Object.entries(accentTally).sort((a, b) => b[1] - a[1]).slice(0, 24)) {
    console.log(`${String(v).padStart(6)}  ${k}`);
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
