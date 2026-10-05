import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { assertPreviewAdvances, recentClips, requireIsolatedTarget, watchErrors } from "./support/recent-clips";

// This is intentionally a real-app contract test (no route mocks). Seed the
// disposable database first; see tests/acceptance/RECENT-CLIPS.md.
test("asset-backed Recent clips stay authoritative across selection, deletion, tabs and reloads", async ({ page, context, browser }, testInfo) => {
  const isolated = requireIsolatedTarget();
  const browserErrors = watchErrors(page);
  const initial = await recentClips(page);
  expect(initial.items.length).toBeGreaterThan(0);
  expect(initial.total).toBeGreaterThan(12);
  expect(initial.hasMore).toBeTruthy();
  expect(new Set(initial.items.map((asset) => asset.id)).size).toBe(initial.items.length);
  for (const asset of initial.items) {
    expect(asset.origin).toMatch(/^(generated-clip|script-output)$/);
    expect(asset.sourceProjectId).toBeTruthy();
    expect(asset.sourceJobId).toBeTruthy();
    expect(asset.sourceClipId).toBeTruthy();
    expect(asset.previewUrl).toBeTruthy();
  }

  const apiAssets = await page.request.get(`${isolated.base}/api/v1/library/assets`).then((response) => response.json()) as { id: string; title: string; origin: string; sourceProjectId: string | null; folderId: string; protected: boolean }[];
  const fixture = JSON.parse(await readFile(`${isolated.dataPath}/recent-clips-fixture.json`, "utf8")) as { sourceAssetId: string; retainedSourceAssetId: string };
  const authoritative = new Map(apiAssets.map((asset) => [asset.id, asset]));
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const recent = page.locator(".recent-clips-section");
  const cards = page.locator(".recent-clip-card");
  await expect(cards).toHaveCount(initial.items.length);
  const renderedTitles: string[] = [];
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    const expected = initial.items[index];
    expect(authoritative.has(expected.id)).toBeTruthy();
    await expect(card).toHaveAttribute("data-asset-id", expected.id);
    await expect(card).toContainText(expected.title);
    renderedTitles.push(expected.title);
  }
  expect(renderedTitles).toEqual(initial.items.map((asset) => asset.title));
  await page.screenshot({ path: testInfo.outputPath("recent-clips-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("recent-clips-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Same-title assets are seeded on different projects. Open must carry the
  // clicked asset ID rather than finding by title or selecting the first match.
  const duplicate = initial.items.find((asset, index) => initial.items.some((other, otherIndex) => otherIndex !== index && other.title === asset.title));
  expect(duplicate, "fixture requires duplicate titles on distinct output assets").toBeTruthy();
  const duplicateIndex = initial.items.findIndex((asset) => asset.id === duplicate!.id);
  await cards.nth(duplicateIndex).getByRole("button", { name: "View in Library" }).click();
  await expect(page.locator(".asset-card.active")).toHaveCount(1);
  await expect(page.locator(`.asset-card.active[data-asset-id="${duplicate!.id}"]`)).toContainText(duplicate!.title);
  await expect(page.locator(`.asset-card[data-asset-id="${duplicate!.id}"]`)).toHaveClass(/active/);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const pageTwo = await page.request.get(`${isolated.base}/api/v1/library/recent-clips?search=&page=2&page_size=12`).then((response) => response.json()) as { items: { id: string; title: string }[]; page: number };
  expect(pageTwo.page).toBe(2);
  await page.locator(".recent-clip-pagination").getByRole("button", { name: "Next" }).click();
  const secondPageCards = page.locator(".recent-clip-card");
  await expect(secondPageCards).toHaveCount(pageTwo.items.length);
  await expect(secondPageCards.first()).toContainText(pageTwo.items[0].title);
  await secondPageCards.first().getByRole("button", { name: "View in Library" }).click();
  await expect(page.locator(".asset-card.active")).toHaveCount(1);
  await expect(page.locator(`.asset-card.active[data-asset-id="${pageTwo.items[0].id}"]`)).toContainText(pageTwo.items[0].title);
  await expect(page.locator(`.asset-card[data-asset-id="${pageTwo.items[0].id}"]`)).toHaveClass(/active/);

  // Real preview: decode a frame, play, and verify both time progression and
  // changed decoded pixels; mere URL loading is not accepted as playback.
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const firstCard = cards.first();
  await firstCard.getByRole("button", { name: /^Preview / }).click();
  await assertPreviewAdvances(page.getByRole("dialog").locator("video"));
  await page.keyboard.press("Escape");

  // Search/counts are server-authoritative. The held request is fetched from
  // the real API, then delayed so a newer no-results response wins first.
  const search = recent.getByRole("searchbox", { name: /recent clips/i });
  await search.fill("RC script output");
  await expect(cards).toHaveCount(1);
  await expect(recent.locator(".section-count")).toHaveText("1");
  const scriptOutput = apiAssets.find((asset) => asset.title === "RC script output");
  expect(scriptOutput).toBeTruthy();
  await expect(cards.first()).toHaveAttribute("data-asset-id", scriptOutput!.id);
  await search.fill("");
  await expect(cards).toHaveCount(initial.items.length);

  let delayedResponseSeen = false;
  await page.route("**/api/v1/library/recent-clips**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("search") !== "RC") return route.continue();
    const response = await route.fetch();
    delayedResponseSeen = true;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.fulfill({ response });
  });
  await search.fill("RC");
  await expect.poll(() => delayedResponseSeen).toBeTruthy();
  await search.fill("RC-no-such-fixture");
  await expect(recent.getByText("No clips match your search")).toBeVisible();
  await expect(recent.locator(".section-count")).toHaveText("0");
  await page.waitForTimeout(1_300);
  await expect(recent.getByText("No clips match your search")).toBeVisible();
  await expect(recent.locator(".section-count")).toHaveText("0");
  await page.unroute("**/api/v1/library/recent-clips**");
  await search.fill("");
  await expect(cards).toHaveCount(initial.items.length);

  // Delete one ordinary output through its card action, then verify server and
  // second-tab propagation without a hard reload.
  const deletable = initial.items.find((asset) => !asset.protected && asset.origin === "generated-clip" && asset.title !== "RC duplicate title");
  expect(deletable, "fixture needs an unprotected generated output").toBeTruthy();
  const otherTab = await context.newPage();
  const otherErrors = watchErrors(otherTab);
  await otherTab.goto("/", { waitUntil: "networkidle" });
  await otherTab.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(otherTab.locator(".recent-clip-card")).toHaveCount(initial.items.length);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search media").fill(deletable!.title);
  await page.getByRole("checkbox", { name: `Select ${deletable!.title}`, exact: true }).check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete media", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.locator(`.recent-clip-card[data-asset-id="${deletable!.id}"]`)).toHaveCount(0);
  await expect(otherTab.locator(`.recent-clip-card[data-asset-id="${deletable!.id}"]`)).toHaveCount(0, { timeout: 10_000 });
  const afterDelete = await recentClips(page);
  expect(afterDelete.items.some((asset) => asset.id === deletable!.id)).toBeFalsy();

  await page.reload({ waitUntil: "networkidle" });
  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  await fresh.goto("/", { waitUntil: "networkidle" });
  const freshIds = await recentClips(fresh).then((result) => result.items.map((asset) => asset.id));
  expect(freshIds).not.toContain(deletable!.id);
  await freshContext.close();

  // Bulk deletion uses the actual Library controls and exact IDs despite title
  // filtering. Select two unique, unprotected outputs outside the cascade set.
  const sourceAsset = apiAssets.find((asset) => asset.id === fixture.sourceAssetId);
  expect(sourceAsset).toBeTruthy();
  const bulkTargets = apiAssets.filter((asset) => asset.origin === "generated-clip" && asset.id !== deletable!.id && asset.title !== "RC duplicate title" && asset.sourceProjectId !== sourceAsset!.sourceProjectId).slice(0, 2);
  expect(bulkTargets).toHaveLength(2);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  for (const target of bulkTargets) {
    await page.getByLabel("Search media").fill(target.title);
    await page.getByRole("checkbox", { name: `Select ${target.title}`, exact: true }).check();
  }
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete 2 items", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const afterBulk = await recentClips(page);
  for (const target of bulkTargets) expect(afterBulk.items.some((asset) => asset.id === target.id)).toBeFalsy();

  // Protected-media refusal retains the exact asset and displays the server error.
  const protectedAsset = apiAssets.find((asset) => asset.title === "RC protected fixture");
  expect(protectedAsset).toBeTruthy();
  const protectedDelete = await page.request.post(`${isolated.base}/api/v1/library/assets/bulk-delete`, { data: { assetIds: [protectedAsset!.id] } });
  expect(protectedDelete.ok()).toBeTruthy();
  expect((await protectedDelete.json()).failed[protectedAsset!.id]).toMatch(/protected/i);
  const afterProtectedFailure = await page.request.get(`${isolated.base}/api/v1/library/assets`).then((response) => response.json()) as { id: string }[];
  expect(afterProtectedFailure.some((asset) => asset.id === protectedAsset!.id)).toBeTruthy();

  const folder = await page.request.get(`${isolated.base}/api/v1/library/folders`).then((response) => response.json()) as { id: string; name: string }[];
  const removable = folder.find((item) => item.name === "RC removable folder");
  expect(removable).toBeTruthy();
  const folderRemoval = await page.request.delete(`${isolated.base}/api/v1/library/folders/${removable!.id}?destination_folder_id=00000000-0000-0000-0000-000000000001&confirmed=true`);
  expect(folderRemoval.status()).toBe(204);
  const movedFolderAsset = await page.request.get(`${isolated.base}/api/v1/library/assets`).then((response) => response.json()) as { title: string; folderId: string }[];
  expect(movedFolderAsset.find((asset) => asset.title === "RC project 1 clip 2")?.folderId).toBe("00000000-0000-0000-0000-000000000001");

  const cascade = await page.request.post(`${isolated.base}/api/v1/library/assets/bulk-delete`, { data: { assetIds: [sourceAsset!.id] } });
  expect(cascade.ok()).toBeTruthy();
  expect((await cascade.json()).deleted).toContain(sourceAsset!.id);
  const afterCascade = await page.request.get(`${isolated.base}/api/v1/library/assets`).then((response) => response.json()) as { id: string; sourceProjectId: string | null; origin: string }[];
  expect(afterCascade.some((asset) => asset.sourceProjectId === sourceAsset!.sourceProjectId && asset.origin === "generated-clip")).toBeFalsy();
  expect(afterCascade.some((asset) => asset.id === fixture.retainedSourceAssetId && asset.origin === "project-source")).toBeTruthy();

  // Remove every remaining eligible output while unrelated stopped project/job
  // history and a linked source asset remain. The authoritative page must be
  // empty even though history and non-output media still exist.
  const finalOutputs = await recentClips(page);
  expect(finalOutputs.total).toBeGreaterThan(0);
  const finalDelete = await page.request.post(`${isolated.base}/api/v1/library/assets/bulk-delete`, { data: { assetIds: finalOutputs.items.map((asset) => asset.id) } });
  expect(finalDelete.ok()).toBeTruthy();
  expect((await finalDelete.json()).deleted).toHaveLength(finalOutputs.items.length);
  const emptyRecent = await recentClips(page);
  expect(emptyRecent).toMatchObject({ items: [], total: 0, hasMore: false });
  const remainingAssets = await page.request.get(`${isolated.base}/api/v1/library/assets`).then((response) => response.json()) as { id: string; origin: string }[];
  expect(remainingAssets.some((asset) => asset.id === fixture.retainedSourceAssetId && asset.origin === "project-source")).toBeTruthy();
  const historyProjects = await page.request.get(`${isolated.base}/api/v1/projects`).then((response) => response.json()) as { name: string }[];
  expect(historyProjects.filter((project) => project.name.startsWith("RC historical stopped "))).toHaveLength(15);
  const historyJobs = await page.request.get(`${isolated.base}/api/v1/jobs`).then((response) => response.json()) as { state: string }[];
  expect(historyJobs.filter((job) => job.state === "cancelled_kept").length).toBeGreaterThanOrEqual(15);

  const purgeRefusal = await page.request.post(`${isolated.base}/api/v1/library/purge`, { data: { confirmation: "not the required phrase" } });
  expect(purgeRefusal.status()).toBe(409);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Delete all Library content/i }).click();
  await page.locator("#purge-confirmation").fill("DELETE ALL CONTENT");
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByText("Library is empty")).toBeVisible();
  await expect(otherTab.locator(".recent-clip-card")).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByText("No clips in your Library yet.")).toBeVisible();
  expect((await recentClips(page)).total).toBe(0);
  await otherTab.close();

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(otherErrors, otherErrors.join("\n")).toEqual([]);
});
