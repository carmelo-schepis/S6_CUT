import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { createVideoOnlyDownload, getVideoOnlyDownload, readableError } from "../api";
import type { VideoDownloadTask } from "../types";
import { Button } from "./common";

const STORAGE_KEY = "s6-cut.video-download-only-task";

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

export function VideoOnlyDownload({ url }: { url: string }) {
  const [task, setTask] = useState<VideoDownloadTask | null>(null);
  const [taskForVideo, setTaskForVideo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorForVideo, setErrorForVideo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [restoringTask, setRestoringTask] = useState(() => {
    try { return typeof window !== "undefined" && Boolean(window.localStorage.getItem(STORAGE_KEY)); }
    catch { return false; }
  });
  const requestInFlight = useRef(false);
  const isMounted = useRef(false);
  const automaticDownloadId = useRef<string | null>(null);
  const autoDownloadPending = useRef<string | null>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const currentVideoId = youtubeId(url);
  const latestVideoId = useRef(currentVideoId);
  useLayoutEffect(() => {
    latestVideoId.current = currentVideoId;
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, [currentVideoId]);
  const currentTask = useMemo(() => task && currentVideoId && taskForVideo === currentVideoId ? task : null, [task, taskForVideo, currentVideoId]);

  useEffect(() => {
    let alive = true;
    let id: string | null;
    try { id = window.localStorage.getItem(STORAGE_KEY); }
    catch { return; }
    if (!id) return;
    void getVideoOnlyDownload(id).then((saved) => {
      if (!alive) return;
      const videoId = youtubeId(saved.url);
      setTask(saved);
      setTaskForVideo(videoId);
      if (saved.state === "queued" || saved.state === "active") autoDownloadPending.current = saved.id;
    }).catch(() => {
      if (alive) {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Ignore unavailable browser storage. */ }
      }
    }).finally(() => {
      if (alive) setRestoringTask(false);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!currentTask || currentTask.state === "complete" || currentTask.state === "failed") return;
    let alive = true;
    const poll = window.setInterval(() => {
      void getVideoOnlyDownload(currentTask.id).then((fresh) => {
        if (!alive || latestVideoId.current !== currentVideoId || youtubeId(fresh.url) !== currentVideoId) return;
        setTask(fresh);
      }).catch((cause: unknown) => {
        if (alive && latestVideoId.current === currentVideoId) {
          setError(readableError(cause));
          setErrorForVideo(currentVideoId);
        }
      });
    }, 1200);
    return () => { alive = false; window.clearInterval(poll); };
  }, [currentTask, currentVideoId]);

  useEffect(() => {
    if (!currentTask || currentTask.state !== "complete" || !currentTask.downloadUrl
      || autoDownloadPending.current !== currentTask.id || automaticDownloadId.current === currentTask.id) return;
    if (latestVideoId.current !== currentVideoId) return;
    automaticDownloadId.current = currentTask.id;
    autoDownloadPending.current = null;
    downloadLink.current?.click();
  }, [currentTask, currentVideoId]);

  const start = async () => {
    const videoId = youtubeId(url);
    if (requestInFlight.current) return;
    if (!videoId) {
      setError("Enter a valid HTTPS YouTube URL.");
      setErrorForVideo(url);
      return;
    }
    requestInFlight.current = true;
    setSubmitting(true);
    setError(null);
    setErrorForVideo(null);
    try {
      let next: VideoDownloadTask;
      if (currentTask?.state === "complete") {
        next = await getVideoOnlyDownload(currentTask.id);
      } else {
        if (currentTask && (currentTask.state === "queued" || currentTask.state === "active")) return;
        next = await createVideoOnlyDownload(url.trim());
      }
      if (!isMounted.current || latestVideoId.current !== videoId || youtubeId(next.url) !== videoId) return;
      setTask(next);
      setTaskForVideo(videoId);
      try { window.localStorage.setItem(STORAGE_KEY, next.id); } catch { /* Keep the current interaction working without browser storage. */ }
      if (next.state === "complete" && next.downloadUrl) {
        autoDownloadPending.current = null;
        automaticDownloadId.current = next.id;
        if (downloadLink.current) {
          downloadLink.current.href = next.downloadUrl;
          downloadLink.current.download = next.filename || "";
          downloadLink.current.click();
        }
      } else if (next.state === "queued" || next.state === "active") {
        autoDownloadPending.current = next.id;
      }
    } catch (cause) {
      if (isMounted.current && latestVideoId.current === videoId) {
        setError(readableError(cause));
        setErrorForVideo(videoId);
      }
    } finally {
      requestInFlight.current = false;
      if (isMounted.current) setSubmitting(false);
    }
  };

  const pending = restoringTask || submitting || currentTask?.state === "queued" || currentTask?.state === "active";
  const requestError = error && (errorForVideo === currentVideoId || errorForVideo === url) ? error : null;
  const taskError = currentTask?.state === "failed" ? currentTask.error : null;
  const visibleError = requestError || taskError;
  const shortError = visibleError ? visibleError.split(/[\r\n]/, 1)[0].trim().slice(0, 120) : null;
  return <div className="video-only-download">
    <Button type="button" variant="secondary" disabled={!url.trim() || Boolean(pending)} onClick={() => void start()}>
      <Download size={15} /> {pending ? "Downloading…" : "Download video"}
    </Button>
    {shortError && <p className="form-error" role="alert">{shortError}</p>}
    <a ref={downloadLink} href={currentTask?.downloadUrl || undefined} download={currentTask?.filename || undefined} hidden aria-hidden="true" tabIndex={-1} />
  </div>;
}
