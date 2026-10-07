import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A card thumbnail is deliberately not a media player. It receives a signed
 * URL from the API, but only assigns it while the card is close to view. This
 * bounds range requests in large boards and drops the resource again when a
 * card is far away.
 */
export function LazyVideoThumbnail({ src, thumbnailSrc, className, videoClassName, label, onError, onRenew, children }: { src?: string | null; thumbnailSrc?: string | null; className?: string; videoClassName?: string; label?: string; onError?: () => void; onRenew?: () => Promise<string | null>; children?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stableSrc] = useState(src);
  const [nearViewport, setNearViewport] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [renewedSrc, setRenewedSrc] = useState<{ original: string; renewed: string } | null>(null);
  const renewalAttempted = useRef(false);
  const currentThumbnail = renewedSrc && renewedSrc.original === thumbnailSrc ? renewedSrc.renewed : thumbnailSrc;
  const imageFailed = Boolean(currentThumbnail && failedSrc === currentThumbnail);
  const imageLoaded = Boolean(currentThumbnail && loadedSrc === currentThumbnail);

  useEffect(() => {
    renewalAttempted.current = false;
  }, [thumbnailSrc]);

  // Revalidation refreshes signed URLs. Callers retain the existing valid URL
  // for an unchanged blob; the immutable identity is also used as this
  // component's key when its source media changes.
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
    {nearViewport && currentThumbnail ? <>
      <img className={videoClassName} src={currentThumbnail} alt={label || "Video thumbnail"} onLoad={() => setLoadedSrc(currentThumbnail)} onError={() => {
        if (!renewalAttempted.current && onRenew) {
          renewalAttempted.current = true;
          void onRenew().then((url) => {
            if (url && thumbnailSrc) setRenewedSrc({ original: thumbnailSrc, renewed: url });
            else setFailedSrc(currentThumbnail);
          }).catch(() => setFailedSrc(currentThumbnail));
        } else {
          setFailedSrc(currentThumbnail);
          onError?.();
        }
      }} />
      {!imageLoaded && !imageFailed && <span className="thumbnail-loading" role="status">Loading thumbnail…</span>}
      {imageFailed && <span className="thumbnail-failure" role="status">Thumbnail unavailable</span>}
    </> : nearViewport && stableSrc && <video ref={videoRef} className={videoClassName} src={stableSrc} muted playsInline preload="metadata" aria-hidden={label ? undefined : true} aria-label={label} tabIndex={-1} onError={onError} />}
    {children}
  </div>;
}
