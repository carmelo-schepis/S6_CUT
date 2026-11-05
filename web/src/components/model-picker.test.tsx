import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { OpenRouterModel } from "../types";
import { ModelPicker } from "./model-picker";

vi.mock("../api", () => ({
  readableError: (cause: unknown) => (cause instanceof Error ? cause.message : "Something went wrong. Try again."),
}));

const alpha: OpenRouterModel = { id: "a/alpha", name: "Alpha" };
const beta: OpenRouterModel = { id: "b/beta", name: "Beta" };

type Props = Partial<Parameters<typeof ModelPicker>[0]> & { onChangeSpy?: (value: string) => void; initial?: string };

function Harness({ scan, onChangeSpy = () => undefined, initial = "", ...rest }: Props & { scan: (signal: AbortSignal) => Promise<OpenRouterModel[]> }) {
  const [value, setValue] = useState(initial);
  return <ModelPicker id="model" label="Model name" hint="Scanned on open." value={value} emptyMessage="No models here."
    onChange={(next) => { setValue(next); onChangeSpy(next); }} scan={scan} {...rest} />;
}

/** A scan the test resolves by hand, so loading and stale-result states can be shown. */
function deferredScan() {
  const calls: { signal: AbortSignal; resolve: (models: OpenRouterModel[]) => void; reject: (cause: unknown) => void }[] = [];
  const scan = vi.fn((signal: AbortSignal) => new Promise<OpenRouterModel[]>((resolve, reject) => { calls.push({ signal, resolve, reject }); }));
  return { scan, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("ModelPicker", () => {
  it("shows no list until the scan resolves, then the fresh list and a count", async () => {
    const { scan, calls } = deferredScan();
    render(<Harness scan={scan} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(screen.getByRole("status")).toHaveTextContent("Scanning models…");
    expect(screen.queryByRole("option")).toBeNull();
    calls[0].resolve([alpha, beta]);
    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 models found");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("scans again on every open and never shows the previous list while rescanning", async () => {
    const { scan, calls } = deferredScan();
    render(<Harness scan={scan} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    fireEvent.click(input);
    calls[0].resolve([alpha]);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(input);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("option")).toBeNull();
    calls[1].resolve([beta]);
    expect(await screen.findByRole("option", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
  });

  it("aborts the scan when closed and ignores its late answer", async () => {
    const { scan, calls } = deferredScan();
    render(<Harness scan={scan} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve([alpha]);
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters on typing without asking the provider again", async () => {
    const { scan, calls } = deferredScan();
    render(<Harness scan={scan} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    fireEvent.click(input);
    calls[0].resolve([alpha, beta]);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.change(input, { target: { value: "beta" } });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("No models match your search.");
  });

  it("picking a model only changes the value; it does not scan or save again", async () => {
    const scan = vi.fn(async () => [alpha, beta]);
    const onChangeSpy = vi.fn();
    render(<Harness scan={scan} onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));
    expect(onChangeSpy).toHaveBeenCalledWith("b/beta");
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports the keyboard: ArrowDown opens and moves, Enter picks, Escape closes without picking", async () => {
    const scan = vi.fn(async () => [alpha, beta]);
    const onChangeSpy = vi.fn();
    render(<Harness scan={scan} onChangeSpy={onChangeSpy} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(scan).toHaveBeenCalledTimes(1);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-1");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChangeSpy).toHaveBeenCalledWith("a/alpha");
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab and when focus leaves the picker", async () => {
    const scan = vi.fn(async () => [alpha]);
    render(<Harness scan={scan} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open or scan while disabled, and does not scan when blocked", () => {
    const scan = vi.fn(async () => [alpha]);
    const { rerender } = render(<Harness scan={scan} disabled />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(scan).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Harness scan={scan} scanBlocked="Add your endpoint to scan its models." />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(scan).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Add your endpoint to scan its models.");
  });

  it("shows the empty message when the provider lists nothing, and keeps the auto option selectable", async () => {
    render(<Harness scan={vi.fn(async () => [])} autoOption="Auto-detect smallest model" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No models here.");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Auto-detect smallest model/ })).toBeInTheDocument();
  });

  it("an auto option sets the field to blank", async () => {
    const onChangeSpy = vi.fn();
    render(<Harness scan={vi.fn(async () => [alpha])} autoOption="Auto-detect smallest model" initial="a/alpha" onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    fireEvent.click(await screen.findByRole("option", { name: /Auto-detect smallest model/ }));
    expect(onChangeSpy).toHaveBeenCalledWith("");
  });

  it("shows the error in the popup with Try again, keeps the typed value, and rescans on retry", async () => {
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error("Ollama is offline. Check the endpoint."))
      .mockResolvedValueOnce([alpha]);
    render(<Harness scan={scan} initial="typed/value" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ollama is offline. Check the endpoint.");
    expect(screen.getByRole("combobox", { name: "Model name" })).toHaveValue("typed/value");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("tells the user when the saved model is missing from the latest scan", async () => {
    render(<Harness scan={vi.fn(async () => [alpha])} savedValue="gone/model" initial="gone/model" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model name" }));
    expect(await screen.findByText("Not found in the latest scan.")).toBeInTheDocument();
  });

  it("is named by its label and described by its hint, with no popup name pollution", () => {
    render(<Harness scan={vi.fn(async () => [alpha])} />);
    const input = screen.getByRole("combobox", { name: "Model name" });
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(within(input.parentElement as HTMLElement).queryByRole("listbox")).toBeNull();
    expect(input).toHaveAccessibleDescription("Scanned on open.");
  });
});
