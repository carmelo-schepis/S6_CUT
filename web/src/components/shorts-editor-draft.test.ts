import { describe, expect, it, vi } from "vitest";
import { isShortsEditorDraft, localFileMatchesDraft, readShortsEditorDraft, type DraftSource, type ShortsEditorDraft } from "./shorts-editor-draft";

const draft: ShortsEditorDraft = {
  version: 1,
  updatedAt: "2026-10-19T00:00:00.000Z",
  source: { mode: "file", name: "source.mp4", size: 12, lastModified: 42, type: "video/mp4" },
  snapshot: { edit: { start: 1, end: 4, aspect: "9:16", subtitles: true }, overlays: [] },
  savedBaseline: { edit: { start: 0, aspect: "9:16", subtitles: true }, overlays: [] },
};
const fileSource = draft.source as Extract<DraftSource, { mode: "file" }>;

describe("Shorts Editor draft records", () => {
  it("accepts a complete versioned snapshot and rejects malformed records", () => {
    expect(isShortsEditorDraft(draft)).toBe(true);
    expect(isShortsEditorDraft({ ...draft, version: 2 })).toBe(false);
    expect(isShortsEditorDraft({ ...draft, snapshot: { edit: {}, overlays: [] } })).toBe(false);
    expect(isShortsEditorDraft({ ...draft, source: { mode: "file", name: "source.mp4" } })).toBe(false);
  });

  it("requires the reselected local file to match its saved identity", () => {
    const file = new File(["hello world!"], "source.mp4", { type: "video/mp4", lastModified: 42 });
    expect(localFileMatchesDraft(file, fileSource)).toBe(true);
    expect(localFileMatchesDraft(new File(["different"], "source.mp4", { type: "video/mp4", lastModified: 42 }), fileSource)).toBe(false);
    expect(localFileMatchesDraft(new File(["hello world!"], "other.mp4", { type: "video/mp4", lastModified: 42 }), fileSource)).toBe(false);
  });

  it("reports unavailable IndexedDB rather than throwing during draft lookup", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try { await expect(readShortsEditorDraft()).rejects.toThrow("Local draft storage is unavailable."); }
    finally { vi.unstubAllGlobals(); }
  });
});
