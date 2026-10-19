import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IOSStatusView } from "./ios-status-view";

const api = vi.hoisted(() => ({
  listJobs: vi.fn(),
  listProjects: vi.fn(),
  listVideoOnlyDownloads: vi.fn(),
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unavailable",
}));
vi.mock("../api", () => api);

const job = (progress: number, previewUrl?: string) => ({
  schemaVersion: 1, id: "job-12345678", projectId: "project-1", mode: "clip", state: "active",
  stage: "download", stageLabel: "Downloading source", progress, currentItem: 0, totalItems: 0,
  style: "funny", processingMode: "smart", contentFormat: "short", warnings: [], clips: previewUrl
    ? [{ id: "clip-1", index: 1, state: "complete", start: 0, end: 10, duration: 10, openingLine: "", selected: true, reviewRequired: false, captionQaWarnings: [], captionDownloads: [], captionCues: [], captionRevision: 0, previewUrl, title: "A finished clip" }]
    : [], beats: [], steps: [], createdAt: "2026-01-01", updatedAt: "2026-01-02",
} as never);

describe("iOS status view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listJobs.mockResolvedValue([job(31, "/signed/clip.mp4")]);
    api.listProjects.mockResolvedValue([{ id: "project-1", name: "Launch video" }]);
    api.listVideoOnlyDownloads.mockResolvedValue([]);
  });

  it("shows project progress and playable signed previews without download controls", async () => {
    render(<IOSStatusView />);
    expect(await screen.findByText("Launch video")).toBeInTheDocument();
    const video = document.querySelector("video");
    expect(video).toHaveAttribute("src", "/signed/clip.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("controlslist", "nodownload noplaybackrate");
    expect(api.listJobs).toHaveBeenCalled();
    expect(api.listProjects).toHaveBeenCalled();
    expect(api.listVideoOnlyDownloads).toHaveBeenCalled();
  });

  it("refreshes changed progress and exposes only read operations", async () => {
    api.listJobs.mockResolvedValueOnce([job(31)]).mockResolvedValueOnce([job(67)]);
    render(<IOSStatusView />);
    await screen.findByText("31%");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(screen.getByText("67%")).toBeInTheDocument());
    expect(api.listJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.listProjects.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.listVideoOnlyDownloads.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
