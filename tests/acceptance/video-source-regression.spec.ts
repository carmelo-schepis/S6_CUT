import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipProject, waitForProjectReady } from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const acceptedUrl = "https://www.youtube.com/watch?v=KNVr5pHAygI";

test.describe("existing source creation regressions", () => {
  test("normal YouTube Fast clip creation still reaches Workspace", async ({ page }) => {
    test.setTimeout(8 * 60_000);
    const projectName = `YouTube clip regression ${Date.now()}`;
    const observed = new Set<string>();
    await page.goto("/");
    await createClipProject(page, {
      name: projectName, count: 1, mode: "Fast", aspect: "9:16", min: 8, max: 12,
      captions: false, source: { kind: "url", url: acceptedUrl },
    });
    await waitForProjectReady(page, observed, 6 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 60_000 });
    expect([...observed].some((step) => step.startsWith("Project ready:"))).toBe(true);
  });

  test("normal local-file clip creation still reaches Workspace", async ({ page }) => {
    test.setTimeout(8 * 60_000);
    const projectName = `Local file clip regression ${Date.now()}`;
    const observed = new Set<string>();
    await page.goto("/");
    await createClipProject(page, {
      name: projectName, count: 1, mode: "Fast", aspect: "9:16", min: 8, max: 12,
      captions: false, source: { kind: "file", path: path.join(root, "tests/fixtures/openrouter-fallback.mp4") },
    });
    await waitForProjectReady(page, observed, 6 * 60_000);
    await expect(page.locator(".clip-tile.complete")).toHaveCount(1, { timeout: 60_000 });
    expect([...observed].some((step) => step.startsWith("Project ready:"))).toBe(true);
  });
});
