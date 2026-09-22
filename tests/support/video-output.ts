import { expect, type Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

export type VideoOutputEvidence = {
  duration: number;
  width: number;
  height: number;
  readyState: number;
  mediaStatus: number;
  mediaContentType: string;
  playbackAdvanced: boolean;
  timestamps: number[];
  frameVariances: number[];
  frameBlackRatios: number[];
  frameDifferences: number[];
  screenshots: string[];
  overlaySample?: { variance: number; darkPixelRatio: number; brightPixelRatio: number };
};

type NormalizedRegion = { x: number; y: number; width: number; height: number };

type VerifyVideoOutputOptions = {
  video: Locator;
  artifactDirectory: string;
  artifactPrefix: string;
  maximumDurationSeconds: number;
  expectedWidth?: number;
  expectedHeight?: number;
  expectedOverlayRegion?: NormalizedRegion;
};

type FrameSample = {
  time: number;
  variance: number;
  blackRatio: number;
  grayscale: number[];
};

async function waitUntilPlayable(video: Locator): Promise<void> {
  await video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    if (media.error) throw new Error(media.error.message || `media error ${media.error.code}`);
    if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("video did not become playable within 30 seconds")), 30_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        media.removeEventListener("loadeddata", loaded);
        media.removeEventListener("error", failed);
      };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error(media.error?.message || "video decode failed")); };
      media.addEventListener("loadeddata", loaded, { once: true });
      media.addEventListener("error", failed, { once: true });
    });
  });
}

async function seekAndSample(video: Locator, timestamp: number, screenshotPath: string): Promise<FrameSample> {
  await video.evaluate(async (element, target) => {
    const media = element as HTMLVideoElement;
    if (media.error) throw new Error(media.error.message || `media error ${media.error.code}`);
    const bounded = Math.min(Math.max(target, 0), Math.max(0, media.duration - 0.05));
    if (Math.abs(media.currentTime - bounded) < 0.01 && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`video did not seek to ${bounded}`)), 10_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        media.removeEventListener("seeked", sought);
        media.removeEventListener("error", failed);
      };
      const sought = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error(media.error?.message || "video decode failed while seeking")); };
      media.addEventListener("seeked", sought, { once: true });
      media.addEventListener("error", failed, { once: true });
      media.currentTime = bounded;
    });
    if ("requestVideoFrameCallback" in media) {
      media.muted = true;
      await media.play();
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`video frame did not decode at ${bounded}`)), 5_000);
        media.requestVideoFrameCallback(() => {
          window.clearTimeout(timeout);
          media.pause();
          resolve();
        });
      });
    }
  }, timestamp);

  await video.screenshot({ path: screenshotPath });
  return video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas frame sampler is unavailable");
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const grayscale: number[] = [];
    let blackPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      grayscale.push(luminance);
      if (luminance < 8) blackPixels += 1;
    }
    const mean = grayscale.reduce((sum, value) => sum + value, 0) / grayscale.length;
    const variance = grayscale.reduce((sum, value) => sum + (value - mean) ** 2, 0) / grayscale.length;
    return { time: media.currentTime, variance, blackRatio: blackPixels / grayscale.length, grayscale };
  });
}

