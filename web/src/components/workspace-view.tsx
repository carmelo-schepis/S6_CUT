import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Captions, ChevronDown, Download, Eye, FileText, Film, Lock, Pause, Play, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, Volume2 } from "lucide-react";
import { controlJob, createZip, getJob, jobEventsUrl, readableError, setClipSelection } from "../api";
import { jobSchema, type Clip, type Job, type Project } from "../types";
import { Button, EmptyState, IconButton, Progress, StatusBadge, formatDuration } from "./common";

export function WorkspaceView({ project, onProjectUpdated, onGoProjects }: { project: Project | null; onProjectUpdated: () => Promise<void>; onGoProjects: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"score" | "captions" | "asset" | "info">("score");
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!project?.latestJobId) return;
    let disposed = false;
    const update = (next: Job) => {
      if (disposed) return;
      setJob(next);
      setSelectedClipId((current) => current && next.clips.some((clip) => clip.id === current) ? current : next.clips.find((clip) => clip.state === "complete")?.id || next.clips[0]?.id || null);
    };
    const fetchJob = () => getJob(project.latestJobId!).then(update).catch((cause) => !disposed && setError(readableError(cause)));
    fetchJob();
    const events = new EventSource(jobEventsUrl(project.latestJobId));
    events.onmessage = (event) => {
      try { update(jobSchema.parse(JSON.parse(event.data))); } catch { fetchJob(); }
    };
    events.onerror = () => {
      events.close();
      if (!pollingRef.current) pollingRef.current = window.setInterval(fetchJob, 2500);
    };
    return () => {
      disposed = true;
      events.close();
      if (pollingRef.current) window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    };
  }, [project?.id, project?.latestJobId]);

  const selectedClip = useMemo(() => job?.clips.find((clip) => clip.id === selectedClipId) || null, [job, selectedClipId]);
  const selectedIds = job?.clips.filter((clip) => clip.selected && clip.state === "complete").map((clip) => clip.id) || [];

  const act = async (action: "pause" | "resume" | "stop-keep" | "retry-failed") => {
    if (!job) return;
    setBusy(true);
    try { setJob(await controlJob(job.id, action)); await onProjectUpdated(); } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };

  const toggleClip = async (clip: Clip) => {
    if (!job) return;
    const next = job.clips.filter((item) => item.state === "complete" && (item.id === clip.id ? !item.selected : item.selected)).map((item) => item.id);
    setJob(await setClipSelection(job.id, next));
  };

  const exportSelected = async () => {
    if (!job || !selectedIds.length) return;
    setBusy(true);
    try {
      const result = await createZip(job.id, selectedIds);
      window.location.assign(result.downloadUrl);
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };

  if (!project) return <div className="page"><EmptyState icon={<SlidersHorizontal size={30} />} title="No project selected" action={<Button variant="primary" onClick={onGoProjects}>Choose a project</Button>}>Open a project to review its clips, score decisions, storyboard, and export state.</EmptyState></div>;

  return <div className="workspace-page">
    <div className="workspace-commandbar">
      <div><span className="mode-chip">{project.mode === "clip" ? <Film size={13} /> : <FileText size={13} />} {project.mode} mode</span><strong>{project.name}</strong><span className="muted">{project.style}</span></div>
      <div>
        {job && <StatusBadge state={job.state} label={job.stageLabel} />}
        {job && ["active", "queued", "recovered"].includes(job.state) && <Button disabled={busy} onClick={() => act("pause")}><Pause size={15} /> Pause</Button>}
        {job?.state === "paused" && <Button disabled={busy} onClick={() => act("resume")}><Play size={15} /> Resume</Button>}
        {job && job.clips.some((clip) => clip.state === "failed") && <Button disabled={busy} onClick={() => act("retry-failed")}><RefreshCw size={15} /> Retry failed</Button>}
        <Button variant="primary" disabled={!selectedIds.length || busy} onClick={exportSelected}><Download size={15} /> Download ZIP <span className="button-count">{selectedIds.length}</span></Button>
      </div>
    </div>

    {error && <div className="workspace-alert" role="alert"><AlertTriangle size={16} /> {error}<button onClick={() => setError(null)}>Dismiss</button></div>}
    {job && !["complete", "failed", "cancelled_kept"].includes(job.state) && <div className="job-strip"><div><strong>{job.stageLabel}</strong><span>{job.currentItem && job.totalItems ? ` · ${job.currentItem} of ${job.totalItems}` : ""}</span></div><Progress value={job.progress} label={job.stageLabel} /></div>}
    {job?.warnings.map((warning) => <div className="warning-strip" key={warning}><AlertTriangle size={14} /><span>{warning}</span></div>)}

    <div className="workspace-grid">
      <aside className="source-panel panel">
        <div className="panel-tabs"><button className="active">{project.mode === "clip" ? "Transcript" : "Script"}</button><button>Media</button></div>
        <div className="source-content">
          <div className="source-card"><div className="source-icon">{project.mode === "clip" ? <Film /> : <FileText />}</div><div><strong>{project.sourceName}</strong><span>{project.sourceKind} · preserved source</span></div></div>
          {project.mode === "clip" ? <div className="transcript-placeholder">
            {selectedClip ? <><span className="timecode">{formatDuration(selectedClip.start)}</span><p>{selectedClip.openingLine}</p><span className="timecode">{formatDuration(selectedClip.end)}</span><p className="muted">The complete canonical timed-word transcript remains in the engine project record. Select another clip to inspect its source range.</p></> : <p className="muted">Timed words will appear when transcription completes.</p>}
          </div> : <div className="beat-source-list">{job?.beats.map((beat) => <button key={beat.id}><span>{formatDuration(beat.start)}</span><p>{beat.text}</p></button>)}</div>}
        </div>
      </aside>

      <section className="viewer-panel panel" aria-label="Output viewer">
        <div className="viewer-toolbar"><span>Output · 9:16</span><div><IconButton label="Toggle safe areas"><Eye size={15} /></IconButton><IconButton label="Mute preview"><Volume2 size={15} /></IconButton></div></div>
        <div className="viewer-stage">
          <div className={`viewer-frame ${project.mode}`}>
            {selectedClip?.state === "complete" && selectedClip.downloadUrl ? <video key={selectedClip.downloadUrl} src={selectedClip.downloadUrl} controls preload="metadata" /> : <div className="viewer-placeholder">
              <div className="safe-area" />
              <img src="/app-icon.png" alt="" />
              <span>{job?.state === "failed" ? "Render unavailable" : job?.stageLabel || "Preparing project"}</span>
              {selectedClip?.visualLabel && <div className="visual-card"><Sparkles size={14} />{selectedClip.visualLabel}</div>}
              {selectedClip?.openingLine && <div className="caption-preview">{selectedClip.openingLine.split(" ").slice(0, 7).map((word, index) => <span className={index === 2 ? "active" : ""} key={`${word}-${index}`}>{word} </span>)}</div>}
            </div>}
          </div>
        </div>
        <div className="transport"><IconButton label="Previous frame"><RotateCcw size={15} /></IconButton><button className="play-button" aria-label="Play"><Play size={17} fill="currentColor" /></button><span className="transport-time">{selectedClip ? `${formatDuration(0)} / ${formatDuration(selectedClip.duration)}` : "0:00 / 0:00"}</span><div className="transport-spacer" /><span>J&nbsp; K&nbsp; L</span></div>
      </section>

      <aside className="inspector-panel panel">
        <div className="panel-title"><strong>Inspector</strong>{selectedClip && <span>Clip {selectedClip.index}</span>}</div>
        <div className="inspector-tabs">
          {(["score", "captions", "asset", "info"] as const).map((tab) => <button key={tab} className={inspectorTab === tab ? "active" : ""} onClick={() => setInspectorTab(tab)}>{tab}</button>)}
        </div>
        <div className="inspector-content">
          {inspectorTab === "score" && (selectedClip ? <ScoreInspector clip={selectedClip} /> : <p className="muted">Select a clip to inspect its auditable score.</p>)}
          {inspectorTab === "captions" && <><div className="inspector-section"><label>Preset</label><select defaultValue="editorial"><option value="editorial">Editorial highlight</option><option value="minimal">Minimal</option><option value="boxed">High contrast box</option></select></div><div className="inspector-note"><Captions size={15} /><span>Caption timing comes from local word timestamps. Preview and export use the same EDL model.</span></div></>}
          {inspectorTab === "asset" && <><div className="inspector-section"><label>Visual intention</label><strong>{selectedClip?.visualLabel || job?.beats[0]?.concept || "No visual beat selected"}</strong></div><div className="inspector-section"><label>Source</label><span>{selectedClip?.provenance[0]?.provider || job?.beats[0]?.source || "Text-card fallback"}</span></div><div className="inspector-note"><Sparkles size={15} /><span>{selectedClip?.provenance[0]?.matchReason || job?.beats[0]?.matchReason || "A relevant text card is preferred over unrelated media."}</span></div></>}
          {inspectorTab === "info" && <dl className="info-list"><dt>Project</dt><dd>{project.id.slice(0, 8)}</dd><dt>Job</dt><dd>{job?.id.slice(0, 8) || "—"}</dd><dt>Mode</dt><dd>{project.mode}</dd><dt>Style</dt><dd>{project.style}</dd><dt>Source</dt><dd>{project.sourceKind}</dd><dt>Storage</dt><dd>Mounted local data</dd></dl>}
        </div>
      </aside>
    </div>

    <section className="board-panel panel">
      <div className="board-header"><div><strong>{project.mode === "clip" ? "Clip board" : "Beat board"}</strong><span>{project.mode === "clip" ? `${job?.clips.length || 0} planned · ${job?.clips.filter((clip) => clip.state === "complete").length || 0} ready` : `${job?.beats.length || 0} visual beats`}</span></div><div className="board-filters"><button className="active">All</button><button>Selected</button><button>Failed</button></div></div>
      {project.mode === "clip" ? <div className="clip-board">{job?.clips.map((clip) => <article key={clip.id} className={`clip-tile ${selectedClipId === clip.id ? "active" : ""} ${clip.state}`} onClick={() => setSelectedClipId(clip.id)}>
        <div className="clip-thumb"><span className="clip-number">{String(clip.index).padStart(2, "0")}</span>{clip.state === "complete" ? <><Film size={24} /><span className="score-ring">{Math.round(clip.score.total)}</span></> : clip.state === "failed" ? <AlertTriangle size={24} /> : <RefreshCw size={24} className="spin" />}</div>
        <div className="clip-tile-body"><strong>{clip.openingLine || `Candidate ${clip.index}`}</strong><span>{formatDuration(clip.duration)} · {clip.state}</span><label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={clip.selected} disabled={clip.state !== "complete"} onChange={() => toggleClip(clip)} /> Include in export</label></div>
      </article>) || <div className="board-placeholder">Candidates appear here after local transcription and selection.</div>}</div>
        : <div className="beat-board">{job?.beats.map((beat, index) => <article key={beat.id} className="beat-tile"><div className="beat-visual"><span>{String(index + 1).padStart(2, "0")}</span><Sparkles size={22} /></div><div><strong>{beat.concept}</strong><p>{beat.text}</p><span>{formatDuration(beat.start)}–{formatDuration(beat.end)} · {beat.source} · {Math.round(beat.confidence * 100)}%</span></div><StatusBadge state={beat.source === "library" ? "ready" : "fallback"} label={beat.ruleState || beat.source} /></article>)}</div>}
    </section>

    <section className={`timeline-panel panel ${timelineOpen ? "open" : "closed"}`}>
      <button className="timeline-toggle" onClick={() => setTimelineOpen(!timelineOpen)} aria-expanded={timelineOpen}><div><ChevronDown size={15} /><strong>Layered timeline</strong><span>EDL v1 · preview/export parity</span></div><span>{timelineOpen ? "Collapse" : "Expand"}</span></button>
      {timelineOpen && <Timeline clip={selectedClip} />}
    </section>
  </div>;
}

