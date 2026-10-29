import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:8080";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE); await page.waitForTimeout(3500);

// (2) count stepper -> 12
await page.getByRole("button", { name: "Short form · 9:16", exact: true }).click();
for (let i = 0; i < 7; i += 1) await page.getByRole("button", { name: "More clips", exact: true }).click();
console.log("count now:", await page.locator(".count-control strong").innerText());
console.log("CTA name:", JSON.stringify(await page.getByRole("button", { name: /^Create/ }).innerText()));
console.log("CTA aria:", JSON.stringify(await page.getByRole("button", { name: /^Create/ }).evaluate((e) => e.textContent)));

// (3) project search for the terminal-gaps target
const target = "Final Browser Retest 20260826T062538111Z";
const search = page.getByLabel("Search projects");
console.log("search box present:", await search.count());
await search.fill(target);
await page.waitForTimeout(1200);
console.log("cards matching:", await page.locator(".project-card").filter({ hasText: target }).count());
const btn = page.getByRole("button", { name: target, exact: false });
console.log("button by name count:", await btn.count());

// (4) provider callout
await search.fill("");
await page.waitForTimeout(500);
const callout = page.locator(".provider-callout:not(.compact)");
console.log("provider callout count:", await callout.count());
await b.close();
