import { useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";
import type { MobileClip } from "../../types";
import { Progress } from "../common";
import type { PreviewableAsset } from "../video-preview-dialog";
import { workFacts, type WorkItem } from "./mobile-model";

export type PreviewTarget = PreviewableAsset;
/** Opens the one shared player; the opener is handed back focus when it closes. */
export type OpenPreview = (target: PreviewTarget, opener: HTMLButtonElement) => void;

const stripQuery = (url: string) => url.split("?")[0];

/**
 * A still from the engine. Signed thumbnail links are re-issued on every status
 * poll, so the image keeps the link it first loaded instead of refetching on
 * each poll; it only adopts a new one when the link stops working or points at
 * a different image (a source poster giving way to the Library thumbnail).
 * It is an `<img>`, never a `<video>`: a phone must not open dozens of media
 * connections just to draw a list.
 */
export function Poster({ src, label, className = "" }: { src?: string | null; label?: string; className?: string }) {
  const [shown, setShown] = useState<string | null>(src ?? null);
  const [failed, setFailed] = useState(false);
  const latest = useRef<string | null>(src ?? null);
  useEffect(() => { latest.current = src ?? null; }, [src]);
  // Adjusted during render (React's documented pattern) rather than in an effect.
  if (src && (!shown || stripQuery(src) !== stripQuery(shown))) {
    setShown(src);
    setFailed(false);
  }
  return <span className={`m-poster ${className}`.trim()}>
    {shown && !failed
      ? <img src={shown} alt={label ?? ""} loading="lazy" decoding="async" draggable={false} onError={() => {
        const next = latest.current;
        if (next && next !== shown) setShown(next);
        else setFailed(true);
      }} />
      : <Film size={16} aria-hidden="true" />}
  </span>;
}

/** Finished clips as a row of stills; each opens the shared player. */
export function ClipStrip({ clips, onPreview, label }: { clips: MobileClip[]; onPreview: OpenPreview; label: string }) {
  if (!clips.length) return null;
  return <ul className="m-clip-strip" aria-label={label}>
    {clips.map((clip) => <li key={clip.id}>
      <button type="button" className="m-clip" aria-label={`Preview ${clip.title}`} disabled={!clip.previewUrl}
        onClick={(event) => { if (clip.previewUrl) onPreview({ id: clip.id, title: clip.title, mediaType: "video/mp4", previewUrl: clip.previewUrl }, event.currentTarget); }}>
        <Poster src={clip.thumbnailUrl} />
      </button>
    </li>)}
  </ul>;
}

/** One line of work in flight: still, title, what it is doing, and a progress bar. */
export function RunningRow({ item, onOpen }: { item: WorkItem; onOpen?: () => void }) {
  const facts = workFacts(item);
  const body = <>
    <Poster src={facts.poster} />
    <span className="m-row-body">
      <strong className="m-clamp">{facts.title}</strong>
      <span className="m-muted m-clamp-1">{[facts.stage, facts.detail].filter(Boolean).join(" · ")}</span>
      <Progress value={facts.percent} indeterminate={facts.indeterminate} label={facts.stage} />
    </span>
  </>;
  return onOpen
    ? <button type="button" className="m-row" onClick={onOpen}>{body}</button>
    : <div className="m-row">{body}</div>;
}
