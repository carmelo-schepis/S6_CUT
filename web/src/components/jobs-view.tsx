import { useCallback, useState } from "react";
import { BriefcaseBusiness, ExternalLink, Pause, Play, RefreshCw } from "lucide-react";
import { controlJob, listJobs, readableError } from "../api";
import { jobPollInterval } from "../project-status";
import { usePoll } from "../use-poll";
import type { Job } from "../types";
import { Button, EmptyState, PageHeader, Progress, StatusBadge, formatAge } from "./common";
import { downloadFacts, groupWarnings, jobFacts } from "../status-format";

// The queue keeps every job forever; rendering all of them produced a
// ~15,000px page that took seconds to settle. Show the recent window by default.
const JOB_LIMIT = 20;

export function JobsView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Match the Projects cadence: fast while work is running, relaxed when idle.
  // usePoll schedules the next read only after this one settles, so a slow
  // single-worker engine never receives a queue of overlapping /jobs calls.
  const pollMs = jobPollInterval(jobs);
  const poll = useCallback(() => listJobs().then((next) => { setJobs(next); setError(null); }).catch((cause) => { setError(readableError(cause)); }), []);
  const runPoll = usePoll(poll, pollMs);
  const load = () => { void runPoll(); };
  const action = async (job: Job, next: "pause" | "resume" | "retry-failed" | "retry-import") => { try { await controlJob(job.id, next); load(); } catch (cause) { setError(readableError(cause)); } };
  const running = jobs.some((job) => ["queued", "active", "paused", "stalled", "recovered"].includes(job.state));
  const description = jobs.length === 0 ? "No job history yet. Create a Clip or Script project to start a durable local render." : running ? "Live stages and partial results stay available here while completed history remains below." : "No jobs are currently running. Completed history and recovery controls remain available here.";
  return <div className="page jobs-page"><PageHeader eyebrow="Durable queue" title="Jobs & recovery" description={description} actions={<><span className="section-count">{jobs.length} total</span><Button onClick={load}><RefreshCw size={14} /> Refresh</Button></>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {jobs.length ? <><div className="jobs-list">{(showAll ? jobs : jobs.slice(0, JOB_LIMIT)).map((job) => <article className="job-card" key={job.id}><div className="job-mode">{job.mode === "clip" ? "CLIP" : "SCRIPT"}</div><div className="job-main">{(() => {
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
      })()}</div><div className="job-actions"><Button onClick={() => onOpenProject(job.projectId)}><ExternalLink size={14} /> Open</Button>{["active", "queued", "recovered"].includes(job.state) && <Button aria-label="Pause job" title="Pause job" onClick={() => action(job, "pause")}><Pause size={14} /></Button>}{job.state === "paused" && <Button aria-label="Resume job" title="Resume job" onClick={() => action(job, "resume")}><Play size={14} /></Button>}{job.clips.some((clip) => clip.state === "failed") && <Button aria-label="Retry failed clips" title="Retry failed clips" onClick={() => action(job, "retry-failed")}><RefreshCw size={14} /></Button>}{job.downloadProgress && ["failed", "stalled", "cancelled_kept"].includes(job.state) && <Button onClick={() => action(job, "retry-import")}><RefreshCw size={14} /> Retry import</Button>}</div></article>)}</div>
      {jobs.length > JOB_LIMIT && <button className="show-all-projects" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? `Show recent ${JOB_LIMIT}` : `Show all ${jobs.length} jobs`}</button>}</>
      : <EmptyState icon={<BriefcaseBusiness size={30} />} title="No jobs yet">Create a Clip or Script project. Live stages, partial results, recovery, and scoped retry will appear here.</EmptyState>}
  </div>;
}
