import { useEffect, useState, type CSSProperties } from "react";
import { Film, Pause, RotateCcw, WifiOff } from "lucide-react";
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
  const activeBlocks = Math.max(1, Math.min(5, Math.ceil(progress / 20)));
  const stageLabel = waitingForEngine ? "Waiting for the local engine"
    : job.state === "paused" ? "Processing paused"
      : job.state === "recovered" ? "Recovering checkpointed work"
        : job.downloadProgress?.phase === "stalled" ? "Download stalled"
          : job.stageLabel;
  const hasItems = job.currentItem > 0 && job.totalItems > 0;
  // The item count stays visible while reconnecting: the disconnect notice is
  // carried by the workspace strip, not by replacing real progress data.
  const stageDetail = hasItems ? `${job.currentItem} of ${job.totalItems} items` : "Working from saved project state";
  const download = job.downloadProgress ? downloadFacts(job.downloadProgress) : null;

  return <div className={`processing-state state-${job.state}`}>
    <div className="processing-live sr-only" aria-live="polite">{stageLabel}</div>
    <section className="processing-section processing-header" aria-label="Processing status">
      <div className="processing-heading">
        <span aria-hidden="true">{waitingForEngine ? <WifiOff size={18} /> : job.state === "paused" ? <Pause size={18} /> : job.state === "recovered" ? <RotateCcw size={18} /> : <Film size={18} />}</span>
        <div><strong>{stageLabel}</strong><small>{stageDetail}</small></div>
        <b aria-label={`Overall progress ${Math.round(progress)} percent`}>{Math.round(progress)}%</b>
      </div>
    </section>
    <section className="processing-section processing-progress" aria-label="Progress details">
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
      <dl className="processing-meta">
        <div><dt>Elapsed</dt><dd>{elapsedSince(job.createdAt, now)}</dd></div>
        {hasItems && <div><dt>Item</dt><dd>{job.currentItem} of {job.totalItems}</dd></div>}
      </dl>
    </section>
    {download && <section className="processing-section download-progress-detail" aria-label="Download status">
      <div className="download-detail-heading"><strong>{download.phase}</strong>{download.percent != null && <b>{Math.round(download.percent)}%</b>}</div>
      {download.percent != null && <div className="download-detail-track" aria-hidden="true"><span style={{ width: `${download.percent}%` }} /></div>}
      <dl className="download-detail-values">
        <div><dt>Transferred</dt><dd>{download.transferred}</dd></div>
        {download.speed && <div><dt>Speed</dt><dd>{download.speed}</dd></div>}
        {download.eta && <div><dt>Remaining</dt><dd>{download.eta}</dd></div>}
        <div><dt>Last progress</dt><dd><time dateTime={download.lastProgressAt}>{new Date(download.lastProgressAt).toLocaleTimeString()}</time></dd></div>
      </dl>
      {download.message && <small className="download-message">{download.message}</small>}
    </section>}
    <p className="processing-help">Processing continues in the local engine if you leave this screen.</p>
  </div>;
}
