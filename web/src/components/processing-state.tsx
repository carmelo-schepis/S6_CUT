import { useEffect, useState, type CSSProperties } from "react";
import { Film, Pause, RotateCcw, WifiOff } from "lucide-react";
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
  const stageLabel = waitingForEngine ? "Waiting for the S6 Cut engine…" : job.state === "paused" ? "Processing paused" : job.state === "recovered" ? "Recovering checkpointed work" : job.stageLabel;

  return <div className={`processing-state state-${job.state}`}>
    <div className="processing-live sr-only" aria-live="polite">{stageLabel}</div>
    <div className="processing-heading"><span>{waitingForEngine ? <WifiOff size={18} /> : job.state === "paused" ? <Pause size={18} /> : job.state === "recovered" ? <RotateCcw size={18} /> : <Film size={18} />}</span><div><strong>{stageLabel}</strong><small>{job.currentItem > 0 && job.totalItems > 0 ? `${job.currentItem} of ${job.totalItems} items` : "Working from durable project state"}</small></div><b>{Math.round(progress)}%</b></div>
    <div className="processing-filmstrip" aria-hidden="true">
      <div className="filmstrip-perforations top" />
      <div className="processing-track">
        {[0, 1, 2, 3, 4].map((index) => <span key={index} className={index < activeBlocks ? "active" : ""} style={{ "--clip-index": index } as CSSProperties} />)}
        <i style={{ left: `${progress}%` }} />
      </div>
      <div className="filmstrip-perforations bottom" />
    </div>
    <div className="processing-meta"><span>Elapsed {formatElapsed(job.createdAt, now)}</span>{job.currentItem > 0 && job.totalItems > 0 && <span>Item {job.currentItem} / {job.totalItems}</span>}</div>
    <p>Processing continues in the local engine if you leave this screen.</p>
  </div>;
}
