/** A splash that has noticeably appeared is held at least this long, so it never flashes past. */
export const SPLASH_MIN_VISIBLE_MS = 250;
/** One that has barely begun to fade in (not yet clearly visible) is discarded instead: load finished right at the boundary. */
export const SPLASH_NOTICEABLE_MS = 40;

/**
 * How long the splash has been on screen, or null while it has not appeared yet.
 * The splash enters after a grace period (the delay on its own CSS animation), so
 * null is how a quick load, which never needed it, is told apart from a slow one.
 * The delay is read from the animation rather than repeated here.
 */
export function splashVisibleFor(screen: HTMLElement): number | null {
  const animation = typeof screen.getAnimations === "function"
    ? screen.getAnimations().find((item) => (item as CSSAnimation).animationName === "startup-appear")
    : undefined;
  if (animation) {
    const delay = Number(animation.effect?.getComputedTiming().delay ?? 0);
    const now = animation.timeline?.currentTime;
    const elapsed = animation.startTime != null && now != null ? Number(now) - Number(animation.startTime) : Number(animation.currentTime ?? 0);
    return elapsed > delay ? elapsed - delay : null;
  }
  // No Web Animations: judge by what is painted.
  return Number.parseFloat(getComputedStyle(screen).opacity) > 0.02 ? SPLASH_MIN_VISIBLE_MS : null;
}

/** Consecutive frames with no new visible media before the page is considered settled enough to reveal. */
const QUIET_FRAMES_BEFORE_REVEAL = 3;

let revealScheduled = false;

/**
 * Reveal even when startup fails, so the existing error and Retry stay usable.
 *
 * A normal load never showed the splash (it appears only after a grace period), so
 * the app is released at once and fades in. A slow load fades the splash out,
 * after it has been on screen long enough to read.
 */
export function revealApp() {
  const screen = document.getElementById("startup-screen");
  if (document.body.classList.contains("startup-revealing") || revealScheduled) return;
  const root = document.getElementById("root");
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = () => {
    screen?.remove();
    root?.removeAttribute("inert");
    document.body.classList.remove("startup-loading", "startup-revealing", "startup-quick");
  };

  const visibleFor = screen ? splashVisibleFor(screen) : null;
  if (!screen || visibleFor === null || visibleFor < SPLASH_NOTICEABLE_MS) {
    // Leave the loading state at once (it also holds the wallpaper's transition off); the app
    // fades in under .startup-quick, and that class is dropped once the fade is done.
    root?.removeAttribute("inert");
    screen?.remove();
    document.body.classList.add("startup-revealing", "startup-quick");
    document.body.classList.remove("startup-loading");
    window.setTimeout(finish, reducedMotion ? 0 : 300);
    return;
  }

  const leave = () => {
    if (reducedMotion) {
      finish();
      return;
    }
    document.body.classList.add("startup-revealing");
    // A bounded fallback also releases keyboard access if animation completion stalls.
    const timeout = window.setTimeout(finish, 600);
    try {
      const fade = screen.animate([{ opacity: getComputedStyle(screen).opacity }, { opacity: 0 }], {
        duration: 360, easing: "ease-in-out", fill: "forwards",
      });
      void fade.finished.catch(() => undefined).then(() => {
        window.clearTimeout(timeout);
        finish();
      });
    } catch {
      window.clearTimeout(timeout);
      finish();
    }
  };

  const hold = SPLASH_MIN_VISIBLE_MS - visibleFor;
  if (hold > 0) {
    revealScheduled = true;
    window.setTimeout(() => { revealScheduled = false; leave(); }, hold);
    return;
  }
  leave();
}

/** Called after initial data settles; retain layout while first-frame media loads. */
export function revealWhenReady(wallpaperSrc = "/projects-wallpaper.jpg"): () => void {
  if (!document.getElementById("startup-screen")) return () => undefined;
  let cancelled = false;
  let finished = false;
  let frame = 0;
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(frame);
    cleanups.splice(0).forEach((dispose) => dispose());
  };
  const finish = () => {
    if (cancelled || finished) return;
    finished = true;
    cleanup();
    frame = window.requestAnimationFrame(() => {
      if (!cancelled) revealApp();
    });
  };
  const timeout = window.setTimeout(finish, 10_000);

  const loaded = (element: HTMLImageElement | HTMLVideoElement) => new Promise<void>((resolve) => {
    const image = element instanceof HTMLImageElement;
    if (image ? element.complete : element.readyState >= 2 || element.error || !(element.currentSrc || element.getAttribute("src"))) {
      resolve();
      return;
    }
    const originalPreload = element.getAttribute("preload");
    let disposed = false;
    const event = image ? "load" : "loadeddata";
    const done = () => { dispose(); resolve(); };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      element.removeEventListener(event, done);
      element.removeEventListener("error", done);
      if (!image) {
        if (originalPreload === null) element.removeAttribute("preload");
        else element.setAttribute("preload", originalPreload);
      }
    };
    element.addEventListener(event, done, { once: true });
    element.addEventListener("error", done, { once: true });
    cleanups.push(dispose);
    // Metadata-only thumbnails need permission to fetch their first frame.
    if (!image) element.preload = "auto";
  });
  const decoded = async (image: HTMLImageElement) => {
    await loaded(image);
    if (!cancelled && !finished && typeof image.decode === "function") await image.decode().catch(() => undefined);
  };
  const wallpaper = new Image();
  wallpaper.src = wallpaperSrc;
  const logo = document.querySelector<HTMLImageElement>("#startup-screen img");
  const assets = Promise.allSettled([
    decoded(wallpaper),
    ...(logo ? [decoded(logo)] : []),
    document.fonts?.ready,
  ]);

  // Lazy thumbnails get their media only after an IntersectionObserver callback, which can land a few
  // frames after the page first renders. A single scan can therefore run before the media it should wait
  // for exists, and reveal the page ahead of its first frames. Keep scanning until a few consecutive frames
  // bring nothing new, then wait for everything seen.
  const visibleMedia = () => Array.from(document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("#root img, #root video"))
    .filter((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
    });
  const seen = new Set<Element>();
  const waiting: Promise<unknown>[] = [assets];
  let quietFrames = 0;
  const scan = () => {
    if (cancelled) return;
    const fresh = visibleMedia().filter((element) => !seen.has(element));
    for (const element of fresh) {
      seen.add(element);
      waiting.push(element instanceof HTMLImageElement ? decoded(element) : loaded(element));
    }
    quietFrames = fresh.length ? 0 : quietFrames + 1;
    if (quietFrames >= QUIET_FRAMES_BEFORE_REVEAL) {
      void Promise.allSettled(waiting).then(finish);
      return;
    }
    frame = window.requestAnimationFrame(scan);
  };
  frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(scan); });
  return () => { cancelled = true; cleanup(); };
}
