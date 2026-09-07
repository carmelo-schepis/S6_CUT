import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:5173";
const DIR = "test-artifacts/ui-review/e2e";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], nets = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) nets.push(`${r.status()} ${r.url().split("?")[0].slice(-55)}`); });
const log = (...a) => console.log(...a);

await page.goto(BASE); await page.waitForTimeout(2500);
await page.getByRole("button", { name: "Workspace", exact: true }).first().click();
await page.waitForTimeout(5000);
log("project:", (await page.locator(".topbar-context").innerText()).replace(/\n/g, " "));
log("status :", (await page.locator(".workspace-commandbar .status").innerText().catch(() => "?")).replace(/\n/g, " "));
log("board  :", (await page.locator(".board-header").innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: `${DIR}/20-complete.png` });

// Select the finished clip and walk the detail tabs.
await page.locator(".clip-tile").first().click();
await page.waitForTimeout(2500);
for (const tab of ["score", "captions", "asset", "info"]) {
  await page.getByRole("button", { name: tab, exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${DIR}/21-tab-${tab}.png` });
  log(`tab ${tab}:`, (await page.locator(".inspector-content").innerText()).replace(/\s+/g, " ").slice(0, 150));
}
await page.getByRole("button", { name: "score", exact: true }).click();
await page.waitForTimeout(2500);

// Preview must actually play the generated asset.
const media = await page.evaluate(async () => {
  const v = document.querySelector(".viewer-frame video");
  if (!v) return { error: "no video element" };
  try { await v.play(); } catch (e) { /* autoplay policy */ }
  await new Promise((r) => setTimeout(r, 1500));
  return { src: v.getAttribute("src")?.split("?")[0], readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight, currentTime: v.currentTime, error: v.error?.message || null };
});
log("PREVIEW:", JSON.stringify(media));
await page.screenshot({ path: `${DIR}/22-preview-playing.png` });

const dl = page.locator('.clip-tile a[download]').first();
log("DOWNLOAD LINK:", await dl.count() ? (await dl.getAttribute("href")).split("?")[0] : "none");
// Verify the download URL actually serves bytes.
const href = await dl.count() ? await dl.getAttribute("href") : null;
if (href) {
  const res = await page.request.get(new URL(href, BASE).toString());
  log("DOWNLOAD FETCH:", res.status(), res.headers()["content-type"], (await res.body()).length, "bytes");
}
// Export ZIP button reflects the selected clip.
log("ZIP BUTTON:", (await page.getByRole("button", { name: /Download ZIP/ }).innerText()).replace(/\n/g, " "));
console.log("CONSOLE:", [...new Set(errs)].slice(0, 5));
console.log("API FAIL:", [...new Set(nets)].slice(0, 5));
await b.close();
