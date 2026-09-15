import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetHealth = vi.fn();
const mockListProjects = vi.fn();
const mockListJobs = vi.fn();
const mockListProfiles = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getHealth: (...args: unknown[]) => mockGetHealth(...args),
    listProjects: (...args: unknown[]) => mockListProjects(...args),
    listJobs: (...args: unknown[]) => mockListJobs(...args),
    listProfiles: (...args: unknown[]) => mockListProfiles(...args),
  };
});

import { App } from "./App";
import { TimeoutError } from "./api";
import { emitLibraryChanged } from "./library-sync";

const health = {
  status: "ready" as const, version: "0.1.0", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "/app/data", freeBytes: 1,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
};

const profile = {
  id: "p1", name: "Studio", textModelId: "openai/gpt-4o-mini", ttsModelId: "free/speech", ttsVoice: "alloy", ttsSpeed: 1, selected: true,
  persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "••••1234", textStatus: "connected" as const,
  ttsStatus: "connected" as const, textMessage: "Connected", ttsMessage: "Connected", textLastCheckedAt: null, ttsLastCheckedAt: null,
  status: "connected", capabilities: ["OpenRouter text generation", "OpenRouter TTS"], fallbacks: { planning: "Deterministic planner" },
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
    mockGetHealth.mockReset();
    mockListProjects.mockReset().mockResolvedValue([]);
    mockListJobs.mockReset().mockResolvedValue([]);
    mockListProfiles.mockReset().mockResolvedValue([profile]);
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes Recent projects when a Library deletion changes persisted records", async () => {
    const recentProject = {
      schemaVersion: 1 as const, id: "deleted-project", name: "Deleted library project", mode: "clip" as const,
      style: "educational" as const, state: "complete" as const, sourceName: "source.mp4", sourceKind: "upload" as const,
      requestedCount: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    mockListProjects.mockResolvedValueOnce([recentProject]).mockResolvedValue([]);
    mockGetHealth.mockResolvedValue(health);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Open project Deleted library project" })).toBeInTheDocument();
    emitLibraryChanged();
    await waitFor(() => expect(mockListProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open project Deleted library project" })).not.toBeInTheDocument());
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

  it("keeps the Workspace name and shows an accessible activity badge", async () => {
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
    expect(workspace).toHaveAccessibleDescription("4 clips remaining across 1 active job");
  });

  it("updates the badge from later jobs polls on another page and removes it at completion", async () => {
    vi.useFakeTimers();
    mockGetHealth.mockResolvedValue(health);
    mockListProjects.mockResolvedValue([activityProject]);
    const updated = { ...activityJob, steps: [{ ...activityJob.steps[0], currentItem: 2 }] };
    const complete = { ...activityJob, state: "complete" as const, stage: "complete", steps: [] };
    mockListJobs.mockResolvedValueOnce([activityJob]).mockResolvedValueOnce([updated]).mockResolvedValueOnce([complete]);
    render(<App />);
    await act(async () => undefined);

    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: /^Library$/ }));
    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("4");

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("workspace-work-count")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Workspace$/ })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockListJobs).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("workspace-work-count")).not.toBeInTheDocument();
  });

  it("does not render an activity badge when no work is live", async () => {
    mockGetHealth.mockResolvedValue(health);
    render(<App />);
    await screen.findByRole("button", { name: /^Workspace$/ });
    expect(screen.queryByTestId("workspace-work-count")).not.toBeInTheDocument();
  });
});
