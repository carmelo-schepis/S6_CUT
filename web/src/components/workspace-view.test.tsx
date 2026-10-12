import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, LibraryAsset, LibraryFolder, Project } from "../types";
import { WorkspaceView } from "./workspace-view";

// ---------------------------------------------------------------
// Mock API module so no real fetch is attempted.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, getJob: vi.fn(), controlJob: vi.fn(), jobEventsUrl: vi.fn(() => ""), createZip: vi.fn(), retryClip: vi.fn(), setClipSelection: vi.fn(), listAssets: vi.fn(), listFolders: vi.fn().mockResolvedValue([]), changeProjectFolder: vi.fn() };
});

import { controlJob, createZip, getJob, listAssets, listFolders } from "../api";
const mockGetJob = vi.mocked(getJob);
const mockControlJob = vi.mocked(controlJob);
const mockListAssets = vi.mocked(listAssets);
const mockListFolders = vi.mocked(listFolders);

const project: Project = {
  schemaVersion: 1, id: "p1", name: "Test", mode: "clip", style: "serious",
  state: "complete", sourceName: "test.mp4", sourceKind: "upload", requestedCount: 3,
  latestJobId: "j1", createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

// Reference point: 2026-08-13T00:00:00Z, exactly 120s after staleSmartJob.updatedAt
const REFERENCE_NOW = new Date("2026-08-13T00:00:00Z").getTime();

const staleSmartJob: Job = {
  schemaVersion: 1, id: "j1", projectId: "p1", mode: "clip", state: "active",
  stage: "planning", stageLabel: "Planning with provider", progress: 15,
  currentItem: 1, totalItems: 3, style: "serious", processingMode: "smart",
  warnings: [], error: null, clips: [], beats: [], steps: [],
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-12T23:58:00Z",
};

const freshSmartJob: Job = {
  ...staleSmartJob,
  updatedAt: "2026-08-13T00:00:00Z",
};

const staleFastJob: Job = {
  ...staleSmartJob, processingMode: "fast",
};

const staleSmartJobWithOutputs: Job = {
  ...staleSmartJob,
  clips: [
    {
      id: "c1", index: 1, state: "complete", start: 0, end: 10, duration: 10,
      openingLine: "Hello world", score: null, selected: true, fallbackUsed: false,
      provenance: [],
    },
  ],
};

const responsiveJob: Job = {
  ...staleSmartJobWithOutputs,
  state: "complete",
  stage: "done",
  stageLabel: "Complete",
  progress: 100,
  clips: [{ ...staleSmartJobWithOutputs.clips[0], downloadUrl: "/clip.mp4" }],
};

// Stub EventSource for jsdom
vi.stubGlobal("EventSource", class { close() {} });

// ---------------------------------------------------------------
function renderView(props: Partial<Parameters<typeof WorkspaceView>[0]> = {}) {
  const onProjectUpdated = vi.fn(async () => undefined);
  const onGoProjects = vi.fn();
  const onConfigureProviders = vi.fn();
  return render(
    <WorkspaceView
      project={project}
      hasSelectedProvider
      onConfigureProviders={onConfigureProviders}
      onProjectUpdated={onProjectUpdated}
      onGoProjects={onGoProjects}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------
describe("WorkspaceView – page structure", () => {
  it("makes the empty workspace title the page heading", () => {
    renderView({ project: null });
    // With no project this empty state is the whole page, so its title has to
    // be the <h1>; there is nothing else to carry it.
    const heading = screen.getByRole("heading", { level: 1, name: "No project selected" });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps the project name as the page heading when a project is open", () => {
    renderView();
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(project.name);
  });

  it("names both complementary landmarks", () => {
    renderView();
    const names = [...document.querySelectorAll("aside")].map((aside) => aside.getAttribute("aria-label"));
    expect(names).toEqual(["Source material", "Clip inspector"]);
  });

  it("does not offer the provider callout before /profiles has answered", () => {
    const { rerender } = renderView({ hasSelectedProvider: false, providersLoaded: false });
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();
    rerender(<WorkspaceView project={project} hasSelectedProvider={false} providersLoaded onConfigureProviders={vi.fn()} onProjectUpdated={vi.fn(async () => undefined)} onGoProjects={vi.fn()} />);
    expect(screen.getByText(/Add optional AI providers/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("WorkspaceView – stalled smart detection", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(REFERENCE_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows stalled callout for a Smart job with updatedAt > 90s ago", async () => {
    mockGetJob.mockResolvedValue(staleSmartJob);
    renderView();
    expect(await screen.findByText(/Smart processing appears stalled/i)).toBeInTheDocument();
    expect(screen.getByText(/not reported progress for over 90 seconds/i)).toBeInTheDocument();
    // Reassurance text
    expect(screen.getAllByText(/processing will continue in the engine/i).length).toBeGreaterThan(0);
  });

  it("does not show stalled callout for a fresh Smart job", async () => {
    mockGetJob.mockResolvedValue(freshSmartJob);
    renderView();
    // stageLabel appears in both the status badge and job strip.
    expect((await screen.findAllByText("Planning with provider")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Smart processing appears stalled/i)).not.toBeInTheDocument();
  });

  it("does not show stalled callout for a stale Fast job", async () => {
    mockGetJob.mockResolvedValue(staleFastJob);
    renderView();
    expect((await screen.findAllByText("Planning with provider")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/processing appears stalled/i)).not.toBeInTheDocument();
  });

  it("'Switch to fast local' calls the switch-fast control API", async () => {
    mockGetJob.mockResolvedValue(staleSmartJob);
    mockControlJob.mockResolvedValue({ ...staleSmartJob, processingMode: "fast" });
    renderView();
    expect(await screen.findByText(/Smart processing appears stalled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Switch to fast local/i }));
    await waitFor(() => expect(mockControlJob).toHaveBeenCalledWith(staleSmartJob.id, "switch-fast"));
  });

  it("'Keep waiting' dismisses the callout", async () => {
    mockGetJob.mockResolvedValue(staleSmartJob);
    renderView();
    expect(await screen.findByText(/Smart processing appears stalled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Keep waiting/i }));
    expect(screen.queryByText(/Smart processing appears stalled/i)).not.toBeInTheDocument();
  });

  it("'Stop & keep outputs' is not shown when no complete clips exist", async () => {
    mockGetJob.mockResolvedValue(staleSmartJob);
    renderView();
    expect(await screen.findByText(/Smart processing appears stalled/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop & keep outputs/i })).not.toBeInTheDocument();
  });

  it("'Stop & keep outputs' calls controlJob stop-keep when outputs exist", async () => {
    mockGetJob.mockResolvedValue(staleSmartJobWithOutputs);
    mockControlJob.mockResolvedValue(staleSmartJobWithOutputs);
    renderView();
    expect(await screen.findByText(/Smart processing appears stalled/i)).toBeInTheDocument();
    const stopBtn = screen.getByRole("button", { name: /Stop & keep outputs/i });
    expect(stopBtn).toBeInTheDocument();
    fireEvent.click(stopBtn);
    expect(mockControlJob).toHaveBeenCalledWith("j1", "stop-keep");
  });

  it("offers a retry when a YouTube import is stopped before progress is recorded", async () => {
    const youtubeProject = { ...project, id: "youtube-project", sourceKind: "youtube" as const };
    // canRetryImport is the engine's own answer (it holds the import url and the
    // job is stopped), which is what the Workspace now renders the control from.
    const stoppedJob = { ...freshSmartJob, id: "youtube-job", projectId: youtubeProject.id, state: "cancelled_kept" as const, stage: "cancelled", stageLabel: "Stopped; completed outputs kept", canRetryImport: true };
    mockGetJob.mockResolvedValue(stoppedJob);
    mockControlJob.mockResolvedValue(stoppedJob);
    renderView({ project: youtubeProject });
    expect((await screen.findAllByRole("button", { name: "Retry import" })).length).toBe(2);
    expect(screen.getByText(/stopped before the download began/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry import" })[0]);
    expect(mockControlJob).toHaveBeenCalledWith("youtube-job", "retry-import");
  });
});

// ---------------------------------------------------------------
describe("WorkspaceView – timeline removal", () => {
  it("does not render the layered timeline while preserving export selection", async () => {
    mockGetJob.mockResolvedValue(staleSmartJobWithOutputs);
    renderView();
    expect((await screen.findAllByText("Hello world")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Layered timeline")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Include in export")).toBeInTheDocument();
  });
});

describe("WorkspaceView – processing checklist placement", () => {
  it("renders the vertical checklist before the lower workspace from API-provided steps", async () => {
    const withSteps: Job = {
      ...freshSmartJob,
      steps: [
        { id: "s1", label: "Source received", status: "complete", completedAt: "2026-08-13T00:00:00Z" },
        { id: "s2", label: "Video validated", status: "active", startedAt: "2026-08-13T00:00:00Z" },
      ],
    };
    mockGetJob.mockResolvedValue(withSteps);
    renderView();
    expect(await screen.findByRole("list", { name: "Short creation progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Short creation progress" })).toBeInTheDocument();
    expect(screen.getByText("Source received")).toBeInTheDocument();
    const checklist = document.querySelector(".checklist-panel")!;
    const lowerWorkspace = document.querySelector("[data-testid=\"lower-workspace\"]")!;
    expect(checklist.compareDocumentPosition(lowerWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checklist.querySelector(".process-checklist")).toBeInTheDocument();
    expect(checklist.querySelector("[aria-current=\"step\"]")).toHaveTextContent("In progress");
  });

  it("renders no checklist when the job has no steps", async () => {
    mockGetJob.mockResolvedValue(freshSmartJob);
    renderView();
    expect(await screen.findAllByText("Planning with provider")).toBeTruthy();
    expect(document.querySelector(".checklist-panel")).toBeNull();
  });
});

// ---------------------------------------------------------------
describe("WorkspaceView – Media source tab", () => {
  const sourceAsset: LibraryAsset = {
    id: "source-asset", title: "Source footage", description: "", mediaType: "video/mp4", filename: "test.mp4",
    tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: true,
    minSpacingSeconds: 0, maxUsesPerProject: 1, activeFrom: null, activeUntil: null,
    licence: "User supplied", attribution: "", contentHash: "source-hash", folderId: "unsorted",
    origin: "project-source", blobId: "source-blob", sourceProjectId: "p1", sourceJobId: "j1", sourceClipId: null,
    durationSeconds: 30, width: 1920, height: 1080, previewUrl: "/source-preview", aspectRatio: "16:9",
    publishedAt: "2026-08-13T00:00:00Z", brands: [], people: [], createdAt: "2026-08-13T00:00:00Z",
  };
  const clipAsset: LibraryAsset = { ...sourceAsset, id: "clip-asset", title: "Generated clip", filename: "cut-01.mp4", origin: "generated-clip", sourceClipId: "c1", previewUrl: "/clip-preview" };
  const unrelatedAsset: LibraryAsset = { ...sourceAsset, id: "other-asset", title: "Other project", sourceProjectId: "other", sourceJobId: "other-job", sourceClipId: "other-clip" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJob.mockResolvedValue(staleSmartJobWithOutputs);
    mockListAssets.mockResolvedValue([]);
  });

  it("provides accessible Transcript and Media tabs without mutating workspace state", async () => {
    renderView();
    const transcriptTab = await screen.findByRole("tab", { name: "Transcript" });
    const mediaTab = screen.getByRole("tab", { name: "Media" });
    expect(screen.getByRole("tablist", { name: "Source material" })).toBeInTheDocument();
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    expect(mediaTab).toHaveAttribute("aria-selected", "false");
    expect(mockListAssets).not.toHaveBeenCalled();

    fireEvent.click(mediaTab);
    expect(mediaTab).toHaveAttribute("aria-selected", "true");
    expect(transcriptTab).toHaveAttribute("aria-selected", "false");
    expect(await screen.findByText("No project media yet")).toBeInTheDocument();
    expect(mockListAssets).toHaveBeenCalledWith();
    expect(mockControlJob).not.toHaveBeenCalled();
  });

  it("supports arrow-key tab navigation and caches repeated media visits", async () => {
    renderView();
    const transcriptTab = await screen.findByRole("tab", { name: "Transcript" });
    const mediaTab = screen.getByRole("tab", { name: "Media" });
    fireEvent.keyDown(transcriptTab, { key: "ArrowRight" });
    expect(mediaTab).toHaveFocus();
    expect(mediaTab).toHaveAttribute("aria-selected", "true");
    await screen.findByText("No project media yet");
    fireEvent.click(transcriptTab);
    fireEvent.click(mediaTab);
    expect(mockListAssets).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state while reading project media", async () => {
    let resolveAssets: (assets: LibraryAsset[]) => void = () => undefined;
    mockListAssets.mockImplementation(() => new Promise((resolve) => { resolveAssets = resolve; }));
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));
    expect(await screen.findByText("Loading project media…")).toBeInTheDocument();
    resolveAssets([]);
    expect(await screen.findByText("No project media yet")).toBeInTheDocument();
  });

  it("shows only assets linked to this project or its clips", async () => {
    mockListAssets.mockResolvedValue([sourceAsset, clipAsset, unrelatedAsset]);
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));

    expect(await screen.findByText("Source footage")).toBeInTheDocument();
    expect(screen.getByText("Generated clip")).toBeInTheDocument();
    expect(screen.getByText("Generated clip · Clip 1")).toBeInTheDocument();
    expect(screen.queryByText("Other project")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getAllByText("Hello world").length).toBeGreaterThan(0);
    expect(screen.getByText("0:00 / 0:10")).toBeInTheDocument();
  });

  it("renders a retryable media loading error", async () => {
    mockListAssets.mockRejectedValueOnce(new Error("Media service unavailable")).mockResolvedValueOnce([sourceAsset]);
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: "Media" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Media service unavailable");

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(await screen.findByText("Source footage")).toBeInTheDocument();
    expect(mockListAssets).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceView – publication metadata, Details rename, read-only captions", () => {
  const folders: LibraryFolder[] = [
    { id: "acme", name: "Acme Corp", parentId: null, description: "", color: null, archived: false, system: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  ];

  const publishedJob: Job = {
    schemaVersion: 1, id: "j1", projectId: "p1", mode: "clip", state: "complete",
    stage: "done", stageLabel: "Complete", progress: 100,
    currentItem: 2, totalItems: 2, style: "serious", processingMode: "fast",
    warnings: [], error: null,
    clips: [
      {
        id: "c1", index: 1, state: "complete", start: 0, end: 10, duration: 10,
        openingLine: "Hello world", score: null, selected: true, fallbackUsed: false,
        provenance: [],
        libraryAssetId: "asset-1", title: "Test — Cut 01", width: 1080, height: 1920,
        folderId: "acme", downloadUrl: "/api/v1/media/dl/one.mp4",
      },
      {
        id: "c2", index: 2, state: "complete", start: 0, end: 12, duration: 12,
        openingLine: "Second clip", score: null, selected: true, fallbackUsed: false,
        provenance: [],
        libraryAssetId: null, title: "Test — Cut 02", width: 1080, height: 1920,
        folderId: "acme", downloadUrl: undefined,
      },
    ],
    beats: [], steps: [],
    createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
  };

  beforeEach(() => {
    mockListFolders.mockResolvedValue(folders);
    mockGetJob.mockResolvedValue(publishedJob);
  });

  it("shows persisted batch counts and reduction explanation", async () => {
    mockGetJob.mockResolvedValue({ ...publishedJob, batchMode: "high_volume", effectiveTarget: 300,
      capExplanation: "Requested 500 outputs. This source is under 30 minutes, so this batch is limited to 300 outputs.",
      plannedCount: 275, successfulCount: 264, clips: publishedJob.clips });
    renderView({ project: { ...project, batchMode: "high_volume", requestedCount: 500, effectiveTarget: 300 } });
    const summary = await screen.findByRole("region", { name: "High-volume batch counts" });
    expect(summary).toHaveTextContent("500 requested · 300 effective · 275 planned · 264 successful");
    expect(summary).toHaveTextContent("limited to 300 outputs");
  });

  it("exports all 500 selected completed outputs by their real clip ids", async () => {
    const clips = Array.from({ length: 500 }, (_, index) => ({
      ...publishedJob.clips[0], id: `high-volume-${index + 1}`, index: index + 1,
      title: `Output ${index + 1}`, libraryAssetId: null, downloadUrl: undefined,
    }));
    mockGetJob.mockResolvedValue({ ...publishedJob, batchMode: "high_volume", effectiveTarget: 500,
      plannedCount: 500, successfulCount: 500, clips });
    vi.mocked(createZip).mockResolvedValue({ downloadUrl: "/api/v1/exports/batch.zip", filename: "batch.zip" });
    renderView({ project: { ...project, batchMode: "high_volume", requestedCount: 500, effectiveTarget: 500 } });

    const exportButton = await screen.findByRole("button", { name: /Download ZIP 500/ });
    fireEvent.click(exportButton);
    await waitFor(() => expect(createZip).toHaveBeenCalledWith("j1", clips.map((clip) => clip.id)));
    expect(vi.mocked(createZip).mock.calls[0][1]).toHaveLength(500);
  }, 60_000);

  it("shows Saved to Library only for server-confirmed linked clips", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    const badges = screen.getAllByText("Saved to Library");
    expect(badges).toHaveLength(1);
    // Badge appears inside the first clip's tile
    expect(badges[0].closest(".clip-tile")?.classList.contains("active")).toBeTruthy();
    // Second clip tile has no badge
    const tiles = document.querySelectorAll(".clip-tile");
    expect(tiles[1].querySelector(".saved-badge")).toBeNull();
  });

  it("shows title, duration, dimensions, and folder on ready cards", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    expect(screen.getByText("Test — Cut 02")).toBeInTheDocument();
    expect(screen.getByText(/0:10 · 9:16 · 1080 × 1920 px · Acme Corp/)).toBeInTheDocument();
    expect(screen.getByText(/0:12 · 9:16 · 1080 × 1920 px · Acme Corp/)).toBeInTheDocument();
  });

  it("board header includes the saved-to-Library count", async () => {
    renderView();
    expect(await screen.findByText(/2 planned · 2 ready · 1 saved to Library/)).toBeInTheDocument();
  });

  it("Preview button selects the clip in the viewer", async () => {
    renderView();
    expect(await screen.findByText("0:00 / 0:10")).toBeInTheDocument();
    const previewBtns = screen.getAllByRole("button", { name: "Preview" });
    expect(previewBtns).toHaveLength(2);
    fireEvent.click(previewBtns[1]);
    await waitFor(() => expect(screen.getByText("0:00 / 0:12")).toBeInTheDocument());
  });

  it("Download link appears when clip has downloadUrl and is complete", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /Download/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/api/v1/media/dl/one.mp4");
  });

  it("shows a retryable preview placeholder when the video thumbnail fails to load", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector<HTMLVideoElement>(".clip-thumbnail")).toBeTruthy());
    const video = document.querySelector<HTMLVideoElement>(".clip-thumbnail");
    expect(video?.src).toContain("/api/v1/media/dl/one.mp4");
    fireEvent.error(video!);
    expect(screen.getByRole("button", { name: "Retry preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(document.querySelector(".clip-thumbnail")).toBeTruthy();
  });

  it("Details panel replaces Inspector, captions are read-only, helper text present", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    // No "Inspector" heading
    expect(screen.queryByText("Inspector")).not.toBeInTheDocument();
    // "Details" heading exists
    expect(screen.getByText("Details")).toBeInTheDocument();
    // Preview/review helper text
    expect(screen.getByText(/Review and download finished clips here/)).toBeInTheDocument();
    // Read-only caption preset
    fireEvent.click(screen.getByRole("button", { name: /captions/i }));
    expect(screen.getAllByText("Read-only")).toHaveLength(2);
    expect(screen.getByText("Editorial highlight")).toBeInTheDocument();
    expect(screen.getByText("Minimal · High contrast box")).toBeInTheDocument();
    expect(screen.getByText("Hook text · OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("Not generated")).toBeInTheDocument();
    // No select inside the inspector content
    const inspectorContent = document.querySelector(".inspector-content");
    expect(inspectorContent?.querySelector("select")).toBeNull();
  });

  it("no timeline as before", async () => {
    renderView();
    expect(await screen.findByText("Test — Cut 01")).toBeInTheDocument();
    expect(screen.queryByText("Layered timeline")).not.toBeInTheDocument();
    // Both ready clips keep their non-destructive include-in-export checkboxes
    expect(screen.getAllByLabelText("Include in export")).toHaveLength(2);
  });
});

describe("WorkspaceView – output aspect ratio presentation", () => {
  const cases = [
    [1080, 1080, "1:1"],
    [1920, 1080, "16:9"],
    [1080, 1920, "9:16"],
    [1080, 1350, "4:5"],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFolders.mockResolvedValue([]);
  });

  it.each(cases)("uses %s×%s consistently in the viewer and clip metadata", async (width, height, aspect) => {
    const ratioJob: Job = {
      ...responsiveJob,
      clips: [{ ...responsiveJob.clips[0], width, height }],
    };
    mockGetJob.mockResolvedValue(ratioJob);
    renderView({ project: { ...project, latestJobId: ratioJob.id } });

    expect(await screen.findByText(`Output · ${aspect}`)).toBeInTheDocument();
    const frame = document.querySelector(".viewer-frame");
    expect(frame).toHaveAttribute("data-output-aspect-ratio", aspect);
    const [aspectWidth, aspectHeight] = aspect.split(":");
    expect(frame).toHaveStyle({ aspectRatio: `${aspectWidth} / ${aspectHeight}` });
    expect(screen.getByText(new RegExp(`0:10 · ${aspect} · ${width} × ${height} px`))).toBeInTheDocument();
    expect(screen.queryByText(`Output · ${aspect === "9:16" ? "1:1" : "9:16"}`)).not.toBeInTheDocument();
  });

  it("falls back to the job content format for a legacy clip without output metadata", async () => {
    const legacyJob: Job = { ...responsiveJob, contentFormat: "long", clips: [{ ...responsiveJob.clips[0], width: null, height: null }] };
    mockGetJob.mockResolvedValue(legacyJob);
    renderView({ project: { ...project, latestJobId: legacyJob.id } });

    expect(await screen.findByText("Output · 16:9")).toBeInTheDocument();
    expect(screen.getByText(/0:10 · 16:9 · dimensions unavailable/)).toBeInTheDocument();
  });
});

describe("WorkspaceView – stable responsive media controls", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFolders.mockResolvedValue([]);
    mockGetJob.mockResolvedValue(responsiveJob);
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  });

  it("loads the selected output with a visible, responsive main player", async () => {
    renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element;
    });
    expect(video).toHaveAttribute("preload", "auto");
    expect(video).toHaveAttribute("playsinline");
    fireEvent.loadedMetadata(video!);
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
  });

  it("bounds media-error retries and returns to an actionable Play state", async () => {
    renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element;
    });
    fireEvent.error(video!);
    fireEvent.error(video!);
    expect(await screen.findByRole("alert")).toHaveTextContent("This clip could not be loaded");
    expect(screen.getByRole("button", { name: "Retry preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("detects a sustained frozen clock, offers explicit muted recovery, and does not reload the source", async () => {
    renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element!;
    });
    let currentTime = 0;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => false },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 4 },
      currentTime: { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } },
      play: { configurable: true, value: vi.fn().mockResolvedValue(undefined) },
      pause: { configurable: true, value: vi.fn() },
      load: { configurable: true, value: vi.fn() },
    });
    vi.useFakeTimers();
    fireEvent.playing(video);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_750); });
    expect(screen.getByRole("alert")).toHaveTextContent("Playback could not start with this browser’s audio output.");
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play muted" })).toBeInTheDocument();
    expect(video.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await act(async () => {});
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.load).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_750); });
    fireEvent.click(screen.getByRole("button", { name: "Play muted" }));
    await act(async () => {});
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not classify advancing playback or transient buffering as stalled", async () => {
    renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element!;
    });
    let currentTime = 0;
    let readyState = 4;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => false },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => readyState },
      currentTime: { configurable: true, get: () => currentTime },
    });
    vi.useFakeTimers();
    fireEvent.playing(video);
    await act(async () => { currentTime = 0.5; await vi.advanceTimersByTimeAsync(500); currentTime = 1; await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    readyState = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.pause(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels watchdogs after pause, end, source reset, and unmount", async () => {
    const view = renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element!;
    });
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => false },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 4 },
      currentTime: { configurable: true, get: () => 0 },
    });
    vi.useFakeTimers();
    for (const event of ["pause", "ended", "emptied"]) {
      fireEvent.playing(video);
      fireEvent(video, new Event(event));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    fireEvent.playing(video);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  });

  it("uses the main player's play, pause, and mute controls", async () => {
    renderView();
    const video = await waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>(".viewer-frame video");
      expect(element).toBeTruthy();
      return element;
    });
    const playMethod = vi.fn().mockResolvedValue(undefined);
    const pauseMethod = vi.fn();
    Object.defineProperty(video!, "paused", { configurable: true, value: true });
    Object.defineProperty(video!, "play", { configurable: true, value: playMethod });
    Object.defineProperty(video!, "pause", { configurable: true, value: pauseMethod });
    const viewer = video!.closest(".viewer-panel")!;
    expect(viewer.querySelector<HTMLButtonElement>(".play-button")).toHaveAttribute("aria-label", "Play");
    fireEvent.click(viewer.querySelector<HTMLButtonElement>(".play-button")!);
    await waitFor(() => expect(playMethod).toHaveBeenCalled());
    Object.defineProperty(video!, "paused", { configurable: true, value: false });
    fireEvent(video!, new Event("playing"));
    await waitFor(() => expect(viewer.querySelector<HTMLButtonElement>(".play-button")).toHaveAttribute("aria-label", "Pause"));
    fireEvent.click(viewer.querySelector<HTMLButtonElement>("[aria-label='Mute preview']")!);
    expect(video?.muted).toBe(true);
    fireEvent.click(viewer.querySelector<HTMLButtonElement>(".play-button")!);
    expect(pauseMethod).toHaveBeenCalled();
  });
});