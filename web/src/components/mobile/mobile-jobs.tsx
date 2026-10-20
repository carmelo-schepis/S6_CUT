import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MobileOverview } from "../../types";
import { groupWarnings, sentenceCase } from "../../status-format";
import { Button, Progress, StatusBadge, formatAge } from "../common";
import { ProcessChecklist } from "../process-checklist";
import { groupFinishedByDay, outputsReady, workFacts, type WorkGroups, type WorkItem } from "./mobile-model";
import { ClipStrip, Poster, type OpenPreview } from "./mobile-parts";

/**
 * Work in flight, in up to three groups: what it is and how far along, the live
 * steps, and the clips finished so far. A wide screen sets the first two side
 * by side, so an entry with steps always fills the page width.
 */
function RunningEntry({ item, onPreview }: { item: WorkItem; onPreview: OpenPreview }) {
  const facts = workFacts(item);
  const [stepsOpen, setStepsOpen] = useState(true);
  const job = item.kind === "job" ? item.job : null;
  const steps = job && job.steps.length > 0 ? job.steps : null;
  const done = steps ? steps.filter((step) => step.status === "complete" || step.status === "skipped").length : 0;
  return <article className={steps ? "m-work m-work-split" : "m-work"} data-work-key={item.key}>
    <div className="m-work-summary">
      <div className="m-work-head">
        <Poster src={facts.poster} className="m-work-poster" />
        <div className="m-work-title">
          <strong className="m-clamp">{facts.title}</strong>
          {facts.subtitle && <span className="m-muted m-clamp-1">{facts.subtitle}</span>}
          <StatusBadge state={facts.state} />
        </div>
      </div>
      <Progress value={facts.percent} indeterminate={facts.indeterminate} label={facts.stage} />
      <p className="m-muted m-work-detail">{[facts.stage, facts.detail].filter(Boolean).join(" · ")}</p>
    </div>
    {job && steps && <div className="m-work-steps">
      <button type="button" className="m-toggle" aria-expanded={stepsOpen} onClick={() => setStepsOpen((open) => !open)}>
        {stepsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {stepsOpen ? "Hide steps" : "Show steps"}<span className="m-muted">{done} of {steps.length} done</span>
      </button>
      {stepsOpen && <ProcessChecklist steps={steps} jobState={job.state} compact label={`Steps for ${facts.title} (job ${job.id.slice(0, 8)})`} />}
    </div>}
    {job && job.clips.length > 0 && <div className="m-work-clips"><p className="m-muted m-work-detail">{job.clipsReady} clip{job.clipsReady === 1 ? "" : "s"} ready so far</p><ClipStrip clips={job.clips} onPreview={onPreview} label={`Finished clips for ${facts.title}`} /></div>}
  </article>;
}

function QueuedEntry({ item }: { item: WorkItem }) {
  const facts = workFacts(item);
  const position = item.kind === "job" && item.job.queuePosition ? `Position ${item.job.queuePosition} in the queue` : "Waiting for a free worker";
  return <div className="m-queued">
    <Poster src={facts.poster} />
    <span className="m-row-body"><strong className="m-clamp-1">{facts.title}</strong><span className="m-muted m-clamp-1">{position}</span></span>
    <StatusBadge state="queued" />
  </div>;
}

function FinishedEntry({ item, onPreview }: { item: WorkItem; onPreview: OpenPreview }) {
  const facts = workFacts(item);
  const [open, setOpen] = useState(false);
  const clips = item.kind === "job" ? item.job.clips : [];
  const summary = item.kind === "job"
    ? [sentenceCase(item.job.style), formatAge(item.at), outputsReady(item.job.clipsReady)].join(" · ")
    : ["Video download", formatAge(item.at)].join(" · ");
  const warning = item.kind === "job" ? groupWarnings(item.job.warnings)[0] : undefined;
  const note = item.kind === "job"
    ? item.job.error || (warning ? `${warning.scope ? `${warning.scope}: ` : ""}${warning.message}` : null)
    : item.task.error;
  const body = <>
    <Poster src={facts.poster} />
    <span className="m-row-body"><strong className="m-clamp">{facts.title}</strong><span className="m-muted m-clamp-1">{summary}</span></span>
    <StatusBadge state={facts.state} />
  </>;
  return <article className="m-done" data-work-key={item.key}>
    {clips.length > 0
      ? <button type="button" className="m-done-main" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{body}</button>
      : <div className="m-done-main">{body}</div>}
    {note && <p className="m-note m-muted">{note}</p>}
    {open && <ClipStrip clips={clips} onPreview={onPreview} label={`Clips from ${facts.title}`} />}
  </article>;
}

export function MobileJobs({ overview, groups, onPreview, onShowOlder, loadingOlder }: { overview: MobileOverview; groups: WorkGroups; onPreview: OpenPreview; onShowOlder: () => void; loadingOlder: boolean }) {
  const days = groupFinishedByDay(groups.finished);
  const total = overview.recentTotal + overview.running.length;
  const hasOlder = overview.recent.length < overview.recentTotal;
  const empty = !groups.running.length && !groups.queued.length && !groups.finished.length;
  return <div className="m-page m-jobs">
    <div className="m-page-head"><h1>Jobs</h1><span className="m-muted">{groups.running.length} running · {total} total</span></div>

    {groups.running.length > 0 && <section className="m-section" aria-labelledby="m-jobs-running">
      <div className="m-section-head"><h2 id="m-jobs-running">Running</h2><span className="m-count">{groups.running.length}</span></div>
      <div className="m-work-list">{groups.running.map((item) => <RunningEntry key={item.key} item={item} onPreview={onPreview} />)}</div>
    </section>}

    {groups.queued.length > 0 && <section className="m-section" aria-labelledby="m-jobs-queued">
      <div className="m-section-head"><h2 id="m-jobs-queued">Queued</h2><span className="m-count">{groups.queued.length}</span></div>
      <div className="m-list">{groups.queued.map((item) => <QueuedEntry key={item.key} item={item} />)}</div>
    </section>}

    {days.map(([day, items]) => <section className="m-section" key={day} aria-label={day}>
      <div className="m-section-head"><h2>{day}</h2></div>
      <div className="m-list">{items.map((item) => <FinishedEntry key={item.key} item={item} onPreview={onPreview} />)}</div>
    </section>)}

    {hasOlder && <div className="m-more"><Button disabled={loadingOlder} aria-busy={loadingOlder || undefined} onClick={onShowOlder}>{loadingOlder ? "Loading…" : `Show older jobs (${overview.recentTotal - overview.recent.length} more)`}</Button></div>}
    {empty && <p className="m-empty m-muted">No jobs yet. Jobs and downloads started in the desktop app appear here with live progress.</p>}
  </div>;
}
