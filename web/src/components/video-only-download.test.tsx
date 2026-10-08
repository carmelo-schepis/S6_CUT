import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVideoOnlyDownload, getVideoOnlyDownload } from "../api";
import type { VideoDownloadTask } from "../types";
import { VideoOnlyDownload } from "./video-only-download";
import { VideoSourcePicker } from "./video-source-picker";

vi.mock("../api", () => ({
  createVideoOnlyDownload: vi.fn(),
  getVideoOnlyDownload: vi.fn(),
  readableError: (error: unknown) => error instanceof Error ? error.message : "Download failed",
  ApiError: class ApiError extends Error { status = 500; },
}));

const firstUrl = "https://www.youtube.com/watch?v=8xEuFQz4E4A";
const secondUrl = "https://youtu.be/KNVr5pHAygI";
const task = (overrides: Partial<VideoDownloadTask> = {}): VideoDownloadTask => ({
  id: "task-1", url: firstUrl, state: "queued", phase: "queued", downloadedBytes: 0,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("video-only download action", () => {
  it("appears beside the URL only in the YouTube source section", () => {
    const renderPicker = (mode: "file" | "url") => render(<VideoSourcePicker mode={mode} onModeChange={vi.fn()} file={null} onFile={vi.fn()} url={firstUrl} onUrl={vi.fn()} downloadAction={<VideoOnlyDownload url={firstUrl} />} />);
    const local = renderPicker("file");
    expect(screen.queryByRole("button", { name: "Download video" })).not.toBeInTheDocument();
    local.unmount();
    renderPicker("url");
    expect(screen.getByRole("button", { name: "Download video" })).toBeInTheDocument();
  });

  it("shows a useful error for an invalid URL and submits only a valid YouTube URL", async () => {
    const { rerender } = render(<VideoOnlyDownload url="not a URL" />);
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid HTTPS YouTube URL.");
    expect(createVideoOnlyDownload).not.toHaveBeenCalled();
    rerender(<VideoOnlyDownload url={firstUrl} />);
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(task());
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    await waitFor(() => expect(createVideoOnlyDownload).toHaveBeenCalledWith(firstUrl));
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate clicks while creation is pending", async () => {
    let resolve!: (value: VideoDownloadTask) => void;
    vi.mocked(createVideoOnlyDownload).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<VideoOnlyDownload url={firstUrl} />);
    const button = screen.getByRole("button", { name: "Download video" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
    await act(async () => resolve(task()));
  });

  it("does not present or download a task when its URL changed during creation", async () => {
    let resolve!: (value: VideoDownloadTask) => void;
    vi.mocked(createVideoOnlyDownload).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { rerender } = render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    rerender(<VideoOnlyDownload url={secondUrl} />);
    await act(async () => resolve(task({ state: "complete", phase: "complete", filename: "video.mp4", downloadUrl: "/download" })));
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryByText("Downloading…")).not.toBeInTheDocument();
    expect(getVideoOnlyDownload).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("automatically initiates the browser download when the task completes", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const ready = task({ state: "complete", phase: "complete", filename: "youtube-video.mp4", downloadUrl: "/signed.mp4" });
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(ready);
    render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link", { name: "Download MP4" })).not.toBeInTheDocument();
    click.mockRestore();
  });

  it("re-downloads a completed task after refreshing its signed link", async () => {
    const ready = task({ state: "complete", phase: "complete", filename: "youtube-video.mp4", downloadUrl: "/signed.mp4" });
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(ready);
    vi.mocked(getVideoOnlyDownload).mockResolvedValue({ ...ready, downloadUrl: "/refreshed.mp4" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    await waitFor(() => expect(getVideoOnlyDownload).toHaveBeenCalledWith(ready.id));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("announces failures and allows the same button to retry", async () => {
    vi.mocked(createVideoOnlyDownload).mockRejectedValueOnce(new Error("Try again later")).mockResolvedValueOnce(task());
    render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later");
    fireEvent.click(screen.getByRole("button", { name: "Download video" }));
    await waitFor(() => expect(createVideoOnlyDownload).toHaveBeenCalledTimes(2));
  });

  it("retries a terminal failed task with the same button", async () => {
    const failed = task({ state: "failed", phase: "failed", error: "The source download failed. Try again." });
    window.localStorage.setItem("s6-cut.video-download-only-task", failed.id);
    vi.mocked(getVideoOnlyDownload).mockResolvedValue(failed);
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(task());
    render(<VideoOnlyDownload url={firstUrl} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("source download failed");
    const button = screen.getByRole("button", { name: "Download video" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(createVideoOnlyDownload).toHaveBeenCalledWith(firstUrl));
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
  });
});
