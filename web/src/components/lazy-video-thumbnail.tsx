import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A card thumbnail is deliberately not a media player. It receives a signed
 * URL from the API, but only assigns it while the card is close to view. This
 * bounds range requests in large boards and drops the resource again when a
 * card is far away.
 */
export function LazyVideoThumbnail({ src, className, videoClassName, label, onError, children }: { src?: string | null; className?: string; videoClassName?: string; label?: string; onError?: () => void; children?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stableSrc] = useState(src);
  const [nearViewport, setNearViewport] = useState(false);

  // Revalidation refreshes signed URLs. The initial state deliberately keeps
  // the first working value rather than replacing it on every refresh. Callers
  // use the immutable blob ID as this component's key when media changes.

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (nearViewport) return;
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }, [nearViewport]);

  return <div ref={containerRef} className={className}>
    {nearViewport && stableSrc && <video ref={videoRef} className={videoClassName} src={stableSrc} muted playsInline preload="metadata" aria-hidden={label ? undefined : true} aria-label={label} tabIndex={-1} onError={onError} />}
    {children}
  </div>;
}
