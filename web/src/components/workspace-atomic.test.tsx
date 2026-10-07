import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, LibraryFolder, Project } from "../types";
import { WorkspaceView } from "./workspace-view";

// ---------------------------------------------------------------
// Mock API module so no real fetch is attempted.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, getJob: vi.fn(), controlJob: vi.fn(), jobEventsUrl: vi.fn(() => ""), createZip: vi.fn(), retryClip: vi.fn(), setClipSelection: vi.fn(), listFolders: vi.fn().mockResolvedValue([]), changeProjectFolder: vi.fn() };
});

import { getJob, listFolders } from "../api";
const mockGetJob = vi.mocked(getJob);
const mockListFolders = vi.mocked(listFolders);

vi.stubGlobal("EventSource", class { close() {} });

const project: Project = {
  schemaVersion: 1, id: "p1", name: "Test", mode: "clip", style: "serious",
  state: "complete", sourceName: "test.mp4", sourceKind: "upload", requestedCount: 4,
  latestJobId: "j1", createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

const folders: LibraryFolder[] = [
  { id: "acme", name: "Acme Corp", parentId: null, description: "", color: null, archived: false, system: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];

// Publication fixture: one ready clip with a confirmed library link, one ready
// clip with only a blob (no link), one failed clip, and one still rendering.
const publishedJob: Job = {
  schemaVersion: 1, id: "j1", projectId: "p1", mode: "clip", state: "complete",
  stage: "done", stageLabel: "Complete", progress: 100,
  currentItem: 4, totalItems: 4, style: "serious", processingMode: "fast",
  warnings: [], error: null,
  clips: [
    {
      id: "c1", index: 1, state: "complete", start: 0, end: 10, duration: 10,
      openingLine: "Linked clip", score: null, selected: true, fallbackUsed: false,
      provenance: [],
      libraryAssetId: "asset-1", title: "Cut 01", width: 1080, height: 1920,
      folderId: "acme", downloadUrl: "/api/v1/files/jobs/j1/clips/01.mp4",
    },
    {
      id: "c2", index: 2, state: "complete", start: 0, end: 12, duration: 12,
      openingLine: "Unlinked clip", score: null, selected: true, fallbackUsed: false,
      provenance: [],
      libraryAssetId: null, blobId: "blob-2", title: "Cut 02", width: 1080, height: 1920,
      folderId: "acme", downloadUrl: undefined,
    },
    {
      id: "c3", index: 3, state: "failed", start: 0, end: 9, duration: 9,
      openingLine: "Failed clip", score: null, selected: false, fallbackUsed: false,
      provenance: [], error: "render error",
    },
    {
      id: "c4", index: 4, state: "rendering", start: 0, end: 8, duration: 8,
      openingLine: "Rendering clip", score: null, selected: false, fallbackUsed: false,
      provenance: [],
    },
  ],
  beats: [], steps: [],
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

function tileOf(text: string) {
  const tile = screen.getAllByText(text).map((node) => node.closest(".clip-tile")).find((node) => node !== null);
  if (!tile) throw new Error(`No clip tile containing "${text}"`);
  return within(tile as HTMLElement);
}

function renderView(job: Job = publishedJob) {
  mockGetJob.mockResolvedValue(job);
  const onProjectUpdated = vi.fn(async () => undefined);
  const onGoProjects = vi.fn();
  const onConfigureProviders = vi.fn();
  return render(
    <WorkspaceView
      project={project}
      onConfigureProviders={onConfigureProviders}
      onProjectUpdated={onProjectUpdated}
      onGoProjects={onGoProjects}
    />,
  );
}

describe("WorkspaceView – atomic output publication acceptance", () => {
  beforeEach(() => {
    mockListFolders.mockResolvedValue(folders);
  });

  it("shows 'Saved to Library' only on a ready card with a confirmed library link", async () => {
    renderView();
    expect(await screen.findByText("Cut 01")).toBeInTheDocument();

    // Ready clip WITH libraryAssetId → badge
    expect(tileOf("Cut 01").getByText("Saved to Library")).toBeInTheDocument();

    // Ready clip with a blob but NO library link → no badge
    expect(tileOf("Cut 02").queryByText("Saved to Library")).not.toBeInTheDocument();

    // Failed clip → no badge
    expect(tileOf("Cut 03").queryByText("Saved to Library")).not.toBeInTheDocument();

    // Still rendering → no badge, even before failure is known
    expect(tileOf("Cut 04").queryByText("Saved to Library")).not.toBeInTheDocument();
  });

  it("never claims 'Saved to Library' when no clip has a confirmed link", async () => {
    const unlinked = {
      ...publishedJob,
      clips: publishedJob.clips.map((clip) =>
        clip.id === "c1" ? { ...clip, libraryAssetId: null } : clip,
      ),
    };
    renderView(unlinked);
    expect(await screen.findByText("Cut 01")).toBeInTheDocument();
    expect(screen.queryByText("Saved to Library")).not.toBeInTheDocument();
    // Board header omits the saved count entirely
    expect(screen.getByText(/4 planned · 2 ready/)).toBeInTheDocument();
    expect(screen.queryByText(/saved to Library/i)).not.toBeInTheDocument();
  });

  it("shows the saved count in the board header only from confirmed links", async () => {
    renderView();
    expect(await screen.findByText("Cut 01")).toBeInTheDocument();
    expect(screen.getByText(/4 planned · 2 ready · 1 saved to Library/)).toBeInTheDocument();
  });

  it("filters the clip board by export selection and failed state", async () => {
    renderView();
    expect(await screen.findByText("Cut 01")).toBeInTheDocument();

    const all = screen.getByRole("button", { name: "All clips" });
    const selected = screen.getByRole("button", { name: "Selected clips" });
    const failed = screen.getByRole("button", { name: "Failed clips" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll(".clip-tile")).toHaveLength(4);

    fireEvent.click(selected);
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelectorAll(".clip-tile")).toHaveLength(2);
    expect(screen.getByText("Cut 01")).toBeInTheDocument();
    expect(screen.getByText("Cut 02")).toBeInTheDocument();
    expect(screen.queryByText("Cut 03")).not.toBeInTheDocument();

    fireEvent.click(failed);
    expect(failed).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll(".clip-tile")).toHaveLength(1);
    expect(screen.getByText("Cut 03")).toBeInTheDocument();
    expect(screen.queryByText("Cut 01")).not.toBeInTheDocument();

    fireEvent.click(all);
    expect(document.querySelectorAll(".clip-tile")).toHaveLength(4);
  });

  it("exposes no timeline, trim, or layer editing controls and stays a preview surface", async () => {
    renderView();
    expect(await screen.findByText("Cut 01")).toBeInTheDocument();

    // No editor surface
    expect(screen.queryByText(/timeline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/trim/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/layer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/in point/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/out point/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\bEdit\b/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save changes/i })).not.toBeInTheDocument();

    // Preview/review surface remains fully usable
    expect(document.querySelector(".viewer-panel")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Download ZIP/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry failed/i })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /Include in export/i }).length).toBeGreaterThan(0);

    // Ready card keeps Preview + Download actions
    expect(tileOf("Cut 01").getByRole("button", { name: /^Preview/ })).toBeInTheDocument();
    expect(tileOf("Cut 01").getByRole("link", { name: /Download/i })).toBeInTheDocument();

    // Review language: Details panel, not an Inspector; helper text present
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.queryByText("Inspector")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("keeps the ready clip out of the Clip Board when publication is not committed", async () => {
    // A job still active with one validated render — the clip is not ready and
    // has no link, so the board shows it as processing, not as published.
    const activeJob: Job = {
      ...publishedJob,
      state: "active",
      clips: [
        {
          id: "c1", index: 1, state: "rendering", start: 0, end: 10, duration: 10,
          openingLine: "In flight", score: null, selected: false, fallbackUsed: false,
          provenance: [],
        },
      ],
    };
    renderView(activeJob);
    expect((await screen.findAllByText("In flight")).length).toBeGreaterThan(0);
    const tile = tileOf("In flight");
    expect(tile.queryByText("Saved to Library")).not.toBeInTheDocument();
    // Not counted as ready in the header
    expect(screen.getByText(/1 planned · 0 ready/)).toBeInTheDocument();
  });
});
