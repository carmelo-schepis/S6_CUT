import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, HEALTH_TIMEOUT_MS, TimeoutError, applyLibraryTitles, suggestLibraryTitles, createClipJob, createFolder, createShortsJob, createShortsSourceJob, getHealth, listRecentClips, readableError, rerenderCaptions, saveCaptionCues, readableDetail } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("engine API boundary", () => {
  it("validates the runtime capability response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "degraded", version: "0.1.0", database: true, ffmpeg: false, ffprobe: false,
      whisper: false, ytdlp: false, dataPath: "Local mounted data directory",
      freeBytes: 100, activeWorkers: 0, queuedJobs: 0, fallbacks: { media: "text card" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const health = await getHealth();
    expect(health.status).toBe("degraded");
    expect(health.fallbacks.media).toBe("text card");
  });

  it("turns bounded API details into readable errors", () => {
    expect(readableError(new ApiError("Queue full", 429))).toBe("Queue full");
  });

  // A wedged engine used to leave the health promise pending forever, which
  // left the shell on "Connecting to the local engine…" with no way out.
  it("aborts a health read that never answers and reports it as a timeout", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
      })));
      let settled = false;
      const pending = getHealth().then(() => "resolved" as unknown, (cause: unknown) => cause).finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS - 500);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      const cause = await pending;
      expect(aborted).toBe(true);
      expect(cause).toBeInstanceOf(TimeoutError);
      expect(readableError(cause)).toMatch(/did not respond within 8s/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends processing_mode with the clip job form", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("processing_mode")).toBe("fast");
      expect(body.get("execution_policy")).toBe("engine_only");
      expect(body.get("source_profile")).toBe("speech");
      expect(body.get("batch_mode")).toBe("high_volume");
      expect(body.get("style")).toBe("serious");
      expect(body.get("library_folder_id")).toBe("business-1");
      return new Response(JSON.stringify({
        project: {
          schemaVersion: 1, id: "p", name: "P", mode: "clip", style: "serious", state: "queued",
          sourceName: "s.mp4", sourceKind: "upload", requestedCount: 3,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
        job: {
          schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "queued", stage: "q",
          stageLabel: "Q", progress: 0, style: "serious", warnings: [], clips: [], beats: [],
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
      }), { status: 202, headers: { "Content-Type": "application/json" } });
    }));
    const result = await createClipJob({
      style: "serious", count: 3, minDuration: 20, maxDuration: 60, aspectRatio: "9:16",
      batchMode: "high_volume", processingMode: "fast", executionPolicy: "engine_only", libraryFolderId: "business-1",
    });
    expect(result.project.id).toBe("p");
    expect(result.job.processingMode).toBe("smart"); // legacy backend omission defaults to Smart
  });

  it("sends hook_text only for an explicit opt-in", async () => {
    const bodies: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body as FormData);
      return new Response(JSON.stringify({
        project: { schemaVersion: 1, id: "p", name: "P", mode: "clip", style: "serious", state: "queued", sourceName: "s", sourceKind: "upload", requestedCount: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        job: { schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "queued", stage: "q", stageLabel: "Q", progress: 0, style: "serious", warnings: [], clips: [], beats: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      }), { status: 202, headers: { "Content-Type": "application/json" } });
    }));
    const input = { style: "serious" as const, count: 1, minDuration: 8, maxDuration: 20, aspectRatio: "9:16" };
    await createClipJob({ ...input, hookText: true });
    await createClipJob({ ...input, hookText: false });
    expect(bodies[0].get("hook_text")).toBe("true");
    expect(bodies[1].has("hook_text")).toBe(false);
  });

  it("sends YouTube metadata options only when explicitly enabled", async () => {
    const bodies: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body as FormData);
      return new Response(JSON.stringify({
        project: { schemaVersion: 1, id: "p", name: "P", mode: "clip", style: "serious", state: "queued", sourceName: "s", sourceKind: "upload", requestedCount: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        job: { schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "queued", stage: "q", stageLabel: "Q", progress: 0, style: "serious", warnings: [], clips: [], beats: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      }), { status: 202, headers: { "Content-Type": "application/json" } });
    }));
    const input = { style: "serious" as const, count: 1, minDuration: 8, maxDuration: 20, aspectRatio: "9:16" };
    await createClipJob({ ...input });
    await createClipJob({ ...input, youtubeMetadata: true, youtubeMetadataModelId: "anthropic/claude-3.5-haiku" });
    expect(bodies[0].has("youtube_metadata")).toBe(false);
    expect(bodies[0].has("youtube_metadata_model_id")).toBe(false);
    expect(bodies[1].get("youtube_metadata")).toBe("true");
    expect(bodies[1].get("youtube_metadata_model_id")).toBe("anthropic/claude-3.5-haiku");
    await createClipJob({ ...input, youtubeMetadata: false });
    expect(bodies[2].get("youtube_metadata")).toBe("false");
  });

  it("posts Library title suggestion and apply requests and parses their responses", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      const payload = url.endsWith("/apply")
        ? { applied: [{ kind: "clip", assetId: "a1", projectId: null, title: "New", reason: null }], conflicts: [] }
        : { suggestions: [{ kind: "clip", assetId: "a1", projectId: null, currentTitle: "Old", suggestedTitle: "New", suggestedDescription: "Desc", revision: 2 }], skipped: [], costUsd: 0.0012, costKind: "actual", model: "m", requests: 1, aiAvailable: true, warning: null };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const suggestions = await suggestLibraryTitles({ scope: "auto-titled" });
    expect(suggestions.suggestions[0].suggestedTitle).toBe("New");
    expect(calls[0]).toEqual({ url: "/api/v1/library/title-suggestions", body: { scope: "auto-titled" } });
    const applied = await applyLibraryTitles([{ kind: "clip", assetId: "a1", projectId: null, currentTitle: "Old", title: "New", description: "Desc", revision: 2, edited: false }]);
    expect(applied.applied).toHaveLength(1);
    expect(calls[1].url).toBe("/api/v1/library/title-suggestions/apply");
    expect(calls[1].body).toEqual({ items: [expect.objectContaining({ assetId: "a1", title: "New", edited: false })] });
  });

  it("serializes the opted-in music profile as source_profile and preserves Smart", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("source_profile")).toBe("music");
      expect(body.get("processing_mode")).toBe("smart");
      return new Response(JSON.stringify({
        project: {
          schemaVersion: 1, id: "music-project", name: "Music", mode: "clip", style: "serious", state: "queued",
          sourceName: "song.mp4", sourceKind: "upload", requestedCount: 1, contentFormat: "short", sourceProfile: "music",
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
        job: {
          schemaVersion: 1, id: "music-job", projectId: "music-project", mode: "clip", state: "queued", stage: "q",
          stageLabel: "Q", progress: 0, style: "serious", processingMode: "smart", contentFormat: "short", sourceProfile: "music",
          warnings: [], clips: [], beats: [], steps: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
      }), { status: 202, headers: { "Content-Type": "application/json" } });
    }));
    const result = await createClipJob({
      style: "serious", count: 1, minDuration: 8, maxDuration: 20, aspectRatio: "9:16",
      processingMode: "smart", sourceProfile: "music",
    });
    expect(result.project.sourceProfile).toBe("music");
    expect(result.job.sourceProfile).toBe("music");
  });

  it("serializes subscribeAnimation in JSON and multipart job requests", async () => {
    const config = { enabled: true, version: 1 as const, shortFormLeadSeconds: 10 as const };
    const response = { project: { schemaVersion: 1, id: "p", name: "P", mode: "clip", style: "serious", state: "queued", sourceName: "s", sourceKind: "upload", requestedCount: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, job: { schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "queued", stage: "q", stageLabel: "Q", progress: 0, style: "serious", warnings: [], clips: [], beats: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } };
    const calls: Array<{ url: string; body: FormData | string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as FormData | string });
      return new Response(JSON.stringify(response), { status: 202, headers: { "Content-Type": "application/json" } });
    }));
    await createClipJob({ style: "serious", count: 1, minDuration: 8, maxDuration: 20, aspectRatio: "9:16", subscribeAnimation: config });
    await createShortsJob({ assetId: "asset", start: 0, aspectRatio: "9:16", subscribeAnimation: config });
    await createShortsSourceJob({ url: "https://youtube.com/watch?v=x", start: 0, aspectRatio: "9:16", subscribeAnimation: config });
    expect((calls[0].body as FormData).get("subscribe_animation")).toBe(JSON.stringify(config));
    expect(JSON.parse(calls[1].body as string).subscribeAnimation).toEqual(config);
    expect((calls[2].body as FormData).get("subscribe_animation")).toBe(JSON.stringify(config));
    expect(calls.map(({ url }) => url)).toEqual(["/api/v1/jobs/clip", "/api/v1/jobs/shorts", "/api/v1/jobs/shorts/source"]);
  });

  it("sends scoped caption save and rerender requests without constructing media URLs", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.method === "PUT") expect(init.body).toBe(JSON.stringify({ revision: 2, cues: [{ id: "c", start: 0, end: 1, text: "Reviewed" }] }));
      return new Response(JSON.stringify({ schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "queued", stage: "render", stageLabel: "Queued", progress: 0, style: "serious", warnings: [], clips: [], beats: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    await saveCaptionCues("j", "c", 2, [{ id: "c", start: 0, end: 1, text: "Reviewed" }]);
    await rerenderCaptions("j", "c", 2);
    expect(calls).toEqual(["/api/v1/jobs/j/clips/c/captions", "/api/v1/jobs/j/clips/c/captions/rerender?revision=2"]);
  });

  it("uses the bounded recent-clips endpoint contract and validates assets", async () => {
    const asset = {
      id: "asset-id", title: "Launch clip", description: "", mediaType: "video/mp4", filename: "launch.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [],
      policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "User supplied", attribution: "", contentHash: "hash",
      folderId: "folder-id", origin: "generated-clip", blobId: "blob-id", durationSeconds: 9.5, width: 1080, height: 1920, previewUrl: "/signed", brands: [], people: [], createdAt: "2026-01-01T00:00:00Z",
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("/api/v1/library/recent-clips?search=launch+clip&page=2&page_size=12");
      return new Response(JSON.stringify({ items: [asset], page: 2, pageSize: 12, hasMore: true, total: 25 }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await listRecentClips({ search: " launch clip ", page: 2, pageSize: 12 });
    expect(result).toMatchObject({ page: 2, pageSize: 12, hasMore: true, total: 25, items: [{ id: "asset-id", durationSeconds: 9.5 }] });
  });

  it("uses the typed folder endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "f1", name: "Acme", parentId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await createFolder({ name: "Acme" })).name).toBe("Acme");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/library/folders", expect.objectContaining({ method: "POST" }));
  });
});

