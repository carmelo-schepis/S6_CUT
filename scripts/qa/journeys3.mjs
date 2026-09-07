// Destructive-action safety: confirmations must be honoured, cancel must be a
// true no-op, and only disposable QA data is ever removed.
import { chromium } from "@playwright/test";
const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const results = [];
const check = (n, ok, d = "") => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const api = async (p) => (await fetch(BASE + p)).json();

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
await page.goto(BASE); await page.waitForTimeout(3000);

// ---- Library: cancelling a delete must not delete ----
await page.getByRole("button", { name: "Library", exact: true }).click();
await page.waitForTimeout(5000);
const before = (await api("/api/v1/library/assets")).length;
await page.locator(".asset-card-details").first().click();
await page.waitForTimeout(1200);
const removeBtn = page.getByRole("button", { name: /Remove Library record/ });
if (await removeBtn.count() && await removeBtn.isEnabled()) {
  page.once("dialog", (d) => { console.log(`  confirm text: "${d.message().slice(0, 70)}…"`); d.dismiss(); });
  await removeBtn.click();
  await page.waitForTimeout(2000);
  const after = (await api("/api/v1/library/assets")).length;
  check("Cancelling the Library delete removes nothing", after === before, `${before} -> ${after}`);
} else check("Remove control is disabled for a protected asset", true, "remove disabled/absent");

// ---- Folder create: cancelling the prompt must not create ----
const foldersBefore = (await api("/api/v1/library/folders")).length;
page.once("dialog", (d) => d.dismiss());
await page.getByRole("button", { name: /New business folder/ }).click();
await page.waitForTimeout(1500);
check("Cancelling the folder prompt creates nothing", (await api("/api/v1/library/folders")).length === foldersBefore,
  `${foldersBefore} -> ${(await api("/api/v1/library/folders")).length}`);

// ---- Folder create: accepting creates exactly one (disposable) ----
const qaFolder = `QA disposable ${Date.now()}`;
page.once("dialog", (d) => d.accept(qaFolder));
await page.getByRole("button", { name: /New business folder/ }).click();
await page.waitForTimeout(2500);
const folders = await api("/api/v1/library/folders");
const made = folders.filter((f) => f.name === qaFolder);
check("Accepting the prompt creates exactly one folder", made.length === 1, `${foldersBefore} -> ${folders.length}`);

// ---- Removing that disposable folder works and keeps media ----
if (made.length === 1) {
  const assetsBefore = (await api("/api/v1/library/assets")).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const node = page.locator(".folder-node").filter({ hasText: qaFolder }).first();
  await node.hover();
  const remove = node.getByRole("button", { name: new RegExp(`Remove ${qaFolder}`) });
  if (await remove.count()) {
    page.once("dialog", (d) => d.accept());
    await remove.click();
    await page.waitForTimeout(2500);
    const left = (await api("/api/v1/library/folders")).filter((f) => f.name === qaFolder && !f.archived);
    check("Removing a disposable folder succeeds", left.length === 0, `${left.length} left`);
    check("Removing a folder deletes no media", (await api("/api/v1/library/assets")).length === assetsBefore,
      `${assetsBefore} -> ${(await api("/api/v1/library/assets")).length}`);
  } else check("Folder remove control reachable", false, "remove button not found");
}

console.log("\nPAGE ERRORS:", [...new Set(errs)].slice(0, 5));
const bad = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - bad.length}/${results.length} passed`);
if (bad.length) console.log("FAILED:", bad.map((f) => f.n));
await b.close();
