import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/acceptance",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "test-artifacts/playwright-report", open: "never" }], ["json", { outputFile: "test-artifacts/playwright-results.json" }]],
  use: {
    baseURL: process.env.S6_ACCEPTANCE_URL || "http://127.0.0.1:8080",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  outputDir: "test-artifacts/test-results",
});
