import { useEffect, useState } from "react";
import { downloadFacts, formatSeconds } from "../status-format";
import type { Job } from "../types";

const terminalStates = new Set(["complete", "partial", "failed", "cancelled_kept"]);

export function isTerminalJob(job: Job) {
  return terminalStates.has(job.state);
}

function elapsedSince(startedAt: string, now: number) {
  return formatSeconds(Math.max(0, (now - new Date(startedAt).getTime()) / 1000));
}

/**
 * The processing card. Every value is rendered as its own labelled element:
 * stage, percentage, elapsed time and transfer figures are never concatenated
 * into a single sentence, so a long phase name or filename cannot run into the
 * value beside it.
 */
export function ProcessingState({ job, waitingForEngine = false }: { job: Job; waitingForEngine?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const { createdAt, state } = job;
  useEffect(() => {
    if (terminalStates.has(state) || state === "paused") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [createdAt, state]);

  const progress = Math.max(0, Math.min(100, job.progress));
  const stageLabel = waitingForEngine ? "Waiting for the local engine"
    : job.state === "paused" ? "Processing paused"
      : job.state === "recovered" ? "Recovering checkpointed work"
        : job.downloadProgress?.phase === "stalled" ? "Download stalled"
          : job.stageLabel;
  const hasItems = job.currentItem > 0 && job.totalItems > 0;
  // The item count stays visible while reconnecting: the disconnect notice is
  // carried by the workspace strip, not by replacing real progress data.
  const stageDetail = hasItems ? `${job.currentItem} of ${job.totalItems} items` : null;
  const download = job.downloadProgress ? downloadFacts(job.downloadProgress) : null;
  // A finished download is history, not progress: it shrinks to one fact
  // beside the elapsed time instead of keeping its own panel.
  const liveDownload = download && job.downloadProgress?.phase !== "complete" ? download : null;

  return <div className={`processing-state state-${job.state}`}>
    <div className="processing-live sr-only" aria-live="polite">{stageLabel}</div>
    <section className="processing-section processing-header" aria-label="Processing status">
      <div className="processing-heading">
        <div><strong>{stageLabel}</strong>{stageDetail && <small>{stageDetail}</small>}</div>
        <b aria-label={`Overall progress ${Math.round(progress)} percent`}>{Math.round(progress)}%</b>
      </div>
    </section>
    <section className="processing-section processing-progress" aria-label="Progress details">
      <div className="processing-progress-bar" role="progressbar" aria-label="Overall processing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div>
      <dl className="processing-meta">
        <div><dt>Elapsed</dt><dd>{elapsedSince(job.createdAt, now)}</dd></div>
        {download && !liveDownload && <div><dt>Source</dt><dd>{download.transferred}</dd></div>}
      </dl>
    </section>
    {liveDownload && <section className="processing-section download-progress-detail" aria-label="Download status">
      <div className="download-detail-heading"><strong>{liveDownload.phase}</strong>{liveDownload.percent != null && <b>{Math.round(liveDownload.percent)}%</b>}</div>
      {liveDownload.percent != null && <div className="download-detail-track" aria-hidden="true"><span style={{ width: `${liveDownload.percent}%` }} /></div>}
      <dl className="download-detail-values">
        <div><dt>Received</dt><dd>{liveDownload.transferred}</dd></div>
        {liveDownload.speed && <div><dt>Speed</dt><dd>{liveDownload.speed}</dd></div>}
        {liveDownload.eta && <div><dt>Remaining</dt><dd>{liveDownload.eta}</dd></div>}
      </dl>
      {liveDownload.message && <small className="download-message">{liveDownload.message}</small>}
    </section>}
    <p className="processing-help">Processing continues if you leave this screen.</p>
  </div>;
}
