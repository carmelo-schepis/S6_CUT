import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShortsJob, createShortsSourceJob, listAssets, listJobs } from "../api";
import type { Job, LibraryAsset } from "../types";
import { ShortsEditorView, parseAssistantRequest } from "./shorts-editor-view";

vi.mock("../api", () => ({
  createShortsJob: vi.fn(), createShortsSourceJob: vi.fn(), listAssets: vi.fn(), listJobs: vi.fn().mockResolvedValue([]), readableError: (error: unknown) => error instanceof Error ? error.message : "Request failed",
}));

const asset: LibraryAsset = { id: "asset-1", title: "Library clip", description: "", mediaType: "video/mp4", filename: "clip.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash", brands: [], people: [], folderId: "folder", origin: "manual-import", blobId: "blob", createdAt: "2026-01-01T00:00:00Z" };

describe("ShortsEditorView", () => {
  beforeEach(() => { vi.mocked(listAssets).mockImplementation(async () => [asset]); vi.mocked(listJobs).mockResolvedValue([]); vi.mocked(createShortsJob).mockResolvedValue({ project: {} as never, job: {} as never }); vi.mocked(createShortsSourceJob).mockResolvedValue({ project: {} as never, job: {} as never }); });
  afterEach(() => vi.useRealTimers());
  it("explains the accepted source, editing controls, and queued output", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    expect(screen.getByText("Trim an authorised video into a social-ready clip. Choose the section, output shape, and subtitles, then queue the render.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Library")).toBeInTheDocument());
    expect(screen.getByText("Local file")).toBeInTheDocument();
    expect(screen.getByText("YouTube")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Source remainder")).toBeInTheDocument();
  });
  it("lays the workspace out without opening a second main landmark", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Library")).toBeInTheDocument());
    // The shell already owns #main-content; a nested <main> is a duplicate
    // landmark and is not top level.
    expect(document.querySelectorAll("main, [role='main']")).toHaveLength(0);
    const workspace = document.querySelector(".shorts-workspace")!;
    expect(workspace.tagName).toBe("SECTION");
    // An unnamed section is a layout container, so the aside inside it stays a
    // top-level complementary landmark.
    expect(workspace.getAttribute("aria-label")).toBeNull();
    expect(document.querySelector("aside.shorts-right-column")).toHaveAttribute("aria-label", "Clips and editing assistant");
  });

  it("shows a useful Library empty state when no videos exist", async () => {
    vi.mocked(listAssets).mockResolvedValue([]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    expect(await screen.findByText("No Library videos available")).toBeInTheDocument();
  });
  it("refreshes a queued render into its completed preview state", async () => {
    vi.useFakeTimers();
    const queued: Job = {
      schemaVersion: 1, id: "job-1", projectId: "project-1", mode: "clip", state: "queued", stage: "queued", stageLabel: "Queued", progress: 0,
      currentItem: 0, totalItems: 1, style: "educational", processingMode: "fast", warnings: [], error: null, beats: [], steps: [],
      clips: [{ id: "clip-1", index: 1, state: "queued", start: 0, end: 4, duration: 4, openingLine: "", score: null, selected: true, fallbackUsed: false, provenance: [] }],
      createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
    };
    vi.mocked(listJobs).mockResolvedValue([queued]);
    const view = render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("queued")).toBeInTheDocument();
    vi.mocked(listJobs).mockResolvedValue([{ ...queued, state: "complete", stage: "complete", stageLabel: "1 fast cut ready", progress: 100, clips: [{ ...queued.clips[0], state: "complete", width: 1080, height: 1350, previewUrl: "/preview.mp4" }] }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("complete")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps proposal-only assistant requests uncommitted until Apply", async () => {
    const current = { start: 0, end: 4, aspect: "9:16" as const, subtitles: true };
    const parsed = parseAssistantRequest("Propose changing the aspect ratio to 1:1 without applying it.", current);
    expect(parsed.proposal?.edit).toEqual({ aspect: "1:1" });
    expect(parsed.edit).toBeUndefined();
    expect(parsed.explanation).not.toMatch(/Applied locally/);
  });

  it("preserves direct assistant changes as apply-now actions", () => {
    const parsed = parseAssistantRequest("Change the aspect ratio to 1:1 now.", { start: 0, end: 4, aspect: "9:16", subtitles: true });
    expect(parsed.edit).toEqual({ aspect: "1:1" });
    expect(parsed.proposal).toBeUndefined();
  });

  it("rejects invalid trim values and submits YouTube through multipart API", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("YouTube")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Start seconds"), { target: { value: "-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Queue short" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 0/);
    fireEvent.click(screen.getByRole("tab", { name: /YouTube/ }));
    await waitFor(() => expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=test" } });
    fireEvent.change(screen.getByLabelText("Start seconds"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    await waitFor(() => expect(createShortsSourceJob).toHaveBeenCalledWith(expect.objectContaining({ url: "https://www.youtube.com/watch?v=test", end: undefined })));
  });
});
