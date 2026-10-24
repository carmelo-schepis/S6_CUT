import { useState } from "react";
import { BriefcaseBusiness, ExternalLink, Pause, Play, RefreshCw } from "lucide-react";
import { controlJob, readableError } from "../api";
import type { Job } from "../types";
import { Button, EmptyState, PageHeader, Progress, StatusBadge, formatAge } from "./common";
import { downloadFacts, groupWarnings, jobFacts } from "../status-format";

// The queue keeps every job forever; rendering all of them produced a
// ~15,000px page that took seconds to settle. Show the recent window by default.
const JOB_LIMIT = 20;

// Jobs read as days rather than one even run of rows: the day heading and the
// space around it do the separating that per-row hairlines used to.
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function groupByDay(jobs: Job[], now = new Date()): [string, Job[]][] {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const label = dayLabel(job.updatedAt, now);
    groups.set(label, [...(groups.get(label) || []), job]);
  }
  return [...groups];
}

export function JobsView({ onOpenProject, jobs, onRefresh }: { onOpenProject: (id: string, jobId: string) => void; jobs: Job[]; onRefresh: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Jobs are shell state. Keeping the refresh here would create a second
  // independent /jobs poll and could race the activity indicator's source.
  const load = () => { void onRefresh().then(() => setError(null)); };
  const action = async (job: Job, next: "pause" | "resume" | "retry-failed" | "retry-import") => { try { await controlJob(job.id, next); load(); } catch (cause) { setError(readableError(cause)); } };
  return <div className="page jobs-page"><PageHeader title="Jobs & recovery" actions={<><span className="section-count">{jobs.length} total</span><Button onClick={load}><RefreshCw size={14} /> Refresh</Button></>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {jobs.length ? <>{groupByDay(showAll ? jobs : jobs.slice(0, JOB_LIMIT)).map(([day, dayJobs]) => <section className="jobs-day" key={day} aria-label={day}><h2 className="jobs-day-heading">{day}</h2><div className="jobs-list">{dayJobs.map((job) => <article className="job-card" key={job.id} data-job-id={job.id} data-project-id={job.projectId}>{job.mode !== "clip" && <div className="job-mode">Legacy</div>}<div className="job-main">{(() => {
        const ready = job.clips.filter((clip) => clip.state === "complete").length;
        const download = job.downloadProgress ? downloadFacts(job.downloadProgress) : null;
        const facts = jobFacts(job);
        const notes = groupWarnings(job.warnings);
        const settled = ["complete", "failed", "cancelled_kept"].includes(job.state);
        return <>
          <div><strong>{job.stageLabel}</strong><StatusBadge state={job.state} /></div>
          <p><span className="job-style">{job.style}</span> · {formatAge(job.updatedAt)} · {ready} output{ready === 1 ? "" : "s"} ready</p>
          {download && <dl className="job-download" aria-label="Download">
            <div><dt>{download.phase}</dt><dd>{download.transferred}</dd></div>
            {download.speed && <div><dt>Speed</dt><dd>{download.speed}</dd></div>}
          </dl>}
          {!settled && <Progress value={facts.percent} indeterminate={facts.indeterminate} label={facts.stage} />}
          {notes.length > 0 && <small className="job-note">{notes[0].scope ? `${notes[0].scope}: ` : ""}{notes[0].message}{notes.length > 1 ? ` (+${notes.length - 1} more)` : ""}</small>}
        </>;
      })()}</div><div className="job-actions"><Button onClick={() => onOpenProject(job.projectId, job.id)}><ExternalLink size={14} /> Open</Button>{job.mode === "clip" && ["active", "queued", "recovered"].includes(job.state) && <Button aria-label="Pause job" title="Pause job" onClick={() => action(job, "pause")}><Pause size={14} /></Button>}{job.mode === "clip" && job.state === "paused" && <Button aria-label="Resume job" title="Resume job" onClick={() => action(job, "resume")}><Play size={14} /></Button>}{job.mode === "clip" && job.clips.some((clip) => clip.state === "failed") && <Button aria-label="Retry failed clips" title="Retry failed clips" onClick={() => action(job, "retry-failed")}><RefreshCw size={14} /></Button>}{job.mode === "clip" && job.downloadProgress && ["failed", "stalled", "cancelled_kept"].includes(job.state) && <Button onClick={() => action(job, "retry-import")}><RefreshCw size={14} /> Retry import</Button>}</div></article>)}</div></section>)}
      {jobs.length > JOB_LIMIT && <button className="show-all-projects" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? `Show recent ${JOB_LIMIT}` : `Show all ${jobs.length} jobs`}</button>}</>
      : <EmptyState icon={<BriefcaseBusiness size={30} />} title="No jobs yet">Create a Clip project. Live stages, partial results, recovery, and scoped retry will appear here.</EmptyState>}
  </div>;
}