function ScoreInspector({ clip }: { clip: Clip }) {
  const factors = [
    ["Hook", clip.score.hook], ["Coherence", clip.score.coherence], ["Ending", clip.score.ending],
    ["Energy", clip.score.energy], ["Practical value", clip.score.practicalValue], ["Visual potential", clip.score.visualPotential], ["Completeness", clip.score.completeness],
  ] as const;
  return <><div className="score-total"><span>{Math.round(clip.score.total)}</span><div><strong>Selection score</strong><small>Deterministic local model</small></div></div><p className="score-explanation">{clip.score.explanation}</p><div className="factor-list">{factors.map(([label, value]) => <div key={label}><span>{label}</span><div><i style={{ width: `${value}%` }} /></div><strong>{Math.round(value)}</strong></div>)}</div>{clip.score.penalties > 0 && <div className="penalty"><AlertTriangle size={14} /> Penalties −{Math.round(clip.score.penalties)}</div>}</>;
}

function Timeline({ clip }: { clip: Clip | null }) {
  const duration = clip?.duration || 30;
  const lanes = [
    { id: "V1", name: "Source", icon: <Film size={13} />, fill: "source", width: "100%" },
    { id: "O2", name: "Visuals", icon: <Sparkles size={13} />, fill: "visuals", width: clip?.visualLabel ? "33%" : "0%" },
    { id: "C1", name: "Captions", icon: <Captions size={13} />, fill: "captions", width: "92%" },
    { id: "A1", name: "Speech", icon: <Volume2 size={13} />, fill: "speech", width: "100%" },
  ];
  return <div className="timeline"><div className="timeline-ruler"><span /><div>{[0, .25, .5, .75, 1].map((part) => <i key={part} style={{ left: `${part * 100}%` }}>{formatDuration(duration * part)}</i>)}</div></div>{lanes.map((lane) => <div className="timeline-lane" key={lane.id}><div className="lane-label"><span>{lane.id}</span>{lane.icon}<strong>{lane.name}</strong><Lock size={11} /></div><div className="lane-track"><div className={`timeline-block ${lane.fill}`} style={{ width: lane.width }}>{lane.width !== "0%" && <span>{lane.name === "Visuals" ? clip?.visualLabel : lane.name}</span>}</div></div></div>)}<div className="playhead" style={{ left: "38%" }} /></div>;
}
