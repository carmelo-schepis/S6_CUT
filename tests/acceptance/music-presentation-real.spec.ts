import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const base = process.env.S6_MUSIC_ACCEPTANCE_URL || "";
const fixture = process.env.S6_MUSIC_FIXTURE || "";
const artifactRoot = process.env.S6_MUSIC_ARTIFACTS || "";
const engineImage = process.env.S6_MUSIC_ENGINE_IMAGE || "";
const explicitlyAuthorized = Boolean(base && fixture && artifactRoot && engineImage && process.env.S6_MUSIC_ACCEPTANCE === "1" && !process.env.S6_TEST_TRANSCRIPT_JSON);
const artifacts = process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts/music-acceptance/playwright";
const endpoint = (pathName: string) => `${base}/api/v1${pathName}`;
const json = async (pathName: string) => {
  const response = await fetch(endpoint(pathName));
  if (!response.ok) throw new Error(`GET ${pathName} failed with HTTP ${response.status}`);
  return response.json();
};
const mediaPath = (file: string) => {
  const relative = path.relative(artifactRoot, path.resolve(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`media inspection path is outside the isolated artifact directory: ${file}`);
  return path.posix.join("/qa", relative.split(path.sep).join("/"));
};
const media = (tool: string, args: string[], binary = false) => {
  const command = ["run", "--rm", "--network", "none", "--volume", `${artifactRoot}:/qa:rw`, "--entrypoint", tool, engineImage, ...args];
  return binary ? exec("docker", command, { encoding: "buffer" }) : exec("docker", command);
};
const ffprobe = async (file: string) => JSON.parse(String((await media("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", mediaPath(file)])).stdout));
const decode = async (file: string) => media("ffmpeg", ["-v", "error", "-xerror", "-i", mediaPath(file), "-f", "null", "-"]);
const regionRgb = async (file: string, time: number, region: string) => {
  const stdout = Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", String(time), "-i", mediaPath(file), "-vf", `crop=${region},scale=1:1:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], true)).stdout);
  expect(stdout.length).toBe(3);
  return [...stdout];
};
const regionColorPixelCount = async (file: string, time: number, region: string) => {
  const pixels = Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", String(time), "-i", mediaPath(file), "-vf", `crop=${region},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], true)).stdout);
  expect(pixels.length % 3).toBe(0);
  let colored = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const channels = [pixels[index], pixels[index + 1], pixels[index + 2]];
    if (Math.max(...channels) - Math.min(...channels) > 24) colored++;
  }
  return colored;
};
const audioSamples = async (file: string, time: number) => Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", String(time), "-i", mediaPath(file), "-t", "0.75", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], true)).stdout);
const correlation = (left: Buffer, right: Buffer) => {
  const a = new Int16Array(left.buffer, left.byteOffset, Math.floor(left.length / 2));
  const b = new Int16Array(right.buffer, right.byteOffset, Math.floor(right.length / 2));
  let best = -1;
  for (let lag = -160; lag <= 160; lag += 4) {
    const aStart = Math.max(0, -lag);
    const bStart = Math.max(0, lag);
    const length = Math.min(a.length - aStart, b.length - bStart);
    if (length < 4000) continue;
    let aMean = 0, bMean = 0;
    for (let index = 0; index < length; index++) { aMean += a[aStart + index]; bMean += b[bStart + index]; }
    aMean /= length; bMean /= length;
    let covariance = 0, aVariance = 0, bVariance = 0;
    for (let index = 0; index < length; index++) {
      const av = a[aStart + index] - aMean, bv = b[bStart + index] - bMean;
      covariance += av * bv; aVariance += av * av; bVariance += bv * bv;
    }
    best = Math.max(best, covariance / Math.sqrt(aVariance * bVariance));
  }
  return best;
};
const capture = async (file: string, time: number, name: string) => {
  const target = path.join(artifacts, "music-frames", name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.chmod(path.dirname(target), 0o777);
  await media("ffmpeg", ["-y", "-v", "error", "-ss", String(time), "-i", mediaPath(file), "-frames:v", "1", mediaPath(target)]);
  return target;
};

test("real authorized sung-vocal Music presentation: all themes, render, playback and exports", async ({ browser }, testInfo) => {
  test.skip(!explicitlyAuthorized, "requires the isolated real-render runner, human-sung authorized vocals, and live local transcription");
  testInfo.setTimeout(60 * 60_000);
  await fs.mkdir(artifacts, { recursive: true });
  const browserErrors: string[] = [];
  const externalRequests: string[] = [];
  const fontRequests: string[] = [];
  const results: Array<{ theme: string; jobId: string; clipIds: string[]; downloadHashes: string[]; audioCorrelations: number[] }> = [];
  const context = await browser.newContext({ acceptDownloads: true, baseURL: base });
  context.on("page", (page) => {
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`console: ${message.text()}`); });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== new URL(base).origin) externalRequests.push(`${request.method()} ${request.url()}`);
      if (/\.(?:ttf|woff2?)(?:\?|$)/i.test(url.pathname)) fontRequests.push(url.href);
    });
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText;
      if (error !== "net::ERR_ABORTED") browserErrors.push(`request failed: ${request.method()} ${request.url()} ${error}`);
    });
    page.on("response", (response) => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()} ${response.url()}`); });
  });
  const themes = [
    { id: "clean", label: "Clean sans" },
    { id: "warm", label: "Warm highlight" },
    { id: "serif", label: "Soft serif" },
    { id: "reference_white_sans", label: "Reference white sans" },
    { id: "reference_yellow_sans", label: "Reference yellow sans" },
    { id: "reference_white_serif", label: "Reference white serif" },
  ] as const;
  for (const [{ id: theme, label }, themeIndex] of themes.map((item, index) => [item, index] as const)) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const created = page.waitForResponse((response) => response.url().includes("/api/v1/jobs/clip") && response.request().method() === "POST");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await page.getByRole("button", { name: /Music.*sung vocals/i }).click();
    await page.getByLabel("Choose video file").setInputFiles(fixture);
    const themeButton = page.getByRole("button", { name: new RegExp(label, "i") });
    await expect(themeButton).toBeVisible();
    const keyboardChoice = themes[(themeIndex + 1) % themes.length];
    const keyboardButton = page.getByRole("button", { name: new RegExp(keyboardChoice.label, "i") });
    await keyboardButton.focus();
    await keyboardButton.press("Space");
    await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");
    await themeButton.click();
    await expect(themeButton).toHaveAttribute("aria-pressed", "true");
    await expect(themeButton).toHaveClass(/active/);
    const referenceSans = theme === "reference_white_sans" || theme === "reference_yellow_sans";
    const referenceSerif = theme === "reference_white_serif";
    if (referenceSans || referenceSerif) {
      const sample = themeButton.locator("span").first();
      await expect.poll(() => sample.evaluate((node) => getComputedStyle(node).fontFamily)).toContain(referenceSans ? "Reference Roboto Condensed" : "Reference Bodoni Moda");
      const fontLoaded = await page.evaluate(async (isSans: boolean) => {
        const descriptor = isSans ? '300 15px "Reference Roboto Condensed"' : '400 15px "Reference Bodoni Moda"';
        return (await document.fonts.load(descriptor)).length > 0 && document.fonts.check(descriptor);
      }, referenceSans);
      expect(fontLoaded, "the selected locally bundled browser font is loaded").toBe(true);
    }
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(dimensions.width, "Music controls fit the mobile viewport").toBeLessThanOrEqual(dimensions.viewport);
    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopDimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(desktopDimensions.width, "Music controls fit the desktop viewport").toBeLessThanOrEqual(desktopDimensions.viewport);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox", { name: /top text/i }).fill(`Authorized vocals — ${theme}`);
    const count = page.locator(".count-control strong");
    await expect(count).toHaveText("5");
    while (await count.textContent() !== "2") await page.getByRole("button", { name: "Fewer clips" }).click();
    await expect(page.getByRole("button", { name: /Create 2 short clips/i })).toBeEnabled();
    await page.getByRole("button", { name: /Create 2 short clips/i }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(202);
    const createdBody = await createdResponse.json();
    const jobId = createdBody.job.id as string;
    expect(createdBody.project).toMatchObject({ mode: "clip", sourceProfile: "music", contentFormat: "short", requestedCount: 2 });
    expect(createdBody.job).toMatchObject({ sourceProfile: "music", processingMode: "smart", musicPresentation: { version: 1, subtitleTheme: theme }, musicTopText: `Authorized vocals — ${theme}` });
    expect(createdBody.job.musicPresentation.subtitleTheme).toBe(theme);
    await expect.poll(async () => (await (await fetch(endpoint(`/jobs/${jobId}`))).json()).state, { timeout: 50 * 60_000, intervals: [1000, 3000, 8000] }).toBe("complete");
    const job = await json(`/jobs/${jobId}`);
    expect(job).toMatchObject({ mode: "clip", processingMode: "smart", sourceProfile: "music", musicPresentation: { version: 1, subtitleTheme: theme } });
    expect(job.musicPresentation.subtitleTheme).toBe(theme);
    expect(job.clips).toHaveLength(2);
    expect(job.clips.map((clip: { musicTreatment: string }) => clip.musicTreatment).sort()).toEqual(["color", "grayscale"]);
    expect(job.clips.every((clip: { musicTopText: string }) => clip.musicTopText === `Authorized vocals — ${theme}`)).toBeTruthy();
    const transcribedLyrics = job.clips.flatMap((clip: { captionCues: Array<{ text: string }> }) => clip.captionCues).map((cue: { text: string }) => cue.text).join(" ").toLowerCase();
    expect(transcribedLyrics, "real Whisper output must contain words from the sung Scarborough Fair recording").toMatch(/\bscarborough\b/);
    expect(transcribedLyrics).toMatch(/\b(?:parsley|sage|rosemary|thyme)\b/);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    const jobCard = page.locator(`.job-card[data-job-id="${jobId}"]`);
    await expect(jobCard).toBeVisible();
    await jobCard.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: createdBody.project.name, exact: true })).toBeVisible();
    const firstTile = page.locator(".clip-tile.complete").first();
    await expect(firstTile).toBeVisible();
    await firstTile.getByRole("button", { name: "Preview", exact: true }).click();
    const player = page.locator(".viewer-frame video").first();
    await expect(player).toBeVisible();
    await player.evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); });
    const firstPreviewFrame = await player.evaluate((video: HTMLVideoElement) => {
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas unavailable for preview frame inspection");
      context.drawImage(video, 0, 0, 64, 64);
      return Array.from(context.getImageData(0, 0, 64, 64).data);
    });
    const playbackStartedAt = await player.evaluate((video: HTMLVideoElement) => video.currentTime);
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 15_000, intervals: [100, 250, 500] }).toBeGreaterThan(playbackStartedAt + 0.5);
    const secondPreviewFrame = await player.evaluate((video: HTMLVideoElement) => {
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas unavailable for preview frame inspection");
      context.drawImage(video, 0, 0, 64, 64);
      video.pause();
      return Array.from(context.getImageData(0, 0, 64, 64).data);
    });
    expect(secondPreviewFrame, "preview video frames change while playback advances").not.toEqual(firstPreviewFrame);
    const result = { theme, jobId, clipIds: [] as string[], downloadHashes: [] as string[], audioCorrelations: [] as number[] };
    for (let index = 0; index < job.clips.length; index++) {
      const clip = job.clips[index];
      result.clipIds.push(clip.id);
      expect(clip.duration).toBeGreaterThanOrEqual(20);
      const mp4 = path.join(artifacts, "downloads", theme, `${clip.id}.mp4`);
      const tile = page.locator(".clip-tile.complete").nth(index);
      await expect(tile).toBeVisible();
      const [directDownload] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), tile.getByRole("link", { name: "Download" }).click()]);
      await directDownload.saveAs(mp4);
      const directHash = createHash("sha256").update(await fs.readFile(mp4)).digest("hex");
      result.downloadHashes.push(directHash);
      const metadata = await ffprobe(mp4);
      const video = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
      const audio = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
      expect(video).toBeTruthy(); expect(audio).toBeTruthy();
      expect(video).toMatchObject({ width: 1080, height: 1920 });
      expect(Number(metadata.format.duration)).toBeGreaterThan(8);
      await decode(mp4);
      const duration = Number(metadata.format.duration);
      const sampleTime = duration / 2;
      const upper = await regionRgb(mp4, sampleTime, "1080:555:0:0");
      const upperTitle = await regionRgb(mp4, sampleTime, "640:160:220:110");
      const lower = await regionRgb(mp4, sampleTime, "1080:555:0:1365");
      const sourceLayerSample = await regionRgb(mp4, sampleTime, "80:80:600:700");
      expect(Math.max(...upperTitle), "centered top text is visible in the black upper band").toBeGreaterThan(2);
      expect(Math.max(...upper), "upper presentation area remains predominantly black").toBeLessThan(24);
      expect(Math.max(...lower), "lower presentation area remains predominantly black").toBeLessThan(32);
      if (clip.musicTreatment === "grayscale") expect(Math.max(...sourceLayerSample) - Math.min(...sourceLayerSample), "only the source layer is grayscale").toBeLessThan(12);
      if (clip.musicTreatment === "color") expect(Math.max(...sourceLayerSample) - Math.min(...sourceLayerSample), "color assignment retains source chroma").toBeGreaterThan(12);
      const cues = clip.captionCues || [];
      expect(cues.length, "real word-timed sung-vocal transcription is present").toBeGreaterThan(0);
      const lyricCue = cues[Math.floor((cues.length - 1) / 2)];
      const lyricSampleTime = lyricCue.start + Math.max(0.05, (lyricCue.end - lyricCue.start) / 2);
      if (theme === "warm" && clip.musicTreatment === "grayscale") {
        const coloredLyricPixels = await regionColorPixelCount(mp4, lyricSampleTime, "900:220:90:850");
        expect(coloredLyricPixels, "warm word highlight remains colored over grayscale footage").toBeGreaterThan(0);
      }
      const sourceAudio = await audioSamples(fixture, clip.start + 1);
      const renderedAudio = await audioSamples(mp4, 1);
      const audioMatch = correlation(sourceAudio, renderedAudio);
      result.audioCorrelations.push(audioMatch);
      expect(audioMatch, "downloaded clip retains the same decoded source audio, not only an audio stream").toBeGreaterThan(0.65);
      const early = await capture(mp4, Math.min(0.4, duration / 5), `${theme}-${clip.id}-early.png`);
      const middle = await capture(mp4, sampleTime, `${theme}-${clip.id}-middle.png`);
      const late = await capture(mp4, Math.max(0.1, duration - 0.4), `${theme}-${clip.id}-late.png`);
      const contact = path.join(artifacts, "music-frames", `${theme}-${clip.id}-contact.png`);
      await fs.chmod(path.dirname(contact), 0o777);
      await media("ffmpeg", ["-y", "-v", "error", "-i", mediaPath(early), "-i", mediaPath(middle), "-i", mediaPath(late), "-filter_complex", "[0:v]scale=360:640[a];[1:v]scale=360:640[b];[2:v]scale=360:640[c];[a][b][c]hstack=inputs=3[out]", "-map", "[out]", mediaPath(contact)]);
      await testInfo.attach(`${theme}-${clip.id}-contact-sheet`, { path: contact, contentType: "image/png" });
      expect(clip.captionCues?.length ?? 0).toBeGreaterThan(0);
      for (const cue of clip.captionCues || []) {
        expect(cue.start).toBeGreaterThanOrEqual(0);
        expect(cue.end).toBeLessThanOrEqual(Number(metadata.format.duration));
      }
      const assLink = (clip.captionDownloads || []).find((item: { format: string }) => item.format === "ass");
      expect(assLink, "burn-in ASS sidecar available for timing and placement audit").toBeTruthy();
      const assResponse = await page.evaluate(async (url: string) => {
        const response = await fetch(url);
        return { ok: response.ok, text: await response.text() };
      }, assLink.url);
      expect(assResponse.ok).toBeTruthy();
      expect(assResponse.text).toContain("MusicTop");
      expect(assResponse.text).toContain(`Authorized vocals — ${theme}`);
      const captionStyle = assResponse.text.split("\n").find((line: string) => line.startsWith("Style: Caption,"));
      const topStyle = assResponse.text.split("\n").find((line: string) => line.startsWith("Style: MusicTop,"));
      if (!captionStyle || !topStyle) throw new Error("Music ASS sidecar is missing its caption or top-text style");
      const expectedFont = theme === "clean" ? "Barlow" : theme === "warm" || theme === "serif" ? "Lora" : referenceSans ? "Roboto Condensed" : "Bodoni Moda";
      expect(captionStyle.split(",")[1]).toBe(expectedFont);
      const expectedColor = theme === "warm" ? "&H0000D7FF&" : theme === "reference_yellow_sans" ? "&H00AAE8F5&" : "&H00FFFFFF&";
      expect(captionStyle.split(",")[4]).toBe(expectedColor);
      expect(topStyle.split(",")[1], "top text stays clean sans across subtitle themes").toBe("Barlow");
      expect(captionStyle.split(",")[18], "lyric alignment remains centered after lifting the source band").toBe("5");
      if (theme === "warm") expect(assResponse.text).toContain("&H0000D7FF&");
    }
    const zip = path.join(artifacts, "downloads", theme, "outputs.zip");
    const [zipDownload] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: /Download ZIP/i }).click()]);
    await zipDownload.saveAs(zip);
    const zipListing = (await media("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist()))", mediaPath(zip)])).stdout;
    expect(zipListing.match(/\.mp4/g) || []).toHaveLength(2);
    const extracted = path.join(artifacts, "downloads", theme, "zip-media");
    await fs.mkdir(extracted, { recursive: true });
    await fs.chmod(extracted, 0o777);
    const extractZip = [
      "import os,sys,zipfile",
      "archive = zipfile.ZipFile(sys.argv[1])",
      "root = sys.argv[2]",
      "for name in archive.namelist():",
      "    if name.lower().endswith('.mp4'): archive.extract(name, root)",
      "for directory, dirs, files in os.walk(root):",
      "    for name in dirs: os.chmod(os.path.join(directory, name), 0o777)",
      "    for name in files: os.chmod(os.path.join(directory, name), 0o666)",
    ].join("\n");
    await media("python3", ["-c", extractZip, mediaPath(zip), mediaPath(extracted)]);
    const zipHashes: string[] = [];
    for (const fileName of (await fs.readdir(extracted, { recursive: true })).filter((name) => String(name).endsWith(".mp4"))) {
      const zipFile = path.join(extracted, String(fileName));
      const hash = createHash("sha256").update(await fs.readFile(zipFile)).digest("hex");
      zipHashes.push(hash);
      await decode(zipFile);
    }
    expect(zipHashes.sort()).toEqual(result.downloadHashes.sort());
    results.push(result);
    await page.close();
  }
  expect(results).toHaveLength(6);
  expect(results.map((result) => result.theme).sort()).toEqual(themes.map(({ id }) => id).sort());
  expect(results.every((result) => result.clipIds.length === 2)).toBeTruthy();
  expect(fontRequests.some((url) => url.includes("RobotoCondensed-Light.ttf"))).toBeTruthy();
  expect(fontRequests.some((url) => url.includes("BodoniModa-Variable.ttf"))).toBeTruthy();
  expect(externalRequests, "browser must not contact external origins").toEqual([]);
  expect(browserErrors, "browser console/page/request/server errors").toEqual([]);
  await fs.writeFile(path.join(artifacts, "music-acceptance-evidence.json"), JSON.stringify(results, null, 2));
  await context.close();
});
