import { defineConfig, devices } from "@playwright/test";

const artifactRoot = process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts";
const testOutput = process.env.S6_PLAYWRIGHT_ARTIFACTS ? `${artifactRoot}/test-results` : "test-artifacts/test-results";

export default defineConfig({
  testDir: "./tests/acceptance",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: `${artifactRoot}/playwright-report`, open: "never" }], ["json", { outputFile: `${artifactRoot}/playwright-results.json` }]],
  use: {
    baseURL: process.env.S6_ACCEPTANCE_URL || process.env.S6_MUSIC_ACCEPTANCE_URL || "http://127.0.0.1:8080",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  outputDir: testOutput,
});
