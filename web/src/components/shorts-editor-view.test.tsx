import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShortsJob, createShortsSourceJob, listAssets, listJobs } from "../api";
import type { Job, LibraryAsset } from "../types";
import { ShortsEditorView, parseAssistantRequest } from "./shorts-editor-view";

vi.mock("../api", () => ({
  createShortsJob: vi.fn(), createShortsSourceJob: vi.fn(), listAssets: vi.fn(), listJobs: vi.fn().mockResolvedValue([]), readableError: (error: unknown) => error instanceof Error ? error.message : "Request failed",
}));

const asset: LibraryAsset = { id: "asset-1", title: "Library clip", description: "", mediaType: "video/mp4", filename: "clip.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash", brands: [], people: [], folderId: "folder", origin: "manual-import", blobId: "blob", createdAt: "2026-01-01T00:00:00Z" };

function trimField(name: "Start seconds" | "End seconds") {
  const inspectorLabel = name === "Start seconds" ? "Video trim start seconds" : "Video trim end seconds";
  return screen.queryByRole("region", { name: "Video properties" })?.querySelector(`[aria-label="${inspectorLabel}"]`) ?? screen.getByLabelText(name, { exact: true });
}

describe("ShortsEditorView", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(listAssets).mockImplementation(async () => [asset]); vi.mocked(listJobs).mockResolvedValue([]); vi.mocked(createShortsJob).mockResolvedValue({ project: {} as never, job: {} as never }); vi.mocked(createShortsSourceJob).mockResolvedValue({ project: {} as never, job: {} as never }); });
  afterEach(() => vi.useRealTimers());
  it("explains the accepted source, editing controls, and queued output", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeInTheDocument();
    expect(screen.queryByText("Trim an authorised video into a social-ready clip. Choose the section, output shape, and subtitles, then queue the render.")).not.toBeInTheDocument();
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

  it("queues the selected Library asset with its clip-relative trim settings", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/api/v1/library/assets/asset-1/preview" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Library/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    fireEvent.change(screen.getByLabelText("Library video"), { target: { value: asset.id } });
    await waitFor(() => expect(screen.getByLabelText("Library video")).toHaveValue(asset.id));
    fireEvent.change(trimField("Start seconds"), { target: { value: "12.5" } });
    fireEvent.change(trimField("End seconds"), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));

    await waitFor(() => expect(createShortsJob).toHaveBeenCalledWith(expect.objectContaining({
      assetId: asset.id, start: 12.5, end: 18, aspectRatio: "9:16",
    })));
    expect(createShortsSourceJob).not.toHaveBeenCalled();
  });

  it("does not create a job while the Library source list is still loading", async () => {
    let finishLoading!: (assets: LibraryAsset[]) => void;
    vi.mocked(listAssets).mockReturnValue(new Promise((resolve) => { finishLoading = resolve; }));
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a Library video first.");
    expect(createShortsJob).not.toHaveBeenCalled();
    expect(createShortsSourceJob).not.toHaveBeenCalled();
    await act(async () => finishLoading([asset]));
  });

  it("surfaces rejected preview playback without leaving the player in a playing state", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Unsupported video", "NotSupportedError"));
    try {
      render(<ShortsEditorView onJobCreated={vi.fn()} />);
      fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
      fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
      await screen.findByLabelText("Source video preview");

      fireEvent.click(screen.getAllByRole("button", { name: "Play preview" })[0]);

      expect(await screen.findByRole("alert")).toHaveTextContent("Preview playback could not start.");
      expect(screen.getAllByRole("button", { name: "Play preview" })).toHaveLength(1);
      expect(play).toHaveBeenCalledOnce();
    } finally {
      play.mockRestore();
    }
  });

  it("ignores a canceled playback rejection after switching Library sources", async () => {
    const firstAsset = { ...asset, previewUrl: "/preview-1.mp4" };
    const secondAsset = { ...asset, id: "asset-2", title: "Another Library clip", filename: "clip-2.mp4", blobId: "blob-2", previewUrl: "/preview-2.mp4" };
    vi.mocked(listAssets).mockResolvedValue([firstAsset, secondAsset]);
    let rejectPlay!: (reason: DOMException) => void;
    const pendingPlay = new Promise<void>((_, reject) => { rejectPlay = reject; });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(pendingPlay);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      render(<ShortsEditorView onJobCreated={vi.fn()} />);
      fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
      fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: firstAsset.id } });
      await screen.findByLabelText("Source video preview");
      fireEvent.click(screen.getAllByRole("button", { name: "Play preview" })[0]);
      expect(play).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByText("Choose another source"));
      fireEvent.change(screen.getByLabelText("Library video"), { target: { value: secondAsset.id } });
      await screen.findByRole("heading", { level: 2, name: secondAsset.title });
      await act(async () => rejectPlay(new DOMException("Playback interrupted", "AbortError")));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: secondAsset.title })).toBeInTheDocument();
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  it("loads a published clip from the same Library asset using clip-relative trim bounds", async () => {
    const job: Job = {
      schemaVersion: 1, id: "job-same-source", projectId: "project-same-source", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100,
      currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", warnings: [], error: null, beats: [], steps: [],
      clips: [{ id: "clip-same-source", index: 1, state: "complete", start: 12, end: 16, duration: 4, openingLine: "", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Published cut", libraryAssetId: asset.id }],
      createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
    };
    vi.mocked(listJobs).mockResolvedValue([job]);
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/api/v1/library/assets/asset-1/preview", origin: "generated-clip", sourceClipId: "clip-same-source", sourceJobId: job.id, sourceProjectId: job.projectId }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Published cut/ }));

    await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(trimField("End seconds")).toHaveValue(4));
    expect(trimField("Start seconds")).toHaveValue(0);
    expect(trimField("End seconds")).toHaveValue(4);
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    await waitFor(() => expect(createShortsJob).toHaveBeenCalledWith(expect.objectContaining({ assetId: asset.id, start: 0, end: 4 })));
  });

  it("slides clips and the assistant in from the right and hands focus back when a clip loads", async () => {
    const job: Job = {
      schemaVersion: 1, id: "job-drawer", projectId: "project-drawer", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100,
      currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", warnings: [], error: null, beats: [], steps: [],
      clips: [{ id: "clip-drawer", index: 1, state: "complete", start: 2, end: 7, duration: 5, openingLine: "", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Drawer cut", libraryAssetId: asset.id }],
      createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
    };
    vi.mocked(listJobs).mockResolvedValue([job]);
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/api/v1/library/assets/asset-1/preview", origin: "generated-clip", sourceClipId: "clip-drawer", sourceJobId: job.id, sourceProjectId: job.projectId }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /^Clips & assistant/ });
    const drawer = document.getElementById("shorts-clip-drawer")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveClass("open");

    fireEvent.click(toggle);
    expect(drawer).toHaveClass("open");
    const clip = await screen.findByRole("button", { name: /Drawer cut/ });
    clip.focus();
    fireEvent.click(clip);
    await waitFor(() => expect(trimField("End seconds")).toHaveValue(5));
    expect(drawer).not.toHaveClass("open");
    expect(toggle).toHaveFocus();

    // Escape inside the drawer closes only the drawer; the open inspector stays put.
    fireEvent.click(toggle);
    clip.focus();
    fireEvent.keyDown(clip, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("region", { name: "Video properties" })).toBeInTheDocument();
  });

  it("drops an eligible clip into the editor and loads its linked asset", async () => {
    const job: Job = {
      schemaVersion: 1, id: "job-drag", projectId: "project-drag", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100,
      currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", warnings: [], error: null, beats: [], steps: [],
      clips: [{ id: "clip-drag", index: 1, state: "complete", start: 9, end: 15, duration: 6, openingLine: "", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Drag cut", libraryAssetId: asset.id }],
      createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
    };
    vi.mocked(listJobs).mockResolvedValue([job]);
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/api/v1/library/assets/asset-1/preview", origin: "generated-clip", sourceClipId: "clip-drag", sourceJobId: job.id, sourceProjectId: job.projectId }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    const clipButton = await screen.findByRole("button", { name: /Drag cut/ });
    const editor = document.querySelector(".shorts-editor-panel")!;
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({ x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 600, width: 400, height: 500, toJSON: () => ({}) });
    Object.defineProperty(clipButton, "setPointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(clipButton, { pointerId: 7, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(clipButton, { pointerId: 7, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 200, clientY: 200 });

    await waitFor(() => expect(trimField("End seconds")).toHaveValue(6));
    expect(trimField("Start seconds")).toHaveValue(0);
    expect(listAssets).toHaveBeenCalledTimes(2);
  });

  it("keeps the current clip selected when discard protection is cancelled", async () => {
    const job: Job = {
      schemaVersion: 1, id: "job-selection", projectId: "project-selection", mode: "clip", state: "complete", stage: "complete", stageLabel: "Ready", progress: 100,
      currentItem: 1, totalItems: 1, style: "educational", processingMode: "fast", warnings: [], error: null, beats: [], steps: [],
      clips: [{ id: "clip-selection", index: 1, state: "complete", start: 3, end: 7, duration: 4, openingLine: "", score: null, selected: true, fallbackUsed: false, provenance: [], title: "Selected cut", libraryAssetId: asset.id }],
      createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
    };
    vi.mocked(listJobs).mockResolvedValue([job]);
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/api/v1/library/assets/asset-1/preview", origin: "generated-clip", sourceClipId: "clip-selection", sourceJobId: job.id, sourceProjectId: job.projectId }]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await screen.findByRole("button", { name: /Selected cut/ });
    fireEvent.change(trimField("Start seconds"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /Selected cut/ }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith("Discard unsaved Shorts Editor changes?"));
    expect(trimField("Start seconds")).toHaveValue(20);
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
  });

  it("rejects invalid trim values and submits YouTube through multipart API", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("YouTube")).toBeInTheDocument());
    fireEvent.change(trimField("Start seconds"), { target: { value: "-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Queue short" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 0/);
    fireEvent.click(screen.getByRole("tab", { name: /YouTube/ }));
    await waitFor(() => expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=test" } });
    fireEvent.change(trimField("Start seconds"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    await waitFor(() => expect(createShortsSourceJob).toHaveBeenCalledWith(expect.objectContaining({ url: "https://www.youtube.com/watch?v=test", end: undefined })));
  });
});
