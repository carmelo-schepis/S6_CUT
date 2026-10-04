import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no layout viewport. Cards use IntersectionObserver in production
// to avoid loading distant media; unit tests intentionally treat them as near.
class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [];
}
window.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;

// jsdom does not implement browser media playback or layout scrolling. Keep
// those APIs deterministic in component tests instead of emitting virtual-console
// "Not implemented" noise; tests that need playback behavior can still spy on them.
Object.defineProperties(HTMLMediaElement.prototype, {
  play: { configurable: true, writable: true, value: () => Promise.resolve() },
  pause: { configurable: true, writable: true, value: () => undefined },
  load: { configurable: true, writable: true, value: () => undefined },
});
Object.defineProperty(window, "scrollTo", {
  configurable: true,
  writable: true,
  value: () => undefined,
});
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value: () => undefined,
});

afterEach(cleanup);
