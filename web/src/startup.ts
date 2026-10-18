/** Reveal even when startup fails, so the existing error and Retry stay usable. */
export function revealApp() {
  document.getElementById("startup-screen")?.remove();
  document.getElementById("root")?.removeAttribute("inert");
  document.body.classList.remove("startup-loading");
}

/** Called after initial data settles; retain layout while first-frame media loads. */
export function revealWhenReady(): () => void {
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
  wallpaper.src = "/projects-wallpaper.jpg";
  const logo = document.querySelector<HTMLImageElement>("#startup-screen img");
  const assets = Promise.allSettled([
    decoded(wallpaper),
    ...(logo ? [decoded(logo)] : []),
    document.fonts?.ready,
  ]);

  // IntersectionObserver assigns lazy thumbnail sources after the first layout.
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const media = Array.from(document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("#root img, #root video"))
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
        });
      void Promise.allSettled([
        assets,
        ...media.map((element) => element instanceof HTMLImageElement ? decoded(element) : loaded(element)),
      ]).then(finish);
    });
  });
  return () => { cancelled = true; cleanup(); };
}
