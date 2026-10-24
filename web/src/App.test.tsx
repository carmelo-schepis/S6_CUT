import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetHealth = vi.fn();
const mockListProjects = vi.fn();
const mockListJobs = vi.fn();
const mockListProfiles = vi.fn();
const mockGetJob = vi.fn();
const mockControlJob = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getHealth: (...args: unknown[]) => mockGetHealth(...args),
    listProjects: (...args: unknown[]) => mockListProjects(...args),
    listJobs: (...args: unknown[]) => mockListJobs(...args),
    getJob: (...args: unknown[]) => mockGetJob(...args),
    controlJob: (...args: unknown[]) => mockControlJob(...args),
    listProfiles: (...args: unknown[]) => mockListProfiles(...args),
    listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })),
    listFolders: vi.fn(async () => []),
  };
});

import { App } from "./App";
import { TimeoutError } from "./api";
import { emitLibraryChanged } from "./library-sync";

const health = {
  status: "ready" as const, version: "0.1.0", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, dataPath: "/app/data", freeBytes: 1,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
};

const profile = {
  id: "p1", name: "Studio", textModelId: "openai/gpt-4o-mini", selected: true,
  persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "••••1234", textStatus: "connected" as const,
  textMessage: "Connected", textLastCheckedAt: null,
  status: "connected", capabilities: ["OpenRouter text generation"], fallbacks: { planning: "Deterministic planner" },
};

