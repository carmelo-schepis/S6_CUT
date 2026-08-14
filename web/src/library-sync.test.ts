import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundedRevalidation, emitLibraryChanged, onLibraryChanged } from "./library-sync";

describe("bounded library revalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid signals into a single reload", () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const reval = createBoundedRevalidation(load);
    reval.signal();
    reval.signal();
    reval.signal();
    vi.advanceTimersByTime(399);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
    reval.dispose();
  });

  it("never starts a second load while one is already in flight", async () => {
    let releaseLoad: () => void = () => undefined;
    const load = vi.fn(() => new Promise<void>((resolve) => { releaseLoad = resolve; }));
    const reval = createBoundedRevalidation(load);
    reval.signal();
    vi.advanceTimersByTime(400);
    expect(load).toHaveBeenCalledTimes(1);
    // Signal arrives while the first load is still running
    reval.signal();
    vi.advanceTimersByTime(400);
    expect(load).toHaveBeenCalledTimes(1);
    releaseLoad();
    await Promise.resolve();
    // One follow-up reload covers the in-flight signal, nothing more
    vi.advanceTimersByTime(0);
    expect(load).toHaveBeenCalledTimes(2);
    reval.dispose();
  });

  it("dispose cancels any pending reload", () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const reval = createBoundedRevalidation(load);
    reval.signal();
    reval.dispose();
    vi.advanceTimersByTime(1000);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("library-changed event bus", () => {
  it("notifies subscribers and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onLibraryChanged(listener);
    emitLibraryChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    emitLibraryChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
