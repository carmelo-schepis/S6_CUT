import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoSourcePicker } from "./video-source-picker";

describe("VideoSourcePicker", () => {
  const renderPicker = () => {
    const onFile = vi.fn();
    render(<VideoSourcePicker mode="file" onModeChange={vi.fn()} file={null} onFile={onFile} url="" onUrl={vi.fn()} />);
    return onFile;
  };
  it("accepts a valid file from the accessible input", () => {
    const onFile = renderPicker();
    fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] } });
    expect(onFile).toHaveBeenCalledWith(expect.any(File));
  });
  it("rejects unsupported and multiple dropped files", () => {
    const onFile = renderPicker();
    const zone = screen.getByText("Drop a video here").parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "clip.txt"), new File(["x"], "other.mp4")] } });
    expect(onFile).toHaveBeenCalledWith(null, "Choose one video file at a time.");
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "clip.txt")] } });
    expect(onFile).toHaveBeenCalledWith(null, expect.stringContaining("Unsupported video type"));
  });
  it("supports Choose another and Remove", () => {
    const onFile = vi.fn();
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    const { rerender } = render(<VideoSourcePicker mode="file" onModeChange={vi.fn()} file={file} onFile={onFile} url="" onUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
    expect(onFile).not.toHaveBeenCalled();
    rerender(<VideoSourcePicker mode="file" onModeChange={vi.fn()} file={file} onFile={onFile} url="" onUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onFile).toHaveBeenCalledWith(null);
  });
  it("renders YouTube wording and keyboard-focusable source area", () => {
    const onModeChange = vi.fn();
    render(<VideoSourcePicker mode="url" onModeChange={onModeChange} file={null} onFile={vi.fn()} url="" onUrl={vi.fn()} />);
    expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument();
    expect(screen.getByText(/DRM and access controls are never bypassed/i)).toBeInTheDocument();
  });
});
