import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.S6_HELP_BASE_URL || "http://127.0.0.1:5173";
const output = new URL("../../web/public/help/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(baseURL, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Projects", exact: true }).click();

const styles = ["Funny", "Serious", "Educational", "Hype"];
for (const style of styles) {
  await page.locator(".project-card", { hasText: `Subtitle style ${style} latest` }).click();
  await page.locator(".viewer-stage").waitFor({ state: "visible" });
  await page.locator(".viewer-stage").screenshot({ path: new URL(`subtitles-${style.toLowerCase()}.png`, output).pathname });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("heading", { name: "Make the first cut" }).waitFor();
}

const captureLayout = async (name, setup) => {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("heading", { name: "Make the first cut" }).waitFor();
  await page.getByRole("button", { name: /Short form · 9:16/ }).click();
  await setup();
  await page.locator(".create-panel").screenshot({ path: new URL(`layout-${name}.png`, output).pathname });
};
await captureLayout("9-16", async () => {});
await captureLayout("16-9", async () => {
  await page.getByRole("button", { name: /Long form · 16:9/ }).click();
});
await captureLayout("1-1", async () => {
  await page.getByRole("button", { name: "Advanced controls" }).click();
  await page.locator(".advanced-grid select").selectOption("1:1");
});
await captureLayout("4-5", async () => {
  if (!await page.locator(".advanced-grid").count()) await page.getByRole("button", { name: "Advanced controls" }).click();
  await page.locator(".advanced-grid select").selectOption("4:5");
});
await browser.close();
console.log(`Generated subtitle and layout references in ${output.pathname}`);
