import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Job, LibraryAsset, LibraryFolder, Project } from "../types";
import { WorkspaceView } from "./workspace-view";

// ---------------------------------------------------------------
// Mock API module so no real fetch is attempted.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, getJob: vi.fn(), controlJob: vi.fn(), jobEventsUrl: vi.fn(() => ""), createZip: vi.fn(), retryClip: vi.fn(), setClipSelection: vi.fn(), listAssets: vi.fn(), listFolders: vi.fn().mockResolvedValue([]), changeProjectFolder: vi.fn() };
});

import { controlJob, getJob, listAssets, listFolders } from "../api";
const mockGetJob = vi.mocked(getJob);
const mockControlJob = vi.mocked(controlJob);
const mockListAssets = vi.mocked(listAssets);
const mockListFolders = vi.mocked(listFolders);

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "Local mounted data directory",
  freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0,
  fallbacks: { planning: "deterministic" },
};

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
      health={health}
      hasSelectedProvider
      onConfigureProviders={onConfigureProviders}
      onProjectUpdated={onProjectUpdated}
      onGoProjects={onGoProjects}
      {...props}
    />,
  );
}

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
  it("renders the checklist above the board from API-provided steps", async () => {
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
    expect(screen.getByText("Source received")).toBeInTheDocument();
    const checklist = document.querySelector(".checklist-panel")!;
    const board = document.querySelector(".board-panel")!;
    expect(checklist.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    const video = document.querySelector<HTMLVideoElement>(".clip-thumbnail");
    expect(video).toBeTruthy();
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
    expect(screen.getByText(/Preview generated videos, review processing details, and choose downloads/)).toBeInTheDocument();
    // Read-only caption preset
    fireEvent.click(screen.getByRole("button", { name: /captions/i }));
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("Editorial highlight")).toBeInTheDocument();
    expect(screen.getByText("Minimal · High contrast box")).toBeInTheDocument();
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