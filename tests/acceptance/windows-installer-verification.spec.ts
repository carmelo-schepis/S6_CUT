import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import { assertPlayback, checkPlayback, createClipProject, downloadTile, openWorkspaceForProject, waitForProjectReady } from "./support/workspace";

test("isolated Windows installer preserves playable Fast-mode media", async ({ page, request }, testInfo) => {
  test.skip(process.env.S6_INSTALLER_ISOLATED !== "1", "Only the disposable Windows installer worker may run this case");
  const name = process.env.S6_INSTALLER_NAME!;
  const recordPath = process.env.S6_INSTALLER_RECORD!;
  const errors: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i.test(message.text())) errors.push(message.text());
  });
  page.on("requestfailed", event => {
    if (event.failure()?.errorText !== "net::ERR_ABORTED") failures.push(`${event.method()} ${new URL(event.url()).pathname}: ${event.failure()?.errorText}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  for (const endpoint of ["/", "/healthz", "/api/health"]) expect((await request.get(endpoint)).ok()).toBeTruthy();
  await page.goto("/");
  if (process.env.S6_INSTALLER_MODE === "seed") {
    await createClipProject(page, { name, count: 1, mode: "Fast", aspect: "16:9", min: 8, max: 20, captions: false, source: { kind: "file", path: process.env.S6_INSTALLER_FIXTURE! } });
    await waitForProjectReady(page, new Set(), 180_000);
  } else {
    await openWorkspaceForProject(page, name);
  }
  const tile = page.locator(".clip-tile.complete");
  await expect(tile).toHaveCount(1);
  await tile.getByRole("button", { name: /Preview/ }).click();
  const playback = await assertPlayback(page);
  checkPlayback(playback, "Windows installed frontend");
  const file = process.env.S6_INSTALLER_DOWNLOAD!;
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  const downloaded = await downloadTile(page, tile, file);
  expect(playback.duration).toBeGreaterThan(0);
  expect(playback.videoWidth).toBeGreaterThan(0);
  const readIds = async (endpoint: string) => {
    const response = await request.get(endpoint);
    expect(response.ok()).toBeTruthy();
    return (await response.json() as Array<{ id: string }>).map(item => item.id).sort();
  };
  const ids = {
    projects: await readIds("/api/v1/projects"),
    jobs: await readIds("/api/v1/jobs"),
    assets: await readIds("/api/v1/library/assets"),
  };
  expect(ids.projects).toHaveLength(1);
  expect(ids.jobs).toHaveLength(1);
  expect(ids.assets.length).toBeGreaterThanOrEqual(2);
  if (process.env.S6_INSTALLER_MODE === "seed") {
    await fs.writeFile(recordPath, JSON.stringify({ name, ids, download: downloaded, playback }, null, 2));
  } else {
    const before = JSON.parse(await fs.readFile(recordPath, "utf8"));
    expect(ids).toEqual(before.ids);
    expect(downloaded.sha256).toBe(before.download.sha256);
    expect(downloaded.sizeBytes).toBe(before.download.sizeBytes);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await openWorkspaceForProject(page, name);
  await page.locator(".clip-tile.complete").getByRole("button", { name: /Preview/ }).click();
  checkPlayback(await assertPlayback(page), "Windows installed frontend after refresh");
  expect(errors, "unexpected browser errors").toEqual([]);
  expect(failures, "relevant network failures").toEqual([]);
});