export async function verifyVideoOutput(options: VerifyVideoOutputOptions): Promise<VideoOutputEvidence> {
  const { video, artifactDirectory, artifactPrefix, maximumDurationSeconds, expectedWidth, expectedHeight, expectedOverlayRegion } = options;
  await fs.mkdir(artifactDirectory, { recursive: true });
  await expect(video).toBeVisible();
  await waitUntilPlayable(video);

  const metadata = await video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    return {
      duration: media.duration,
      width: media.videoWidth,
      height: media.videoHeight,
      readyState: media.readyState,
      error: media.error ? { code: media.error.code, message: media.error.message } : null,
      source: media.currentSrc,
    };
  });
  expect(metadata.error).toBeNull();
  expect(metadata.readyState).toBeGreaterThanOrEqual(2);
  expect(Number.isFinite(metadata.duration)).toBe(true);
  expect(metadata.duration).toBeGreaterThan(0);
  expect(metadata.duration).toBeLessThanOrEqual(maximumDurationSeconds);
  expect(metadata.width).toBeGreaterThan(0);
  expect(metadata.height).toBeGreaterThan(0);
  if (expectedWidth !== undefined) expect(metadata.width).toBe(expectedWidth);
  if (expectedHeight !== undefined) expect(metadata.height).toBe(expectedHeight);

  const mediaResponse = await video.evaluate(async (element) => {
    const response = await fetch((element as HTMLVideoElement).currentSrc, { headers: { Range: "bytes=0-1023" } });
    return { status: response.status, contentType: response.headers.get("content-type") || "" };
  });
  expect([200, 206]).toContain(mediaResponse.status);
  expect(mediaResponse.contentType).toMatch(/^video\//);

  const playbackStart = await video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    return media.currentTime;
  });
  await video.evaluate(async (element) => { await (element as HTMLVideoElement).play(); });
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(playbackStart + 0.25);
  const playbackEnd = await video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    media.pause();
    return media.currentTime;
  });

  const requestedTimestamps = [
    Math.min(0.1, metadata.duration * 0.05),
    metadata.duration / 2,
    Math.max(0, metadata.duration - Math.min(0.5, metadata.duration * 0.2)),
  ];
  const labels = ["begin", "middle", "end"];
  const screenshots = labels.map((label) => path.join(artifactDirectory, `${artifactPrefix}-${label}.png`));
  const samples: FrameSample[] = [];
  for (let index = 0; index < requestedTimestamps.length; index += 1) {
    samples.push(await seekAndSample(video, requestedTimestamps[index], screenshots[index]));
  }
  for (const sample of samples) {
    expect(sample.variance, `frame at ${sample.time}s is blank or uniform`).toBeGreaterThan(20);
    expect(sample.blackRatio, `frame at ${sample.time}s is almost entirely black`).toBeLessThan(0.98);
  }
  const frameDifferences = samples.slice(1).map((sample, index) =>
    sample.grayscale.reduce((sum, value, pixel) => sum + Math.abs(value - samples[index].grayscale[pixel]), 0) / sample.grayscale.length,
  );
  expect(
    frameDifferences.some((difference) => difference > 1),
    `all sampled frames appear frozen: ${JSON.stringify({ timestamps: samples.map((sample) => sample.time), frameDifferences })}`,
  ).toBe(true);

  const overlaySample = expectedOverlayRegion ? await video.evaluate((element, region) => {
    const media = element as HTMLVideoElement;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas overlay sampler is unavailable");
    context.drawImage(
      media,
      region.x * media.videoWidth,
      region.y * media.videoHeight,
      region.width * media.videoWidth,
      region.height * media.videoHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values: number[] = [];
    let dark = 0;
    let bright = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      values.push(luminance);
      if (luminance < 25) dark += 1;
      if (luminance > 180) bright += 1;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      variance: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
      darkPixelRatio: dark / values.length,
      brightPixelRatio: bright / values.length,
    };
  }, expectedOverlayRegion) : undefined;
  if (overlaySample) {
    expect(overlaySample.variance, "creator-credit region is uniform").toBeGreaterThan(200);
    expect(overlaySample.darkPixelRatio, "creator-credit backing plate is absent").toBeGreaterThan(0.05);
    expect(overlaySample.brightPixelRatio, "creator-credit text is not visibly rendered").toBeGreaterThan(0.005);
  }

  return {
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    readyState: metadata.readyState,
    mediaStatus: mediaResponse.status,
    mediaContentType: mediaResponse.contentType,
    playbackAdvanced: playbackEnd > playbackStart + 0.25,
    timestamps: samples.map((sample) => sample.time),
    frameVariances: samples.map((sample) => sample.variance),
    frameBlackRatios: samples.map((sample) => sample.blackRatio),
    frameDifferences,
    screenshots,
    overlaySample,
  };
}
