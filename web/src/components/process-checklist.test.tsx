import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStep } from "../types";
import { ProcessChecklist } from "./process-checklist";

const pending: ProcessingStep = { id: "s1", label: "Source received", status: "pending" };
const active: ProcessingStep = { id: "s2", label: "Clips rendered", status: "active", startedAt: "2026-08-13T00:00:00Z", currentItem: 3, totalItems: 5, detail: "Rendering output 3" };
const complete: ProcessingStep = { id: "s3", label: "Speech transcribed", status: "complete", completedAt: "2026-08-13T00:01:00Z" };
const skipped: ProcessingStep = { id: "s4", label: "AI planning completed", status: "skipped", detail: "No connected provider; used local planning" };
const failed: ProcessingStep = { id: "s5", label: "OpenRouter planning", status: "failed", detail: "Provider request failed [redacted]" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------
describe("ProcessChecklist – structure & semantics", () => {
  it("renders an ordered list with an accessible label", () => {
    render(<ProcessChecklist steps={[pending, complete]} />);
    expect(screen.getByRole("list", { name: "Short creation progress" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("returns null when steps is empty", () => {
    const { container } = render(<ProcessChecklist steps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders steps in API-reported order", () => {
    render(<ProcessChecklist steps={[complete, pending, active]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Speech transcribed");
    expect(items[1]).toHaveTextContent("Source received");
    expect(items[2]).toHaveTextContent("Clips rendered");
  });

  it("includes a step count and semantic heading in the panel", () => {
    render(<ProcessChecklist steps={[pending, active, complete]} />);
    expect(screen.getByRole("heading", { name: "Short creation progress" })).toBeInTheDocument();
    expect(screen.getByText("3 steps")).toBeInTheDocument();
  });

  it("keeps the current step identifiable without changing API order", () => {
    render(<ProcessChecklist steps={[complete, active, pending]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[1]).toHaveTextContent("In progress");
    expect(items[2]).toHaveTextContent("Pending");
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – checkmark only for complete", () => {
  it("shows a check icon only for the complete step", () => {
    render(<ProcessChecklist steps={[pending, active, complete, skipped, failed]} />);
    const items = screen.getAllByRole("listitem");
    // pending
    expect(items[0].querySelector(".lucide-circle")).toBeInTheDocument();
    expect(items[0].querySelector(".lucide-check")).toBeNull();
    // active
    expect(items[1].querySelector(".lucide-loader-circle")).toBeInTheDocument();
    expect(items[1].querySelector(".lucide-check")).toBeNull();
    // complete
    expect(items[2].querySelector(".lucide-check")).toBeInTheDocument();
    // skipped
    expect(items[3].querySelector(".lucide-minus")).toBeInTheDocument();
    expect(items[3].querySelector(".lucide-check")).toBeNull();
    // failed — checks for any icon svg and no checkmark
    expect(items[4].querySelector(".checklist-icon svg")).toBeInTheDocument();
    expect(items[4].querySelector(".lucide-check")).toBeNull();
  });

  it("never infers completion from a full item count when status is still active", () => {
    const fullItems: ProcessingStep = {
      id: "r", label: "Clips rendered", status: "active",
      currentItem: 5, totalItems: 5, startedAt: "2026-08-13T00:00:00Z",
    };
    render(<ProcessChecklist steps={[fullItems]} />);
    const row = screen.getByRole("listitem");
    expect(row.querySelector(".lucide-check")).toBeNull();
    expect(row.querySelector(".lucide-loader-circle")).toBeInTheDocument();
    expect(screen.getByText("5 of 5")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – active elapsed & item progress", () => {
  it("shows X of Y and elapsed derived from startedAt", () => {
    render(<ProcessChecklist steps={[active]} />);
    expect(screen.getByText("3 of 5")).toBeInTheDocument();
    expect(screen.getByText(/Elapsed 0:00/)).toBeInTheDocument();
  });

  it("ticks elapsed time with fake timers when active step has startedAt", () => {
    render(<ProcessChecklist steps={[active]} />);
    expect(screen.getByText(/Elapsed 0:00/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText(/Elapsed 0:05/)).toBeInTheDocument();
  });

  it("does not show elapsed when startedAt is missing", () => {
    const noStart: ProcessingStep = { id: "a", label: "Cut points planned", status: "active" };
    render(<ProcessChecklist steps={[noStart]} />);
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
  });

  it("does not show item progress when totalItems is null", () => {
    const noItems: ProcessingStep = { id: "a", label: "Cut points planned", status: "active", startedAt: "2026-08-13T00:00:00Z" };
    render(<ProcessChecklist steps={[noItems]} />);
    expect(screen.queryByText("of")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – paused state", () => {
  it("labels the active row Paused when jobState is paused", () => {
    render(<ProcessChecklist steps={[active]} jobState="paused" />);
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Clips rendered");
    expect(row).toHaveTextContent("Paused");
    expect(row.querySelector(".lucide-check")).toBeNull();
  });

  it("does not tick elapsed when paused", () => {
    render(<ProcessChecklist steps={[active]} jobState="paused" />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
  });

  it("shows active row status without inference when paused", () => {
    const pausedNoStart: ProcessingStep = { id: "a", label: "Cut points planned", status: "active" };
    render(<ProcessChecklist steps={[pausedNoStart]} jobState="paused" />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("listitem").querySelector(".lucide-loader-circle")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – skipped & failed detail", () => {
  it("shows visible status labels and explanation detail for skipped and failed steps", () => {
    render(<ProcessChecklist steps={[skipped, failed]} />);
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("No connected provider; used local planning")).toBeInTheDocument();
    expect(screen.getByText("Provider request failed [redacted]")).toBeInTheDocument();
  });

  it("shows active detail alongside elapsed", () => {
    render(<ProcessChecklist steps={[active]} />);
    expect(screen.getByText(/Rendering output 3/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – compact mode", () => {
  it("applies the compact class when compact prop is true", () => {
    const { container } = render(<ProcessChecklist steps={[complete, skipped]} compact jobState="complete" />);
    expect(container.querySelector(".checklist-panel")).toHaveClass("compact");
    expect(screen.getByRole("list", { name: "Short creation progress" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – accessibility", () => {
  it("has exactly one aria-live polite region for transitions", () => {
    render(<ProcessChecklist steps={[pending, active]} />);
    const live = document.querySelector(".checklist-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("hides decorative icons from assistive technology", () => {
    const { container } = render(<ProcessChecklist steps={[pending, active, complete, skipped, failed]} />);
    const icons = container.querySelectorAll(".checklist-icon");
    icons.forEach((icon) => expect(icon).toHaveAttribute("aria-hidden", "true"));
  });

  it("does not announce on initial mount", () => {
    render(<ProcessChecklist steps={[pending]} />);
    const live = document.querySelector(".checklist-live");
    expect(live).toHaveTextContent("");
  });

  it("announces a transition to complete in the polite region", () => {
    const { rerender } = render(<ProcessChecklist steps={[pending]} jobState="active" />);
    const live = document.querySelector(".checklist-live")!;
    expect(live.textContent).toBe("");
    rerender(<ProcessChecklist steps={[{ ...pending, status: "complete", completedAt: "2026-08-13T00:00:30Z" }]} jobState="active" />);
    expect(live.textContent).toBe("Source received");
  });

  it("announces item progress on active step change", () => {
    const base: ProcessingStep = { id: "render", label: "Clips rendered", status: "active", currentItem: 2, totalItems: 5, startedAt: "2026-08-13T00:00:00Z" };
    const { rerender } = render(<ProcessChecklist steps={[base]} />);
    const live = document.querySelector(".checklist-live")!;
    expect(live.textContent).toBe("");
    rerender(<ProcessChecklist steps={[{ ...base, currentItem: 3 }]} />);
    expect(live.textContent).toBe("Clips rendered 3 of 5");
  });

  it("announces processing paused and resumed", () => {
    const { rerender } = render(<ProcessChecklist steps={[active]} jobState="active" />);
    const live = document.querySelector(".checklist-live")!;
    expect(live.textContent).toBe("");
    rerender(<ProcessChecklist steps={[active]} jobState="paused" />);
    expect(live.textContent).toBe("Processing paused");
    rerender(<ProcessChecklist steps={[active]} jobState="active" />);
    expect(live.textContent).toBe("Processing resumed");
  });

  it("announces failed and skipped transitions", () => {
    const { rerender } = render(<ProcessChecklist steps={[pending]} jobState="active" />);
    const live = document.querySelector(".checklist-live")!;
    rerender(<ProcessChecklist steps={[{ ...pending, status: "failed", detail: "Provider error" }]} jobState="active" />);
    expect(live.textContent).toBe("Source received failed");
    rerender(<ProcessChecklist steps={[{ ...pending, status: "skipped", detail: "Not needed" }]} jobState="active" />);
    expect(live.textContent).toBe("Source received skipped");
  });
});

// ---------------------------------------------------------------
describe("ProcessChecklist – reduced-motion CSS", () => {
  it("contains the checklist animation override in the reduced-motion stylesheet", async () => {
    // vitest css:true does not expose app styles via document.styleSheets in jsdom,
    // so we read the source CSS file directly to verify the rule exists.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const css = readFileSync(join(process.cwd(), "web", "src", "styles.css"), "utf-8");
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/);
    expect(css).toMatch(/checklist.*animation.*none/);
  });
});