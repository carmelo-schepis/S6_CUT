import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipStrip, Poster } from "./mobile-parts";

describe("Poster", () => {
  it("keeps the still it loaded when the engine re-signs the same link on a status poll", () => {
    const { container, rerender } = render(<Poster src="/thumb/a.jpg?sig=1" />);
    const image = container.querySelector("img");
    rerender(<Poster src="/thumb/a.jpg?sig=2" />);
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector("img")).toHaveAttribute("src", "/thumb/a.jpg?sig=1");
  });
  it("adopts a link that points at a different image, such as the Library thumbnail replacing a source poster", () => {
    const { container, rerender } = render(<Poster src="/api/v1/jobs/j/source-thumbnail?sig=1" />);
    rerender(<Poster src="/api/v1/library/assets/a/thumbnail?sig=1" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/v1/library/assets/a/thumbnail?sig=1");
  });
  it("shows the first link once it arrives, and retries with the latest signed link when the old one expires", () => {
    const { container, rerender } = render(<Poster src={null} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<Poster src="/thumb/a.jpg?sig=1" />);
    rerender(<Poster src="/thumb/a.jpg?sig=2" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toHaveAttribute("src", "/thumb/a.jpg?sig=2");
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
  });
  it("never creates a video element", () => {
    const { container } = render(<Poster src="/thumb/a.jpg" />);
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("ClipStrip", () => {
  it("opens the shared player only for clips that have a preview link", () => {
    const onPreview = vi.fn();
    render(<ClipStrip label="Clips" onPreview={onPreview} clips={[
      { id: "a", index: 1, title: "Playable", duration: 3, thumbnailUrl: "/t/a.jpg", previewUrl: "/p/a.mp4" },
      { id: "b", index: 2, title: "Not ready", duration: 3, thumbnailUrl: "/t/b.jpg", previewUrl: null },
    ]} />);
    expect(screen.getByRole("button", { name: "Preview Not ready" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Playable" }));
    expect(onPreview).toHaveBeenCalledWith({ id: "a", title: "Playable", mediaType: "video/mp4", previewUrl: "/p/a.mp4" }, expect.any(HTMLButtonElement));
  });
});
