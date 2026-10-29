// DO-NOT-CHANGE: see DO-NOT-CHANGE/INVARIANTS.md
// debounce semantics keep Library <-> Workspace consistent; keep the bounded revalidation

/**
 * Cross-view Media Library invalidation.
 *
 * The workspace and the Library are separate screens in the same SPA (and can
 * be open in separate tabs). Instead of optimistic writes that could disagree
 * with the engine, views signal "library data changed" and the Library screen
 * performs a bounded server revalidation: signals are collapsed by a short
 * debounce and a load already in flight is never duplicated. This keeps the
 * Clip Board and Library consistent without a manual hard refresh while
 * avoiding request storms on focus storms or rapid publication events.
 */

export const LIBRARY_REVALIDATE_DEBOUNCE_MS = 400;
export const LIBRARY_REVISION_KEY = "s6-cut.library-revision";

type Listener = () => void;

const listeners = new Set<Listener>();

/** Signal that server-confirmed Library data changed (publication, move, …). */
export function emitLibraryChanged(): void {
  for (const listener of listeners) listener();
  try { localStorage.setItem(LIBRARY_REVISION_KEY, `${Date.now()}-${Math.random()}`); } catch { /* local event still updates this tab */ }
}

/** Subscribe to library-change signals. Returns an unsubscribe function. */
export function onLibraryChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Bounded revalidation scheduler. `signal` collapses rapid calls (publication
 * events, focus/visibility bursts) into a single server reload after a short
 * quiet period. A load already in flight is never duplicated.
 */
export function createBoundedRevalidation(load: () => void | Promise<void>) {
  let timer: number | null = null;
  let running = false;
  let pendingAfterFlight = false;

  const run = () => {
    timer = null;
    if (running) {
      // A signal arrived while a load is in flight: schedule exactly one
      // follow-up reload once the current load settles.
      pendingAfterFlight = true;
      return;
    }
    running = true;
    pendingAfterFlight = false;
    Promise.resolve(load()).finally(() => {
      running = false;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        window.setTimeout(run, 0);
      }
    });
  };

  return {
    signal() {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(run, LIBRARY_REVALIDATE_DEBOUNCE_MS);
    },
    dispose() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pendingAfterFlight = false;
    },
  };
}

/** Hook-friendly helper: window focus + visibility for bounded revalidation. */
export function bindRevalidationOnFocus(signal: () => void): () => void {
  const onFocus = () => signal();
  const onVisibility = () => {
    if (document.visibilityState === "visible") signal();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LIBRARY_REVISION_KEY) signal();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("storage", onStorage);
  };
}
