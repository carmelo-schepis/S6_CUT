import { useCallback, useEffect, useRef, useState } from "react";
import { Film, LoaderCircle, RefreshCw } from "lucide-react";
import { listJobs, listProjects, listVideoOnlyDownloads, readableError } from "../api";
import { formatBytes, jobFacts } from "../status-format";
import type { Job, Project, VideoDownloadTask } from "../types";
import { usePoll } from "../use-poll";
import { StatusBadge } from "./common";

const ACTIVE_STATES = new Set(["queued", "active", "paused", "stalled", "recovered"]);
type Snapshot = { jobs: Job[]; projects: Project[]; downloads: VideoDownloadTask[] };

function StatusPreview({ clip }: { clip: Job["clips"][number] }) {
  const latestUrl = useRef(clip.previewUrl ?? undefined);
  const [src, setSrc] = useState(clip.previewUrl ?? undefined);
  useEffect(() => { latestUrl.current = clip.previewUrl ?? undefined; }, [clip.previewUrl]);
  return <figure><video src={src} controls playsInline preload="metadata" controlsList="nodownload noplaybackrate" disablePictureInPicture aria-label={clip.title || `Preview clip ${clip.index}`} onError={() => { if (latestUrl.current && latestUrl.current !== src) setSrc(latestUrl.current); }} /><figcaption>{clip.title || `Clip ${String(clip.index).padStart(2, "0")}`}</figcaption></figure>;
}

function titleFor(job: Job, projects: Project[]) {
  const project = projects.find((item) => item.id === job.projectId);
  return project?.name || `Project ${job.projectId.slice(0, 8)}`;
}

export function IOSStatusView() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [jobs, projects, downloads] = await Promise.all([listJobs(), listProjects(), listVideoOnlyDownloads()]);
      setSnapshot({ jobs, projects, downloads });
      setError(null);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  const active = snapshot?.jobs.some((job) => ACTIVE_STATES.has(job.state)) || snapshot?.downloads.some((task) => task.state === "queued" || task.state === "active") || false;
  const runRefresh = usePoll(refresh, active ? 3_000 : 15_000, true, true);

  if (loading && !snapshot) return <main className="ios-status-page" aria-busy="true"><div className="ios-status-brand"><img src="/app-icon.png" alt="" /><span>S6_cut status</span></div><p role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading your work…</p></main>;

  const jobs = [...(snapshot?.jobs || [])].sort((a, b) => {
    const aActive = ACTIVE_STATES.has(a.state) ? 1 : 0;
    const bActive = ACTIVE_STATES.has(b.state) ? 1 : 0;
    return bActive - aActive || b.updatedAt.localeCompare(a.updatedAt);
  });
  const downloads = snapshot?.downloads || [];

  return <main className="ios-status-page">
    <header className="ios-status-header"><div className="ios-status-brand"><img src="/app-icon.png" alt="" /><span>S6_cut status</span></div><button type="button" className="ios-status-refresh" onClick={() => void runRefresh()} aria-label="Refresh status"><RefreshCw size={16} /></button></header>
    {error && <div className="ios-status-error" role="alert"><span>{error}</span><button type="button" onClick={() => void runRefresh()}>Retry</button></div>}
    {!error && !jobs.length && !downloads.length && <section className="ios-status-empty"><Film size={24} aria-hidden="true" /><h1>No recent work</h1><p>Project and video processing status will appear here.</p></section>}
    {!!jobs.length && <section className="ios-status-section" aria-labelledby="ios-jobs-heading"><h1 id="ios-jobs-heading">Project work</h1><div className="ios-status-list">
      {jobs.map((job) => {
        const activeJob = ACTIVE_STATES.has(job.state);
        const facts = jobFacts(job);
        const completeClips = job.clips.filter((clip) => clip.state === "complete" && clip.previewUrl);
        return <article className="ios-status-card" key={job.id}>
          <div className="ios-status-card-heading"><div><strong>{titleFor(job, snapshot?.projects || [])}</strong><span>{job.mode === "clip" ? `Job ${job.id.slice(0, 8)}` : `Project ${job.id.slice(0, 8)}`}</span></div><StatusBadge state={job.state} label={job.stageLabel} /></div>
          {activeJob && <div className="ios-status-progress"><div className="ios-status-progress-label"><span>{facts.stage}</span><span>{facts.indeterminate ? "In progress" : `${Math.round(facts.percent)}%`}</span></div><progress aria-label={facts.stage} value={facts.indeterminate ? undefined : facts.percent} max="100" />{job.downloadProgress && <div className="ios-status-transfer"><span>{formatBytes(job.downloadProgress.downloadedBytes)}{job.downloadProgress.totalBytes ? ` of ${formatBytes(job.downloadProgress.totalBytes)}` : " transferred"}</span>{job.downloadProgress.speedBytesPerSecond ? <span>{formatBytes(job.downloadProgress.speedBytesPerSecond)}/s</span> : null}</div>}</div>}
          {completeClips.length > 0 && <div className="ios-status-previews">{completeClips.map((clip) => <StatusPreview key={clip.id} clip={clip} />)}</div>}
          {!activeJob && completeClips.length === 0 && <p className="ios-status-summary">{job.error || job.stageLabel}</p>}
        </article>;
      })}
    </div></section>}
    {!!downloads.length && <section className="ios-status-section" aria-labelledby="ios-downloads-heading"><h1 id="ios-downloads-heading">Video downloads</h1><div className="ios-status-list">
      {downloads.map((task) => <article className="ios-status-card" key={task.id}><div className="ios-status-card-heading"><div><strong>Video download</strong><span>Task {task.id.slice(0, 8)}</span></div><StatusBadge state={task.state === "complete" ? "complete" : task.state === "failed" ? "failed" : "active"} label={task.phase} /></div>{(task.state === "active" || task.state === "queued") && <div className="ios-status-progress"><div className="ios-status-progress-label"><span>{task.message || task.phase}</span><span>{task.percent == null ? "In progress" : `${Math.round(task.percent)}%`}</span></div><progress aria-label={task.message || task.phase} value={task.percent ?? undefined} max="100" /><div className="ios-status-transfer"><span>{formatBytes(task.downloadedBytes)}{task.totalBytes ? ` of ${formatBytes(task.totalBytes)}` : " transferred"}</span></div></div>}{task.state === "failed" && <p className="ios-status-summary">{task.error || task.message || "Download failed"}</p>}{task.state === "complete" && <p className="ios-status-summary">Video ready on the desktop app.</p>}</article>)}
    </div></section>}
    <p className="ios-status-readonly">Viewing status only · Updates automatically</p>
  </main>;
}
