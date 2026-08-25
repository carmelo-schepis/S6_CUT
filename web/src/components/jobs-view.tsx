import { useEffect, useState } from "react";
import { BriefcaseBusiness, ExternalLink, Pause, Play, RefreshCw } from "lucide-react";
import { controlJob, listJobs, readableError } from "../api";
import type { Job } from "../types";
import { Button, EmptyState, PageHeader, Progress, StatusBadge, formatAge, formatBytes } from "./common";

export function JobsView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => listJobs().then(setJobs).catch((cause) => setError(readableError(cause)));
  useEffect(() => { load(); const timer = window.setInterval(load, 4000); return () => clearInterval(timer); }, []);
  const action = async (job: Job, next: "pause" | "resume" | "retry-failed" | "retry-import") => { try { await controlJob(job.id, next); load(); } catch (cause) { setError(readableError(cause)); } };
  return <div className="page jobs-page"><PageHeader eyebrow="Durable queue" title="Jobs & recovery" description="Every completed artifact is checkpointed before it appears here." actions={<Button onClick={load}><RefreshCw size={14} /> Refresh</Button>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {jobs.length ? <div className="jobs-list">{jobs.map((job) => <article className="job-card" key={job.id}><div className="job-mode">{job.mode === "clip" ? "CLIP" : "SCRIPT"}</div><div className="job-main"><div><strong>{job.stageLabel}</strong><StatusBadge state={job.state} /></div><p>{job.style} · {formatAge(job.updatedAt)} · {job.clips.filter((clip) => clip.state === "complete").length} outputs ready</p>{job.downloadProgress && <p role="status">Download: {formatBytes(job.downloadProgress.downloadedBytes)}{job.downloadProgress.totalBytes ? ` of ${formatBytes(job.downloadProgress.totalBytes)}` : ""}{job.downloadProgress.percent != null ? ` · ${Math.round(job.downloadProgress.percent)}%` : " · size unknown"}</p>}<Progress value={job.downloadProgress?.percent ?? job.progress} indeterminate={Boolean(job.downloadProgress && job.downloadProgress.percent == null)} label={job.downloadProgress ? `Download ${job.downloadProgress.phase}` : job.stageLabel} />{job.warnings.length > 0 && <small>{job.warnings[0]}</small>}</div><div className="job-actions"><Button onClick={() => onOpenProject(job.projectId)}><ExternalLink size={14} /> Open</Button>{["active", "queued", "recovered"].includes(job.state) && <Button onClick={() => action(job, "pause")}><Pause size={14} /></Button>}{job.state === "paused" && <Button onClick={() => action(job, "resume")}><Play size={14} /></Button>}{job.clips.some((clip) => clip.state === "failed") && <Button onClick={() => action(job, "retry-failed")}><RefreshCw size={14} /></Button>}{job.downloadProgress && ["failed", "stalled", "cancelled_kept"].includes(job.state) && <Button onClick={() => action(job, "retry-import")}><RefreshCw size={14} /> Retry import</Button>}</div></article>)}</div>
      : <EmptyState icon={<BriefcaseBusiness size={30} />} title="No jobs yet">Create a Clip or Script project. Live stages, partial results, recovery, and scoped retry will appear here.</EmptyState>}
  </div>;
}
