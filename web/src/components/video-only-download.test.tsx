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
    expect(screen.queryByRole("button", { name: "Download video only" })).not.toBeInTheDocument();
    local.unmount();
    renderPicker("url");
    expect(screen.getByRole("button", { name: "Download video only" })).toBeInTheDocument();
  });

  it("requires a valid YouTube URL and submits only the URL", async () => {
    const { rerender } = render(<VideoOnlyDownload url="not a URL" />);
    expect(screen.getByRole("button", { name: "Download video only" })).toBeDisabled();
    rerender(<VideoOnlyDownload url={firstUrl} />);
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(task());
    fireEvent.click(screen.getByRole("button", { name: "Download video only" }));
    await waitFor(() => expect(createVideoOnlyDownload).toHaveBeenCalledWith(firstUrl));
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate clicks while creation is pending", async () => {
    let resolve!: (value: VideoDownloadTask) => void;
    vi.mocked(createVideoOnlyDownload).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<VideoOnlyDownload url={firstUrl} />);
    const button = screen.getByRole("button", { name: "Download video only" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(createVideoOnlyDownload).toHaveBeenCalledTimes(1);
    await act(async () => resolve(task()));
  });

  it("does not present an old task if the URL changes while creation is pending", async () => {
    let resolve!: (value: VideoDownloadTask) => void;
    vi.mocked(createVideoOnlyDownload).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video only" }));
    rerender(<VideoOnlyDownload url={secondUrl} />);
    await act(async () => resolve(task({ state: "complete", phase: "complete", filename: "video.mp4", downloadUrl: "/download" })));
    expect(screen.queryByRole("link", { name: "Download MP4" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(getVideoOnlyDownload).not.toHaveBeenCalled();
  });

  it("automatically initiates the browser download only once across remounts", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const ready = task({ state: "complete", phase: "complete", filename: "youtube-video.mp4", downloadUrl: "/signed.mp4" });
    vi.mocked(createVideoOnlyDownload).mockResolvedValue(ready);
    vi.mocked(getVideoOnlyDownload).mockResolvedValue(ready);
    const first = render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video only" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<VideoOnlyDownload url={firstUrl} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Download MP4" })).toBeInTheDocument());
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("announces failures and allows a retry", async () => {
    vi.mocked(createVideoOnlyDownload).mockRejectedValueOnce(new Error("Try again later")).mockResolvedValueOnce(task());
    render(<VideoOnlyDownload url={firstUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Download video only" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later");
    fireEvent.click(screen.getByRole("button", { name: "Download video only" }));
    await waitFor(() => expect(createVideoOnlyDownload).toHaveBeenCalledTimes(2));
  });
});
