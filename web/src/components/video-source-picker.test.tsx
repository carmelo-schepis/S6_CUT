import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

  it("exposes source choices as accessible tabs with a labelled panel", () => {
    renderPicker();
    const tablist = screen.getByRole("tablist", { name: "Source video type" });
    const localTab = screen.getByRole("tab", { name: "Local file" });
    const urlTab = screen.getByRole("tab", { name: "YouTube" });
    expect(tablist).toContainElement(localTab);
    expect(localTab).toHaveAttribute("aria-selected", "true");
    expect(localTab).toHaveAttribute("tabindex", "0");
    expect(urlTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", localTab.id);
  });

  it("moves focus and selection with the tab arrow keys", () => {
    function Harness() {
      const [mode, setMode] = useState<"file" | "url" | "library">("file");
      return <VideoSourcePicker mode={mode} onModeChange={setMode} file={null} onFile={vi.fn()} url="" onUrl={vi.fn()} children={<p>Library content</p>} />;
    }
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");

    const assertMode = (index: number) => {
      const selected = screen.getByRole("tab", { name: ["Local file", "YouTube", "Library"][index] });
      expect(selected).toHaveAttribute("aria-selected", "true");
      expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toEqual([selected]);
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", selected.id);
      expect(document.getElementById(selected.getAttribute("aria-controls")!)).toBe(screen.getByRole("tabpanel"));

    };
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus(); assertMode(1);
    fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
    expect(tabs[0]).toHaveFocus(); assertMode(0);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[2]).toHaveFocus(); assertMode(2);
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(tabs[0]).toHaveFocus(); assertMode(0);
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(tabs[2]).toHaveFocus(); assertMode(2);
  });

  it("rejects unsupported and multiple dropped files", () => {
    const onFile = renderPicker();
    const zone = screen.getByText("Drop a video here").parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "clip.txt"), new File(["x"], "other.mp4")] } });
    expect(onFile).toHaveBeenCalledWith(null, "Choose one video file at a time.");
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "clip.txt")] } });
    expect(onFile).toHaveBeenCalledWith(null, expect.stringContaining("Unsupported video type"));
  });

  it("shows drop feedback and accepts one supported dropped video", () => {
    const onFile = vi.fn();
    const file = new File(["video bytes"], "sample.MP4", { type: "video/mp4" });
    render(<VideoSourcePicker mode="file" onModeChange={vi.fn()} file={null} onFile={onFile} url="" onUrl={vi.fn()} />);
    const dropZone = screen.getByRole("group", { name: "Local video source" });
    expect(dropZone).toHaveAttribute("aria-describedby");
    expect(document.getElementById(dropZone.getAttribute("aria-describedby")!)).toHaveTextContent("Use Browse files to choose one video, or drop one video here.");
    expect(screen.getByRole("button", { name: "Browse files" })).toBeInTheDocument();
    const dropHint = screen.getByText("Drop a video here");
    fireEvent.dragEnter(dropZone, { dataTransfer: { files: [file] } });
    fireEvent.dragEnter(dropHint, { dataTransfer: { files: [file] } });
    fireEvent.dragLeave(dropZone, { dataTransfer: { files: [file] } });
    expect(dropZone).toHaveClass("drag-active");
    fireEvent.dragLeave(dropHint, { dataTransfer: { files: [file] } });
    expect(dropZone).not.toHaveClass("drag-active");
    fireEvent.dragEnter(dropZone, { dataTransfer: { files: [file] } });
    expect(dropZone).toHaveClass("drag-active");
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(dropZone).not.toHaveClass("drag-active");
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

  it("renders the YouTube example as a placeholder without changing input behavior", () => {
    const onUrl = vi.fn();
    render(<VideoSourcePicker mode="url" onModeChange={vi.fn()} file={null} onFile={vi.fn()} url="" onUrl={onUrl} />);
    const input = screen.getByLabelText("YouTube URL");
    expect(input).toHaveAttribute("placeholder", "https://www.youtube.com/watch?v=...");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "https://www.youtube.com/watch?v=abc123" } });
    expect(onUrl).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    expect(screen.getByText(/DRM and access controls are never bypassed/i)).toBeInTheDocument();
  });
});
