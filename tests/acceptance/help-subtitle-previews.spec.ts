import { expect, test } from "@playwright/test";
import path from "node:path";
import { createClipProject, gateway, jobBoundaries, openProjects, root, waitForProjectReady } from "./support/workspace";

const styles = ["Funny", "Serious", "Educational", "Hype"] as const;
const previewPaths = Object.fromEntries(styles.map((style) => [style, `/help/subtitles-${style.toLowerCase()}.mp4`])) as Record<typeof styles[number], string>;
const isExpectedBrowserWarning = (text: string) => /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(text);

test.use({ storageState: { cookies: [], origins: [] } });
// A real YouTube import rendered behind a single job worker: in a full-suite
// run this job queues behind every other spec's work, and one measured run
// took 25 minutes end to end against the default 15-minute wait. Budget the
// wait from that measurement and give the test room for the Help dialog and
// the four preview players checked afterwards. 45 minutes matches the other
// real-media spec (shorts-background-blur). A genuine stall still shows up:
// waitForProjectReady prints progress as it goes, so it is distinguishable
// from slow.
const READY_DEADLINE_MS = 35 * 60_000;
test.setTimeout(45 * 60_000);

test("Help subtitle previews load and play after a YouTube source workflow", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isExpectedBrowserWarning(message.text())) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && (response.url().includes("/api/") || response.url().includes("/help/"))) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const projectName = `Help preview source ${Date.now()}`;
  let projectId: string | undefined;
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });
    const observed = new Set<string>();
    await createClipProject(page, {
      name: projectName,
      count: 1,
      mode: "Fast",
      aspect: "9:16",
      min: 8,
      max: 10,
      captions: false,
      source: { kind: "url", url: "https://www.youtube.com/watch?v=WwA_7QyqtGI" },
    });
    // Capture the durable ID as soon as the project exists so finally can
    // clean it up even if a slow real-media job hits the generous wait limit.
    projectId = (await jobBoundaries(projectName)).project.id;
    await waitForProjectReady(page, observed, "clip", READY_DEADLINE_MS);

    const openAndVerifyPreviews = async () => {
      await page.getByRole("button", { name: "Open S6 Cut Help" }).click();
      const dialog = page.getByRole("dialog", { name: "S6 Cut Help" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Subtitle styles" }).click();
      const section = dialog.locator("#help-subtitles");
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole("heading", { name: "Subtitle styles" })).toBeVisible();

      for (const style of styles) {
        const preview = dialog.getByTestId(`subtitle-preview-${style.toLowerCase()}`);
        await preview.scrollIntoViewIfNeeded();
        const video = preview.locator("video");
        await expect(video).toBeVisible();
        await expect(preview).toHaveAttribute("data-preview-state", "ready", { timeout: 30_000 });
        await expect(preview.getByRole("status")).toHaveCount(0);
        const source = await video.getAttribute("src");
        expect(source).toBe(previewPaths[style]);
        const media = await page.evaluate(async (url) => {
          const response = await fetch(url);
          const range = await fetch(url, { headers: { Range: "bytes=0-15" } });
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            bytes: (await response.arrayBuffer()).byteLength,
            rangeStatus: range.status,
            contentRange: range.headers.get("content-range"),
            rangeBytes: (await range.arrayBuffer()).byteLength,
            origin: new URL(response.url).origin,
          };
        }, source);
        expect(media.status, `${style} preview response`).toBe(200);
        expect(media.contentType).toMatch(/^video\/mp4/i);
        expect(media.rangeStatus).toBe(206);
        expect(media.contentRange).toMatch(/^bytes 0-15\//i);
        expect(media.rangeBytes).toBe(16);
        expect(media.bytes).toBeGreaterThan(1000);
        // Same-origin as the app under test: the point is that previews are
        // served by this gateway, not a third party. Pinning one machine's
        // address broke the test on every other host.
        expect(media.origin, `${style} preview origin`).toBe(new URL(gateway).origin);
        const dimensions = await video.evaluate((element) => {
          const player = element as HTMLVideoElement;
          return { readyState: player.readyState, width: player.videoWidth, height: player.videoHeight, error: player.error?.message ?? null };
        });
        expect(dimensions.readyState, `${style} readyState`).toBeGreaterThanOrEqual(2);
        expect(dimensions.width, `${style} video width`).toBeGreaterThan(0);
        expect(dimensions.height, `${style} video height`).toBeGreaterThan(0);
        expect(dimensions.error, `${style} media error`).toBeNull();

        await video.evaluate((element) => {
          const player = element as HTMLVideoElement;
          player.pause();
          player.currentTime = 0;
          void player.play();
        });
        await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 10_000, message: `${style} preview did not advance` }).toBeGreaterThan(0.1);
        const visual = await video.evaluate((element) => {
          const player = element as HTMLVideoElement;
          const canvas = document.createElement("canvas");
          canvas.width = player.videoWidth;
          canvas.height = player.videoHeight;
          const context = canvas.getContext("2d");
          if (!context) return { nonBlack: 0 };
          context.drawImage(player, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let nonBlack = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) nonBlack += 1;
          }
          return { nonBlack: nonBlack / (pixels.length / 4) };
        });
        expect(visual.nonBlack, `${style} preview is not blank`).toBeGreaterThan(0.01);
        await video.evaluate((element) => (element as HTMLVideoElement).pause());
      }

      await page.screenshot({ path: path.join(root, "test-artifacts/help-section-loaded.png"), fullPage: true });
      await section.screenshot({ path: path.join(root, "test-artifacts/subtitle-style-previews-loaded.png") });
      return dialog;
    };

    await openAndVerifyPreviews();
    await page.getByRole("button", { name: "Close S6 Cut Help" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await openAndVerifyPreviews();
    await page.getByRole("button", { name: "Close S6 Cut Help" }).click();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.getByRole("button", { name: "Open S6 Cut Help" }).click();
    const narrowDialog = page.getByRole("dialog", { name: "S6 Cut Help" });
    await narrowDialog.getByRole("button", { name: "Subtitle styles" }).click();
    await narrowDialog.locator("#help-subtitles").scrollIntoViewIfNeeded();
    for (const style of styles) {
      const preview = narrowDialog.getByTestId(`subtitle-preview-${style.toLowerCase()}`);
      await preview.scrollIntoViewIfNeeded();
      await expect(preview).toHaveAttribute("data-preview-state", "ready", { timeout: 30_000 });
      await expect(preview.locator("video")).toBeVisible();
    }

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
    expect(failedRequests, failedRequests.join("\n")).toEqual([]);
    expect(failedResponses, failedResponses.join("\n")).toEqual([]);
  } finally {
    if (projectId) await page.request.delete(`${gateway}/api/v1/projects/${projectId}?delete_assets=true`).catch(() => undefined);
  }
});
