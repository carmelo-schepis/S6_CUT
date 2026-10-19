import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPLASH_MIN_VISIBLE_MS, SPLASH_NOTICEABLE_MS, revealApp, splashVisibleFor } from "./startup";

// The splash enters after a grace period, so whether it is "visible" is read from its own animation.
function fakeAnimation(elapsed: number, delay = 800) {
  return { animationName: "startup-appear", effect: { getComputedTiming: () => ({ delay }) }, timeline: { currentTime: elapsed }, startTime: 0, currentTime: elapsed };
}

function mount(visibleForMs: number | null, delay = 800) {
  document.body.className = "startup-loading";
  document.body.innerHTML = '<div id="startup-screen"></div><div id="root" inert></div>';
  const screen = document.getElementById("startup-screen")!;
  const animations = visibleForMs === null ? [fakeAnimation(delay - 100, delay)] : [fakeAnimation(delay + visibleForMs, delay)];
  screen.getAnimations = (() => animations) as unknown as typeof screen.getAnimations;
  const fade = { finished: Promise.resolve() };
  screen.animate = vi.fn(() => fade) as unknown as typeof screen.animate;
  return screen;
}

describe("startup splash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { vi.useRealTimers(); document.body.className = ""; document.body.innerHTML = ""; });

  it("reports null while the grace period has not elapsed, and the time on screen after it", () => {
    expect(splashVisibleFor(mount(null))).toBeNull();
    expect(splashVisibleFor(mount(120))).toBe(120);
  });

  it("never shows the splash for a quick load: the app is released at once and fades in", () => {
    const screen = mount(null);
    revealApp();
    expect(screen.isConnected).toBe(false);
    expect(document.getElementById("root")).not.toHaveAttribute("inert");
    expect(document.body.classList.contains("startup-quick")).toBe(true);
    // The loading state ends at once: it is what holds the wallpaper's transition off.
    expect(document.body.classList.contains("startup-loading")).toBe(false);
    expect(screen.animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(document.body.className).toBe("");
  });

  it("discards a splash that has barely begun to appear, as if the load had been quick", () => {
    const screen = mount(SPLASH_NOTICEABLE_MS - 10);
    revealApp();
    expect(screen.isConnected).toBe(false);
    expect(document.body.classList.contains("startup-quick")).toBe(true);
    expect(screen.animate).not.toHaveBeenCalled();
  });

  it("holds a splash that has only just appeared, then fades it out", async () => {
    const screen = mount(100);
    revealApp();
    // Still covering the app: it has been visible for 100ms of the 350ms minimum.
    expect(screen.isConnected).toBe(true);
    expect(document.getElementById("root")).toHaveAttribute("inert");
    expect(screen.animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS - 100);
    expect(screen.animate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.isConnected).toBe(false);
    expect(document.getElementById("root")).not.toHaveAttribute("inert");
  });

  it("fades out at once when the splash has been visible long enough", async () => {
    const screen = mount(2_000);
    revealApp();
    expect(screen.animate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.isConnected).toBe(false);
  });

  it("ignores a second reveal while one is pending or running", () => {
    const screen = mount(100);
    revealApp();
    revealApp();
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS);
    expect(screen.animate).toHaveBeenCalledTimes(1);
  });

  it("skips the fade under reduced motion but still waits out the minimum", () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query })) as unknown as typeof window.matchMedia;
    const screen = mount(100);
    revealApp();
    expect(screen.isConnected).toBe(true);
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS);
    expect(screen.isConnected).toBe(false);
    expect(screen.animate).not.toHaveBeenCalled();
  });
});
