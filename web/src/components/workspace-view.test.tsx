import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Job, Project } from "../types";
import { WorkspaceView } from "./workspace-view";

// ---------------------------------------------------------------
// Mock API module so no real fetch is attempted.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, getJob: vi.fn(), controlJob: vi.fn(), jobEventsUrl: vi.fn(() => ""), createZip: vi.fn(), retryClip: vi.fn(), setClipSelection: vi.fn() };
});

import { controlJob, getJob } from "../api";
const mockGetJob = vi.mocked(getJob);
const mockControlJob = vi.mocked(controlJob);

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