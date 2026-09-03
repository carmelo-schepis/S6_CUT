import { useEffect, useState, type CSSProperties } from "react";
import { Film, Pause, RotateCcw, WifiOff } from "lucide-react";
import { formatBytes } from "./common";
import type { Job } from "../types";

const terminalStates = new Set(["complete", "partial", "failed", "cancelled_kept"]);

export function isTerminalJob(job: Job) {
  return terminalStates.has(job.state);
}

function formatElapsed(startedAt: string, now: number) {
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ProcessingState({ job, waitingForEngine = false }: { job: Job; waitingForEngine?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const { createdAt, state } = job;
  useEffect(() => {
    if (terminalStates.has(state) || state === "paused") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [createdAt, state]);

  const progress = Math.max(0, Math.min(100, job.progress));
  const activeBlocks = Math.max(1, Math.min(5, Math.ceil(progress / 20)));
  const stageLabel = waitingForEngine ? "Waiting for the S6 Cut engine…" : job.state === "paused" ? "Processing paused" : job.state === "recovered" ? "Recovering checkpointed work" : job.downloadProgress?.phase === "stalled" ? "YouTube download stalled" : job.stageLabel;
  const download = job.downloadProgress;
  const downloadText = download ? `${formatBytes(download.downloadedBytes)}${download.totalBytes ? ` of ${formatBytes(download.totalBytes)}` : " downloaded"}` : null;
  const speedText = download?.speedBytesPerSecond ? `${formatBytes(download.speedBytesPerSecond)}/s` : null;
  const downloadPhase = download?.phase ? download.phase.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") : null;
  const downloadPercent = download?.percent == null ? null : Math.max(0, Math.min(100, download.percent));

  return <div className={`processing-state state-${job.state}`}>
    <div className="processing-live sr-only" aria-live="polite">{stageLabel}</div>
    <div className="processing-heading">
      <span aria-hidden="true">{waitingForEngine ? <WifiOff size={18} /> : job.state === "paused" ? <Pause size={18} /> : job.state === "recovered" ? <RotateCcw size={18} /> : <Film size={18} />}</span>
      <div><strong>{stageLabel}</strong><small>{job.currentItem > 0 && job.totalItems > 0 ? `${job.currentItem} of ${job.totalItems} items` : "Working from durable project state"}</small></div>
      <b aria-label={`Overall progress ${Math.round(progress)} percent`}>{Math.round(progress)}%</b>
    </div>
    <div className="processing-progress-summary"><span>Overall progress</span></div>
    <div className="processing-progress-bar" role="progressbar" aria-label="Overall processing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div>
    <div className="processing-filmstrip" aria-hidden="true">
      <div className="filmstrip-perforations top" />
      <div className="processing-track">
        {[0, 1, 2, 3, 4].map((index) => <span key={index} className={index < activeBlocks ? "active" : ""} style={{ "--clip-index": index } as CSSProperties} />)}
        <i style={{ left: `${progress}%` }} />
      </div>
      <div className="filmstrip-perforations bottom" />
    </div>
    <div className="processing-meta"><span>Elapsed {formatElapsed(job.createdAt, now)}</span>{job.currentItem > 0 && job.totalItems > 0 && <span>Item {job.currentItem} / {job.totalItems}</span>}</div>
    {download && <div className="download-progress-detail" role="status" aria-label="Download status">
      <div className="download-detail-heading"><strong>{downloadPhase}</strong>{downloadPercent != null && <b>{Math.round(downloadPercent)}%</b>}</div>
      <div className="download-detail-values"><span>{downloadText}</span>{speedText && <span>{speedText}{download.etaSeconds != null ? ` · about ${Math.ceil(download.etaSeconds / 60)} min left` : ""}</span>}</div>
      {downloadPercent != null && <div className="download-detail-track" aria-hidden="true"><span style={{ width: `${downloadPercent}%` }} /></div>}
      <div className="download-detail-foot"><span>Last byte progress</span><time dateTime={download.lastProgressAt}>{new Date(download.lastProgressAt).toLocaleTimeString()}</time></div>
      {download.message && <small className="download-message">{download.message}</small>}
    </div>}
    <p className="processing-help">Processing continues in the local engine if you leave this screen.</p>
  </div>;
}
