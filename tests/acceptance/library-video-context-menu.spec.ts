import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Library video actions persist stars and preview video", async ({ page, request }) => {
  test.setTimeout(90_000);
  expect(process.env.S6_ACCEPTANCE_ISOLATED, "mutating test requires an isolated disposable app/backend").toBe("1");
  expect(process.env.S6_ACCEPTANCE_URL, "set the isolated branch app URL explicitly").toBeTruthy();

  const title = `Context menu QA ${Date.now()}`;
  const uploaded = await request.post("/api/v1/library/assets", { multipart: {
    file: { name: "context-menu-qa.mp4", mimeType: "video/mp4", buffer: await fs.readFile(path.join(root, "test-video.mp4")) },
    title,
    licence: "QA disposable",
    policy: "neutral",
  } });
  expect(uploaded.status()).toBe(200);
  const asset = await uploaded.json() as { id: string; title: string };
  const starUpdates: unknown[] = [];
  page.on("request", (requestEvent) => {
    if (requestEvent.method() === "PUT" && requestEvent.url().includes(`/api/v1/library/assets/${asset.id}`)) {
      try { starUpdates.push(requestEvent.postDataJSON()); } catch { starUpdates.push(requestEvent.postData()); }
    }
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    const card = page.locator(`.asset-card[data-asset-id="${asset.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator("img")).toBeVisible();
    await expect.poll(() => card.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Star", exact: true }).click();
    await expect(card.getByLabel("Starred")).toBeVisible();
    await expect.poll(() => starUpdates).toEqual([{ starred: true }]);

    await page.reload();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const reloadedCard = page.locator(`.asset-card[data-asset-id="${asset.id}"]`);
    await expect(reloadedCard.getByLabel("Starred")).toBeVisible();
    await reloadedCard.getByRole("button", { name: `Actions for ${title}` }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Undo star", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Undo star", exact: true }).click();
    await expect(reloadedCard.getByLabel("Starred")).toHaveCount(0);
    await expect.poll(() => starUpdates).toEqual([{ starred: true }, { starred: false }]);

    await reloadedCard.getByRole("button", { name: `Preview ${title}` }).click();
    const dialog = page.getByRole("dialog", { name: `${title} video preview` });
    const video = dialog.locator("video");
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Play video", exact: true }).click();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("library-video-preview.png"), fullPage: true });
    await page.getByRole("button", { name: "Close video preview", exact: true }).click();
  } finally {
    const cleanup = await request.delete(`/api/v1/library/assets/${asset.id}`);
    expect([204, 404]).toContain(cleanup.status());
  }
});
