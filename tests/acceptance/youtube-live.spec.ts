import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyVideoOutput } from "../support/video-output";

const fixture = JSON.parse(await fs.readFile(fileURLToPath(new URL("../fixtures/youtube-live-sources.json", import.meta.url)), "utf8"));
const liveEnabled = process.env.S6_RUN_LIVE_YOUTUBE === "1";
const isolatedTargetConfirmed = process.env.S6_ACCEPTANCE_ISOLATED === "1";

// Opt-in only: this creates a real project, invokes yt-dlp through the normal API,
// and renders one short. It must target an isolated test deployment/data root.
test.describe("live YouTube workflow", () => {
  test.skip(!liveEnabled, "Set S6_RUN_LIVE_YOUTUBE=1 to run against an isolated live deployment");

  test.beforeAll(() => {
    if (liveEnabled && !isolatedTargetConfirmed) {
      throw new Error("Live YouTube tests create data; set S6_ACCEPTANCE_ISOLATED=1 only for a disposable test deployment");
    }
  });

  test("imports the supplied source and produces playable, varying video", async ({ page }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const source = fixture.sources[0] as { url: string; videoId: string };
    const projectName = `YouTube live ${source.videoId} ${Date.now()}`;
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText || "request failed";
      // Seeking intentionally cancels superseded media range reads in Chromium.
      if (!(request.resourceType() === "media" && failure.includes("ERR_ABORTED"))) {
        errors.push(`request: ${request.method()} ${request.url()} ${failure}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.request().method()} ${response.url()}`);
    });

    await page.goto("/");
    await page.getByRole("tab", { name: "YouTube" }).click();
    await page.getByRole("textbox", { name: "YouTube URL" }).fill(source.url);
    await page.getByRole("textbox", { name: "Project name" }).fill(projectName);
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
    await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();

    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
    const readyStep = page.locator(".process-checklist li").filter({ hasText: "Project ready" });
    await expect(readyStep).toHaveClass(/status-(complete|failed)/, { timeout: 14 * 60_000 });
    await expect(readyStep).toHaveClass(/status-complete/);

    const video = page.getByRole("region", { name: "Output viewer" }).locator("video");
    const evidence = await verifyVideoOutput({
      video,
      artifactDirectory: testInfo.outputDir,
      artifactPrefix: "youtube-live",
      maximumDurationSeconds: 180,
      expectedWidth: 1080,
      expectedHeight: 1920,
    });

    await testInfo.attach("video-evidence", {
      body: Buffer.from(JSON.stringify({ ...evidence, source: { videoId: source.videoId } }, null, 2)),
      contentType: "application/json",
    });
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
