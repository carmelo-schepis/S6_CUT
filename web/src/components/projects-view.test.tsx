import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Job, Project } from "../types";
import { ProjectsView } from "./projects-view";

// ---------------------------------------------------------------
// Mock the API module so no real fetch is attempted on submit.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, createClipJob: vi.fn(), createScriptJob: vi.fn(), listFolders: vi.fn(async () => []), createFolder: vi.fn() };
});

import { createScriptJob } from "../api";
const mockCreateScriptJob = vi.mocked(createScriptJob);

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

const undefinedJob: Job = {
  schemaVersion: 1, id: "job-id", projectId: "project-id", mode: "script", state: "queued",
  stage: "queued", stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0,
  style: "serious", processingMode: "fast", warnings: [], error: null, clips: [], beats: [], steps: [],
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

describe("Projects create flow", () => {
  beforeEach(() => {
    mockCreateScriptJob.mockReset();
  });
  it("keeps the three-step path and real project card accessible", () => {
    const open = vi.fn();
    render(<ProjectsView projects={[project]} health={health} onCreated={vi.fn()} onOpen={open} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("heading", { name: "Create a project" })).toBeInTheDocument();
    expect(screen.getByText("Pick style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create 5 clips/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Interview/i }));
    expect(open).toHaveBeenCalledWith("project-id");
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
    const note = screen.getByText((_content, element) => Boolean(element?.classList?.contains("mode-note") && element?.textContent?.includes("No provider selected") && element?.textContent?.includes("Fast local cut")));
    expect(note).toBeInTheDocument();
  });

  it("keeps explicit Smart as a local Whisper opt-in without a provider", () => {
    render(<ProjectsView projects={[]} health={health} hasSelectedProvider={false} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.getByText(/Smart local mode/i)).toBeInTheDocument();
    expect(screen.getByText(/local Whisper and deterministic planning/i)).toBeInTheDocument();
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
