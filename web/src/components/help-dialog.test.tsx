import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpDialog } from "./help-dialog";

const close = vi.fn();

afterEach(() => { close.mockReset(); document.body.innerHTML = ""; document.body.style.overflow = ""; });

describe("HelpDialog", () => {
  it("documents the workflow, processing modes, editorial styles, subtitles, layouts, and recovery", () => {
    render(<><button aria-label="Open S6 Cut Help">Help</button><HelpDialog open onClose={close} /></>);
    expect(screen.getByRole("dialog", { name: "S6 Cut Help" })).toBeInTheDocument();
    for (const heading of ["Getting started", "Fast, Auto & Smart", "Editorial modes", "Subtitle styles", "Video layouts", "Troubleshooting"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    for (const mode of ["Fast", "Auto", "Smart", "Funny", "Serious", "Educational", "Hype", "9:16 vertical", "16:9 landscape", "1:1 square", "4:5 portrait"]) {
      expect(screen.getAllByText(mode, { exact: true }).length).toBeGreaterThan(0);
    }
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(8);
    expect(images.every((image) => image.getAttribute("src")?.startsWith("/help/") && image.getAttribute("alt"))).toBe(true);
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
