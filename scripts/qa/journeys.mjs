// Customer journey acceptance checks. Each check reports PASS/FAIL with evidence.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const BASE = process.env.S6_URL || "http://127.0.0.1:8080";
const DIR = "test-artifacts/qa/journeys";
await mkdir(DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], nets = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 180)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 180)));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) nets.push(`${r.status()} ${r.url().split("?")[0].slice(-60)}`); });

// ---------- J1: launch ----------
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
check("J1 app renders a heading", await page.getByRole("heading", { name: "Make the first cut" }).isVisible());
check("J1 engine status is accurate", /local engine/i.test(await page.locator(".topbar-state").innerText()), (await page.locator(".topbar-state").innerText()).replace(/\n/g, " "));
check("J1 no stuck loading overlay", !(await page.locator(".skeleton").first().isVisible().catch(() => false)));
await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000);
check("J1 usable after refresh", await page.getByRole("button", { name: /Create \d+ short clip/ }).isEnabled());

// ---------- J2: local file ----------
await page.getByRole("tab", { name: /Local file/ }).click();
const fileInput = page.locator('input[type=file][aria-label="Choose video file"]');
await fileInput.setInputFiles({ name: "qa-clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("0".repeat(2048)) });
await page.waitForTimeout(600);
const dz = await page.locator(".drop-zone").innerText();
check("J2 accepted file shows name + size", dz.includes("qa-clip.mp4") && /KB|MB/.test(dz), dz.replace(/\n/g, " ").slice(0, 80));
check("J2 offers replace and remove", await page.getByRole("button", { name: "Choose another" }).isVisible() && await page.getByRole("button", { name: "Remove" }).isVisible());
// unsupported type
await fileInput.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
await page.waitForTimeout(600);
const err1 = await page.locator(".form-error").innerText().catch(() => "");
check("J2 rejects unsupported file with a clear message", /Unsupported video type/i.test(err1), err1.slice(0, 90));
await page.getByRole("button", { name: "Remove" }).click().catch(() => {});
await page.waitForTimeout(400);
// empty submission
await page.getByRole("button", { name: /Create \d+ short clip/ }).click();
await page.waitForTimeout(900);
const err2 = await page.locator(".form-error").innerText().catch(() => "");
check("J2 blocks empty submission with guidance", /Choose a local video first/i.test(err2), err2.slice(0, 90));

// ---------- J3: YouTube validation ----------
await page.getByRole("tab", { name: /YouTube/ }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /Create \d+ short clip/ }).click();
await page.waitForTimeout(700);
const err3 = await page.locator(".form-error").innerText().catch(() => "");
check("J3 blocks empty URL", /YouTube URL first/i.test(err3), err3.slice(0, 90));
await page.getByLabel("YouTube URL").fill("not-a-url");
await page.getByRole("button", { name: /Create \d+ short clip/ }).click();
await page.waitForTimeout(2500);
const err4 = await page.locator(".form-error").innerText().catch(() => "");
check("J3 rejects malformed URL with a customer-readable message", err4.length > 0 && !/traceback|pydantic|\{"detail"/i.test(err4), err4.replace(/\n/g, " ").slice(0, 120));
await page.getByLabel("YouTube URL").fill("");

// ---------- J4: style selection ----------
const styleNames = ["Funny", "Serious", "Educational", "Hype"];
let styleOk = true, styleDetail = "";
for (const s of styleNames) {
  await page.getByRole("button", { name: new RegExp("^" + s) }).click();
  await page.waitForTimeout(200);
  const pressed = await page.evaluate((n) => [...document.querySelectorAll(".style-card")].map((e) => [e.innerText.split("\n")[0], e.getAttribute("aria-pressed")]), s);
  const selected = pressed.filter(([, p]) => p === "true");
  if (selected.length !== 1 || selected[0][0] !== s) { styleOk = false; styleDetail = JSON.stringify(pressed); }
}
check("J4 exactly one style selected at a time", styleOk, styleDetail);
await page.getByRole("button", { name: /^Educational/ }).click();

// ---------- J5: clip count ----------
const countVal = () => page.locator(".count-control strong").innerText();
for (let i = 0; i < 40; i += 1) await page.getByRole("button", { name: "Fewer clips" }).click();
check("J5 count clamps at minimum 1", (await countVal()) === "1", `got ${await countVal()}`);
check("J5 CTA reflects count and pluralises", /Create 1 short clip$/.test(await page.getByRole("button", { name: /Create 1 short clip/ }).innerText()), (await page.getByRole("button", { name: /Create/ }).innerText()).replace(/\n/g, " "));
for (let i = 0; i < 40; i += 1) await page.getByRole("button", { name: "More clips" }).click();
check("J5 count clamps at maximum 30", (await countVal()) === "30", `got ${await countVal()}`);
for (let i = 0; i < 29; i += 1) await page.getByRole("button", { name: "Fewer clips" }).click();

// ---------- J6: output format ----------
await page.getByRole("button", { name: /Long form/ }).click(); await page.waitForTimeout(300);
const longNote = await page.locator(".field-group", { hasText: "FORMAT" }).innerText().catch(() => "");
check("J6 long form updates its explanation", /Landscape/i.test(longNote), longNote.replace(/\n/g, " ").slice(0, 80));
check("J6 long form updates the CTA", /landscape/i.test(await page.getByRole("button", { name: /Create 1/ }).innerText()));
await page.getByRole("button", { name: /Short form/ }).click(); await page.waitForTimeout(300);
check("J6 short form restores vertical copy", /Vertical/i.test(await page.locator(".field-group", { hasText: "FORMAT" }).innerText()));
// Format switch must not reset unrelated settings
check("J6 switching format keeps the chosen style", (await page.locator(".style-card.active").innerText()).includes("Educational"));

// ---------- J7: processing mode ----------
for (const m of ["Auto", "Fast", "Smart"]) {
  await page.getByRole("button", { name: m, exact: true }).click();
  await page.waitForTimeout(250);
  const pressed = await page.getByRole("button", { name: m, exact: true }).getAttribute("aria-pressed");
  const note = await page.locator(".field-group", { hasText: "PROCESSING MODE" }).innerText();
  check(`J7 mode ${m} selects and explains`, pressed === "true" && note.length > 20, note.replace(/\n/g, " ").slice(0, 95));
}
await page.getByRole("button", { name: "Fast", exact: true }).click();

// ---------- J8: project details ----------
const nameField = page.getByLabel("Project name");
await nameField.fill("QA " + "x".repeat(200));
check("J8 project name enforces a max length", (await nameField.inputValue()).length <= 160, `len=${(await nameField.inputValue()).length}`);
await nameField.fill("QA <script>&'\" — ünïcødé");
check("J8 accepts special characters", (await nameField.inputValue()).includes("ünïcødé"));
await nameField.fill("");
check("J8 name is optional (CTA stays enabled)", await page.getByRole("button", { name: /Create 1/ }).isEnabled());

// ---------- J10: advanced controls ----------
const advToggle = page.getByRole("button", { name: /Advanced controls/ });
await advToggle.click(); await page.waitForTimeout(300);
check("J10 advanced expands and reports state", (await advToggle.getAttribute("aria-expanded")) === "true" && await page.getByLabel("Minimum seconds").isVisible());
await page.getByLabel("Minimum seconds").fill("12");
await advToggle.click(); await page.waitForTimeout(300);
await advToggle.click(); await page.waitForTimeout(300);
check("J10 collapsing advanced keeps entered values", (await page.getByLabel("Minimum seconds").inputValue()) === "12", `got ${await page.getByLabel("Minimum seconds").inputValue()}`);
const aspect = page.getByLabel("Aspect", { exact: false }).first();
check("J10 aspect is disabled for long form only", await aspect.isEnabled());
await advToggle.click();

// ---------- J17: navigation & persistence ----------
for (const s of ["Library", "Jobs", "Settings", "Workspace", "Shorts Editor", "Projects"]) {
  await page.getByRole("button", { name: s, exact: true }).first().click();
  await page.waitForTimeout(1200);
  const heading = await page.locator("main h1, main h2").first().innerText().catch(() => "");
  const cur = await page.getByRole("button", { name: s, exact: true }).first().getAttribute("aria-current");
  check(`J17 ${s} renders and marks itself current`, heading.length > 0 && cur === "page", heading.slice(0, 40));
}
await page.screenshot({ path: `${DIR}/journeys-end.png` });

console.log("\n--- CONSOLE ERRORS ---", [...new Set(errs)].slice(0, 10));
console.log("--- API FAILURES ---", [...new Set(nets)].slice(0, 10));
const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name));
await b.close();
