import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

export type Asset = {
  id: string;
  title: string;
  origin: string;
  sourceProjectId: string | null;
  sourceJobId: string | null;
  sourceClipId: string | null;
  previewUrl: string | null;
  [key: string]: unknown;
};

export type RecentPage = {
  items: Asset[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
};

/** Fail closed: no implicit localhost/default dataset is ever accepted. */
export function requireIsolatedTarget() {
  const rawUrl = process.env.S6_ACCEPTANCE_URL;
  const rawData = process.env.S6_DATA_PATH;
  if (!rawUrl || !rawData) throw new Error("Set S6_ACCEPTANCE_URL and S6_DATA_PATH to the disposable acceptance app and dataset.");
  const url = new URL(rawUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname) || port < 20_000 || port > 65_535) {
    throw new Error("Acceptance target must use a unique loopback port in the 20000–65535 range.");
  }
  const dataPath = resolve(rawData);
  if (dirname(dataPath) !== "/tmp" || !/^s6-recent-clips-[a-zA-Z0-9-]{8,}$/.test(basename(dataPath))) {
    throw new Error("S6_DATA_PATH must be a uniquely named disposable /tmp/s6-recent-clips-<run-id> directory.");
  }
  if (!existsSync(`${dataPath}/recent-clips-fixture.json`)) {
    throw new Error("The isolated Recent clips fixture marker is missing; seed this disposable data directory first.");
  }
  return { base: url.origin, dataPath };
}

export async function recentClips(page: Page) {
  const { base } = requireIsolatedTarget();
  const response = await page.request.get(`${base}/api/v1/library/recent-clips?search=&page=1&page_size=12`);
  expect(response.ok(), `recent-clips API returned ${response.status()}`).toBeTruthy();
  const payload = await response.json() as RecentPage;
  expect(payload).toMatchObject({ page: 1, pageSize: 12 });
  expect(Array.isArray(payload.items)).toBeTruthy();
  expect(typeof payload.hasMore).toBe("boolean");
  expect(typeof payload.total).toBe("number");
  expect(payload.items.length).toBeLessThanOrEqual(12);
  return payload;
}

export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  return errors;
}

export async function assertPreviewAdvances(video: Locator) {
  await expect(video).toBeVisible();
  const playback = await video.evaluate(async (node: HTMLVideoElement) => {
    node.muted = true;
    if (node.readyState < 2) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview did not decode a frame")), 20_000);
      node.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Preview media decode failed")); }, { once: true });
    });
    const first = document.createElement("canvas");
    first.width = node.videoWidth; first.height = node.videoHeight;
    first.getContext("2d")!.drawImage(node, 0, 0);
    const firstPixels = first.getContext("2d")!.getImageData(0, 0, first.width, first.height).data;
    const before = node.currentTime;
    await node.play();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    node.pause();
    const second = document.createElement("canvas");
    second.width = node.videoWidth; second.height = node.videoHeight;
    second.getContext("2d")!.drawImage(node, 0, 0);
    const secondPixels = second.getContext("2d")!.getImageData(0, 0, second.width, second.height).data;
    let different = 0;
    for (let i = 0; i < firstPixels.length; i += 32) {
      if (firstPixels[i] !== secondPixels[i] || firstPixels[i + 1] !== secondPixels[i + 1] || firstPixels[i + 2] !== secondPixels[i + 2]) different++;
    }
    return { readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, advanced: node.currentTime - before, different };
  });
  expect(playback.readyState).toBeGreaterThanOrEqual(2);
  expect(playback.width * playback.height).toBeGreaterThan(0);
  expect(playback.advanced).toBeGreaterThan(0.05);
  expect(playback.different, "decoded preview frames should progress").toBeGreaterThan(0);
}
