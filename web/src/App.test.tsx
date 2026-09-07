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

const health = {
  status: "ready" as const, version: "0.1.0", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "/app/data", freeBytes: 1,
  configuredWorkers: 1, activeWorkers: 1, queuedJobs: 0, fallbacks: { media: "text card" },
};

const profile = {
  id: "p1", name: "Studio", modelId: "openai/gpt-4o-mini", voiceId: null, selected: true,
  persistence: "encrypted", openrouterConfigured: true, elevenlabsConfigured: false,
  openrouterMasked: "••••1234", elevenlabsMasked: null, openrouterStatus: "connected" as const,
  elevenlabsStatus: "not_configured" as const, openrouterMessage: "Connected",
  openrouterLastCheckedAt: null, elevenlabsMessage: "Optional", elevenlabsLastCheckedAt: null,
  status: "connected", capabilities: ["structured planning"], fallbacks: { planning: "Deterministic planner" },
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
    expect(screen.getByText(/All local tools ready/i)).toBeInTheDocument();
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

  it("renders one top-level main landmark and a skip link that targets it", async () => {
    mockGetHealth.mockResolvedValue(health);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: /Make the first cut/i });

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
});
