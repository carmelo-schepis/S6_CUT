/**
 * A Library video preview must keep playing while the Library revalidates
 * behind it. Revalidation is routine — it fires when the window regains focus,
 * when another tab signals a change, and whenever a background render
 * publishes a clip — so a reset here is something a viewer hits in ordinary use.
 */
import { test, expect } from "@playwright/test";

test("Library preview keeps playing across a library revalidation", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(4_000);

  await page.getByRole("button", { name: "Library", exact: true }).first().click();
  await page.waitForTimeout(2_500);
  await page.getByLabel("Media type").selectOption("video");
  await page.waitForTimeout(2_000);

  const trigger = page.locator(".asset-preview-trigger").first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const video = page.locator(".video-preview-dialog video");
  await expect(video).toBeVisible({ timeout: 20_000 });

  // Sample the playhead while the Library revalidates behind the dialog. A
  // returning window raises the same signal a freshly published clip does.
  // Sampling stops at the natural end of the media so a short asset cannot be
  // mistaken for an interrupted one.
  const trace = await page.evaluate(async () => {
    const v = document.querySelector<HTMLVideoElement>(".video-preview-dialog video");
    if (!v) return { error: "no video" };
    v.muted = true;
    await v.play();
    const samples: { t: number; paused: boolean; ended: boolean }[] = [];
    for (let i = 0; i < 18; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      samples.push({ t: +v.currentTime.toFixed(3), paused: v.paused, ended: v.ended });
      if (i === 5) window.dispatchEvent(new Event("focus"));
      if (v.ended) break;
    }
    return { samples, duration: v.duration };
  });

  expect(trace.error).toBeUndefined();
  const samples = trace.samples!;
  const rewinds = samples.filter((s, i) => i > 0 && s.t < samples[i - 1].t - 0.05);
  const stopped = samples.filter((s) => s.paused && !s.ended);

  expect(rewinds, `playhead rewound during playback; trace=${JSON.stringify(samples.map((s) => s.t))}`).toEqual([]);
  expect(stopped, `preview was paused by a background re-render; trace=${JSON.stringify(samples)}`).toEqual([]);
  expect(samples.at(-1)!.t, "playhead should have advanced overall").toBeGreaterThan(1.0);
});
