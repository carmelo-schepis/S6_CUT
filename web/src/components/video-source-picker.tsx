import { useId, useRef, useState, type ReactNode } from "react";
import { Film, Link2, UploadCloud } from "lucide-react";
import { Button } from "./common";

export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.m4v,.avi";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"]);
export type VideoSourceMode = "file" | "url" | "library";

export function isSupportedVideoFile(file: File) {
  const suffix = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTENSIONS.has(suffix);
}

export function humanFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function VideoSourcePicker({ mode, onModeChange, file, onFile, url, onUrl, children, downloadAction }: {
  mode: VideoSourceMode;
  onModeChange: (mode: VideoSourceMode) => void;
  file: File | null;
  onFile: (file: File | null, error?: string) => void;
  url: string;
  onUrl: (url: string) => void;
  children?: ReactNode;
  downloadAction?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const instructionsId = useId();
  const [dragActive, setDragActive] = useState(false);
  const select = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!isSupportedVideoFile(candidate)) {
      onFile(null, "Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.");
      return;
    }
    onFile(candidate);
  };
  const changeMode = (next: VideoSourceMode) => {
    dragDepth.current = 0;
    setDragActive(false);
    onModeChange(next);
  };
  return <div className="video-source-picker">
    <div className="mini-tabs source-tabs" role="tablist" aria-label="Source video type">
      <button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => changeMode("file")}><UploadCloud size={14} /> Local file</button>
      <button type="button" role="tab" aria-selected={mode === "url"} className={mode === "url" ? "active" : ""} onClick={() => changeMode("url")}><Link2 size={14} /> YouTube</button>
      {children && <button type="button" role="tab" aria-selected={mode === "library"} className={mode === "library" ? "active" : ""} onClick={() => changeMode("library")}><Film size={14} /> Library</button>}
    </div>
    {mode === "file" && <div className={`drop-zone ${file ? "has-file" : ""} ${dragActive ? "drag-active" : ""}`} role="group" aria-label="Local video source" aria-describedby={instructionsId} onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setDragActive(true); }} onDragOver={(event) => { event.preventDefault(); setDragActive(true); }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragActive(false); if (event.dataTransfer.files.length > 1) { onFile(null, "Choose one video file at a time."); return; } select(event.dataTransfer.files[0]); }}>
      <input ref={input} type="file" accept={VIDEO_ACCEPT} aria-label="Choose video file" hidden onChange={(event) => { select(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <span id={instructionsId} className="sr-only">Use Browse files to choose one video, or drop one video here.</span>
      {file ? <><Film size={25} /><strong title={file.name}>{file.name}</strong><span>{humanFileSize(file.size)} · ready to validate</span><div className="source-actions"><button type="button" onClick={() => input.current?.click()}>Choose another</button><button type="button" onClick={() => onFile(null)}>Remove</button></div></> : <><UploadCloud size={26} /><strong>Drop a video here</strong><span>MP4, MOV, WebM, MKV, M4V or AVI</span><Button type="button" onClick={() => input.current?.click()}>Browse files</Button></>}
    </div>}
    {mode === "url" && <div className="field"><label className="field-label" htmlFor="source-youtube-url">YouTube URL</label><input id="source-youtube-url" type="url" value={url} onChange={(event) => onUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." /><small>Public YouTube links only. DRM and access controls are never bypassed.</small>{downloadAction}</div>}
    {mode === "library" && children}
  </div>;
}
