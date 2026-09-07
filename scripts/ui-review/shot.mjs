import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const BASE = "http://127.0.0.1:8080";
const OUT = process.argv[2] || "test-artifacts/ui-review/detail";
const jobs = [
  { nav: "Projects", vp: [1440, 900], name: "projects-1440" },
  { nav: "Library", vp: [1440, 900], name: "library-1440" },
  { nav: "Jobs", vp: [1440, 900], name: "jobs-1440" },
  { nav: "Settings", vp: [1440, 900], name: "settings-1440" },
  { nav: "Shorts Editor", vp: [1440, 900], name: "shorts-1440" },
  { nav: "AI Video", vp: [1440, 900], name: "aivideo-1440" },
  { nav: "Projects", vp: [390, 844], name: "projects-390" },
  { nav: "Workspace", vp: [390, 844], name: "workspace-390" },
  { nav: "Settings", vp: [390, 844], name: "settings-390" },
  { nav: "Library", vp: [390, 844], name: "library-390" },
];
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
for (const j of jobs) {
  const ctx = await browser.newContext({ viewport: { width: j.vp[0], height: j.vp[1] } });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.waitForTimeout(1600);
  await page.getByRole("button", { name: j.nav, exact: true }).first().click();
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${OUT}/${j.name}.png` });
  await ctx.close();
}
await browser.close();
console.log("done", OUT);
