import { defineConfig, devices } from "@playwright/test";

const artifactRoot = process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts";
const testOutput = process.env.S6_PLAYWRIGHT_ARTIFACTS ? `${artifactRoot}/test-results` : "test-artifacts/test-results";
const chromiumLaunchOptions = process.env.S6_PLAYWRIGHT_DISABLE_GPU === "1" ? { launchOptions: { args: ["--disable-gpu"] } } : {};

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
    headless: true,
    trace: process.env.S6_ACCEPTANCE_TRACE === "1" ? "on" : "retain-on-failure",
    video: process.env.S6_PLAYWRIGHT_VIDEO === "1" ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "Desktop Chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium", ...chromiumLaunchOptions } },
    { name: "iPad WebKit portrait", use: { ...devices["iPad (gen 7)"], browserName: "webkit", userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", viewport: { width: 810, height: 1080 }, isMobile: true } },
    { name: "iPad WebKit landscape", use: { ...devices["iPad (gen 7)"], browserName: "webkit", userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", viewport: { width: 1080, height: 810 }, isMobile: true } },
    { name: "iPad WebKit desktop mode", use: { ...devices["iPad (gen 7)"], browserName: "webkit", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" } },
    { name: "iPhone WebKit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
    { name: "Android Chromium", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
  outputDir: testOutput,
});
