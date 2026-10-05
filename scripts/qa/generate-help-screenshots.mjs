import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.S6_HELP_BASE_URL || "http://127.0.0.1:5173";
const output = new URL("../../web/public/help/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(baseURL, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Projects", exact: true }).click();
await page.getByRole("heading", { name: "Create a project" }).waitFor();

async function openWorkspaceForProject(name) {
  const projectResponse = await page.request.get(new URL("/api/v1/projects", baseURL).toString());
  if (!projectResponse.ok()) throw new Error(`Could not load projects: HTTP ${projectResponse.status()}`);
  const projects = await projectResponse.json();
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`Project not found: ${name}`);

  const jobsResponse = await page.request.get(new URL("/api/v1/jobs", baseURL).toString());
  if (!jobsResponse.ok()) throw new Error(`Could not load jobs: HTTP ${jobsResponse.status()}`);
  const job = (await jobsResponse.json()).find((item) => item.projectId === project.id);
  if (!job) throw new Error(`Job not found for project: ${name}`);

  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("heading", { name: "Jobs & recovery" }).waitFor();
  const jobCard = page.locator(`.job-card[data-job-id="${job.id}"]`);
  const showAll = page.getByRole("button", { name: /^Show all \d+ jobs$/ });
  await page.waitForFunction((jobId) => document.querySelector(`.job-card[data-job-id="${jobId}"]`) || document.querySelector(".jobs-page .show-all-projects"), job.id);
  if (await jobCard.count() === 0) await showAll.click();
  await jobCard.waitFor({ state: "visible" });
  await jobCard.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".viewer-stage").waitFor({ state: "visible" });
}

const styles = ["Funny", "Serious", "Educational", "Hype"];
for (const style of styles) {
  await openWorkspaceForProject(`Subtitle style ${style} latest`);
  await page.locator(".viewer-stage").screenshot({ path: new URL(`subtitles-${style.toLowerCase()}.png`, output).pathname });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("heading", { name: "Create a project" }).waitFor();
}

const captureLayout = async (name, setup) => {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("heading", { name: "Create a project" }).waitFor();
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
