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
  return { readableError, createClipJob: vi.fn(), createScriptJob: vi.fn(), listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })), listFolders: vi.fn(async () => []), createFolder: vi.fn() };
});

import { createClipJob, createScriptJob } from "../api";
const mockCreateClipJob = vi.mocked(createClipJob);
const mockCreateScriptJob = vi.mocked(createScriptJob);

const storedValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => storedValues.clear(),
    getItem: (key: string) => storedValues.get(key) ?? null,
    key: (index: number) => [...storedValues.keys()][index] ?? null,
    get length() { return storedValues.size; },
    removeItem: (key: string) => storedValues.delete(key),
    setItem: (key: string, value: string) => storedValues.set(key, value),
  } satisfies Storage,
});

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
    storedValues.clear();
    mockCreateClipJob.mockReset();
    mockCreateScriptJob.mockReset();
  });
  it("keeps creation settings and Recent Clips while omitting Recent projects and its UI", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Create a project" })).toBeInTheDocument();
    expect(screen.getByText("Editorial style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create 5 short clips/i })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Recent clips" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all \d+ projects/ })).not.toBeInTheDocument();
    expect(document.querySelector(".project-card, .project-grid")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open project Interview/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete project Interview/ })).not.toBeInTheDocument();
  });

  it("selects Long form by keyboard-friendly control and sends landscape format", async () => {
    mockCreateClipJob.mockResolvedValue({ project: { ...project, contentFormat: "long" }, job: undefinedJob });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
    expect(screen.getByRole("button", { name: /Long form · 16:9/i })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /Create 5 landscape clips/i })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "movie.mp4", { type: "video/mp4" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 landscape clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ contentFormat: "long", aspectRatio: "16:9" })));
  });

  it("rejects a long-form minimum duration above the engine boundary before submitting", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced controls/i }));
    fireEvent.change(screen.getByLabelText("Minimum seconds"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Maximum seconds"), { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 landscape clips/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Minimum seconds must be at most 120.");
    expect(mockCreateClipJob).not.toHaveBeenCalled();
  });

  it("uses Smart transcription and keeps sung lyrics enabled without a subtitle toggle", async () => {
    mockCreateClipJob.mockResolvedValue({ project: { ...project, sourceProfile: "music" }, job: { ...undefinedJob, sourceProfile: "music", processingMode: "smart" } });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Music / sung vocals" }));
    expect(screen.getByText(/always uses Smart transcription locally.*VAD disabled.*word timestamps retained/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Burn in subtitles/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ sourceProfile: "music", processingMode: "smart", burnSubtitles: true, count: 5 })));
  });

  it("switches to exact-source Script mode without a setup gate", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    expect(screen.getByPlaceholderText(/Paste the exact script/i)).toBeInTheDocument();
    expect(screen.getByText(/Upload .txt or .md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create script video/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
  });

  it("clears a clip validation error when switching to Script mode", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://example.com/not-youtube" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Only public HTTPS YouTube URLs are supported.");
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a script validation error when the script is edited", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least 10 characters of script.");
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "A valid disposable script." } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("defaults to Auto mode and resolves no-provider auto to a Fast local cut note", () => {
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Auto" })).toHaveClass("active");
    // Note text is split across icon and <strong> children, so inspect the .mode-note element's full textContent.
    expect(screen.getByText(/No provider is connected, so Auto runs as a fast local cut\./i)).toBeInTheDocument();
  });

  it("does not claim a provider is missing before /profiles has answered", () => {
    render(<ProjectsView health={health} providersLoaded={false} hasSelectedProvider={false} onCreated={vi.fn()} />);
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Checking connected providers/i)).toBeInTheDocument();
    // The "add a provider" callout is the same claim in another shape.
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Checking connected providers/i)).toBeInTheDocument();
  });

  it("states the no-provider fallback only once /profiles confirms it", () => {
    render(<ProjectsView health={health} providersLoaded hasSelectedProvider={false} onCreated={vi.fn()} />);
    expect(screen.getByText(/No provider is connected, so Auto runs as a fast local cut\./i)).toBeInTheDocument();
    expect(screen.getByText(/Add optional AI providers/i)).toBeInTheDocument();
  });

  it("remembers when the optional provider callout is dismissed", () => {
    const props = { health, providersLoaded: true, hasSelectedProvider: false, onCreated: vi.fn() };
    const first = render(<ProjectsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();
    first.unmount();

    render(<ProjectsView {...props} />);
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();
  });

  it("reports a connected provider once /profiles confirms it", () => {
    render(<ProjectsView health={health} providersLoaded hasSelectedProvider onCreated={vi.fn()} />);
    expect(screen.getByText(/Auto uses a connected provider, otherwise a fast local cut\./i)).toBeInTheDocument();
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
  });

  it("holds back the local-tools badge and engine summary until health is known", () => {
    const { rerender } = render(<ProjectsView health={null} healthChecked={false} onCreated={vi.fn()} />);
    expect(screen.queryByText(/Checking local tools/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking local engine/i)).not.toBeInTheDocument();
    expect(document.querySelector(".engine-summary")).toBeNull();

    rerender(<ProjectsView health={health} healthChecked onCreated={vi.fn()} />);
    expect(screen.queryByText(/All local tools ready/i)).not.toBeInTheDocument();
    expect(document.querySelector(".engine-summary")).toHaveTextContent(/Local engine ready/i);
    expect(screen.queryByText(/Local-first studio|Make the first cut|Add a source, choose an editorial style, and review clips as they finish\./i)).not.toBeInTheDocument();
  });

  it("keeps explicit Smart as a local Whisper opt-in without a provider", () => {
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.getByText(/local Whisper and deterministic planning/i)).toBeInTheDocument();
  });

  it("trims and sends an explicit project name", async () => {
    const created: Project = { ...project, id: "named-id", name: "QA Browser Test" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "named-id" } });
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  QA Browser Test  " } });
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "This is a script long enough to create a project." } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.objectContaining({ name: "QA Browser Test" })));
  });

  it("sends the selected editorial style through script job creation", async () => {
    const created: Project = { ...project, id: "style-id", style: "funny" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "style-id", style: "funny" } });
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /Funny/i }));
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "Wow, this amazing idea is a win!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.objectContaining({ style: "funny" })));
  });

  it("does not send processingMode through the script API", async () => {
    const created: Project = { ...project, id: "new-id" };
    mockCreateScriptJob.mockResolvedValue({ project: created, job: { ...undefinedJob, projectId: "new-id" } });
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "This is a script long enough to create a project." } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => {
      expect(mockCreateScriptJob).toHaveBeenCalledWith(expect.not.objectContaining({ processingMode: expect.anything() }));
    });
  });
});
