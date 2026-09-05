import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "./use-poll";

/** Renders `usePoll` and exposes the `runNow` it returns. */
function Harness({ task, delayMs, enabled = true, immediate = true, onRun }: {
  task: () => Promise<unknown>; delayMs: number; enabled?: boolean; immediate?: boolean;
  onRun?: (run: () => Promise<void>) => void;
}) {
  const run = usePoll(task, delayMs, enabled, immediate);
  onRun?.(run);
  return null;
}

/** A task whose settlement the test controls, so overlap becomes observable. */
function deferredTask() {
  const pending: { resolve: () => void; reject: (cause: unknown) => void }[] = [];
  let started = 0;
  const settle = async (kind: "resolve" | "reject") => {
    const next = pending.pop();
    if (!next) throw new Error("no run in flight");
    if (kind === "resolve") next.resolve(); else next.reject(new Error("engine unreachable"));
    await act(async () => undefined);
  };
  return {
    task: () => {
      started += 1;
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
    },
    get started() { return started; },
    get inFlight() { return pending.length; },
    settleLast: () => settle("resolve"),
    rejectLast: () => settle("reject"),
  };
}

describe("usePoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it("never starts a second run while the previous one is still in flight", async () => {
    const deferred = deferredTask();
    render(<Harness task={deferred.task} delayMs={100} />);
    expect(deferred.started).toBe(1);

    // Ten cadences elapse while the read is still on the wire.
    await advance(1_000);
    expect(deferred.started).toBe(1);
    expect(deferred.inFlight).toBe(1);

    await deferred.settleLast();
    await advance(99);
    expect(deferred.started).toBe(1);
    await advance(2);
    expect(deferred.started).toBe(2);
  });

  it("waits a full delay after settlement rather than on a fixed interval", async () => {
    const deferred = deferredTask();
    render(<Harness task={deferred.task} delayMs={100} />);
    await advance(500);
    await deferred.settleLast();
    await advance(90);
    expect(deferred.started).toBe(1);
    await advance(20);
    expect(deferred.started).toBe(2);
  });

  it("keeps polling after a rejection", async () => {
    const deferred = deferredTask();
    render(<Harness task={deferred.task} delayMs={50} />);
    await deferred.rejectLast();
    await advance(60);
    expect(deferred.started).toBe(2);
  });

  it("pulls the next run in when the cadence shortens, without overlapping", async () => {
    const deferred = deferredTask();
    const view = render(<Harness task={deferred.task} delayMs={10_000} />);
    await deferred.settleLast();
    await advance(100);
    expect(deferred.started).toBe(1);

    // The shorter cadence is measured from the moment it changed, and it must
    // beat the 10s that was already armed.
    view.rerender(<Harness task={deferred.task} delayMs={500} />);
    await advance(450);
    expect(deferred.started).toBe(1);
    await advance(60);
    expect(deferred.started).toBe(2);
    await advance(5_000);
    expect(deferred.started).toBe(2);
    expect(deferred.inFlight).toBe(1);
  });

  it("stops on unmount and leaves no orphaned loop", async () => {
    const deferred = deferredTask();
    const view = render(<Harness task={deferred.task} delayMs={50} />);
    await deferred.settleLast();
    view.unmount();
    await advance(5_000);
    expect(deferred.started).toBe(1);
  });

  it("stops when disabled and resumes when re-enabled", async () => {
    const deferred = deferredTask();
    const view = render(<Harness task={deferred.task} delayMs={50} enabled={false} />);
    await advance(1_000);
    expect(deferred.started).toBe(0);

    view.rerender(<Harness task={deferred.task} delayMs={50} enabled />);
    await advance(1);
    expect(deferred.started).toBe(1);

    view.rerender(<Harness task={deferred.task} delayMs={50} enabled={false} />);
    await deferred.settleLast();
    await advance(5_000);
    expect(deferred.started).toBe(1);
  });

  it("waits one delay before the first run when immediate is false", async () => {
    const deferred = deferredTask();
    render(<Harness task={deferred.task} delayMs={200} immediate={false} />);
    await advance(150);
    expect(deferred.started).toBe(0);
    await advance(60);
    expect(deferred.started).toBe(1);
  });

  it("joins the in-flight read when runNow is called instead of racing it", async () => {
    const deferred = deferredTask();
    let run: (() => Promise<void>) | undefined;
    render(<Harness task={deferred.task} delayMs={1_000} onRun={(value) => { run = value; }} />);
    expect(deferred.started).toBe(1);

    let done = false;
    await act(async () => { void run!().then(() => { done = true; }); });
    expect(deferred.started).toBe(1);
    expect(done).toBe(false);

    await deferred.settleLast();
    expect(done).toBe(true);
  });

  it("runs once through runNow even when polling is disabled for the screen", async () => {
    const deferred = deferredTask();
    let run: (() => Promise<void>) | undefined;
    render(<Harness task={deferred.task} delayMs={1_000} enabled={false} onRun={(value) => { run = value; }} />);
    expect(deferred.started).toBe(0);

    await act(async () => { void run!(); });
    expect(deferred.started).toBe(1);
    await deferred.settleLast();
    await advance(5_000);
    expect(deferred.started).toBe(1);
  });

  it("always uses the latest task closure", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const view = render(<Harness task={first} delayMs={100} />);
    expect(first).toHaveBeenCalledTimes(1);

    view.rerender(<Harness task={second} delayMs={100} />);
    await advance(110);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
