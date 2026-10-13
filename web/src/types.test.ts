import { describe, expect, it } from "vitest";
import { beatSchema, clipSchema, jobSchema, musicPresentationSchema, processingModeSchema, processingStepSchema, sourceProfileSchema } from "./types";

const score = {
  hook: 80, coherence: 82, ending: 79, energy: 70, practicalValue: 75,
  visualPotential: 77, completeness: 91, penalties: 2, llmContribution: null,
  total: 82, explanation: "A complete, useful thought.",
};

describe("versioned UI contracts", () => {
  it("accepts the three additive reference Music themes without changing version 1", () => {
    for (const subtitleTheme of ["reference_white_sans", "reference_yellow_sans", "reference_white_serif"]) {
      expect(musicPresentationSchema.parse({ version: 1, subtitleTheme })).toEqual({ version: 1, subtitleTheme });
    }
    expect(musicPresentationSchema.parse({ version: 1, subtitleTheme: "clean" })).toEqual({ version: 1, subtitleTheme: "clean" });
    expect(() => musicPresentationSchema.parse({ version: 1, subtitleTheme: "unsupported" })).toThrow();
  });
  it("rejects malformed clip ranges and scores", () => {
    expect(() => clipSchema.parse({ id: "one", index: 1, state: "complete", start: -1, end: 5, duration: 6, openingLine: "Hello", score, selected: true, fallbackUsed: false, provenance: [] })).toThrow();
    expect(() => clipSchema.parse({ id: "one", index: 1, state: "complete", start: 0, end: 5, duration: 5, openingLine: "Hello", score: { ...score, total: 102 }, selected: true, fallbackUsed: false, provenance: [] })).toThrow();
  });

  it("accepts optional nullable clip hook text and an optional hookTextEnabled job flag", () => {
    const clip = clipSchema.parse({ id: "c", index: 1, state: "complete", start: 0, end: 5, duration: 5, openingLine: "Hello", hookText: null, selected: true, fallbackUsed: false, provenance: [] });
    const job = jobSchema.parse({ schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "complete", stage: "done", stageLabel: "Done", progress: 100, style: "serious", hookTextEnabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    expect(clip.hookText).toBeNull();
    expect(job.hookTextEnabled).toBe(true);
  });

  it("parses optional YouTube metadata fields while preserving legacy responses", () => {
    const legacy = clipSchema.parse({ id: "old", index: 1, state: "complete", start: 0, end: 5, duration: 5, openingLine: "Source line", selected: true, fallbackUsed: false, provenance: [] });
    const current = clipSchema.parse({ id: "new", index: 1, state: "complete", start: 0, end: 5, duration: 5, openingLine: "Source line", title: "A title", youtubeDescription: "A description", selected: true, fallbackUsed: false, provenance: [] });
    const job = jobSchema.parse({ schemaVersion: 1, id: "j", projectId: "p", mode: "clip", state: "complete", stage: "done", stageLabel: "Done", progress: 100, style: "serious", youtubeMetadataEnabled: true, youtubeMetadataModelId: "openai/gpt-4.1-mini", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    expect(legacy.youtubeDescription).toBeUndefined();
    expect(current.youtubeDescription).toBe("A description");
    expect(job.youtubeMetadataEnabled).toBe(true);
  });

  it("keeps exact beat spans explicit", () => {
    const script = "The Beatles changed popular music.";
    const beat = beatSchema.parse({ id: "beat", start: 0, end: 2.5, charStart: 0, charEnd: script.length, text: script, concept: "The Beatles", source: "text-card", confidence: .7, matchReason: "fallback" });
    expect(script.slice(beat.charStart, beat.charEnd)).toBe(beat.text);
  });

  it("requires schema version 1 for durable jobs", () => {
    expect(() => jobSchema.parse({ schemaVersion: 2 })).toThrow();
  });

  it("defaults legacy Job processingMode to smart", () => {
    const job = jobSchema.parse({
      schemaVersion: 1, id: "x", projectId: "p", mode: "clip", state: "queued",
      stage: "q", stageLabel: "Q", progress: 0, style: "funny",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(job.processingMode).toBe("smart");
  });

  it("defaults Job.steps to an empty array for legacy jobs without steps", () => {
    const job = jobSchema.parse({
      schemaVersion: 1, id: "x", projectId: "p", mode: "clip", state: "queued",
      stage: "q", stageLabel: "Q", progress: 0, style: "funny",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(job.steps).toEqual([]);
  });

  it("parses structured processing steps with camelCase timestamps", () => {
    const job = jobSchema.parse({
      schemaVersion: 1, id: "x", projectId: "p", mode: "clip", state: "active",
      stage: "r", stageLabel: "Rendering clips", progress: 40, style: "funny",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      steps: [
        { id: "s1", label: "Source received", status: "complete", completedAt: "2026-01-01T00:00:01Z" },
        { id: "s2", label: "Clips rendered", status: "active", startedAt: "2026-01-01T00:00:02Z", currentItem: 3, totalItems: 5, detail: "Rendering output 3" },
      ],
    });
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0].status).toBe("complete");
    expect(job.steps[0].completedAt).toBe("2026-01-01T00:00:01Z");
    expect(job.steps[1].currentItem).toBe(3);
    expect(job.steps[1].totalItems).toBe(5);
  });

  it("rejects unknown processing step statuses and non-string timestamps", () => {
    expect(() => processingStepSchema.parse({ id: "s", label: "X", status: "done" })).toThrow();
    expect(() => processingStepSchema.parse({ id: "s", label: "X", status: "complete", completedAt: 123 })).toThrow();
    expect(() => processingStepSchema.parse({ id: "s", label: "X", status: "active", currentItem: -1, totalItems: 5 })).toThrow();
  });

  it("enforces processing step timestamp and item-count invariants", () => {
    const base = { id: "render", label: "Clips rendered" };
    expect(processingStepSchema.safeParse({ ...base, status: "complete" }).success).toBe(false);
    expect(processingStepSchema.safeParse({ ...base, status: "pending", completedAt: "2026-01-01T00:00:00Z" }).success).toBe(false);
    expect(processingStepSchema.safeParse({ ...base, status: "active", currentItem: 4, totalItems: 3 }).success).toBe(false);
    expect(processingStepSchema.safeParse({ ...base, status: "complete", completedAt: "2026-01-01T00:00:00Z" }).success).toBe(true);
  });

  it("accepts only the persisted source profile values", () => {
    expect(sourceProfileSchema.parse("speech")).toBe("speech");
    expect(sourceProfileSchema.parse("music")).toBe("music");
    expect(sourceProfileSchema.safeParse("song").success).toBe(false);
  });

  it("accepts explicit processingMode values", () => {
    expect(processingModeSchema.parse("auto")).toBe("auto");
    expect(processingModeSchema.parse("fast")).toBe("fast");
    expect(processingModeSchema.parse("smart")).toBe("smart");
  });

  it("makes clip score nullable with null default", () => {
    const clip = clipSchema.parse({
      id: "c1", index: 1, state: "complete", start: 0, end: 5, duration: 5,
      openingLine: "Hi", score: null, selected: true, fallbackUsed: false, provenance: [],
    });
    expect(clip.score).toBeNull();
    // Omitting score also defaults to null
    const clip2 = clipSchema.parse({
      id: "c2", index: 2, state: "complete", start: 0, end: 5, duration: 5,
      openingLine: "Hi", selected: true, fallbackUsed: false, provenance: [],
    });
    expect(clip2.score).toBeNull();
  });

  it("still accepts a valid score object", () => {
    const score = {
      hook: 80, coherence: 82, ending: 79, energy: 70, practicalValue: 75,
      visualPotential: 77, completeness: 91, penalties: 2, llmContribution: null,
      total: 82, explanation: "A complete, useful thought.",
    };
    const clip = clipSchema.parse({
      id: "c1", index: 1, state: "complete", start: 0, end: 5, duration: 5,
      openingLine: "Hi", score, selected: true, fallbackUsed: false, provenance: [],
    });
    expect(clip.score).not.toBeNull();
    expect(clip.score!.total).toBe(82);
  });

  it("accepts publication metadata fields (libraryAssetId, title, dimensions, folder, publishedAt, previewUrl)", () => {
    const clip = clipSchema.parse({
      id: "c1", index: 1, state: "complete", start: 0, end: 5, duration: 5,
      openingLine: "Test", selected: true, fallbackUsed: false, provenance: [],
      libraryAssetId: "asset-1",
      title: "Project — Cut 01",
      width: 1080, height: 1920,
      folderId: "business-1", folderName: "Acme Corp",
      publishedAt: "2026-08-14T00:00:00Z",
      previewUrl: "/api/v1/media/preview/hash.mp4",
    });
    expect(clip.libraryAssetId).toBe("asset-1");
    expect(clip.title).toBe("Project — Cut 01");
    expect(clip.width).toBe(1080);
    expect(clip.height).toBe(1920);
    expect(clip.folderId).toBe("business-1");
    expect(clip.folderName).toBe("Acme Corp");
    expect(clip.publishedAt).toBe("2026-08-14T00:00:00Z");
    expect(clip.previewUrl).toBe("/api/v1/media/preview/hash.mp4");
  });

  it("legacy clip without publication metadata still parses (fields are undefined)", () => {
    const clip = clipSchema.parse({
      id: "c1", index: 1, state: "complete", start: 0, end: 5, duration: 5,
      openingLine: "Hi", selected: true, fallbackUsed: false, provenance: [],
    });
    expect(clip.libraryAssetId).toBeUndefined();
    expect(clip.title).toBeUndefined();
    expect(clip.width).toBeUndefined();
    expect(clip.height).toBeUndefined();
    expect(clip.folderId).toBeUndefined();
    expect(clip.folderName).toBeUndefined();
    expect(clip.publishedAt).toBeUndefined();
    expect(clip.previewUrl).toBeUndefined();
  });
});
