import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Job, LibraryAsset, Project } from "../types";
import { ProjectsView } from "./projects-view";

// ---------------------------------------------------------------
// Mock the API module so no real fetch is attempted on submit.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, createClipJob: vi.fn(), createScriptJob: vi.fn(), listAssets: vi.fn(async () => []), listFolders: vi.fn(async () => []), createFolder: vi.fn() };
});

import { createClipJob, createScriptJob, listAssets } from "../api";
const mockCreateClipJob = vi.mocked(createClipJob);
const mockCreateScriptJob = vi.mocked(createScriptJob);
const mockListAssets = vi.mocked(listAssets);

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "Local mounted data directory",
  freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0,
  fallbacks: { planning: "deterministic" },
};

const project: Project = {
  schemaVersion: 1, id: "project-id", name: "Interview", mode: "clip", style: "serious",
  state: "complete", sourceName: "interview.mp4", sourceKind: "upload", requestedCount: 3,
  latestJobId: "job-id", createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

const sourceAsset: LibraryAsset = {
  id: "source-asset", title: "Interview source", description: "", mediaType: "video/mp4", filename: "interview.mp4",
  tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false,
  minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "User supplied", attribution: "", contentHash: "source-hash",
  folderId: "folder-id", origin: "project-source", blobId: "source-blob", sourceProjectId: project.id,
  previewUrl: "/api/v1/library/assets/source-asset/preview?fresh", brands: [], people: [], createdAt: "2026-08-13T00:00:00Z",
};

const undefinedJob: Job = {
  schemaVersion: 1, id: "job-id", projectId: "project-id", mode: "script", state: "queued",
  stage: "queued", stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0,
  style: "serious", processingMode: "fast", warnings: [], error: null, clips: [], beats: [], steps: [],
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

describe("Projects create flow", () => {
  beforeEach(() => {
    mockCreateClipJob.mockReset();
    mockCreateScriptJob.mockReset();
    mockListAssets.mockReset();
    mockListAssets.mockResolvedValue([]);
  });
  it("keeps the three-step path and real project card accessible", () => {
    const open = vi.fn();
    render(<ProjectsView projects={[project]} health={health} onCreated={vi.fn()} onOpen={open} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("heading", { name: "Create a project" })).toBeInTheDocument();
    expect(screen.getByText("Editorial style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create 5 short clips/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Interview/i }));
    expect(open).toHaveBeenCalledWith("project-id");
  });

  it("opens a fresh source-video preview without opening the project", async () => {
    const open = vi.fn();
    const freshAsset = { ...sourceAsset, previewUrl: "/api/v1/library/assets/source-asset/preview?renewed" };
    mockListAssets.mockResolvedValueOnce([sourceAsset]).mockResolvedValueOnce([freshAsset]);
    render(<ProjectsView projects={[project]} health={health} onCreated={vi.fn()} onOpen={open} onRefresh={vi.fn(async () => undefined)} />);
    const preview = await screen.findByRole("button", { name: "Preview source video for Interview" });
    fireEvent.click(preview);
    expect(await screen.findByRole("dialog", { name: "Interview source video preview" })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").querySelector("video")?.getAttribute("src")).toContain("renewed");
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(preview).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open project Interview" }));
    expect(open).toHaveBeenCalledWith("project-id");
  });

  it("derives card status and progress from the authoritative latest job", () => {
    const staleProject = { ...project, state: "queued" as const };
    const completeJob = { ...undefinedJob, state: "complete" as const, stage: "complete", stageLabel: "Project ready", progress: 100 };
    render(<ProjectsView projects={[staleProject]} jobs={[completeJob]} health={health} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    const card = screen.getByRole("button", { name: /Open project Interview/ }).closest(".project-card");
    expect(card).toHaveTextContent("Project ready");
    expect(card).toHaveTextContent("100%");
    expect(card).not.toHaveTextContent("queued");
  });

  it("selects Long form by keyboard-friendly control and sends landscape format", async () => {
    mockCreateClipJob.mockResolvedValue({ project: { ...project, contentFormat: "long" }, job: undefinedJob });
    render(<ProjectsView projects={[]} health={health} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
    expect(screen.getByRole("button", { name: /Long form · 16:9/i })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /Create 5 landscape clips/i })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "movie.mp4", { type: "video/mp4" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 landscape clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ contentFormat: "long", aspectRatio: "16:9" })));
  });

  it("switches to exact-source Script mode without a setup gate", () => {
    render(<ProjectsView projects={[]} health={health} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    expect(screen.getByPlaceholderText(/Paste the exact script/i)).toBeInTheDocument();
    expect(screen.getByText(/Upload .txt or .md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create script video/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
  });

  it("defaults to Auto mode and resolves no-provider auto to a Fast local cut note", () => {
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("button", { name: "Auto" })).toHaveClass("active");
    // Note text is split across icon and <strong> children, so inspect the .mode-note element's full textContent.
    expect(screen.getByText(/No provider is connected, so Auto runs as a fast local cut\./i)).toBeInTheDocument();
  });

  it("does not claim a provider is missing before /profiles has answered", () => {
    render(<ProjectsView projects={[]} health={health} providersLoaded={false} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Checking connected providers/i)).toBeInTheDocument();
    // The "add a provider" callout is the same claim in another shape.
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Checking connected providers/i)).toBeInTheDocument();
  });

  it("states the no-provider fallback only once /profiles confirms it", () => {
    render(<ProjectsView projects={[]} health={health} providersLoaded hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByText(/No provider is connected, so Auto runs as a fast local cut\./i)).toBeInTheDocument();
    expect(screen.getByText(/Add optional AI providers/i)).toBeInTheDocument();
  });

  it("reports a connected provider once /profiles confirms it", () => {
    render(<ProjectsView projects={[]} health={health} providersLoaded hasSelectedProvider onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByText(/Auto uses a connected provider, otherwise a fast local cut\./i)).toBeInTheDocument();
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
  });

  it("holds back the local-tools badge and engine summary until health is known", () => {
    const { rerender } = render(<ProjectsView projects={[]} health={null} healthChecked={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.queryByText(/Checking local tools/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking local engine/i)).not.toBeInTheDocument();
    expect(document.querySelector(".engine-summary")).toBeNull();

    rerender(<ProjectsView projects={[]} health={health} healthChecked onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.queryByText(/All local tools ready/i)).not.toBeInTheDocument();
    expect(document.querySelector(".engine-summary")).toHaveTextContent(/Local engine ready/i);
    expect(screen.queryByText(/Local-first studio|Make the first cut|Add a source, choose an editorial style, and review clips as they finish\./i)).not.toBeInTheDocument();
  });

  it("keeps explicit Smart as a local Whisper opt-in without a provider", () => {
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.getByText(/local Whisper and deterministic planning/i)).toBeInTheDocument();
  });

  it("trims and sends an explicit project name", async () => {
    const created: Project = { ...project, id: "named-id", name: "QA Browser Test" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "named-id" } });
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  QA Browser Test  " } });
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "This is a script long enough to create a project." } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.objectContaining({ name: "QA Browser Test" })));
  });

  it("sends the selected editorial style through script job creation", async () => {
    const created: Project = { ...project, id: "style-id", style: "funny" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "style-id", style: "funny" } });
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /Funny/i }));
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "Wow, this amazing idea is a win!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.objectContaining({ style: "funny" })));
  });

  it("does not send processingMode through the script API", async () => {
    const created: Project = { ...project, id: "new-id" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "new-id" } });
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "This is a script long enough to create a project." } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => {
      expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.not.objectContaining({ processingMode: expect.anything() }));
    });
  });
});