const activityProject = {
  schemaVersion: 1 as const, id: "activity-project", name: "Activity project", mode: "clip" as const,
  style: "educational" as const, state: "active" as const, sourceName: "source.mp4", sourceKind: "upload" as const,
  requestedCount: 5, latestJobId: "activity-job", createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const activityJob = {
  schemaVersion: 1 as const, id: "activity-job", projectId: activityProject.id, mode: "clip" as const, state: "active" as const,
  stage: "render", stageLabel: "Rendering", progress: 20, currentItem: 1, totalItems: 5, style: "educational" as const,
  processingMode: "fast" as const, warnings: [], clips: [], beats: [],
  steps: [{ id: "render", label: "Clips rendered", status: "active" as const, currentItem: 1, totalItems: 5 }],
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("App shell", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} });
    mockGetHealth.mockReset();
    mockListProjects.mockReset().mockResolvedValue([]);
    mockListJobs.mockReset().mockResolvedValue([]);
    mockListProfiles.mockReset().mockResolvedValue([profile]);
    mockGetJob.mockReset();
    mockControlJob.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes shared project state when a Library deletion changes persisted records", async () => {
    const deletedProject = {
      schemaVersion: 1 as const, id: "deleted-project", name: "Deleted library project", mode: "clip" as const,
      style: "educational" as const, state: "complete" as const, sourceName: "source.mp4", sourceKind: "upload" as const,
      requestedCount: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    mockListProjects.mockResolvedValueOnce([deletedProject]).mockResolvedValue([]);
    mockGetHealth.mockResolvedValue(health);
    render(<App />);

    await screen.findByRole("button", { name: "Workspace" });
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(document.querySelector(".topbar-context")).toHaveTextContent(deletedProject.name);
    emitLibraryChanged();
    await waitFor(() => expect(mockListProjects).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No project selected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: deletedProject.name })).not.toBeInTheDocument();
  });

  it("never moves the open Workspace to another project when the selected one leaves the listing", async () => {
    // A stopped import drops out of the listing until it publishes output. The
    // shell used to re-point the selection at the newest project, which put an
    // unrelated live job behind the Workspace controls — so "Stop & keep" for
    // this import could stop someone else's job.
    const stoppedImport = {
      schemaVersion: 1 as const, id: "youtube-import", name: "YouTube import", mode: "clip" as const,
      style: "educational" as const, state: "cancelled_kept" as const, sourceName: "clip.mp4", sourceKind: "youtube" as const,
      requestedCount: 5, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    let listing = [stoppedImport, activityProject];
    mockListProjects.mockImplementation(() => Promise.resolve(listing));
    mockListJobs.mockResolvedValue([{
      ...activityJob,
      id: "youtube-import-job",
      projectId: stoppedImport.id,
      state: "cancelled_kept",
      stage: "stopped",
      stageLabel: "Stopped during import",
      progress: 0,
      downloadProgress: {
        downloadedBytes: 512,
        totalBytes: 1024,
        percent: 50,
        phase: "stopped_partial",
        lastProgressAt: "2026-01-01T00:00:00Z",
        resumable: true,
      },
    }]);
    mockGetHealth.mockResolvedValue(health);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Jobs" }));
    expect(await screen.findByRole("heading", { name: "Jobs & recovery" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Retry import" })).toBeVisible();
    const openImport = screen.getByRole("button", { name: "Open" });
    await act(async () => { fireEvent.click(openImport); });
    expect(document.querySelector(".topbar-context")).toHaveTextContent("YouTube import");

    listing = [activityProject];
    const readsBefore = mockListProjects.mock.calls.length;
    emitLibraryChanged();
    await waitFor(() => expect(mockListProjects.mock.calls.length).toBeGreaterThan(readsBefore));

    // The Workspace says it has nothing open rather than silently adopting the
    // other project and its live job controls.
    expect(await screen.findByText("No project selected")).toBeInTheDocument();
    expect(document.querySelector(".topbar-context")).not.toHaveTextContent(activityProject.name);
  });

  it("shows exactly one engine startup message while the first health read is outstanding", async () => {
    const pending = deferred<typeof health>();
    mockGetHealth.mockReturnValue(pending.promise);
    render(<App />);

    const startup = await screen.findByText(/Connecting to the local engine/i);
    expect(startup).toBeInTheDocument();
    // The competing startup captions must stay off the first paint.
    expect(screen.queryByText(/Checking local tools/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking local engine/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".engine-startup")).toHaveLength(1);
    expect(document.querySelector(".rail-foot")).toBeNull();

    await act(async () => { pending.resolve(health); });
    await waitFor(() => expect(document.querySelector(".engine-startup")).toBeNull());
    // …and the steady-state reading remains in the top bar while Help owns the rail footer.
    expect(screen.getByText("Local engine", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open S6 Cut Help" })).toBeInTheDocument();
    expect(screen.queryByText(/All local tools ready/i)).not.toBeInTheDocument();
  });

  it("turns an unanswered health read into the retryable error state, not an endless loader", async () => {
    mockGetHealth.mockRejectedValueOnce(new TimeoutError(8_000));
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Engine unavailable/i);
    expect(alert).toHaveTextContent(/did not respond within 8s/i);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".engine-startup")).toBeNull());
    expect(screen.queryByText(/Connecting to the local engine/i)).not.toBeInTheDocument();
  });

  it("performs another health check when Retry is pressed and recovers", async () => {
    mockGetHealth.mockRejectedValueOnce(new TimeoutError(8_000)).mockResolvedValue(health);
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(mockGetHealth).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(within(alert).getByRole("button", { name: "Retry" })); });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mockGetHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Local engine", { exact: true })).toBeInTheDocument();
  });

  it("never has a second health read on the wire while the first is pending", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof health>();
    mockGetHealth.mockReturnValue(pending.promise);
    render(<App />);
    await act(async () => undefined);
    expect(mockGetHealth).toHaveBeenCalledTimes(1);

    // Six health cadences pass with the first read still unresolved.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mockGetHealth).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(health); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(mockGetHealth).toHaveBeenCalledTimes(2);
  });

  it("never has a second jobs read on the wire while the first is pending", async () => {
    vi.useFakeTimers();
    mockGetHealth.mockResolvedValue(health);
    const pending = deferred<never[]>();
    mockListJobs.mockReturnValue(pending.promise);
    render(<App />);
    await act(async () => undefined);
    expect(mockListJobs).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve([]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100); });
    expect(mockListJobs).toHaveBeenCalledTimes(2);
  });

  it("keeps the shell jobs poll single-flight while live work is viewed outside Projects", async () => {
    vi.useFakeTimers();
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    mockListJobs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue([]);
    render(<App />);
    await act(async () => undefined);
    expect(mockListJobs).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve([activityJob]); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: /^Library$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("4");

    // A slow read must not be replaced by another request while the user stays
    // on Library, where the Workspace view is unmounted.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve([activityJob]); });
  });

  it("renders one top-level main landmark and a skip link that targets it", async () => {
    mockGetHealth.mockResolvedValue(health);
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Create a project" });

    const mains = document.querySelectorAll("main, [role='main']");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", "main-content");

    const skip = screen.getByRole("link", { name: /Skip to main content/i });
    expect(skip).toHaveAttribute("href", "#main-content");
    // It must be the first focusable stop, ahead of the rail destinations.
    const focusables = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    expect(focusables[0]).toBe(skip);

    await act(async () => { skip.click(); });
    expect(document.activeElement).toBe(document.getElementById("main-content"));
  });

  it("keeps the Workspace name and shows accessible activity progress", async () => {
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    mockListJobs.mockResolvedValue([activityJob]);
    render(<App />);

    const workspace = await screen.findByRole("button", { name: /^Workspace$/ });
    const badge = await screen.findByTestId("workspace-work-count");
    expect(workspace).toHaveAttribute("aria-label", "Workspace");
    expect(workspace).toHaveAttribute("aria-describedby", "workspace-work-description");
    expect(badge).toHaveTextContent("4");
    expect(badge).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("workspace-nav-icon")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-work-spinner")).toBeInTheDocument();
    expect(workspace).toHaveAccessibleDescription("Loading progress: 4 clips remaining across 1 active job");
  });

  it("updates Workspace activity progress from later jobs polls and removes it at completion", async () => {
    vi.useFakeTimers();
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    const updated = { ...activityJob, steps: [{ ...activityJob.steps[0], currentItem: 2 }] };
    const complete = { ...activityJob, state: "complete" as const, stage: "complete", steps: [] };
    mockListJobs.mockResolvedValueOnce([activityJob]).mockResolvedValueOnce([updated]).mockResolvedValueOnce([complete]);
    render(<App />);
    await act(async () => undefined);

    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("4");
    expect(screen.getByTestId("workspace-work-spinner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Library$/ }));
    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("4");
    expect(screen.getByTestId("workspace-work-spinner")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Workspace$/ })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("workspace-work-count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-work-spinner")).not.toBeInTheDocument();
  });

  it.each(["queued", "active", "recovered"] as const)("shows the processing spinner for %s work", async (state) => {
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    mockListJobs.mockResolvedValue([{ ...activityJob, state }]);
    render(<App />);
    expect(await screen.findByTestId("workspace-work-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-work-count")).toBeInTheDocument();
  });

  it.each(["complete", "failed", "cancelled_kept", "paused", "stalled"] as const)("does not show the spinner for %s work", async (state) => {
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    mockListJobs.mockResolvedValue([{ ...activityJob, state }]);
    render(<App />);
    await screen.findByRole("button", { name: /^Workspace$/ });
    expect(screen.getByTestId("workspace-nav-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-work-spinner")).not.toBeInTheDocument();
    if (state === "paused" || state === "stalled") expect(screen.getByTestId("workspace-work-count")).toBeInTheDocument();
    else expect(screen.queryByTestId("workspace-work-count")).not.toBeInTheDocument();
  });

  it("labels the unified Workspace progress indicator without changing the navigation name", async () => {
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    mockListJobs.mockResolvedValue([activityJob]);
    render(<App />);
    const workspace = await screen.findByRole("button", { name: /^Workspace$/ });
    const progress = screen.getByTestId("workspace-work-progress");
    expect(workspace).toHaveAttribute("aria-label", "Workspace");
    expect(workspace).toHaveAccessibleDescription("Loading progress: 4 clips remaining across 1 active job");
    expect(progress).toHaveAttribute("role", "img");
    expect(progress).toHaveAttribute("aria-label", "Loading progress: 4 clips remaining across 1 active job");
    expect(progress).toHaveAttribute("data-progress-value", "4");
  });

  it("opens the latest job identity for a project and sends Workspace controls to that job", async () => {
    const TestEventSource = class { close() {} };
    vi.stubGlobal("EventSource", TestEventSource);
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: TestEventSource });
    const olderJob = { ...activityJob, id: "older-job", state: "complete" as const, stage: "complete", updatedAt: "2026-01-01" };
    const latestJob = { ...activityJob, id: "latest-job", updatedAt: "2026-01-02" };
    const project = { ...activityProject, latestJobId: latestJob.id };
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([project]);
    mockListJobs.mockResolvedValue([olderJob, latestJob]);
    mockGetJob.mockResolvedValue(latestJob);
    mockControlJob.mockResolvedValue({ ...latestJob, state: "paused" });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Jobs" }));
    await screen.findByRole("heading", { name: "Jobs & recovery" });
    await waitFor(() => expect(document.querySelector(`.job-card[data-job-id="${latestJob.id}"]`)).toBeTruthy());
    const latestCard = document.querySelector(`.job-card[data-job-id="${latestJob.id}"]`);
    expect(latestCard).toBeTruthy();
    fireEvent.click(within(latestCard as HTMLElement).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(mockGetJob).toHaveBeenCalledWith(latestJob.id));
    await screen.findByRole("heading", { name: project.name });
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mockControlJob).toHaveBeenCalledWith(latestJob.id, "pause"));
  });

  it("does not render an activity badge when no work is live", async () => {
    mockGetHealth.mockResolvedValue(health);
    render(<App />);
    await screen.findByRole("button", { name: /^Workspace$/ });
    expect(screen.getByTestId("workspace-nav-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-work-count")).not.toBeInTheDocument();
  });
});
