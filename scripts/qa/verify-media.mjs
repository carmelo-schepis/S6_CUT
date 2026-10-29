import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:8080";
const TARGET = "Final Browser Retest 20260826T062538111Z";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], nets = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });
page.on("response", (r) => { if (r.status() >= 400) nets.push(`${r.status()} ${r.url().split("?")[0].slice(-55)}`); });
await page.goto(BASE); await page.waitForTimeout(3500);
await page.getByLabel("Search projects").fill(TARGET);
await page.waitForTimeout(1200);
await page.locator(".project-card").filter({ hasText: TARGET }).first().click();
await page.waitForTimeout(6000);
const info = await page.evaluate(async () => {
  const v = document.querySelector(".viewer-frame video");
  if (!v) return { error: "no video element" };
  try { await v.play(); } catch { /* autoplay */ }
  await new Promise((r) => setTimeout(r, 2500));
  return { src: (v.getAttribute("src") || "").split("?")[0], readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight, err: v.error?.message || null };
});
console.log("PREVIEW:", JSON.stringify(info));
console.log("board:", (await page.locator(".board-header").innerText()).replace(/\n/g, " | "));
const ve = await page.evaluate(() => {
  const e = document.querySelector(".viewer-error");
  if (!e) return null;
  const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
  return { text: e.innerText.replace(/\s+/g," ").slice(0,90), w: Math.round(r.width), h: Math.round(r.height), display: st.display, opacity: st.opacity, z: st.zIndex };
});
console.log("viewer error element:", JSON.stringify(ve));
await page.screenshot({ path: "test-artifacts/qa/durable-media-preview.png" });
console.log("CONSOLE:", [...new Set(errs)].slice(0, 5));
console.log("HTTP>=400:", [...new Set(nets)].slice(0, 5));
await b.close();
