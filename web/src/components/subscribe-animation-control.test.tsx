import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSCRIBE_ANIMATION } from "../types";
import { SubscribeAnimationControl } from "./subscribe-animation-control";

describe("SubscribeAnimationControl", () => {
  it("defaults enabled with a five-second lead", () => {
    render(<SubscribeAnimationControl value={DEFAULT_SUBSCRIBE_ANIMATION} onChange={vi.fn()} longForm />);
    expect(screen.getByRole("checkbox", { name: "Enable Subscribe animation" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Subscribe animation timing" })).toHaveValue("5");
    expect(screen.getByRole("combobox", { name: "Subscribe animation timing" })).toBeDisabled();
    expect(screen.getByText(/midpoint and again starting 30 seconds before the end/)).toBeInTheDocument();
  });

  it("reports enabled toggles and the selected 10-second timing", () => {
    const onChange = vi.fn();
    render(<SubscribeAnimationControl value={DEFAULT_SUBSCRIBE_ANIMATION} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Subscribe animation" }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SUBSCRIBE_ANIMATION, enabled: false });
    fireEvent.change(screen.getByRole("combobox", { name: "Subscribe animation timing" }), { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBSCRIBE_ANIMATION, shortFormLeadSeconds: 10 });
  });
});
