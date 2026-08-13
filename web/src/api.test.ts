import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getHealth, readableError } from "./api";

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
});
