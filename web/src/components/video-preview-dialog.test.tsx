import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../types";
import { VideoPreviewDialog } from "./video-preview-dialog";

const asset: LibraryAsset = {
  id: "video-1", title: "Launch reel", description: "", mediaType: "video/mp4", filename: "launch.mp4",
  tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false,
  minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: "hash",
  folderId: "folder", origin: "manual-import", blobId: "blob", previewUrl: "/api/v1/library/assets/video-1/preview?expires=123&signature=signed",
  brands: [], people: [], createdAt: "2026-01-01",
};

const opener = document.createElement("button");
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.appendChild(opener);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
});
afterEach(() => vi.restoreAllMocks());

function renderDialog(onClose = vi.fn()) {
  const view = render(<VideoPreviewDialog asset={asset} opener={opener} onClose={onClose} />);
  return { ...view, dialog: screen.getByRole("dialog", { name: "Launch reel video preview" }), onClose };
}

describe("VideoPreviewDialog", () => {
  it("renders the exact signed URL without autoplay and moves focus into the dialog", () => {
    const { dialog } = renderDialog();
    const video = dialog.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(asset.previewUrl);
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).not.toHaveAttribute("autoplay");
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close video preview" }));
    expect(document.body.style.overflow).toBe("hidden");
    expect(play).not.toHaveBeenCalled();
  });

  it("starts playback, hides the custom button, and restores replay on pause/end", async () => {
    const { dialog } = renderDialog();
    const video = dialog.querySelector("video")!;
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.play(video);
    expect(screen.queryByRole("button", { name: "Play video" })).not.toBeInTheDocument();
    fireEvent.pause(video);
    expect(screen.getByRole("button", { name: "Replay video" })).toBeInTheDocument();
    fireEvent.play(video);
    fireEvent.ended(video);
    expect(screen.getByRole("button", { name: "Replay video" })).toBeInTheDocument();
  });

  it("reports safe playback and media-load errors", async () => {
    const { dialog } = renderDialog();
    const video = dialog.querySelector("video")!;
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("secret signed URL details"));
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    expect(await screen.findByText("This video preview could not be played.")).toBeInTheDocument();
    expect(screen.queryByText(/secret signed URL/)).not.toBeInTheDocument();
    fireEvent.error(video);
    expect(screen.getByText("This video preview could not be loaded.")).toBeInTheDocument();
  });

  it("closes by button, Escape, or backdrop, pauses/resets, restores focus, and traps Tab", () => {
    const first = renderDialog();
    const { dialog, onClose } = first;
    const close = screen.getByRole("button", { name: "Close video preview" });
    const video = dialog.querySelector("video")!;
    video.currentTime = 5;
    const playButton = screen.getByRole("button", { name: "Play video" });
    playButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(playButton);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The caller owns removal; simulate it to exercise the effect cleanup contract.
    first.unmount();
    expect(pause).toHaveBeenCalled();
    expect(video.currentTime).toBe(0);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);

    const second = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(second.onClose).toHaveBeenCalledTimes(1);
    second.unmount();

    const third = renderDialog();
    fireEvent.click(third.dialog);
    expect(third.onClose).not.toHaveBeenCalled();
    fireEvent.click(third.dialog.parentElement!);
    expect(third.onClose).toHaveBeenCalledTimes(1);
    third.unmount();
  });
});
