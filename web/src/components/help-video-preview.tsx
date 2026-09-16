import { useEffect, useRef, useState } from "react";

export function HelpVideoPreview({ name, src }: { name: string; src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const player = video.current;
    if (!player) return;

    const ready = () => {
      if (!active) return;
      setState("ready");
      try {
        const playback = player.play();
        if (playback) void playback.catch(() => undefined);
      } catch {
        // Controls remain available when autoplay is blocked by the browser.
      }
    };
    const failed = () => {
      if (active) setState("error");
    };

    player.addEventListener("loadeddata", ready);
    player.addEventListener("canplay", ready);
    player.addEventListener("error", failed);
    if (player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready();
    try { player.load(); } catch { failed(); }

    return () => {
      active = false;
      player.removeEventListener("loadeddata", ready);
      player.removeEventListener("canplay", ready);
      player.removeEventListener("error", failed);
      player.pause();
    };
  }, [src, attempt]);

  const retry = () => {
    setState("loading");
    setAttempt((value) => value + 1);
  };

  return <div className="help-video-preview" data-testid={`subtitle-preview-${name.toLowerCase()}`} data-preview-state={state} aria-busy={state === "loading"}>
    <video
      key={`${src}-${attempt}`}
      ref={video}
      src={src}
      muted
      loop
      playsInline
      controls
      preload="metadata"
      aria-label={`${name} subtitle style preview`}
    />
    {state === "loading" && <div className="help-video-status" role="status">Loading {name} preview…</div>}
    {state === "error" && <div className="help-video-error" role="alert"><span>Unable to load this preview.</span><button type="button" onClick={retry} aria-label={`Retry ${name} preview`}>Retry</button></div>}
  </div>;
}
