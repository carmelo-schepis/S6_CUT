import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OptionRow } from "./option-row";

function Harness({ onToggle = vi.fn(), open }: { onToggle?: () => void; open: boolean }) {
  return <OptionRow id="subtitle" title="Subtitle style" summary="Word pop" open={open} onToggle={onToggle}>
    <button type="button">Inner control</button>
  </OptionRow>;
}

describe("OptionRow", () => {
  it("names the toggle by its title and describes it by its current value", () => {
    render(<Harness open={false} />);
    const toggle = screen.getByRole("button", { name: "Subtitle style" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleDescription("Word pop");
  });

  it("keeps its controls hidden while closed and reachable once open", () => {
    const { rerender } = render(<Harness open={false} />);
    expect(screen.queryByRole("button", { name: "Inner control" })).not.toBeInTheDocument();
    rerender(<Harness open />);
    expect(screen.getByRole("button", { name: "Inner control" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Subtitle style" })).toHaveAttribute("aria-expanded", "true");
  });

  it("reports each click so the parent owns the open state", () => {
    const onToggle = vi.fn();
    render(<Harness open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Subtitle style" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
