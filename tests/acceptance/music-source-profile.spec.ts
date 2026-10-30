import { test, expect } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";

const now = "2026-01-01T00:00:00Z";
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.startsWith("iPhone") || testInfo.project.name.startsWith("iPad"), "iOS provides a read-only status view; creation uses the desktop or Android workspace");
});
const backgroundSong = readFileSync(path.resolve("tests/fixtures/background-song.mp3"));
const folder = { id: "unsorted", name: "Unsorted", description: "", color: null, parentId: null, archived: false, system: true, createdAt: now, updatedAt: now };
const health = { status: "ready", version: "fixture", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: false, dataPath: "Local mounted data directory", freeBytes: 10000000, configuredWorkers: 1, activeWorkers: 0, queuedJobs: 0, fallbacks: {} };

test("Music / sung vocals opts into Smart and sends the durable music profile", async ({ page }) => {
  const project = {
    schemaVersion: 1, id: "music-project", name: "Lyric acceptance", mode: "clip", style: "educational", state: "queued",
    sourceName: "YouTube import", sourceKind: "youtube", requestedCount: 2, contentFormat: "short", sourceProfile: "music",
    latestJobId: "music-job", libraryFolderId: folder.id, createdAt: now, updatedAt: now,
  };
  const job = {
    schemaVersion: 1, id: "music-job", projectId: project.id, mode: "clip", state: "queued", stage: "queued",
    stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0, style: "educational",
    processingMode: "smart", contentFormat: "short", sourceProfile: "music", warnings: [], clips: [], beats: [], steps: [],
    createdAt: now, updatedAt: now,
  };
  let created = false;
  let submittedForm = "";
  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/library/folders", (route) => route.fulfill({ json: [folder] }));
  await page.route("**/api/v1/library/assets**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: created ? [project] : [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: created ? [job] : [] }));
  await page.route("**/api/v1/jobs/clip", async (route) => {
    submittedForm = route.request().postData() || "";
    created = true;
    await route.fulfill({ status: 202, json: { project, job } });
  });
  await page.route("**/api/v1/jobs/music-job/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
  await page.route("**/api/v1/jobs/music-job", (route) => route.fulfill({ json: job }));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clip mode" })).toHaveAttribute("aria-pressed", "true");
  const musicChoice = page.getByRole("button", { name: "Music / sung vocals" });
  await musicChoice.click();
  await expect(musicChoice).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Lyrics presentation", exact: true }).click();
  await expect(page.getByText(/always uses Smart transcription locally.*VAD disabled.*word timestamps retained/i)).toBeVisible();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Background song", exact: true }).click();
  await expect(page.getByLabel("YouTube song URL")).toBeVisible();
  await page.getByLabel("YouTube song URL").fill("https://music.youtube.com/watch?v=9bZkp7q19f0");
  await page.getByLabel("Song speed").selectOption("1.5");
  await page.getByRole("button", { name: /Create \d+ short clips?/ }).click();

  await expect(page.getByRole("heading", { name: "Lyric acceptance" })).toBeVisible();
  expect(submittedForm).toMatch(/name="source_profile"\s+music/);
  expect(submittedForm).toMatch(/name="processing_mode"\s+smart/);
  expect(submittedForm).toMatch(/name="min_duration"\s+20/);
  expect(submittedForm).toMatch(/name="music_track_url"\s+https:\/\/music\.youtube\.com\/watch\?v=9bZkp7q19f0/);
  expect(submittedForm).toMatch(/name="music_track_speed"\s+1\.5/);
  await expect(page.getByText(/smart processing/i)).toBeVisible();
});

test("switching from a picked MP3 to a song URL clears the native picker state", async ({ page }) => {
  let submittedForm = "";
  const project = { schemaVersion: 1, id: "switch-project", name: "Switch source", mode: "clip", style: "educational", state: "queued", sourceName: "YouTube import", sourceKind: "youtube", requestedCount: 1, contentFormat: "short", sourceProfile: "music", latestJobId: "switch-job", libraryFolderId: folder.id, createdAt: now, updatedAt: now };
  const job = { schemaVersion: 1, id: "switch-job", projectId: project.id, mode: "clip", state: "queued", stage: "queued", stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0, style: "educational", processingMode: "smart", contentFormat: "short", sourceProfile: "music", warnings: [], clips: [], beats: [], steps: [], createdAt: now, updatedAt: now };
  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/library/folders", (route) => route.fulfill({ json: [folder] }));
  await page.route("**/api/v1/library/assets**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs/clip", async (route) => { submittedForm = route.request().postData() || ""; await route.fulfill({ status: 202, json: { project, job } }); });
  await page.route("**/api/v1/jobs/switch-job/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
  await page.route("**/api/v1/jobs/switch-job", (route) => route.fulfill({ json: job }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Background song", exact: true }).click();
  const picker = page.getByLabel("Background song MP3");
  await picker.setInputFiles({ name: "backing.mp3", mimeType: "audio/mpeg", buffer: backgroundSong });
  await expect.poll(() => picker.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(1);
  await page.getByLabel("YouTube song URL").fill("https://music.youtube.com/watch?v=9bZkp7q19f0");
  await expect.poll(() => picker.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0);
  await page.getByLabel("YouTube song URL").fill("");
  await page.getByRole("button", { name: /Create \d+ short clips?/ }).click();
  await expect(page.getByRole("heading", { name: "Switch source" })).toBeVisible();
  expect(submittedForm).not.toContain('name="music_track_file"');
  expect(submittedForm).not.toContain('name="music_track_url"');
});

test("Music mode uploads an MP3 background song with the selected slow speed", async ({ page }) => {
  const project = {
    schemaVersion: 1, id: "song-project", name: "Song upload", mode: "clip", style: "educational", state: "queued",
    sourceName: "YouTube import", sourceKind: "youtube", requestedCount: 2, contentFormat: "short", sourceProfile: "music",
    latestJobId: "song-job", libraryFolderId: folder.id, createdAt: now, updatedAt: now,
  };
  const job = {
    schemaVersion: 1, id: "song-job", projectId: project.id, mode: "clip", state: "queued", stage: "queued",
    stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0, style: "educational",
    processingMode: "smart", contentFormat: "short", sourceProfile: "music", warnings: [], clips: [], beats: [], steps: [],
    createdAt: now, updatedAt: now,
  };
  let submittedForm = "";
  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/library/folders", (route) => route.fulfill({ json: [folder] }));
  await page.route("**/api/v1/library/assets**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs/clip", async (route) => {
    submittedForm = route.request().postData() || "";
    await route.fulfill({ status: 202, json: { project, job } });
  });
  await page.route("**/api/v1/jobs/song-job/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
  await page.route("**/api/v1/jobs/song-job", (route) => route.fulfill({ json: job }));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await page.getByRole("tab", { name: "YouTube" }).click();
  await page.getByLabel("YouTube URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Background song", exact: true }).click();
  await page.getByLabel("Background song MP3").setInputFiles({ name: "backing-track.mp3", mimeType: "audio/mpeg", buffer: backgroundSong });
  const songPicker = page.getByLabel("Background song MP3");
  await page.getByRole("button", { name: "Remove song" }).click();
  await expect.poll(() => songPicker.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0);
  await songPicker.setInputFiles({ name: "backing-track.mp3", mimeType: "audio/mpeg", buffer: backgroundSong });
  await page.getByLabel("Song speed").selectOption("0.75");
  await page.getByRole("button", { name: /Create \d+ short clips?/ }).click();

  await expect(page.getByRole("heading", { name: "Song upload" })).toBeVisible();
  expect(submittedForm).toContain('name="music_track_file"');
  expect(submittedForm).toContain('filename="backing-track.mp3"');
  expect(submittedForm).toMatch(/name="music_track_speed"\s+0\.75/);
  expect(submittedForm).not.toContain('name="music_track_url"');
});

test("known-short Music sources show a warning and remain creatable", async ({ page }) => {
  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/library/folders", (route) => route.fulfill({ json: [folder] }));
  await page.route("**/api/v1/library/assets**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [] }));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Choose video file").setInputFiles(path.resolve("test-video.mp4"));
  const requestedCount = page.locator(".count-control strong");
  await expect(requestedCount).toHaveText("5");
  await page.getByRole("button", { name: "Music / sung vocals" }).click();
  await expect(page.getByRole("status").filter({ hasText: /source may not contain enough distinct lyric windows/ })).toBeVisible();
  await expect(requestedCount).toHaveText("5");
  await expect(page.getByRole("button", { name: /Create \d+ short clips?/ })).toBeEnabled();
});

test("completed music jobs meet the requested minimum and expose timed caption artifacts", async ({ page }) => {
  const minimumDuration = 20;
  const outputPath = "/api/v1/files/jobs/music-complete-job/clips";
  const completedProject = {
    schemaVersion: 1, id: "music-complete-project", name: "Completed music fixture", mode: "clip", style: "educational", state: "complete",
    sourceName: "music-fixture.mp4", sourceKind: "upload", requestedCount: 2, contentFormat: "short", sourceProfile: "music",
    latestJobId: "music-complete-job", libraryFolderId: folder.id, musicTrack: { assetId: "song-asset", title: "Verified backing track", source: "upload", speed: 0.85 }, createdAt: now, updatedAt: now,
  };
  const completedJob = {
    schemaVersion: 1, id: "music-complete-job", projectId: completedProject.id, libraryFolderId: folder.id, mode: "clip", state: "complete", stage: "complete",
    stageLabel: "2 music cuts ready", progress: 100, currentItem: 2, totalItems: 2, style: "educational", processingMode: "smart", contentFormat: "short", sourceProfile: "music",
    burnSubtitles: true, embedSubtitles: false, musicTrack: completedProject.musicTrack, warnings: [], error: null,
    clips: [
      {
        id: "music-clip-1", index: 1, state: "complete", start: 0, end: 20, duration: 20, openingLine: "Sing it back", score: null, selected: true,
        outputName: "01-music.mp4", blobId: "music-output-1", downloadUrl: `${outputPath}/01-music.mp4`, previewUrl: `${outputPath}/01-music.mp4`, libraryAssetId: "music-asset-1",
        title: "Sing it back", width: 1080, height: 1920, folderId: folder.id, publishedAt: now, fallbackUsed: false, provenance: [],
        captionCues: [{ id: "cue-1", start: 0, end: 1.8, text: "Sing it back", confidence: 0.94, warnings: [] }], captionRevision: 1,
        captionDownloads: [
          { format: "srt", filename: "01-music.srt", url: "/api/v1/jobs/music-complete-job/clips/music-clip-1/captions/srt?expires=4102444800&signature=fixture" },
          { format: "vtt", filename: "01-music.vtt", url: "/api/v1/jobs/music-complete-job/clips/music-clip-1/captions/vtt?expires=4102444800&signature=fixture" },
        ],
      },
      {
        id: "music-clip-2", index: 2, state: "complete", start: 24, end: 46, duration: 22, openingLine: "Hold the melody", score: null, selected: true,
        outputName: "02-music.mp4", blobId: "music-output-2", downloadUrl: `${outputPath}/02-music.mp4`, previewUrl: `${outputPath}/02-music.mp4`, libraryAssetId: "music-asset-2",
        title: "Hold the melody", width: 1080, height: 1920, folderId: folder.id, publishedAt: now, fallbackUsed: false, provenance: [],
        captionCues: [{ id: "cue-2", start: 0.2, end: 2.1, text: "Hold the melody", confidence: 0.91, warnings: [] }], captionRevision: 1,
        captionDownloads: [
          { format: "srt", filename: "02-music.srt", url: "/api/v1/jobs/music-complete-job/clips/music-clip-2/captions/srt?expires=4102444800&signature=fixture" },
          { format: "vtt", filename: "02-music.vtt", url: "/api/v1/jobs/music-complete-job/clips/music-clip-2/captions/vtt?expires=4102444800&signature=fixture" },
        ],
      },
    ],
    beats: [],
    steps: [
      { id: "source", label: "Source received", status: "complete", completedAt: now },
      { id: "probe", label: "Video validated", status: "complete", completedAt: now },
      { id: "render", label: "Clips rendered and saved", status: "complete", completedAt: now, currentItem: 2, totalItems: 2 },
      { id: "verify", label: "Outputs verified", status: "complete", completedAt: now, currentItem: 2, totalItems: 2 },
      { id: "ready", label: "Project ready", status: "complete", completedAt: now },
    ],
    createdAt: now, updatedAt: now,
  };

  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/library/folders", (route) => route.fulfill({ json: [folder] }));
  await page.route("**/api/v1/library/assets**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: [completedProject] }));
  await page.route(`**/api/v1/projects/${completedProject.id}`, (route) => route.fulfill({ json: completedProject }));
  await page.route("**/api/v1/jobs", (route) => route.fulfill({ json: [completedJob] }));
  await page.route(`**/api/v1/jobs/${completedJob.id}/events`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\n\n" }));
  await page.route(`**/api/v1/jobs/${completedJob.id}`, (route) => route.fulfill({ json: completedJob }));
  await page.route("**/api/v1/files/jobs/music-complete-job/clips/*", (route) => route.fulfill({ path: path.resolve("test-video.mp4"), contentType: "video/mp4" }));
  await page.route("**/api/v1/jobs/music-complete-job/clips/*/captions/*", (route) => {
    const requestUrl = new URL(route.request().url());
    const format = requestUrl.pathname.endsWith("/vtt") ? "vtt" : "srt";
    const text = requestUrl.pathname.includes("/music-clip-2/") ? "Hold the melody" : "Sing it back";
    return route.fulfill({ contentType: format === "vtt" ? "text/vtt" : "application/x-subrip", body: format === "vtt" ? `WEBVTT\n\n00:00.000 --> 00:01.800\n${text}\n` : `1\n00:00:00,000 --> 00:00:01,800\n${text}\n` });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.locator('.job-card[data-job-id="music-complete-job"]')
    .getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Completed music fixture" })).toBeVisible();
  await expect(page.getByText("Song: Verified backing track · 0.85× speed")).toBeVisible();
  await expect(page.locator(".workspace-secondary-meta").first()).toContainText(/Music \/ sung vocals/);
  await expect(page.locator(".clip-tile.complete")).toHaveCount(completedProject.requestedCount);

  // The workspace does not render cue rows or sidecar labels. Assert the
  // typed single-job response instead: it is the durable API contract that
  // supplies timed cues and signed sidecar URLs to downstream consumers.
  const observedJob = await page.evaluate(() => fetch("/api/v1/jobs/music-complete-job").then((response) => response.json()));
  expect(observedJob.sourceProfile).toBe("music");
  const completeClips = observedJob.clips.filter((clip: { state: string }) => clip.state === "complete");
  expect(completeClips).toHaveLength(completedProject.requestedCount);
  for (const clip of completeClips) {
    expect(clip.duration).toBeGreaterThanOrEqual(minimumDuration);
    expect(clip.captionCues.length).toBeGreaterThan(0);
    expect(clip.captionDownloads.map((download: { format: string }) => download.format)).toEqual(expect.arrayContaining(["srt", "vtt"]));
    for (const download of clip.captionDownloads) {
      expect(download.url).toMatch(/[?&]expires=\d+&signature=/);
      const sidecar = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return { ok: response.ok, body: await response.text() };
      }, download.url);
      expect(sidecar.ok).toBeTruthy();
      expect(sidecar.body).toContain(clip.captionCues[0].text);
    }
  }

  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await expect(page.getByText(/Caption style and timing are fixed.*local word timestamps/i)).toBeVisible();
});
