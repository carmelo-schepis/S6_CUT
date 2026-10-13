import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TitleSuggestionResponse } from "../types";
import { SeoTitleReviewDialog } from "./seo-title-review";

const result: TitleSuggestionResponse = {
  suggestions: [
    { kind: "clip", assetId: "a1", projectId: null, currentTitle: "YouTube import — Next restaurant · Cut 05", suggestedTitle: "We Got Lucky at the Next Restaurant", suggestedDescription: "A lucky find.", revision: 3 },
    { kind: "source", assetId: "a2", projectId: null, currentTitle: "next-restaurant.mp4", suggestedTitle: "Next Restaurant Full Visit", suggestedDescription: "", revision: null },
    { kind: "project", assetId: null, projectId: "p1", currentTitle: "YouTube import — Next restaurant", suggestedTitle: "Next restaurant visit", suggestedDescription: "", revision: null },
  ],
  skipped: [{ assetId: "a3", projectId: null, title: "Hand-written title", reason: "Title was edited by you" }],
  costUsd: 0.00123, costKind: "actual", model: "google/gemini-2.5-flash-lite", requests: 1, aiAvailable: true, warning: null,
};

function renderDialog(overrides: Partial<TitleSuggestionResponse> = {}) {
  const onApply = vi.fn(); const onCancel = vi.fn();
  render(<SeoTitleReviewDialog result={{ ...result, ...overrides }} applying={false} error={null} onApply={onApply} onCancel={onCancel} />);
  return { onApply, onCancel, dialog: screen.getByTestId("seo-title-review") };
}

describe("SeoTitleReviewDialog", () => {
  it("renders an accessible dialog with one ticked row per suggestion", () => {
    const { dialog } = renderDialog();
    expect(screen.getByRole("dialog", { name: "Review SEO titles" })).toBe(dialog);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const rows = screen.getAllByTestId("seo-title-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-asset-id", "a1");
    expect(rows[2]).toHaveAttribute("data-project-id", "p1");
    expect(within(rows[0]).getByText("Clip")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Source")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Project")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Current")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `Apply title for ${result.suggestions[0].currentTitle}` })).toBeChecked();
    const clipTitle = screen.getByRole("textbox", { name: `New title for ${result.suggestions[0].currentTitle}` });
    expect(clipTitle).toHaveValue("We Got Lucky at the Next Restaurant");
    expect(clipTitle).toHaveAttribute("maxLength", "100");
    expect(within(rows[2]).getByRole("textbox", { name: /New title for/ })).toHaveAttribute("maxLength", "160");
    expect(within(rows[0]).getByText("35/70")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("textbox", { name: /New description for/ })).toHaveAttribute("maxLength", "500");
    expect(within(rows[2]).queryByText("Description")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: `Apply title for ${result.suggestions[0].currentTitle}` }));
    expect(screen.getByText("Cost: $0.0012 (actual) · google/gemini-2.5-flash-lite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply selected (3)" })).toBeEnabled();
  });

  it("applies only ticked rows, marks inline edits, and keeps revisions and kinds", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: `Apply title for ${result.suggestions[1].currentTitle}` }));
    const title = screen.getByRole("textbox", { name: `New title for ${result.suggestions[0].currentTitle}` });
    fireEvent.change(title, { target: { value: "x".repeat(72) } });
    expect(screen.getByText("72/70")).toHaveClass("over");
    fireEvent.change(title, { target: { value: "  Lucky Night at Next  " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply selected (2)" }));
    expect(onApply).toHaveBeenCalledWith([
      { kind: "clip", assetId: "a1", projectId: null, currentTitle: result.suggestions[0].currentTitle, title: "Lucky Night at Next", description: "A lucky find.", revision: 3, edited: true },
      { kind: "project", assetId: null, projectId: "p1", currentTitle: result.suggestions[2].currentTitle, title: "Next restaurant visit", description: "", revision: null, edited: false },
    ]);
  });

  it("marks a description edit and blocks apply when a ticked title is blank or nothing is ticked", () => {
    const { onApply } = renderDialog({ suggestions: result.suggestions.slice(0, 1) });
    fireEvent.change(screen.getByRole("textbox", { name: /New description for/ }), { target: { value: "Changed" } });
    const title = screen.getByRole("textbox", { name: /New title for/ });
    fireEvent.change(title, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Apply selected (1)" })).toBeDisabled();
    fireEvent.change(title, { target: { value: "Restored" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply selected (1)" }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ title: "Restored", description: "Changed", edited: true })]);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Apply selected (0)" })).toBeDisabled();
  });

  it("lists skipped titles with reasons and closes on Escape or Cancel", () => {
    const { onCancel } = renderDialog();
    const skipped = screen.getByTestId("seo-title-skipped");
    expect(skipped).toHaveTextContent("Hand-written title");
    expect(skipped).toHaveTextContent("Title was edited by you");
    fireEvent.keyDown(screen.getByTestId("seo-title-review"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("explains rule-only results when AI is unavailable and hides the cost line without requests", () => {
    renderDialog({ aiAvailable: false, requests: 0, warning: "OpenRouter rate limited; try later.", suggestions: result.suggestions.slice(2) });
    expect(screen.getByText("Connect an OpenRouter profile in Settings to write AI titles; only rule-based project renames are shown.")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter rate limited; try later.")).toBeInTheDocument();
    expect(screen.queryByText(/^Cost:/)).not.toBeInTheDocument();
  });

  it("shows the empty state when nothing needs a new title", () => {
    renderDialog({ suggestions: [], skipped: [] });
    expect(screen.getByText("Nothing to retitle — every selected item already has a reviewed title.")).toBeInTheDocument();
    expect(screen.queryByTestId("seo-title-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("seo-title-skipped")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply selected (0)" })).toBeDisabled();
  });
});
