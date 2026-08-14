import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClipJob, createFolder, getHealth, readableError } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("engine API boundary", () => {
  it("validates the runtime capability response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "degraded", version: "0.1.0", database: true, ffmpeg: false, ffprobe: false,
      whisper: false, ytdlp: false, localTts: false, dataPath: "Local mounted data directory",
      freeBytes: 100, activeWorkers: 0, queuedJobs: 0, fallbacks: { media: "text card" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const health = await getHealth();
    expect(health.status).toBe("degraded");
    expect(health.fallbacks.media).toBe("text card");
  });

  it("turns bounded API details into readable errors", () => {
    expect(readableError(new ApiError("Queue full", 429))).toBe("Queue full");
  });

  it("sends processing_mode with the clip job form", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("processing_mode")).toBe("fast");
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
      processingMode: "fast", libraryFolderId: "business-1",
    });
    expect(result.project.id).toBe("p");
    expect(result.job.processingMode).toBe("smart"); // legacy backend omission defaults to Smart
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
