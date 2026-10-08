import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Download, RefreshCw } from "lucide-react";
import { ApiError, createVideoOnlyDownload, getVideoOnlyDownload, readableError } from "../api";
import type { VideoDownloadTask } from "../types";
import { Button } from "./common";

const STORAGE_KEY = "s6-cut.video-download-only-task";
const AUTO_DOWNLOAD_KEY = "s6-cut.video-download-only-auto";

function youtubeId(value: string) {
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const id = host === "youtu.be" ? parsed.pathname.split("/").filter(Boolean)[0]
      : parsed.pathname === "/watch" ? parsed.searchParams.get("v")
        : parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
    return parsed.protocol === "https:" && ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host) && id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function statusLabel(task: VideoDownloadTask) {
  if (task.state === "queued") return "Queued";
  if (task.state === "failed") return "Failed";
  if (task.state === "complete") return "Ready";
  if (task.phase === "preparing") return "Preparing MP4";
  return "Downloading";
}

export function VideoOnlyDownload({ url }: { url: string }) {
  const [task, setTask] = useState<VideoDownloadTask | null>(null);
  const [taskForVideo, setTaskForVideo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorForVideo, setErrorForVideo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingLink, setRefreshingLink] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const automaticDownloadId = useRef<string | null>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const currentVideoId = youtubeId(url);
  const latestVideoId = useRef(currentVideoId);
  const currentTask = useMemo(() => task && currentVideoId && taskForVideo === currentVideoId ? task : null, [task, taskForVideo, currentVideoId]);

  useEffect(() => { latestVideoId.current = currentVideoId; }, [currentVideoId]);

  useEffect(() => {
    const id = window.localStorage.getItem(STORAGE_KEY);
    if (!id) return;
    void getVideoOnlyDownload(id).then((saved) => {
      setTask(saved);
      setTaskForVideo(youtubeId(saved.url));
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 404) window.localStorage.removeItem(STORAGE_KEY);
      else setError(readableError(cause));
    });
  }, []);

  useEffect(() => {
    if (!currentTask || currentTask.state === "complete" || currentTask.state === "failed") return;
    let alive = true;
    const poll = window.setInterval(() => {
      void getVideoOnlyDownload(currentTask.id).then((fresh) => {
        if (alive && youtubeId(fresh.url) === currentVideoId) setTask(fresh);
      }).catch((cause: unknown) => {
        if (!alive) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setError("This download task is no longer available. Start a new download.");
          setErrorForVideo(currentVideoId);
          window.clearInterval(poll);
        } else { setError(readableError(cause)); setErrorForVideo(currentVideoId); }
      });
    }, 1200);
    return () => { alive = false; window.clearInterval(poll); };
  }, [currentTask, currentVideoId]);

  useEffect(() => {
    if (!currentTask || currentTask.state !== "complete" || !currentTask.downloadUrl || automaticDownloadId.current === currentTask.id) return;
    try {
      if (window.localStorage.getItem(AUTO_DOWNLOAD_KEY) === currentTask.id) return;
      window.localStorage.setItem(AUTO_DOWNLOAD_KEY, currentTask.id);
    } catch { /* Session-local ref still prevents duplicate effects if storage is unavailable. */ }
    automaticDownloadId.current = currentTask.id;
    downloadLink.current?.click();
  }, [currentTask]);

  const start = async () => {
    const videoId = youtubeId(url);
    if (!videoId || requestInFlight.current) {
      if (!videoId) setError("Enter a valid HTTPS YouTube video URL.");
      return;
    }
    requestInFlight.current = true;
    setSubmitting(true);
    setError(null);
    setErrorForVideo(null);
    setLinkNotice(null);
    try {
      const next = await createVideoOnlyDownload(url.trim());
      if (latestVideoId.current === videoId) {
        setTask(next);
        setTaskForVideo(videoId);
        window.localStorage.setItem(STORAGE_KEY, next.id);
      }
    } catch (cause) {
      if (latestVideoId.current === videoId) { setError(readableError(cause)); setErrorForVideo(videoId); }
    } finally {
      requestInFlight.current = false;
      setSubmitting(false);
    }
  };

  const pending = currentTask?.state === "queued" || currentTask?.state === "active";
  const refreshExpiredLink = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!currentTask?.downloadUrl || !currentVideoId) return;
    const expires = Number(new URL(currentTask.downloadUrl, window.location.href).searchParams.get("expires"));
    if (Number.isFinite(expires) && expires > Math.floor(Date.now() / 1000)) return;
    event.preventDefault();
    setRefreshingLink(true);
    try {
      const fresh = await getVideoOnlyDownload(currentTask.id);
      if (youtubeId(fresh.url) === currentVideoId && fresh.state === "complete") {
        setTask(fresh);
        setTaskForVideo(currentVideoId);
        setLinkNotice("The download link was refreshed. Select Download MP4 again.");
      }
    } catch (cause) {
      setError(readableError(cause));
      setErrorForVideo(currentVideoId);
    } finally {
      setRefreshingLink(false);
    }
  };
  return <div className="video-only-download">
    <Button type="button" variant="secondary" disabled={!currentVideoId || submitting || pending} onClick={() => void start()}>
      <Download size={15} /> Download video only
    </Button>
    {error && errorForVideo === currentVideoId && <p className="form-error" role="alert">{error}</p>}
    {currentTask && <div className="video-only-status" role="status" aria-live="polite">
      <strong>{statusLabel(currentTask)}</strong>
      {currentTask.message && <span>{currentTask.message}</span>}
      {currentTask.state === "active" && (currentTask.percent == null
        ? <progress aria-label="Download progress" />
        : <><progress aria-label="Download progress" max="100" value={currentTask.percent} /><span>{Math.round(currentTask.percent)}%</span></>)}
      {linkNotice && <span role="status">{linkNotice}</span>}
      {currentTask.state === "complete" && currentTask.downloadUrl && <a ref={downloadLink} className="button button-primary" href={currentTask.downloadUrl} download={currentTask.filename || undefined} onClick={(event) => void refreshExpiredLink(event)}><Download size={14} /> {refreshingLink ? "Refreshing link…" : "Download MP4"}</a>}
      {currentTask.state === "failed" && <><small>{currentTask.error}</small><Button type="button" onClick={() => void start()}><RefreshCw size={14} /> Try again</Button></>}
    </div>}
  </div>;
}
