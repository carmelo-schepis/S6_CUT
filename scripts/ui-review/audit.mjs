// UI review harness: navigates the running app, captures screenshots at several
// viewports and reports overflow / collision / console defects as JSON.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const OUT = process.env.OUT_DIR || "test-artifacts/ui-review/baseline";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
];

const only = process.env.ONLY_VIEWPORTS ? new Set(process.env.ONLY_VIEWPORTS.split(",")) : null;
const viewports = only ? VIEWPORTS.filter((v) => only.has(v.name)) : VIEWPORTS;

// Screens reachable from the rail, in journey order.
const SCREENS = [
  { id: "projects", nav: "Projects" },
  { id: "library", nav: "Library" },
  { id: "workspace", nav: "Workspace" },
  { id: "shorts-editor", nav: "Shorts Editor" },
  { id: "ai-video", nav: "AI Video" },
  { id: "jobs", nav: "Jobs" },
  { id: "settings", nav: "Settings" },
];

/** Measure layout defects inside the page. */
const measure = () => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const overflow = [];
  const tiny = [];
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      overflow.push({
        sel: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""),
        left: Math.round(r.left), right: Math.round(r.right), vw,
        text: (el.textContent || "").trim().slice(0, 60),
      });
    }
    // A control whose content is wider than its box (label squeezed / clipped)
    if (/^(button|a|label)$/.test(el.tagName.toLowerCase())) {
      if (el.scrollWidth > el.clientWidth + 2 && style.overflow !== "visible") {
        clipped.push({ sel: el.tagName.toLowerCase() + "." + String(el.className).slice(0, 40), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || "").trim().slice(0, 50) });
      }
      const size = parseFloat(style.fontSize);
      if (size && size < 11 && (el.textContent || "").trim()) tiny.push({ text: (el.textContent || "").trim().slice(0, 40), size });
    }
  }
  return {
    horizontalScroll: doc.scrollWidth > vw + 1,
    scrollWidth: doc.scrollWidth,
    clientWidth: vw,
    overflow: overflow.slice(0, 25),
    clipped: clipped.slice(0, 25),
    tiny: tiny.slice(0, 15),
  };
};

const run = async () => {
  const browser = await chromium.launch();
  const report = [];
  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const consoleErrors = [];
    const netFailures = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
    page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err).slice(0, 300)));
    page.on("response", (res) => { if (res.status() >= 400) netFailures.push(`${res.status()} ${res.url().slice(0, 140)}`); });

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);

    for (const screen of SCREENS) {
      try {
        await page.getByRole("button", { name: screen.nav, exact: true }).first().click({ timeout: 5000 });
      } catch {
        report.push({ viewport: vp.name, screen: screen.id, error: "nav failed" });
        continue;
      }
      await page.waitForTimeout(Number(process.env.WAIT || 3200));
      const dir = path.join(OUT, vp.name);
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${screen.id}.png`), fullPage: true });
      const metrics = await page.evaluate(measure);
      report.push({ viewport: vp.name, screen: screen.id, ...metrics });
    }
    report.push({ viewport: vp.name, consoleErrors: [...new Set(consoleErrors)], netFailures: [...new Set(netFailures)].slice(0, 20) });
    await context.close();
  }
  await browser.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  // Console summary
  for (const row of report) {
    if (row.consoleErrors) {
      if (row.consoleErrors.length || row.netFailures.length) console.log(`[${row.viewport}] console=${row.consoleErrors.length} net=${row.netFailures.length}`, row.consoleErrors.slice(0, 3), row.netFailures.slice(0, 3));
      continue;
    }
    const flags = [];
    if (row.horizontalScroll) flags.push(`H-SCROLL ${row.scrollWidth}>${row.clientWidth}`);
    if (row.overflow?.length) flags.push(`overflow x${row.overflow.length}`);
    if (row.clipped?.length) flags.push(`clipped x${row.clipped.length}`);
    if (row.tiny?.length) flags.push(`tiny x${row.tiny.length}`);
    if (flags.length) console.log(`[${row.viewport}] ${row.screen}: ${flags.join(" | ")}`);
  }
  console.log("report:", path.join(OUT, "report.json"));
};

run().catch((err) => { console.error(err); process.exit(1); });
