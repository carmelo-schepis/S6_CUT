import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { selectWorkspaceJob } from "./workspace-job-selector";
import type { Job } from "./types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetHealth = vi.fn();
const mockListProjects = vi.fn();
const mockListJobs = vi.fn();
const mockListProfiles = vi.fn();
const mockGetJob = vi.fn();
const mockCreateClipJob = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getHealth: (...args: unknown[]) => mockGetHealth(...args),
    listProjects: (...args: unknown[]) => mockListProjects(...args),
    listJobs: (...args: unknown[]) => mockListJobs(...args),
    listProfiles: (...args: unknown[]) => mockListProfiles(...args),
    getJob: (...args: unknown[]) => mockGetJob(...args),
    createClipJob: (...args: unknown[]) => mockCreateClipJob(...args),
    listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })),
    listFolders: vi.fn(async () => []),
  };
});

import { App } from "./App";
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

function project(id: string, name: string, updatedAt: string, latestJobId = `${id}-job`) {
  return {
    schemaVersion: 1 as const, id, name, mode: "clip" as const, style: "educational" as const,
    state: "active" as const, sourceName: "source.mp4", sourceKind: "upload" as const,
    requestedCount: 5, latestJobId, createdAt: "2026-01-01", updatedAt,
  };
}

function job(id: string, projectId: string, state: "active" | "queued" | "complete", updatedAt: string, queuePosition?: number) {
  return {
    schemaVersion: 1 as const, id, projectId, mode: "clip" as const, state,
    stage: state === "queued" ? "queued" : state === "complete" ? "ready" : "render",
    stageLabel: state === "queued" ? "Waiting in queue" : state === "complete" ? "Complete" : "Rendering",
    progress: state === "complete" ? 100 : 20, currentItem: 1, totalItems: 5, style: "educational" as const,
    processingMode: "fast" as const, warnings: [], clips: [], beats: [], steps: [],
    queuePosition, createdAt: "2026-01-01", updatedAt,
  };
}

describe("Workspace project selection", () => {
  it("immediately follows the active job from the last snapshot when creating a queued project", async () => {
    const activeProject = project("active-project", "Currently processing", "2026-01-01", "active-job");
    const activeJob = job("active-job", activeProject.id, "active", "2026-01-01");
    const previouslyOpenedProject = project("opened-queue", "Previously opened queued project", "2026-01-08", "opened-queue-job");
    const previouslyOpenedJob = job("opened-queue-job", previouslyOpenedProject.id, "queued", "2026-01-08", 1);
    const newlyCreatedProject = project("new-queue", "New queued project", "2026-01-09", "new-queue-job");
    const newlyCreatedJob = job("new-queue-job", newlyCreatedProject.id, "queued", "2026-01-09", 2);
    const lastSnapshot = [activeJob, previouslyOpenedJob];
    let holdJobsPoll = false;
    let resolveHeldPoll!: (value: typeof lastSnapshot) => void;
    const heldJobsPoll = new Promise<typeof lastSnapshot>((resolve) => { resolveHeldPoll = resolve; });
    mockListProjects.mockResolvedValue([activeProject, previouslyOpenedProject]);
    mockListJobs.mockImplementation(() => holdJobsPoll ? heldJobsPoll : Promise.resolve(lastSnapshot));
    mockGetJob.mockImplementation(async (id: string) => lastSnapshot.find((item) => item.id === id) || null);
    mockCreateClipJob.mockResolvedValue({ project: newlyCreatedProject, job: newlyCreatedJob });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Jobs" }));
    await screen.findByRole("heading", { name: "Jobs & recovery" });
    const openedQueue = document.querySelector<HTMLButtonElement>(`.job-card[data-project-id="${previouslyOpenedProject.id}"] button`);
    expect(openedQueue).toBeTruthy();
    fireEvent.click(openedQueue!);
    await waitFor(() => expect(mockGetJob.mock.calls.at(-1)?.[0]).toBe("opened-queue-job"));

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("tab", { name: "YouTube" }));
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL" }), {
      target: { value: "https://www.youtube.com/watch?v=queued-fixture" },
    });
    holdJobsPoll = true;
    fireEvent.click(screen.getByRole("button", { name: "Create 5 short clips" }));

    await waitFor(() => expect(mockCreateClipJob).toHaveBeenCalledTimes(1));
    // Keep the post-create /jobs response pending: the result must come from
    // the active identity already present in the prior authoritative snapshot.
    expect(document.querySelector(".topbar-context")).toHaveTextContent(activeProject.name);
    await waitFor(() => expect(mockGetJob.mock.calls.at(-1)?.[0]).toBe("active-job"));
    expect(mockGetJob).not.toHaveBeenCalledWith("new-queue-job");

    holdJobsPoll = false;
    await act(async () => { resolveHeldPoll(lastSnapshot); });
  });
  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} });
    mockGetHealth.mockReset().mockResolvedValue(health);
    mockListProjects.mockReset().mockResolvedValue([]);
    mockListJobs.mockReset().mockResolvedValue([]);
    mockListProfiles.mockReset().mockResolvedValue([profile]);
    mockGetJob.mockReset().mockResolvedValue(null);
    mockCreateClipJob.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("follows the active project regardless of project updatedAt, retains it through a poll gap, then advances to the next active project", async () => {
    const oldActive = project("active-old", "Active project", "2026-01-01");
    const freshIdle = project("idle-new", "Recently updated project", "2026-01-03");
    const nextActive = project("active-next", "Next active project", "2026-01-02");
    let projects = [freshIdle, oldActive, nextActive];
    let jobs = [job("job-old", oldActive.id, "active", "2026-01-01")];
    mockListProjects.mockImplementation(() => Promise.resolve(projects));
    mockListJobs.mockImplementation(() => Promise.resolve(jobs));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(oldActive.name));

    // A temporarily empty/stale jobs response must not drop the current follow target.
    jobs = [];
    await act(async () => { emitLibraryChanged(); });
    await waitFor(() => expect(mockListProjects.mock.calls.length).toBeGreaterThan(1));
    expect(document.querySelector(".topbar-context")).toHaveTextContent(oldActive.name);

    // Once the old job completes, the next live project becomes the follow target.
    jobs = [job("job-old", oldActive.id, "complete", "2026-01-04"), job("job-next", nextActive.id, "active", "2026-01-02")];
    projects = [freshIdle, oldActive, nextActive];
    await act(async () => { emitLibraryChanged(); });
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(nextActive.name));
  });

  it("uses queuePosition for the queued fallback and resumes the manually opened project after Jobs navigation", async () => {
    const projectA = project("queued-a", "Queue position two", "2026-01-03");
    const projectB = project("queued-b", "Queue position one", "2026-01-01");
    const projectC = project("queued-c", "Manually opened project", "2026-01-02");
    mockListProjects.mockResolvedValue([projectA, projectB, projectC]);
    mockListJobs.mockResolvedValue([
      job("job-a", projectA.id, "queued", "2026-01-03", 2),
      job("job-b", projectB.id, "queued", "2026-01-01", 1),
      job("job-c", projectC.id, "queued", "2026-01-02", 3),
    ]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(projectB.name));

    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    await screen.findByRole("heading", { name: "Jobs & recovery" });
    const manuallyOpen = document.querySelector(".job-card[data-project-id=\"queued-c\"] button");
    expect(manuallyOpen).toBeTruthy();
    fireEvent.click(manuallyOpen!);
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(projectC.name));

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(document.querySelector(".topbar-context")).toHaveTextContent(projectC.name);
  });

  it("ignores an out-of-order project response after a newer refresh has selected another project", async () => {
    const firstRead = (() => {
      let resolve!: (value: ReturnType<typeof project>[]) => void;
      const promise = new Promise<ReturnType<typeof project>[]>((done) => { resolve = done; });
      return { promise, resolve };
    })();
    const selected = project("selected", "Selected live project", "2026-01-01");
    const stale = project("stale", "Stale response project", "2026-01-09");
    let call = 0;
    mockListProjects.mockImplementation(() => ++call === 1 ? firstRead.promise : Promise.resolve([selected]));
    mockListJobs.mockResolvedValue([job("selected-job", selected.id, "active", "2026-01-01")]);
    render(<App />);

    await waitFor(() => expect(mockListProjects).toHaveBeenCalledTimes(1));
    await act(async () => { emitLibraryChanged(); });
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(selected.name));

    await act(async () => { firstRead.resolve([stale]); });
    await waitFor(() => expect(document.querySelector(".topbar-context")).toHaveTextContent(selected.name));
    expect(screen.queryByText("No project selected")).not.toBeInTheDocument();
  });
});

