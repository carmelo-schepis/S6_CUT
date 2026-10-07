import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test.use({ trace: "off", video: "off", screenshot: "off" });

const artifactDir = path.resolve(process.env.S6_PLAYWRIGHT_ARTIFACTS || "test-artifacts/music-live");
const sourcePath = process.env.S6_MUSIC_SOURCE_VIDEO;

type JobData = {
  id: string; projectId: string; state: string; sourceProfile: string; processingMode?: string; totalItems?: number;
  clips: { state: string; index: number; start: number; end: number; duration: number; outputName: string; previewUrl?: string; captionDownloads?: { format: string; url: string }[] }[];
  steps?: { label?: string; status?: string; currentItem?: number; totalItems?: number }[];
};
type ProjectData = { id: string; sourceProfile: string; requestedCount: number; latestJobId: string };

function isJobData(value: unknown): value is JobData {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "projectId" in value && typeof value.projectId === "string" && "state" in value && typeof value.state === "string" && "sourceProfile" in value && typeof value.sourceProfile === "string" && "clips" in value && Array.isArray(value.clips);
}

function isProjectData(value: unknown): value is ProjectData {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "sourceProfile" in value && typeof value.sourceProfile === "string" && "requestedCount" in value && typeof value.requestedCount === "number" && "latestJobId" in value && typeof value.latestJobId === "string";
}

function safeJob(job: JobData) {
  return {
    id: job?.id ?? null,
    projectId: job?.projectId ?? null,
    state: job?.state ?? null,
    sourceProfile: job?.sourceProfile ?? null,
    processingMode: job?.processingMode ?? null,
    totalItems: Number.isFinite(job?.totalItems) ? job.totalItems : null,
    clipCounts: (job.clips ?? []).reduce((counts: Record<string, number>, clip) => {
      const state = typeof clip.state === "string" ? clip.state : "unknown";
      counts[state] = (counts[state] ?? 0) + 1;
      return counts;
    }, {}),
    steps: (job.steps ?? []).map((step) => ({
      label: typeof step.label === "string" ? step.label : "unknown",
      status: typeof step.status === "string" ? step.status : "unknown",
      currentItem: Number.isFinite(step.currentItem) ? step.currentItem : null,
      totalItems: Number.isFinite(step.totalItems) ? step.totalItems : null,
    })),
  };
}

