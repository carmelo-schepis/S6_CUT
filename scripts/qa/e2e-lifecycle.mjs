// A real lightweight job, exercised the way a customer would interrupt it:
// double-click submit, navigate away mid-run, refresh mid-run, then verify the
// result is intact and downloadable.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const URL_UNDER_TEST = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const DIR = "test-artifacts/qa/lifecycle";
await mkdir(DIR, { recursive: true });
const results = [];
const check = (n, ok, d = "") => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], nets = [];
let clipPosts = 0;
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 150)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) nets.push(`${r.status()} ${r.url().split("?")[0].slice(-50)}`); });
page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/v1/jobs/clip")) clipPosts += 1; });

const name = `QA lifecycle ${Date.now()}`;
const jobsBefore = (await (await fetch(BASE + "/api/v1/jobs")).json()).length;

await page.goto(BASE); await page.waitForTimeout(3500);
await page.getByRole("tab", { name: /YouTube/ }).click();
await page.getByLabel("YouTube URL").fill(URL_UNDER_TEST);
await page.getByRole("button", { name: /^Educational/ }).click();
for (let i = 0; i < 4; i += 1) await page.getByRole("button", { name: "Fewer clips" }).click();
await page.getByRole("button", { name: "Fast", exact: true }).click();
await page.getByLabel("Project name").fill(name);
await page.getByRole("button", { name: /Advanced controls/ }).click();
await page.getByLabel("Minimum seconds").fill("8");
await page.getByLabel("Maximum seconds").fill("20");
await page.screenshot({ path: `${DIR}/01-form.png` });

// Double-click the primary action: exactly one job must be created.
const create = page.getByRole("button", { name: /^Create 1 short clip$/ });
await create.dispatchEvent("click");
await create.dispatchEvent("click");
await page.waitForTimeout(4000);
check("Double-clicking Create issues exactly one job request", clipPosts === 1, `${clipPosts} POST(s)`);
const jobsAfter = (await (await fetch(BASE + "/api/v1/jobs")).json()).length;
check("Exactly one job exists after the double click", jobsAfter === jobsBefore + 1, `${jobsBefore} -> ${jobsAfter}`);
await page.screenshot({ path: `${DIR}/02-submitted.png` });

// Navigate away mid-run and come back: state must be intact, not corrupted.
await page.getByRole("button", { name: "Library", exact: true }).click();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Workspace", exact: true }).click();
await page.waitForTimeout(5000);
const afterNav = (await page.locator(".workspace-commandbar").innerText()).replace(/\s+/g, " ");
check("Returning to the Workspace restores the running project", afterNav.includes(name.slice(0, 18)), afterNav.slice(0, 90));
await page.screenshot({ path: `${DIR}/03-after-nav.png` });

// Refresh mid-run: the page must reload into a coherent state.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const heading = await page.locator("main h1").first().innerText().catch(() => "");
check("Refresh mid-run lands on a usable page", heading.length > 0, heading);

// Wait for completion, then verify the result end to end.
await page.getByLabel("Search projects").fill(name).catch(() => {});
await page.waitForTimeout(1500);
await page.locator(".project-card").filter({ hasText: name }).first().click();
const deadline = Date.now() + 8 * 60 * 1000;
let status = "";
while (Date.now() < deadline) {
  status = (await page.locator(".workspace-commandbar .status").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/ready|failed|complete|stopped|cancelled/i.test(status)) break;
  await page.waitForTimeout(3000);
}
log("terminal status:", status);
check("Job reaches a terminal state", /ready|complete/i.test(status), status);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${DIR}/04-complete.png` });

const board = (await page.locator(".board-header").innerText()).replace(/\n/g, " | ");
check("Clip board reports a ready clip saved to the Library", /1 ready/.test(board) && /saved to Library/.test(board), board);
const dl = page.locator('.clip-tile a[download]').first();
if (await dl.count()) {
  const href = await dl.getAttribute("href");
  const res = await page.request.get(new URL(href, BASE).toString());
  const bytes = (await res.body()).length;
  check("Generated clip downloads as real media", res.status() === 200 && /^video\//.test(res.headers()["content-type"] || "") && bytes > 10000,
    `${res.status()} ${res.headers()["content-type"]} ${bytes}B`);
} else check("Download link present on the finished clip", false);

const media = await page.evaluate(async () => {
  const v = document.querySelector(".viewer-frame video");
  if (!v) return { error: "no video" };
  await new Promise((r) => setTimeout(r, 2000));
  return { readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight };
});
check("Finished clip previews at the requested 9:16 shape", media.w === 1080 && media.h === 1920 && media.readyState >= 2, JSON.stringify(media));
await page.screenshot({ path: `${DIR}/05-result.png` });

console.log("\nCONSOLE:", [...new Set(errs)].slice(0, 6));
console.log("API FAILURES:", [...new Set(nets)].slice(0, 6));
const bad = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - bad.length}/${results.length} passed`);
if (bad.length) console.log("FAILED:", bad.map((f) => f.n));
console.log("PROJECT:", name);
await b.close();
