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
    expect(screen.getByRole("heading", { level: 1, name: "Editor" })).toBeInTheDocument();
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

  it("undoes and redoes complete edits, leaves no-op changes alone, and supports shortcuts", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = await screen.findByLabelText("Aspect ratio");
    fireEvent.change(aspect, { target: { value: "1:1" } });
    expect(aspect).toHaveValue("1:1");
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(aspect).toHaveValue("9:16");
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.change(aspect, { target: { value: "9:16" } }); // no-op keeps redo available
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.change(aspect, { target: { value: "16:9" } });
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(aspect).toHaveValue("16:9");
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    expect(aspect).toHaveValue("16:9");
    const name = screen.getByLabelText("Project name");
    name.focus();
    fireEvent.keyDown(name, { key: "z", ctrlKey: true });
    expect(aspect).toHaveValue("16:9"); // native text editing keeps the shortcut
  });

  it("commits a canceled text drag as one grouped undo action", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    fireEvent.click(screen.getByRole("button", { name: "Add text overlay" }));
    const overlay = screen.getByRole("button", { name: "Text overlay: Your text" });
    const frame = document.querySelector(".shorts-video-frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400, toJSON: () => ({}) });
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ x: 200, y: 200, left: 200, top: 200, right: 300, bottom: 240, width: 100, height: 40, toJSON: () => ({}) });
    fireEvent.pointerDown(overlay, { pointerId: 11, button: 0, clientX: 250, clientY: 220 });
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 380, clientY: 350 });
    fireEvent.pointerCancel(window, { pointerId: 11 });
    expect(overlay).toHaveStyle({ left: "70%", top: "62.5%" });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Text overlay: Your text" })).toHaveStyle({ left: "50%", top: "50%" });
  });

  it("enables undo for a meaningful focused edit and clears redo without splitting the group", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = screen.getByLabelText("Aspect ratio");
    const trimStart = screen.getByLabelText("Video trim start seconds");
    fireEvent.change(aspect, { target: { value: "1:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    fireEvent.focus(trimStart);
    fireEvent.change(trimStart, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.change(trimStart, { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(trimStart).toHaveValue(0);
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(trimStart).toHaveValue(1);
  });

  it("keeps redo when a grouped edit returns to its starting snapshot", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = screen.getByLabelText("Aspect ratio");
    fireEvent.change(aspect, { target: { value: "1:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    const projectName = screen.getByLabelText("Project name");
    fireEvent.focus(projectName);
    fireEvent.change(projectName, { target: { value: "temporary" } });
    fireEvent.change(projectName, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.blur(projectName);
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(aspect).toHaveValue("1:1");
  });

  it("groups tint colour changes made during one picker session", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Filter preset"), { target: { value: "tint" } });
    const tint = screen.getByLabelText("Tint color");
    fireEvent.focus(tint);
    fireEvent.change(tint, { target: { value: "#123456" } });
    fireEvent.change(tint, { target: { value: "#654321" } });
    fireEvent.blur(tint);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(tint).toHaveValue("#d58a55");
    expect(screen.getByLabelText("Filter preset")).toHaveValue("tint");
  });

  it("groups tint colour changes on the empty editor screen", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Filter preset"), { target: { value: "tint" } });
    const tint = screen.getByLabelText("Tint color");
    fireEvent.focus(tint);
    fireEvent.change(tint, { target: { value: "#123456" } });
    fireEvent.change(tint, { target: { value: "#654321" } });
    fireEvent.blur(tint);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(tint).toHaveValue("#d58a55");
    expect(screen.getByLabelText("Filter preset")).toHaveValue("tint");
  });

  it("restores project name, trims, tint settings, and subscribe animation snapshots", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });

    const projectName = screen.getByLabelText("Project name");
    fireEvent.focus(projectName);
    fireEvent.change(projectName, { target: { value: "Project Aurora" } });
    fireEvent.blur(projectName);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(projectName).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(projectName).toHaveValue("Project Aurora");

    const trimStart = screen.getByLabelText("Video trim start seconds");
    fireEvent.focus(trimStart);
    fireEvent.change(trimStart, { target: { value: "0.5" } });
    fireEvent.blur(trimStart);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(trimStart).toHaveValue(0);
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(trimStart).toHaveValue(0.5);

    fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Filter preset"), { target: { value: "tint" } });
    const tint = screen.getByLabelText("Tint color");
    fireEvent.focus(tint);
    fireEvent.change(tint, { target: { value: "#123456" } });
    fireEvent.blur(tint);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(tint).toHaveValue("#d58a55");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(tint).toHaveValue("#123456");

    fireEvent.click(screen.getByText("Subscribe animation settings", { selector: "summary" }));
    const enabled = screen.getByLabelText("Enable Subscribe animation");
    const timing = screen.getByLabelText("Subscribe animation timing");
    fireEvent.change(timing, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(timing).toHaveValue("5");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(timing).toHaveValue("10");
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(enabled).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(enabled).not.toBeChecked();
  });

  it("caps meaningful undo history at 100 entries", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = screen.getByLabelText("Aspect ratio");
    const values = ["16:9", "1:1", "4:5", "9:16"];
    for (let index = 0; index < 101; index += 1) fireEvent.change(aspect, { target: { value: values[index % values.length] } });
    const undo = screen.getByRole("button", { name: "Undo" });
    for (let index = 0; index < 100; index += 1) fireEvent.click(undo);
    expect(aspect).toHaveValue("16:9");
    expect(undo).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
  });

  it("saves the queued baseline and clears undo and redo after success", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = screen.getByLabelText("Aspect ratio");
    fireEvent.change(aspect, { target: { value: "1:1" } });
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    await waitFor(() => expect(createShortsJob).toHaveBeenCalled());
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();

    fireEvent.change(aspect, { target: { value: "16:9" } });
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(aspect).toHaveValue("1:1");
  });

  it("preserves both history stacks when queueing fails", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    vi.mocked(createShortsJob).mockRejectedValueOnce(new Error("Queue unavailable"));
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    const aspect = screen.getByLabelText("Aspect ratio");
    fireEvent.change(aspect, { target: { value: "1:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(aspect).toHaveValue("9:16");
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Queue unavailable");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(aspect).toHaveValue("1:1");
  });

  it("clears undo and redo after a successful source replacement", async () => {
    const second = { ...asset, id: "asset-2", title: "Second clip", filename: "second.mp4", blobId: "blob-2", previewUrl: "/second.mp4" };
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }, second]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    fireEvent.change(screen.getByLabelText("Aspect ratio"), { target: { value: "1:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    fireEvent.click(screen.getByText("Choose another source"));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: second.id } });
    await screen.findByRole("heading", { level: 2, name: second.title });
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("preserves edits and undo history when a Library source load fails", async () => {
    const second = { ...asset, id: "asset-2", title: "Second clip", filename: "second.mp4", blobId: "blob-2", previewUrl: "/second.mp4" };
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }, second]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    fireEvent.change(trimField("Start seconds"), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    vi.mocked(listAssets).mockRejectedValueOnce(new Error("Library unavailable"));
    fireEvent.click(screen.getByText("Choose another source"));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: second.id } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Library unavailable");
    expect(trimField("Start seconds")).toHaveValue(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(trimField("Start seconds")).toHaveValue(0);
  });

  it("reconfirms a source switch if the document changes after mode confirmation", async () => {
    vi.mocked(listAssets).mockResolvedValue([{ ...asset, previewUrl: "/preview.mp4" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Library/ }));
    fireEvent.change(await screen.findByLabelText("Library video"), { target: { value: asset.id } });
    await screen.findByRole("heading", { level: 2, name: asset.title });
    fireEvent.change(trimField("Start seconds"), { target: { value: "1" } });
    fireEvent.click(screen.getByText("Choose another source"));
    fireEvent.click(screen.getByRole("tab", { name: /Local file/ }));
    fireEvent.change(screen.getByLabelText("Aspect ratio"), { target: { value: "1:1" } });
    fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "replacement.mp4", { type: "video/mp4" })] } });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 2, name: asset.title })).toBeInTheDocument();
    expect(screen.getByLabelText("Aspect ratio")).toHaveValue("1:1");
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });
});