describe("readableDetail", () => {
  it("passes a plain string detail through", () => {
    expect(readableDetail("Minimum duration must be shorter than maximum duration", "fallback"))
      .toBe("Minimum duration must be shorter than maximum duration");
  });

  it("flattens FastAPI validation arrays into a customer-readable sentence", () => {
    const detail = [
      { type: "greater_than_equal", loc: ["body", "min_duration"], msg: "Input should be greater than or equal to 8", input: "0" },
    ];
    expect(readableDetail(detail, "fallback")).toBe("Minimum seconds: Input should be greater than or equal to 8");
  });

  it("joins multiple field problems and drops duplicates", () => {
    const detail = [
      { loc: ["body", "count"], msg: "Input should be less than or equal to 30" },
      { loc: ["body", "count"], msg: "Input should be less than or equal to 30" },
      { loc: ["body", "max_duration"], msg: "Input should be a valid number" },
    ];
    expect(readableDetail(detail, "fallback"))
      .toBe("Clips requested: Input should be less than or equal to 30. Maximum seconds: Input should be a valid number");
  });

  it("never renders an object as [object Object]", () => {
    const message = readableDetail([{ loc: ["body", "unknown_field"], msg: "bad" }], "fallback");
    expect(message).not.toContain("[object Object]");
    expect(message).toBe("bad");
  });

  it("falls back when the detail carries nothing usable", () => {
    expect(readableDetail(undefined, "Request failed (500)")).toBe("Request failed (500)");
    expect(readableDetail([], "Request failed (500)")).toBe("Request failed (500)");
    expect(readableDetail([{}], "Request failed (500)")).toBe("Request failed (500)");
  });
});
