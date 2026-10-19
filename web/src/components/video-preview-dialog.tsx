import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LibraryAsset } from "../types";

export type PreviewableAsset = Pick<LibraryAsset, "id" | "title" | "mediaType" | "previewUrl">;

export function VideoPreviewDialog({ asset, opener, onClose, onMediaError, children }: { asset: PreviewableAsset; opener: HTMLButtonElement | null; onClose: () => void; onMediaError?: () => void; children?: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The teardown below pauses and rewinds the preview, so it must run only when
  // the dialog really closes. Callers hand fresh callback identities down on
  // every parent render, and the Library re-renders whenever it revalidates —
  // on window focus, on a cross-tab signal, or when a background render
  // publishes a clip — which would otherwise reset playback mid-watch.
  const onCloseRef = useRef(onClose);
  const openerRef = useRef(opener);
  useEffect(() => { onCloseRef.current = onClose; openerRef.current = opener; });

  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = event.currentTarget as HTMLElement;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, video[controls], [tabindex]:not([tabindex=\"-1\"])")]
        .filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) || first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const dialog = document.getElementById(`video-preview-${asset.id}`);
    dialog?.addEventListener("keydown", onKeyDown);
    const video = videoRef.current;
    return () => {
      dialog?.removeEventListener("keydown", onKeyDown);
      video?.pause();
      if (video) {
        try { video.currentTime = 0; } catch { /* Some media implementations reject seeking before metadata loads. */ }
      }
      document.body.style.overflow = previousOverflow;
      const returnTo = openerRef.current;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [asset.id]);

  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    try {
      await video.play();
    } catch {
      setError("This video preview could not be played.");
    }
  };

  return <div className="video-preview-backdrop" onClick={onClose}>
    <section
      id={`video-preview-${asset.id}`}
      className={`video-preview-dialog${children ? " asset-preview-dialog" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`video-preview-title-${asset.id}`}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="video-preview-header">
        <h2 id={`video-preview-title-${asset.id}`}>{asset.title} {asset.mediaType.startsWith("video/") ? "video preview" : "details"}</h2>
        <button ref={closeRef} className="icon-button video-preview-close" type="button" aria-label="Close video preview" onClick={onClose}>×</button>
      </div>
      <div className="asset-preview-body">
      {asset.mediaType.startsWith("video/") && asset.previewUrl && <div className="video-preview-stage">
        <video
          ref={videoRef}
          className="video-preview-video"
          src={asset.previewUrl}
          controls
          playsInline
          preload="metadata"
          onPlay={() => { setPlaying(true); setHasPlayed(true); }}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setHasPlayed(true); }}
          onError={() => { setPlaying(false); setError("This video preview could not be loaded."); onMediaError?.(); }}
        />
        {!playing && <button className="video-preview-play" type="button" aria-label={hasPlayed ? "Replay video" : "Play video"} onClick={() => void play()}>{hasPlayed ? "Replay video" : "Play video"}</button>}
      </div>}
      {children}
      </div>
      {error && <p className="video-preview-error" role="alert">{error}</p>}
    </section>
  </div>;
}
