// Typography inventory collector for S6 Cut.
// Usage: node collect.mjs <baseURL> <outDir> <label>
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

// Text-bearing elements only; media/vector/third-party are out of scope.
const COLLECT = `(() => {
  const EXCLUDE_TAGS = new Set(["SVG","CANVAS","VIDEO","IMG","SCRIPT","STYLE","NOSCRIPT","PATH","LINE","CIRCLE","RECT","POLYLINE","POLYGON","G","DEFS","USE","AUDIO","SOURCE","TRACK","IFRAME","OBJECT","EMBED"]);
  const out = [];
  const walk = (root) => {
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (EXCLUDE_TAGS.has(el.tagName)) continue;
      if (el.closest("svg,canvas,video,img,iframe")) continue;
      // Only elements that directly render text.
      let own = "";
      for (const node of el.childNodes) {
        if (node.nodeType === 3) own += node.nodeValue;
      }
      const isInputish = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
      if (!own.trim() && !isInputish) continue;
      const rect = el.getBoundingClientRect();
      if (!isInputish && (rect.width === 0 || rect.height === 0)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
      let sample = (own.trim() || el.getAttribute("placeholder") || el.value || "").replace(/\\s+/g," ").slice(0,70);
      if (!sample) continue;
      // Resolve line-height to a ratio for comparison.
      const fs = parseFloat(cs.fontSize);
      const lhRaw = cs.lineHeight;
      const lh = lhRaw === "normal" ? "normal" : (parseFloat(lhRaw) / fs).toFixed(3);
      out.push({
        sample,
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === "string" ? el.className : "").slice(0,80),
        family: cs.fontFamily.split(",")[0].replace(/["']/g,"").trim(),
        size: cs.fontSize,
        weight: cs.fontWeight,
        lineHeight: lh,
        lineHeightPx: lhRaw,
        letterSpacing: cs.letterSpacing,
        transform: cs.textTransform,
        color: cs.color,
        inlineFontSize: el.style && el.style.fontSize ? el.style.fontSize : "",
        // overflow detection
        clippedX: el.scrollWidth > el.clientWidth + 1,
      });
    }
  };
  walk(document.body);
  return out;
})()`;

const records = [];
const overflow = [];

async function snap(page, vp, route, state) {
  const rows = await page.evaluate(COLLECT);
  for (const r of rows) records.push({ viewport: vp, route, state, ...r });
  const bodyOverflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  if (bodyOverflow.scrollW > bodyOverflow.clientW + 1) {
    overflow.push({ viewport: vp, route, state, ...bodyOverflow });
  }
}

async function shot(page, vp, name) {
  const dir = resolve(OUT, "screens", vp);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${LABEL}-${name}.png`), fullPage: false });
}

const NAV = ["Projects","Library","Workspace","Shorts Editor","Jobs","Settings"];

async function run() {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[pageerror ${vp.name}]`, e.message));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    for (const label of NAV) {
      const btn = page.locator(`.app-rail nav button[aria-label="${label}"]`);
      if (await btn.count() === 0) { console.error(`missing nav ${label}`); continue; }
      await btn.first().click();
      await page.waitForTimeout(900);
      const route = label.toLowerCase().replace(/\s+/g,"-");
      await snap(page, vp.name, route, "default");
      await shot(page, vp.name, route);

      if (label === "Projects") {
        // Open a project -> workspace, which populates the inspector panel.
        const card = page.locator(".project-card").first();
        if (await card.count()) {
          await card.click({ timeout: 5000 });
          await page.locator(".inspector-panel").waitFor({ state: "visible", timeout: 15000 });
          await page.waitForTimeout(1200);
          await snap(page, vp.name, "workspace", "project-open");
          await shot(page, vp.name, "workspace-open");
          for (const tab of ["score", "captions", "asset", "info"]) {
            const t = page.locator(".inspector-tabs button", { hasText: new RegExp(`^${tab}$`, "i") });
            if (!(await t.count())) throw new Error(`inspector tab not found: ${tab}`);
            await t.first().click();
            await page.waitForTimeout(500);
            await snap(page, vp.name, "workspace", `tab-${tab}`);
            await shot(page, vp.name, `workspace-tab-${tab}`);
          }
        } else {
          throw new Error("no .project-card to open");
        }
      }

      if (label === "Settings") {
        await page.waitForTimeout(500);
        await snap(page, vp.name, "settings", "loaded");
      }
    }

    // Help dialog (modal state)
    try {
      const help = page.locator('button[aria-label*="Help" i], button:has-text("Help")').first();
      if (await help.count()) {
        await help.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        await snap(page, vp.name, "help-dialog", "open");
        await shot(page, vp.name, "help-dialog");
        await page.keyboard.press("Escape");
      }
    } catch (e) { console.error("help dialog:", e.message); process.exitCode = 1; }

    await ctx.close();
  }
  await browser.close();

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${LABEL}-records.json`), JSON.stringify(records, null, 1));

  // Group by unique computed typography combination.
  const groups = new Map();
  for (const r of records) {
    const key = [r.family, r.size, r.weight, r.lineHeight, r.letterSpacing, r.transform].join(" | ");
    if (!groups.has(key)) groups.set(key, { key, count: 0, samples: [], routes: new Set(), tags: new Set(), classes: new Set() });
    const g = groups.get(key);
    g.count++;
    if (g.samples.length < 4) g.samples.push(r.sample);
    g.routes.add(r.route); g.tags.add(r.tag); if (r.cls) g.classes.add(r.cls);
  }
  const sorted = [...groups.values()].sort((a,b) => b.count - a.count)
    .map(g => ({ ...g, routes: [...g.routes], tags: [...g.tags], classes: [...g.classes].slice(0,8) }));
  writeFileSync(resolve(OUT, `${LABEL}-groups.json`), JSON.stringify(sorted, null, 1));

  console.log(`\n=== ${LABEL}: ${records.length} text elements, ${sorted.length} unique typography combinations ===\n`);
  for (const g of sorted) {
    console.log(`${String(g.count).padStart(4)}  ${g.key}`);
    console.log(`      e.g. ${g.samples.map(s=>JSON.stringify(s)).join(", ")}`);
  }
  if (overflow.length) {
    console.log(`\n!!! horizontal overflow: ${JSON.stringify(overflow, null, 1)}`);
  } else {
    console.log("\nNo horizontal document overflow detected.");
  }
  const inline = records.filter(r => r.inlineFontSize);
  console.log(`\nInline font-size declarations: ${inline.length}`);
  const clipped = records.filter(r => r.clippedX);
  console.log(`Elements with horizontal content clipping: ${clipped.length}`);
  if (clipped.length) console.log(JSON.stringify(clipped.slice(0,15).map(c=>({vp:c.viewport,route:c.route,cls:c.cls,tag:c.tag,sample:c.sample})), null, 1));
}
run().catch(e => { console.error(e); process.exit(1); });