// Keep the selector contract covered independently of the shell rendering.

describe("selectWorkspaceJob", () => {
  const selection = (projectId: string, jobId: string) => ({ projectId, jobId });
  const asJob = (value: ReturnType<typeof job>) => value as unknown as Job;

  it("chooses active work ahead of newer queued jobs", () => {
    const running = asJob(job("running", "project-running", "active", "2026-01-01"));
    const queuedB = asJob(job("queued-b", "project-b", "queued", "2026-01-08", 1));
    const queuedC = asJob(job("queued-c", "project-c", "queued", "2026-01-09", 2));
    expect(selectWorkspaceJob([queuedC, running, queuedB], null)).toEqual(selection("project-running", "running"));
  });

  it("chooses active work ahead of newer queued jobs", () => {
    const running = asJob(job("running", "project-running", "active", "2026-01-01"));
    const queuedB = asJob(job("queued-b", "project-b", "queued", "2026-01-08", 1));
    const queuedC = asJob(job("queued-c", "project-c", "queued", "2026-01-09", 2));
    expect(selectWorkspaceJob([queuedC, running, queuedB], null)).toEqual(selection("project-running", "running"));
  });

  it("keeps the selected active job stable when another active job has a newer updatedAt", () => {
    const previous = selection("project-a", "job-a");
    const current = asJob(job("job-a", "project-a", "active", "2026-01-01"));
    const newer = asJob(job("job-b", "project-b", "active", "2026-01-09"));
    expect(selectWorkspaceJob([newer, current], previous)).toEqual(previous);
  });

  it("uses queuePosition for the queued fallback, retains a gap, advances after completion, and detects a replacement job in the same project", () => {
    const second = asJob(job("job-second", "project-second", "queued", "2026-01-01", 2));
    const first = asJob(job("job-first", "project-first", "queued", "2026-01-09", 1));
    expect(selectWorkspaceJob([second, first], null)).toEqual(selection("project-first", "job-first"));
    expect(selectWorkspaceJob([], selection("project-first", "job-first"))).toEqual(selection("project-first", "job-first"));

    const replacement = asJob(job("job-replacement", "project-first", "active", "2026-01-10"));
    const next = asJob(job("zz-job-next", "project-next", "active", "2026-01-12"));
    expect(selectWorkspaceJob([replacement, next], selection("project-first", "job-first")))
      .toEqual(selection("project-first", "job-replacement"));
  });
});
