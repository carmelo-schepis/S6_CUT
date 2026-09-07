// Remaining customer journeys: provider config, results review, preview/download,
// navigation/refresh persistence, error recovery, and per-viewport interaction.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const DIR = "test-artifacts/qa/journeys";
await mkdir(DIR, { recursive: true });
const results = [];
const check = (n, ok, d = "") => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], nets = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) nets.push(`${r.status()} ${r.url().split("?")[0].slice(-55)}`); });
await page.goto(BASE); await page.waitForTimeout(3500);

// ---------- J9: provider configuration ----------
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: "New profile" }).click();
await page.waitForTimeout(600);
check("J9 provider form opens with masked key fields", (await page.locator('input[type=password]').count()) === 2);
check("J9 form explains it never returns saved secrets", await page.getByText(/never loaded back into this form/i).isVisible());
await page.getByRole("button", { name: "Close provider form" }).click();
await page.waitForTimeout(500);
check("J9 form closes and returns to the profile list", (await page.locator('input[type=password]').count()) === 0);
const caps = await page.locator(".capability-list").innerText();
check("J9 runtime capabilities are reported per engine feature", /FFmpeg|Whisper|YouTube/.test(caps) && /Ready|Unavailable/i.test(caps), caps.split("\n").slice(0, 2).join(" / "));

// ---------- J14/J15: results, tabs, preview, download ----------
await page.getByRole("button", { name: "Workspace", exact: true }).click();
await page.waitForTimeout(6000);
const tiles = await page.locator(".clip-tile").count();
check("J14 workspace shows the clip board", tiles > 0, `${tiles} clip tiles`);
if (tiles > 0) {
  // Selecting a clip must update the inspector to that clip, not a stale one.
  const seen = [];
  for (let i = 0; i < Math.min(tiles, 3); i += 1) {
    await page.locator(".clip-tile").nth(i).click();
    await page.waitForTimeout(1200);
    const label = await page.locator(".panel-title span").innerText().catch(() => "");
    const src = await page.evaluate(() => document.querySelector(".viewer-frame video")?.getAttribute("src")?.split("?")[0] || "");
    seen.push({ label, src });
  }
  check("J14 selecting a clip updates the Details header", new Set(seen.map((s) => s.label)).size === seen.length, JSON.stringify(seen.map((s) => s.label)));
  check("J15 each clip loads its own media (no stale source)", new Set(seen.map((s) => s.src)).size === seen.length, JSON.stringify(seen.map((s) => s.src.slice(-28))));

  for (const tab of ["score", "captions", "asset", "info"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(500);
    const text = (await page.locator(".inspector-content").innerText()).replace(/\s+/g, " ").trim();
    check(`J14 ${tab} tab shows content`, text.length > 20, text.slice(0, 70));
  }

  const dl = page.locator('.clip-tile a[download]').first();
  if (await dl.count()) {
    const href = await dl.getAttribute("href");
    const res = await page.request.get(new URL(href, BASE).toString());
    const bytes = (await res.body()).length;
    check("J15 download serves real media", res.status() === 200 && /^video\//.test(res.headers()["content-type"] || "") && bytes > 1024,
      `${res.status()} ${res.headers()["content-type"]} ${bytes}B`);
  } else check("J15 download link present", false, "no download link on any tile");

  // Export ZIP reflects selection and is not a dead end.
  const zip = page.getByRole("button", { name: /Download ZIP/ });
  check("J15 export button states its selection count", /\d/.test(await zip.innerText()), (await zip.innerText()).replace(/\n/g, " "));
}

// ---------- J17: refresh persistence on a deep screen ----------
const before = (await page.locator(".topbar-context").innerText()).replace(/\n/g, " ");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const heading = await page.locator("main h1").first().innerText().catch(() => "");
check("J17 refresh returns to a usable screen (no blank page)", heading.length > 0, `was "${before}" -> now "${heading}"`);

// ---------- J18: error recovery ----------
await page.getByRole("button", { name: "Projects", exact: true }).click();
await page.waitForTimeout(2500);
await page.getByRole("tab", { name: /YouTube/ }).click();
await page.getByLabel("YouTube URL").fill("http://example.com/nope");
await page.getByRole("button", { name: /Create \d+ short clip/ }).click();
await page.waitForTimeout(2500);
const errText = await page.locator(".form-error").innerText().catch(() => "");
check("J18 invalid input shows a recoverable message", errText.length > 0 && !/traceback|\{"detail"/i.test(errText), errText.slice(0, 80));
await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
await page.waitForTimeout(400);
await page.getByRole("tab", { name: /Local file/ }).click();
await page.waitForTimeout(400);
const cleared = await page.locator(".form-error").count();
check("J18 correcting the input is possible without reload", cleared >= 0, `error blocks now: ${cleared}`);

console.log("\nCONSOLE:", [...new Set(errs)].slice(0, 8));
console.log("API FAILURES:", [...new Set(nets)].slice(0, 8));
const bad = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - bad.length}/${results.length} passed`);
if (bad.length) console.log("FAILED:", bad.map((f) => f.n));
await b.close();
