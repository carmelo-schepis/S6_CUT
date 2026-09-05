import { useCallback, useEffect, useRef } from "react";

/**
 * Self-scheduling poll: the next run is queued only once the previous one has
 * settled.
 *
 * The engine runs a single worker, so the old `setInterval` polling made a slow
 * response strictly worse — a 15s `/jobs` read with a 4s interval left three
 * more requests queued behind it, and the queue grew for as long as the engine
 * stayed slow. Waiting for settlement caps each poll at one request in flight.
 *
 * `task` and `delayMs` are read through refs, so a re-render with a new closure
 * or a new cadence never restarts the loop and never resurrects stale state.
 *
 * Returns a `runNow` that performs the poll immediately and restarts the
 * cadence from that run. It shares the single-flight guard, so a manual Retry
 * during a slow read joins the request already on the wire instead of adding a
 * second one behind it.
 */
export function usePoll(task: () => Promise<unknown>, delayMs: number, enabled = true, immediate = true): () => Promise<void> {
  const taskRef = useRef(task);
  // Written from an effect rather than during render: the loop only ever reads
  // it from a timer callback, which always runs after the commit.
  useEffect(() => { taskRef.current = task; }, [task]);
  const delayRef = useRef(delayMs);
  // Set by the running loop so the cadence effect below can pull the next run
  // earlier when work starts and the interval shortens.
  const pullInRef = useRef<(() => void) | null>(null);
  // Set by the running loop so `runNow` reschedules rather than racing it.
  const triggerRef = useRef<(() => Promise<void>) | null>(null);
  /**
   * The one request this poll may have on the wire. Every caller — the loop,
   * a manual refresh, and React's double-invoked mount effect in development —
   * joins this promise instead of issuing a parallel read.
   */
  const inFlightRef = useRef<Promise<void> | null>(null);

  const runOnce = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    const pending: Promise<void> = (async () => { await taskRef.current(); })()
      .finally(() => { if (inFlightRef.current === pending) inFlightRef.current = null; });
    inFlightRef.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    let dueAt = 0;

    const clear = () => {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
    };

    const arm = (ms: number) => {
      clear();
      if (!active) return;
      dueAt = Date.now() + ms;
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      clear();
      if (!active) return;
      try {
        await runOnce();
      } catch {
        // The task reports its own failure to the UI; a rejection must never
        // stop the loop, or a single blip would end polling for the session.
      }
      if (active) arm(delayRef.current);
    };

    pullInRef.current = () => {
      // Only meaningful while asleep: a run in flight already re-arms on settle.
      if (!active || inFlightRef.current || timer === undefined) return;
      if (delayRef.current < dueAt - Date.now()) arm(delayRef.current);
    };
    triggerRef.current = tick;

    if (immediate) void tick();
    else arm(delayRef.current);

    return () => {
      active = false;
      clear();
      pullInRef.current = null;
      if (triggerRef.current === tick) triggerRef.current = null;
    };
  }, [enabled, immediate, runOnce]);

  useEffect(() => {
    delayRef.current = delayMs;
    pullInRef.current?.();
  }, [delayMs]);

  return useCallback(async () => {
    // While a loop owns this poll, go through it so the cadence restarts from
    // this run; otherwise (polling disabled for the current page) still honour
    // the caller with a single guarded read.
    const trigger = triggerRef.current;
    if (trigger) return trigger();
    try { await runOnce(); } catch { /* Reported by the task itself. */ }
  }, [runOnce]);
}
