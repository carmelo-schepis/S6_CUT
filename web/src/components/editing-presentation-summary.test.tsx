import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditingPresentationSummary } from "./speech-style-controls";

describe("EditingPresentationSummary", () => {
  it("shows the saved speech choices read-only and resolves omitted ones to the existing behaviour", () => {
    render(<EditingPresentationSummary presentation={{ version: 1, captionPreset: "active_word_box", videoFilter: "vintage" }} />);
    const summary = screen.getByLabelText("Editing style");
    expect(summary).toHaveTextContent("Read-only");
    for (const [term, value] of [["Subtitle style", "Active word box"], ["Video filter", "Vintage"], ["Heading appearance", "Plain"], ["Emoji reactions", "Existing behaviour"]]) {
      expect(screen.getByText(term, { selector: "dt" }).nextElementSibling).toHaveTextContent(value);
    }
    expect(summary.querySelector("button, input, select")).toBeNull();
  });

  it("shows only the picture filter for Music", () => {
    render(<EditingPresentationSummary music presentation={{ version: 1, videoFilter: "black_white", captionPreset: "word_pop" }} />);
    expect(screen.getByText("Video filter", { selector: "dt" }).nextElementSibling).toHaveTextContent("Black & white");
    expect(screen.queryByText("Subtitle style")).toBeNull();
    expect(screen.queryByText("Emoji reactions")).toBeNull();
  });
});
