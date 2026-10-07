import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";

describe("LazyVideoThumbnail still-image mode", () => {
  it("renders an image without mounting the source video and preserves caller content on failure", () => {
    const onError = vi.fn();
    const { container } = render(<LazyVideoThumbnail src="/signed/source.mp4" thumbnailSrc="/signed/still.jpg" className="card" onError={onError}><span>Clip 04</span></LazyVideoThumbnail>);
    const image = screen.getByRole("img", { name: "Video thumbnail" });
    expect(image).toHaveAttribute("src", "/signed/still.jpg");
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("Clip 04")).toBeInTheDocument();

    fireEvent.error(image);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Thumbnail unavailable");
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("Clip 04")).toBeInTheDocument();
  });

  it("renews a failed signed URL once and clears failure only after the replacement loads", async () => {
    const onError = vi.fn();
    const onRenew = vi.fn().mockResolvedValue("/signed/renewed.jpg");
    render(<LazyVideoThumbnail thumbnailSrc="/signed/expired.jpg" onError={onError} onRenew={onRenew} />);
    fireEvent.error(screen.getByRole("img"));

    const renewed = await screen.findByRole("img");
    await waitFor(() => expect(renewed).toHaveAttribute("src", "/signed/renewed.jpg"));
    expect(onRenew).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    fireEvent.load(renewed);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.error(renewed);
    expect(onRenew).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Thumbnail unavailable");
  });

  it("retains the legacy video-only mode for callers without a still URL", () => {
    const { container } = render(<LazyVideoThumbnail src="/signed/playback.mp4" label="Playable preview" />);
    expect(container.querySelector("video")).toHaveAttribute("src", "/signed/playback.mp4");
    expect(container.querySelector("img")).toBeNull();
  });
});
