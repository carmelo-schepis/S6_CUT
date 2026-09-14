import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpDialog } from "./help-dialog";

const close = vi.fn();

afterEach(() => { close.mockReset(); vi.restoreAllMocks(); document.body.innerHTML = ""; document.body.style.overflow = ""; });

describe("HelpDialog", () => {
  it("documents the workflow, processing modes, editorial styles, subtitles, layouts, and recovery", () => {
    render(<><button aria-label="Open S6 Cut Help">Help</button><HelpDialog open onClose={close} /></>);
    expect(screen.getByRole("dialog", { name: "S6 Cut Help" })).toBeInTheDocument();
    expect(screen.getByText("S6 Cut guide")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "S6 Cut Help" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Make local, reviewable cuts without losing track of what the engine is doing.")).toBeVisible();
    for (const heading of ["Getting started", "Fast, Auto & Smart", "Editorial modes", "Subtitle styles", "Video layouts", "Troubleshooting"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    for (const mode of ["Fast", "Auto", "Smart", "Funny", "Serious", "Educational", "Hype", "9:16 vertical", "16:9 landscape", "1:1 square", "4:5 portrait"]) {
      expect(screen.getAllByText(mode, { exact: true }).length).toBeGreaterThan(0);
    }
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(4);
    expect(images.every((image) => image.getAttribute("src")?.startsWith("/help/") && image.getAttribute("alt"))).toBe(true);
    const previews = screen.getAllByTestId(/subtitle-preview-/);
    expect(previews).toHaveLength(4);
    for (const name of ["Funny", "Serious", "Educational", "Hype"]) {
      const preview = screen.getByTestId(`subtitle-preview-${name.toLowerCase()}`);
      expect(preview.querySelector("video")?.getAttribute("src")).toBe(`/help/subtitles-${name.toLowerCase()}.mp4`);
    }
  });

  it("moves every subtitle preview from loading to ready on media readiness", () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    render(<HelpDialog open onClose={close} />);

    for (const name of ["Funny", "Serious", "Educational", "Hype"]) {
      const preview = screen.getByTestId(`subtitle-preview-${name.toLowerCase()}`);
      expect(preview).toHaveAttribute("data-preview-state", "loading");
      fireEvent(preview.querySelector("video")!, new Event("loadeddata"));
      expect(preview).toHaveAttribute("data-preview-state", "ready");
      expect(preview).toHaveAttribute("aria-busy", "false");
      expect(screen.queryByText(`Loading ${name} preview…`)).not.toBeInTheDocument();
    }
  });

  it("shows a retryable fallback after a failed preview request", () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    render(<HelpDialog open onClose={close} />);
    const preview = screen.getByTestId("subtitle-preview-funny");
    fireEvent.error(preview.querySelector("video")!);
    expect(preview).toHaveAttribute("data-preview-state", "error");
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load this preview.");

    fireEvent.click(screen.getByRole("button", { name: "Retry Funny preview" }));
    expect(screen.getByTestId("subtitle-preview-funny")).toHaveAttribute("data-preview-state", "loading");
    fireEvent(preview.querySelector("video")!, new Event("canplay"));
    expect(screen.getByTestId("subtitle-preview-funny")).toHaveAttribute("data-preview-state", "ready");
  });

  it("removes media listeners when a loading preview unmounts", () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const removeListener = vi.spyOn(HTMLMediaElement.prototype, "removeEventListener");
    const { unmount } = render(<HelpDialog open onClose={close} />);
    unmount();
    expect(removeListener.mock.calls.some(([type]) => type === "loadeddata")).toBe(true);
    expect(removeListener.mock.calls.some(([type]) => type === "canplay")).toBe(true);
    expect(removeListener.mock.calls.some(([type]) => type === "error")).toBe(true);
  });

  it("focuses the close control, traps Tab, closes on Escape, and restores opener focus", () => {
    const opener = document.createElement("button");
    opener.setAttribute("aria-label", "Open S6 Cut Help");
    document.body.append(opener);
    opener.focus();
    const { rerender } = render(<HelpDialog open onClose={close} />);
    expect(screen.getByRole("button", { name: "Close S6 Cut Help" })).toHaveFocus();
    const focusables = screen.getByRole("dialog").querySelectorAll<HTMLElement>("button, a[href]");
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close S6 Cut Help" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    rerender(<HelpDialog open={false} onClose={close} />);
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });
});
