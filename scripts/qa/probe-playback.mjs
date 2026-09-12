/**
 * Proves the browser-side content gate (§5.10) can run at all: loads the
 * Workspace for a project that already has a completed clip, plays the served
 * stream, and reports readyState/advance/frame-difference. If this cannot pass
 * on known-good existing media, the gate itself is broken and every later
 * per-case failure would be a false negative.
 */
import { chromium } from "playwright";

const base = process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080";

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#main-content", { timeout: 30_000 });
await page.waitForTimeout(4_000);

await page.getByRole("button", { name: "Workspace", exact: true }).click();
await page.waitForTimeout(3_000);

// Select the first completed clip so the viewer loads finished media.
const preview = page.getByRole("button", { name: "Preview", exact: true }).first();
if (await preview.count()) {
  await preview.click();
  await page.waitForTimeout(3_000);
}

const result = await page.evaluate(async () => {
  const v = document.querySelector(".viewer-frame video");
  if (!v) return { error: "no video element" };
  v.muted = true;
  try { await v.play(); } catch (e) { return { error: "play rejected: " + e.message }; }
  const snap = () => {
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, 160, 90);
    return ctx.getImageData(0, 0, 160, 90).data;
  };
  await new Promise((r) => setTimeout(r, 1200));
  const t0 = v.currentTime;
  let a;
  try { a = snap(); } catch (e) { return { error: "getImageData threw: " + e.message, tainted: true }; }
  await new Promise((r) => setTimeout(r, 3000));
  const t1 = v.currentTime, b = snap();
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
  return {
    src: v.currentSrc.slice(0, 120),
    readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
    advanced: +(t1 - t0).toFixed(3), meanDiff: +(diff / (a.length / 4)).toFixed(3),
    err: v.error?.message || null,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
