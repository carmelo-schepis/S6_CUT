import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";

for (const connected of [false, true]) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test("Engine only submits local captions and hooks: connected=" + connected + ", width=" + viewport.width, async ({ page }) => {
      await page.setViewportSize(viewport);
      let submitted = "";
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        let body: unknown = [];
        if (path.endsWith("/health")) body = {
          status: "ready", version: "verification", database: true, ffmpeg: true, ffprobe: true,
          whisper: true, ytdlp: true, dataPath: "Isolated verification", freeBytes: 1e9,
          configuredWorkers: 1, activeWorkers: 0, queuedJobs: 0, fallbacks: {},
        };
        if (path.endsWith("/profiles")) body = connected ? [{
          id: "verification", name: "Mock connected provider", textModelId: "test/model", selected: true,
          persistence: "session", openrouterConfigured: true, textStatus: "connected",
          status: "connected", capabilities: [], fallbacks: {},
        }] : [];
        if (path.endsWith("/library/folders")) body = [{
          id: "00000000-0000-0000-0000-000000000001", name: "Unsorted", system: true,
          createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
        }];
        if (path.endsWith("/library/recent-clips")) body = { items: [], page: 1, pageSize: 12, hasMore: false, total: 0 };
        if (path.endsWith("/jobs/clip") && route.request().method() === "POST") {
          submitted = route.request().postData() || "";
          return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Verification captured submission" }) });
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Local engine ready", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
      const local = page.getByRole("button", { name: "Engine only", exact: true });
      await local.click();
      await expect(local).toHaveAttribute("aria-pressed", "true");
      const captions = page.getByRole("checkbox", { name: /Burn in subtitles/ });
      const hook = page.getByRole("checkbox", { name: "Hook text", exact: true });
      await expect(captions).toBeEnabled();
      await expect(captions).toBeChecked();
      await expect(hook).toBeEnabled();
      await hook.check();
      await page.getByRole("tab", { name: "YouTube", exact: true }).click();
      await page.getByRole("textbox", { name: "YouTube URL" }).fill("https://www.youtube.com/watch?v=fixture");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      const directory = process.env.S6_PLAYWRIGHT_ARTIFACTS || ".qa/local-engine-verification/browser";
      await fs.mkdir(directory, { recursive: true });
      await page.screenshot({ path: directory + "/local-" + connected + "-" + viewport.width + ".png", fullPage: true });
      await page.getByRole("button", { name: /Create 5 short clips/ }).click();
      await expect.poll(() => submitted).toContain('name="execution_policy"\r\n\r\nengine_only');
      expect(submitted).toContain('name="burn_subtitles"\r\n\r\ntrue');
      expect(submitted).toContain('name="hook_text"\r\n\r\ntrue');
      expect(errors).toEqual([]);
    });
  }
}