test("real Music upload reaches a persisted, playable terminal job", async ({ page }) => {
  test.skip(!sourcePath, "Set S6_MUSIC_SOURCE_VIDEO to the offline fixture or an authorized human-sung video.");
  const source = path.resolve(sourcePath!);
  const stat = await fs.stat(source);
  expect(stat.isFile(), "S6_MUSIC_SOURCE_VIDEO must name a regular video file").toBeTruthy();
  await fs.mkdir(path.join(artifactDir, "screenshots"), { recursive: true });

  const report = {
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    fixture: { sizeBytes: stat.size, sha256: null as string | null },
    request: null as Record<string, unknown> | null,
    project: null as Record<string, unknown> | null,
    job: null as Record<string, unknown> | null,
    clips: [] as Record<string, unknown>[], playback: null as Record<string, unknown> | null,
    failure: null as { errorClass: string; step: string } | null,
    networkErrors: [] as Record<string, unknown>[], requestCancellations: [] as Record<string, unknown>[], trace: [] as Record<string, unknown>[],
    browserErrors: [] as Record<string, unknown>[], screenshotFailure: null as { errorClass: string } | null,
  };
  const { createHash } = await import("node:crypto");
  report.fixture.sha256 = createHash("sha256").update(await fs.readFile(source)).digest("hex");
  let currentStep = "initialize";
  let project: ProjectData | null = null;
  let job: JobData | null = null;

  const safePath = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : url.protocol;
    } catch { return "unknown"; }
  };
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      report.browserErrors.push({ type: "console", name: "ConsoleError", sourcePath: safePath(location.url), line: location.lineNumber || null, column: location.columnNumber || null });
    }
  });
  page.on("pageerror", (error) => {
    report.browserErrors.push({ type: "page", name: error.name || "Error", sourcePath: safePath(page.url()) });
  });
  page.on("request", (request) => {
    report.trace.push({ at: new Date().toISOString(), method: request.method(), path: safePath(request.url()) });
  });
  page.on("response", (response) => {
    const request = response.request();
    const route = safePath(response.url());
    report.trace.push({ at: new Date().toISOString(), method: request.method(), status: response.status(), path: route });
    if (response.status() >= 400) report.networkErrors.push({ method: request.method(), status: response.status(), path: route });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    const record = { method: request.method(), path: safePath(request.url()), errorClass: /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure) ? "AbortedRequest" : "RequestFailed" };
    if (record.errorClass === "AbortedRequest") report.requestCancellations.push(record);
    else report.networkErrors.push(record);
  });

  try {
    currentStep = "upload and configure one requested clip";
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = init?.body;
        if (requestUrl.includes("/api/v1/jobs/clip") && body instanceof FormData) {
          const fields: Record<string, string | null> = {};
          for (const name of ["source_profile", "processing_mode", "count", "min_duration", "max_duration", "content_format"]) {
            const value = body.get(name);
            fields[name] = typeof value === "string" ? value : null;
          }
          (window as typeof window & { __musicUploadFields?: typeof fields }).__musicUploadFields = fields;
        }
        return originalFetch.call(this, input, init);
      };
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    await page.locator('input[aria-label="Choose video file"]').setInputFiles(source);
    await expect(page.locator(".drop-zone.has-file")).toBeVisible();
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    await expect(page.getByRole("button", { name: "Music / sung vocals" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/always uses Smart transcription locally.*VAD disabled.*word timestamps retained/i)).toBeVisible();
    const countControl = page.locator(".count-control strong");
    while (Number(await countControl.textContent()) > 1) await page.getByRole("button", { name: "Fewer clips" }).click();
    await expect(countControl).toHaveText("1");
    await page.getByRole("button", { name: "Advanced controls" }).click();
    await page.getByLabel("Minimum seconds").fill("8");
    await page.getByLabel("Maximum seconds").fill("20");
    await page.getByLabel("Project name").fill(`Music live ${new Date().toISOString().replace(/[:.]/g, "-")}`);

    const createRequest = page.waitForRequest((request) => request.url().includes("/api/v1/jobs/clip") && request.method() === "POST");
    await page.getByRole("button", { name: "Create 1 short clip", exact: true }).click();
    await createRequest;
    report.request = await page.evaluate(() => {
      const fields = (window as typeof window & { __musicUploadFields?: Record<string, string | null> }).__musicUploadFields;
      return {
        sourceProfile: fields?.source_profile ?? null,
        processingMode: fields?.processing_mode ?? null,
        count: Number(fields?.count),
        minDuration: Number(fields?.min_duration),
        maxDuration: Number(fields?.max_duration),
        contentFormat: fields?.content_format ?? null,
      };
    });
    expect(report.request).toMatchObject({ sourceProfile: "music", processingMode: "smart", count: 1, minDuration: 8, maxDuration: 20 });

    currentStep = "obtain persisted project and poll persisted job to terminal";
    const deadline = Date.now() + 240_000;
    let jobReadErrorClass: string | null = null;
    while (Date.now() < deadline) {
      try {
        const found = await page.evaluate(async () => {
          const response = await fetch("/api/v1/projects");
          if (!response.ok) throw new Error("projects response failed");
          const projects: unknown = await response.json();
          const name = document.querySelector(".workspace-project-name")?.textContent?.trim();
          if (!Array.isArray(projects)) return null;
          const project = projects.find((item: unknown) => typeof item === "object" && item !== null && "name" in item && item.name === name && "latestJobId" in item && typeof item.latestJobId === "string");
          if (typeof project !== "object" || project === null || !("latestJobId" in project) || typeof project.latestJobId !== "string") return null;
          const jobResponse = await fetch(`/api/v1/jobs/${encodeURIComponent(project.latestJobId)}`);
          if (!jobResponse.ok) throw new Error("job response failed");
          const job: unknown = await jobResponse.json();
          return { project, job };
        });
        if (found && isProjectData(found.project) && isJobData(found.job)) {
          project = found.project;
          job = found.job;
          report.project = { id: project.id, sourceProfile: project.sourceProfile, requestedCount: project.requestedCount, latestJobId: project.latestJobId };
          report.job = safeJob(job);
          jobReadErrorClass = null;
          if (["complete", "partial", "failed", "cancelled_kept"].includes(job.state)) break;
        }
      } catch (error) {
        jobReadErrorClass = error instanceof Error ? error.name : "UnknownError";
      }
      await page.waitForTimeout(2_000);
    }
    if (!job || !["complete", "partial", "failed", "cancelled_kept"].includes(job.state)) {
      report.failure = { errorClass: jobReadErrorClass || "TerminalStateTimeout", step: currentStep };
      throw new Error("Persisted job did not reach terminal state");
    }

    currentStep = "assert persisted Music profile and requested clip";
    if (!project) throw new Error("Persisted project was not found");
    expect(project.sourceProfile).toBe("music");
    expect(job.sourceProfile).toBe("music");
    expect(project.latestJobId).toBe(job.id);
    expect(job.projectId).toBe(project.id);
    expect(job.state).toBe("complete");
    expect(job.clips).toHaveLength(1);
    const clip = job.clips[0];
    expect(clip.state).toBe("complete");
    expect(clip.start).toBeGreaterThanOrEqual(0);
    expect(clip.end).toBeGreaterThan(clip.start);
    expect(clip.duration).toBeGreaterThanOrEqual(8);
    expect(clip.duration).toBeLessThanOrEqual(20);
    expect(Math.abs((clip.end - clip.start) - clip.duration)).toBeLessThanOrEqual(1);

    currentStep = "verify signed timed SRT and VTT sidecars";
    const downloads = clip.captionDownloads ?? [];
    const sidecarResults = [];
    for (const format of ["srt", "vtt"]) {
      const download = downloads.find((entry) => entry.format === format);
      expect(download?.url).toBeTruthy();
      if (!download) throw new Error(`Missing ${format} caption download`);
      const signed = new URL(download.url, page.url());
      expect(signed.searchParams.has("signature")).toBeTruthy();
      const metrics = await page.evaluate(async ({ url, format }) => {
        const response = await fetch(url);
        if (!response.ok) return { ok: false, cueCount: 0, cueTimings: [] };
        const text = await response.text();
        const rows = text.split(/\r?\n/);
        const pattern = format === "srt"
          ? /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})$/
          : /^(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})(?:\s+.*)?$/;
        const seconds = (m: RegExpMatchArray, i: number) => Number(m[i] || 0) * 3600 + Number(m[i + 1]) * 60 + Number(m[i + 2]) + Number(m[i + 3]) / 1000;
        const cueTimings = [];
        for (let i = 0; i < rows.length; i++) {
          const match = rows[i].trim().match(pattern);
          if (!match) continue;
          let nonemptyBody = false;
          for (let body = i + 1; body < rows.length && rows[body].trim(); body++) nonemptyBody = true;
          if (nonemptyBody) cueTimings.push({ start: seconds(match, 1), end: seconds(match, 5) });
        }
        return { ok: true, cueCount: cueTimings.length, cueTimings };
      }, { url: download.url, format });
      expect(metrics.ok).toBeTruthy();
      expect(metrics.cueCount).toBeGreaterThan(0);
      expect(metrics.cueTimings.every((cue) => cue.start >= 0 && cue.end > cue.start && cue.end <= clip.duration + 1)).toBeTruthy();
      sidecarResults.push({ format, cueCount: metrics.cueCount, cueTimings: metrics.cueTimings });
    }

    currentStep = "verify playable output";
    await page.screenshot({ path: path.join(artifactDir, "screenshots", "music-live-workspace.png"), fullPage: true, mask: [page.locator(".clip-tile"), page.locator(".workspace-project-name"), page.locator(".viewer-frame"), page.locator(".source-content")] });
    await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
    const video = page.locator(".viewer-frame video");
    const playback = await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      if (element.readyState < 2) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("video did not reach loaded data")), 30_000);
        element.addEventListener("loadeddata", () => { clearTimeout(timeout); resolve(); }, { once: true });
        element.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("video playback failed")); }, { once: true });
      });
      await element.play();
      const initial = element.currentTime;
      const frame = document.createElement("canvas"); frame.width = 96; frame.height = 96;
      const context = frame.getContext("2d");
      if (!context) throw new Error("canvas context unavailable");
      const sample = () => { context.drawImage(element, 0, 0, frame.width, frame.height); return context.getImageData(0, 0, frame.width, frame.height).data; };
      const before = sample(); await new Promise((resolve) => setTimeout(resolve, 1_500));
      const advanced = element.currentTime - initial; const after = sample(); let pixelDelta = 0;
      for (let i = 0; i < before.length; i += 4) pixelDelta += Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
      element.pause();
      return { readyState: element.readyState, duration: element.duration, advancedSeconds: advanced, meanRgbChannelDelta: pixelDelta / (before.length / 4 * 3), width: element.videoWidth, height: element.videoHeight, mediaError: element.error?.code ?? null };
    });
    expect(playback.readyState).toBeGreaterThanOrEqual(2);
    expect(playback.advancedSeconds).toBeGreaterThan(0.1);
    expect(playback.meanRgbChannelDelta).toBeGreaterThan(0);
    expect(playback.width).toBeGreaterThan(0);
    expect(playback.height).toBeGreaterThan(0);
    expect(playback.mediaError).toBeNull();
    report.playback = playback;
    const outputName = clip.outputName;
    expect(typeof outputName).toBe("string");
    expect(outputName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    const extension = outputName.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "";
    report.clips = [{ index: clip.index, state: clip.state, start: clip.start, end: clip.end, duration: clip.duration, filenameSha256: createHash("sha256").update(outputName).digest("hex"), extension, sidecars: sidecarResults, playbackUrlPath: clip.previewUrl ? new URL(clip.previewUrl, page.url()).pathname : null }];
  } catch (error) {
    report.failure ??= { errorClass: error instanceof Error ? error.name : "UnknownError", step: currentStep };
    throw error;
  } finally {
    report.job = job ? safeJob(job) : report.job;
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.join(artifactDir, "screenshots"), { recursive: true });
    try {
      await page.screenshot({ path: path.join(artifactDir, "screenshots", "music-live-workspace.png"), fullPage: true, mask: [page.locator(".clip-tile"), page.locator(".workspace-project-name"), page.locator(".viewer-frame"), page.locator(".source-content")] });
    } catch (error) {
      report.screenshotFailure = { errorClass: error instanceof Error ? error.name : "UnknownError" };
    }
    await fs.writeFile(path.join(artifactDir, "music-live.json"), `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(path.join(artifactDir, "music-live-trace.json"), `${JSON.stringify(report.trace, null, 2)}\n`);
  }
});
