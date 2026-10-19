import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Job, Project, ProviderProfile } from "../types";
import { ProjectsView } from "./projects-view";

// ---------------------------------------------------------------
// Mock the API module so no real fetch is attempted on submit.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, createClipJob: vi.fn(), listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })), listFolders: vi.fn(async () => []), createFolder: vi.fn() };
});

import { createClipJob } from "../api";
const mockCreateClipJob = vi.mocked(createClipJob);

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
  whisper: true, ytdlp: true, dataPath: "Local mounted data directory",
  freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0,
  fallbacks: { planning: "deterministic" },
};

const project: Project = {
  schemaVersion: 1, id: "project-id", name: "Interview", mode: "clip", style: "serious",
  state: "complete", sourceName: "interview.mp4", sourceKind: "upload", requestedCount: 3,
  latestJobId: "job-id", createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

const undefinedJob: Job = {
  schemaVersion: 1, id: "job-id", projectId: "project-id", mode: "clip", state: "queued",
  stage: "queued", stageLabel: "Queued on this machine", progress: 0, currentItem: 0, totalItems: 0,
  style: "serious", processingMode: "fast", warnings: [], error: null, clips: [], beats: [], steps: [],
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

describe("Projects create flow", () => {
  beforeEach(() => {
    storedValues.clear();
    mockCreateClipJob.mockReset();
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

  it.each([1, 37, 500])("shows %i as the requested high-volume count and in Create", (value) => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value: String(value) } });
    expect(count).toHaveValue(String(value));
    expect(screen.getByRole("button", { name: new RegExp(`Create ${value} short clips?`, "i") })).toBeEnabled();
  });

  it.each(["501", "9999"])("corrects pasted/entered high-volume count %s to 500 immediately", (value) => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value } });
    expect(count).toHaveValue("500");
    expect(screen.getByRole("button", { name: /Create 500 short clips/i })).toBeEnabled();
  });

  it("allows clearing then typing 250 without forcing zero or losing input focus", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    count.focus();
    fireEvent.change(count, { target: { value: "" } });
    expect(count).toHaveValue("");
    expect(count).toHaveFocus();
    for (const digit of ["2", "5", "0"]) {
      fireEvent.change(count, { target: { value: `${(count as HTMLInputElement).value}${digit}` } });
      expect(count).toHaveFocus();
    }
    expect(count).toHaveValue("250");
    expect(screen.getByRole("button", { name: /Create 250 short clips/i })).toBeEnabled();
  });

  it.each(["", "0", "-1"])("normalizes blank or non-positive count %s on blur and Create", async (value) => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value } });
    fireEvent.blur(count);
    expect(count).toHaveValue("1");
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 1 short clip/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ count: 1 })));
  });

  it.each(["", "0", "-1"])("normalizes a blank or non-positive high-volume count on Create (%s)", async (value) => {
    mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByRole("textbox", { name: "Clips requested" });
    fireEvent.change(count, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: /Create 1 short clip/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ count: 1 })));
    expect(count).toHaveValue("1");
  });

  it.each(["1.5", "abc"])("does not submit malformed high-volume count %s", (value) => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value } });
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create .* short clips?/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mockCreateClipJob).not.toHaveBeenCalled();
  });

  it("submits a corrected 500 high-volume count and mode", async () => {
    mockCreateClipJob.mockResolvedValue({ project: { ...project, requestedCount: 500, batchMode: "high_volume" }, job: undefinedJob });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value: "501" } });
    expect(count).toHaveValue("500");
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 500 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ batchMode: "high_volume", count: 500 })));
  });

  it.each(["Standard · up to 30", "Music / sung vocals"])("caps a 500 count at 30 when switching to %s", (mode) => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Clips requested");
    fireEvent.change(count, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: mode === "Standard · up to 30" ? /Standard · up to 30/ : "Music / sung vocals" }));
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create 30 short clips/i })).toBeInTheDocument();
  });

  it("uses the Scenes requested label and same high-volume count behavior for Long form", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
    fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    const count = screen.getByLabelText("Scenes requested");
    fireEvent.change(count, { target: { value: "501" } });
    expect(count).toHaveValue("500");
    expect(screen.getByRole("button", { name: /Create 500 landscape clips/i })).toBeEnabled();
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
    expect(screen.getByText(/Music \/ sung vocals always uses Smart transcription locally\. VAD disabled; word timestamps retained\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Burn in subtitles/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ sourceProfile: "music", processingMode: "smart", burnSubtitles: true, count: 5 })));
  });

  it.each(["Auto", "Smart"])("keeps eligible %s hook text unchecked by default with a connected provider", (mode) => {
    render(<ProjectsView health={health} hasSelectedProvider onCreated={vi.fn()} />);
    if (mode === "Smart") fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    const hookText = screen.getByRole("checkbox", { name: /Hook text/i });
    expect(hookText).toBeEnabled();
    expect(hookText).not.toBeChecked();
    expect(hookText.parentElement).toHaveTextContent("Off by default. Tick to add transcript-grounded hook text locally or with the API in Auto.");
  });

  it("sends hookText true only after an explicit opt-in", async () => {
    mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hook text/i }));
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ hookText: true })));
  });

  it("omits hookText when eligible but unticked", async () => {
    mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalled());
    expect(mockCreateClipJob.mock.calls[0][0]).not.toHaveProperty("hookText");
  });

  it("uses Music mode's effective Smart processing after Fast was selected", () => {
    render(<ProjectsView health={health} providersLoaded hasSelectedProvider onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Music / sung vocals" }));
    expect(screen.getByRole("checkbox", { name: /YouTube metadata/ })).toBeEnabled();
  });

  it("resets hook text opt-in after eligibility is lost and regained", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: /Hook text/i });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    expect(checkbox).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(checkbox).toBeEnabled();
    expect(checkbox).not.toBeChecked();
  });

  it.each([
    ["Fast", "Fast mode does not support AI hook text."],
    ["Long form", "Long form does not support AI hook text."],
    ["High-volume", "High-volume batches do not support AI hook text."],
    ["Music", "Music mode does not support AI hook text; Music keeps its manual Top text."],
  ])("explains why hook text is unavailable for %s", (reason, message) => {
    render(<ProjectsView health={health} hasSelectedProvider={reason !== "No provider"} onCreated={vi.fn()} />);
    if (reason === "Fast") fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    if (reason === "Long form") fireEvent.click(screen.getByRole("button", { name: /Long form/ }));
    if (reason === "High-volume") fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
    if (reason === "Music") fireEvent.click(screen.getByRole("button", { name: "Music / sung vocals" }));
    const checkbox = screen.getByRole("checkbox", { name: /Hook text/i });
    expect(checkbox).toBeDisabled();
    expect(checkbox.parentElement).toHaveTextContent(message);
  });

  it("defaults to Auto mode with local transcription available without a provider", () => {
    render(<ProjectsView health={health} hasSelectedProvider={false} onCreated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Processing mode" })).toBeInTheDocument();
  });

  it.each([
    { label: "Auto while profiles are pending", providersLoaded: false, hasSelectedProvider: false, mode: "Auto", expectedMode: "auto", burnSubtitles: true },
    { label: "Auto without a provider", providersLoaded: true, hasSelectedProvider: false, mode: "Auto", expectedMode: "auto", burnSubtitles: true },
    { label: "Auto with a connected provider", providersLoaded: true, hasSelectedProvider: true, mode: "Auto", expectedMode: "auto", burnSubtitles: true },
    { label: "Fast with a connected provider", providersLoaded: true, hasSelectedProvider: true, mode: "Fast", expectedMode: "fast", burnSubtitles: false },
    { label: "Smart without a provider", providersLoaded: true, hasSelectedProvider: false, mode: "Smart", expectedMode: "smart", burnSubtitles: true },
  ])("submits $label with the expected processing and caption behavior", async ({ providersLoaded, hasSelectedProvider, mode, expectedMode, burnSubtitles }) => {
    mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
    render(<ProjectsView health={health} providersLoaded={providersLoaded} hasSelectedProvider={hasSelectedProvider} onCreated={vi.fn()} />);
    if (mode !== "Auto") fireEvent.click(screen.getByRole("button", { name: mode }));
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ processingMode: expectedMode, burnSubtitles })));
  });

  it("keeps the provider callout absent while /profiles is pending", () => {
    render(<ProjectsView health={health} providersLoaded={false} hasSelectedProvider={false} onCreated={vi.fn()} />);
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Hook text/i })).toBeEnabled();
    // The "add a provider" callout is the same claim in another shape.
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Smart" }));
    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/No provider is connected/i)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Hook text/i })).toBeEnabled();
  });

  it("shows the optional-provider callout only after /profiles confirms disconnection", () => {
    render(<ProjectsView health={health} providersLoaded hasSelectedProvider={false} onCreated={vi.fn()} />);
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
    expect(screen.queryByText(/Add optional AI providers/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No provider is connected|Auto uses a connected provider/i)).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute("aria-pressed", "true");
  });

  describe("Write SEO titles with AI", () => {
    const profile: ProviderProfile = { id: "p1", name: "Work", textModelId: "openai/gpt-4.1-mini", youtubeMetadataModelId: "google/gemini-2.5-flash-lite", selected: true, persistence: "encrypted", openrouterConfigured: true, textStatus: "connected", status: "connected", capabilities: [], fallbacks: {} };
    const submitUrl = () => {
      fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
      fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
      fireEvent.click(screen.getByRole("button", { name: /Create \d+ (short|landscape) clips?/i }));
    };
    const toggle = () => screen.getByTestId("youtube-metadata-toggle");

    it("defaults on for a connected profile with auto SEO titles and sends an explicit true", async () => {
      mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
      render(<ProjectsView health={health} providersLoaded hasSelectedProvider selectedProfile={profile} onCreated={vi.fn()} />);
      expect(screen.getByRole("checkbox", { name: /Write SEO titles with AI/ })).toBe(toggle());
      expect(screen.getByText("Generate YouTube metadata")).toBeInTheDocument();
      expect(toggle()).toBeChecked();
      submitUrl();
      await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ youtubeMetadata: true })));
    });

    it("defaults off when the profile disables auto SEO titles and sends an explicit false", async () => {
      mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
      render(<ProjectsView health={health} providersLoaded hasSelectedProvider selectedProfile={{ ...profile, autoSeoTitles: false }} onCreated={vi.fn()} />);
      expect(toggle()).toBeEnabled();
      expect(toggle()).not.toBeChecked();
      submitUrl();
      await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ youtubeMetadata: false })));
    });

    it("follows the default as eligibility changes until touched", () => {
      const { rerender } = render(<ProjectsView health={health} providersLoaded={false} hasSelectedProvider={false} selectedProfile={null} onCreated={vi.fn()} />);
      expect(toggle()).toBeEnabled();
      expect(toggle()).not.toBeChecked();
      rerender(<ProjectsView health={health} providersLoaded hasSelectedProvider selectedProfile={profile} onCreated={vi.fn()} />);
      expect(toggle()).toBeEnabled();
      expect(toggle()).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: /High-volume/ }));
      expect(toggle()).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: /Standard · up to 30/ }));
      expect(toggle()).toBeChecked();
    });

    it("respects the customer's untick across eligibility changes", async () => {
      mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
      render(<ProjectsView health={health} providersLoaded hasSelectedProvider selectedProfile={profile} onCreated={vi.fn()} />);
      fireEvent.click(toggle());
      expect(toggle()).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Fast" }));
      expect(toggle()).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Smart" }));
      expect(toggle()).toBeEnabled();
      expect(toggle()).not.toBeChecked();
      submitUrl();
      await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({ youtubeMetadata: false })));
    });

    it("omits the field when the toggle is ineligible", async () => {
      mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
      render(<ProjectsView health={health} providersLoaded hasSelectedProvider selectedProfile={profile} onCreated={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
      expect(toggle()).toBeDisabled();
      expect(toggle()).not.toBeChecked();
      submitUrl();
      await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalled());
      expect(mockCreateClipJob.mock.calls[0][0]).not.toHaveProperty("youtubeMetadata");
    });
  });
});


describe("Local execution selection", () => {
  it.each([false, true])("submits captions and hooks with Engine only (provider connected: %s)", async (connected) => {
    mockCreateClipJob.mockReset();
    mockCreateClipJob.mockResolvedValue({ project, job: undefinedJob });
    render(<ProjectsView health={health} providersLoaded hasSelectedProvider={connected} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Engine only" }));
    expect(screen.getByRole("button", { name: "Engine only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: /Burn in subtitles/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), { target: { value: "https://www.youtube.com/watch?v=fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledWith(expect.objectContaining({
      executionPolicy: "engine_only", processingMode: "auto", burnSubtitles: true, hookText: true,
    })));
  });
});
