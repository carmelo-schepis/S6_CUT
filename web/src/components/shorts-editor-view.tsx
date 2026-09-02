import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CircleStop, Clock3, Film, Maximize2, MessageSquare, Pause, Play, RefreshCw, RotateCcw, Scissors, Send, Sparkles, Volume2, WandSparkles, X } from "lucide-react";
import { controlJob, createShortsJob, createShortsSourceJob, listAssets, listJobs, readableError, retryClip } from "../api";
import type { Clip, Job, LibraryAsset } from "../types";
import { Button, StatusBadge, formatDimensions, formatDuration } from "./common";
import { VideoSourcePicker, type VideoSourceMode } from "./video-source-picker";

const aspects = ["9:16", "16:9", "1:1", "4:5"] as const;
type AspectRatio = typeof aspects[number];
type EditState = { start: number; end?: number; aspect: AspectRatio; subtitles: boolean; projectName?: string };
type ClipRow = { job: Job; clip: Clip };
type AssistantMessage = { id: number; role: "assistant" | "user"; text: string };
type AssistantEdit = { edit: Partial<EditState>; explanation: string };

function sameEditState(left: EditState, right: EditState) {
  return left.start === right.start && left.end === right.end && left.aspect === right.aspect && left.subtitles === right.subtitles && (left.projectName || "") === (right.projectName || "");
}

function clipStatus(clip: Clip, job: Job) {
  if (clip.state === "complete") return "complete";
  if (clip.state === "failed") return "failed";
  if (job.state === "paused") return "paused";
  return clip.state === "rendering" ? "rendering" : "queued";
}

export function parseAssistantRequest(text: string, current: EditState): { edit?: Partial<EditState>; proposal?: AssistantEdit; explanation: string; unsupported?: boolean } {
  const value = text.toLowerCase();
  const edit: Partial<EditState> = {};
  const proposalIntent = /\b(propose|suggest|preview|recommend)\b/.test(value) || /\b(?:without|don't|do not|not)\s+(?:applying|apply|changing|change|making|make)\b/.test(value);
  const seconds = value.match(/(?:make|trim|duration|length)[^\d]*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)/);
  const forward = value.match(/start[^\d]*(?:forward|later|ahead)[^\d]*(\d+(?:\.\d+)?)/);
  if (seconds) { edit.end = current.start + Number(seconds[1]); }
  if (forward) { edit.start = current.start + Number(forward[1]); if (current.end !== undefined) edit.end = Math.max(current.start + Number(forward[1]) + .1, current.end); }
  const explicitStart = value.match(/start(?:\s+at|\s*:)?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/);
  const explicitEnd = value.match(/end(?:\s+at|\s*:)?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/);
  if (explicitStart) edit.start = Number(explicitStart[1]);
  if (explicitEnd) edit.end = Number(explicitEnd[1]);
  const aspect = value.match(/(?:use|make|set)?\s*(9:16|16:9|1:1|4:5)/);
  if (aspect) edit.aspect = aspect[1] as AspectRatio;
  if (value.includes("bold subtitles") || value.includes("add subtitles") || value.includes("captions")) edit.subtitles = true;
  if (value.includes("centre the speaker") || value.includes("center the speaker") || value.includes("remove the silent")) {
    return { explanation: "That request needs subject tracking or speech analysis that is not exposed by Shorts Editor yet.", unsupported: true };
  }
  if (!Object.keys(edit).length) return { explanation: "I can safely change duration, start/end seconds, aspect ratio, or subtitle preference locally.", unsupported: true };
  const explanation = `Proposed change: ${Object.entries(edit).map(([key, item]) => `${key} → ${item}`).join(" · ")}.`;
  return proposalIntent
    ? { proposal: { edit, explanation }, explanation: `${explanation} Nothing changed. Apply it when you are ready.` }
    : { edit, explanation };
}

export function ShortsEditorView({ onJobCreated }: { onJobCreated: () => void }) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [assetId, setAssetId] = useState("");
  const [mode, setMode] = useState<VideoSourceMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [subtitles, setSubtitles] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [savedBaseline, setSavedBaseline] = useState<EditState>({ start: 0, end: undefined, aspect: "9:16", subtitles: true, projectName: "" });
  const [history, setHistory] = useState<EditState[]>([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([{ id: 1, role: "assistant", text: "Describe a safe trim or aspect-ratio change. I will propose the edit before applying it." }]);
  const [pendingProposal, setPendingProposal] = useState<AssistantEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const objectUrl = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextAssets, nextJobs] = await Promise.all([listAssets(), listJobs()]);
      setAssets(nextAssets.filter((item) => item.mediaType.toLowerCase().startsWith("video/")));
      setJobs(nextJobs.filter((job) => job.mode === "clip"));
      setError(null);
    } catch (cause) { setError(readableError(cause)); }
  }, []);
  useEffect(() => { queueMicrotask(() => void refresh()); return () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [refresh]);

  const rows = useMemo<ClipRow[]>(() => jobs.flatMap((job) => job.clips.map((clip) => ({ job, clip }))).filter(({ clip, job }) => filter === "all" || clipStatus(clip, job) === filter), [filter, jobs]);
  const selectedRow = rows.find(({ clip }) => clip.id === selectedClipId) || jobs.flatMap((job) => job.clips.map((clip) => ({ job, clip }))).find(({ clip }) => clip.id === selectedClipId);
  const contextName = selectedRow ? selectedRow.clip.title || `Clip ${String(selectedRow.clip.index).padStart(2, "0")}` : file?.name || assets.find((item) => item.id === assetId)?.title || (url ? "YouTube source" : "No clip selected");

  useEffect(() => {
    if (!file) return;
    const nextUrl = URL.createObjectURL(file);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = nextUrl;
    queueMicrotask(() => setPreviewUrl(nextUrl));
    return () => { URL.revokeObjectURL(nextUrl); if (objectUrl.current === nextUrl) objectUrl.current = null; };
  }, [file]);

  const selectClip = (row: ClipRow) => {
    if (dirty && !window.confirm("Discard unsaved Shorts Editor changes?")) return;
    setSelectedClipId(row.clip.id);
    const nextAspect = row.clip.width && row.clip.height && row.clip.width / row.clip.height < 1 ? "9:16" : aspect;
    const nextBaseline = { start: row.clip.start, end: row.clip.end, aspect: nextAspect, subtitles: row.job.burnSubtitles !== false, projectName: "" } as EditState;
    setStart(String(nextBaseline.start)); setEnd(String(nextBaseline.end));
    setAspect(nextBaseline.aspect); setSavedBaseline(nextBaseline); setHistory([]);
    if (row.clip.previewUrl || row.clip.downloadUrl) setPreviewUrl(row.clip.previewUrl || row.clip.downloadUrl || null);
    setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: `Context switched to ${row.clip.title || `Clip ${row.clip.index}`}.` }]);
  };

  const updateEdit = (next: Partial<EditState>) => {
    setHistory((current) => [...current.slice(-9), editState]);
    if (next.start !== undefined) setStart(String(next.start));
    if ("end" in next) setEnd(next.end === undefined ? "" : String(next.end));
    if (next.aspect !== undefined) setAspect(next.aspect);
    if (next.subtitles !== undefined) setSubtitles(next.subtitles);
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setStart(String(previous.start)); setEnd(previous.end === undefined ? "" : String(previous.end)); setAspect(previous.aspect); setSubtitles(previous.subtitles); setProjectName(previous.projectName || "");
    setHistory((current) => current.slice(0, -1));
  };

  const loadFile = (next: File | null, pickerError?: string) => { setFile(next); setError(pickerError || null); if (next) { setMode("file"); setSelectedClipId(null); setSavedBaseline(editState); setHistory([]); } };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault(); if (assistantBusy) return;
    setError(null); setStatus("");
    const from = Number(start); const to = end.trim() === "" ? undefined : Number(end);
    if (!Number.isFinite(from) || from < 0) return setError("Start seconds must be a finite number at least 0.");
    if (to !== undefined && (!Number.isFinite(to) || to <= from)) return setError("End seconds must be blank or greater than start.");
    if (mode === "file" && !file) return setError("Choose a local video first.");
    if (mode === "url" && !url.trim()) return setError("Paste a supported YouTube URL first.");
    if (mode === "library" && !assetId) return setError("Choose a Library video first.");
    setAssistantBusy(true);
    try {
      setStatus(mode === "file" ? "Uploading and validating source…" : mode === "url" ? "Importing and validating YouTube source…" : "Validating Library source…");
      if (mode === "library") await createShortsJob({ assetId, name: projectName.trim() || undefined, burnSubtitles: subtitles, start: from, end: to, aspectRatio: aspect });
      else await createShortsSourceJob({ file: mode === "file" ? file || undefined : undefined, url: mode === "url" ? url.trim() : undefined, name: projectName.trim() || undefined, burnSubtitles: subtitles, start: from, end: to, aspectRatio: aspect });
      setStatus("Short queued successfully."); setSavedBaseline(editState); setHistory([]); await refresh(); onJobCreated();
    } catch (cause) { setError(readableError(cause)); setStatus(""); } finally { setAssistantBusy(false); }
  };

  const sendAssistant = async (event?: FormEvent) => {
    event?.preventDefault(); const text = assistantInput.trim(); if (!text || assistantBusy) return;
    setAssistantInput(""); setAssistantMessages((current) => [...current, { id: Date.now(), role: "user", text }]); setAssistantBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const parsed = parseAssistantRequest(text, editState);
    if (parsed.unsupported) setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: parsed.explanation }]);
    else if (parsed.proposal) {
      setPendingProposal(parsed.proposal);
      setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: parsed.explanation }]);
    } else {
      updateEdit(parsed.edit || {});
      setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: `${parsed.explanation} Applied locally. Queue the short to render this edit.` }]);
    }
    setAssistantBusy(false);
  };

  const seek = (value: number) => { setCurrentTime(value); if (videoRef.current) videoRef.current.currentTime = value; };
  const togglePlay = () => { if (!videoRef.current) return; if (videoRef.current.paused) { void videoRef.current.play(); setPlaying(true); } else { videoRef.current.pause(); setPlaying(false); } };
  const sourcePreview = previewUrl || (mode === "library" ? assets.find((item) => item.id === assetId)?.previewUrl || null : null);
  const editState: EditState = { start: Number(start) || 0, end: end.trim() ? Number(end) : undefined, aspect, subtitles, projectName };
  const dirty = !sameEditState(editState, savedBaseline);
  const applyProposal = () => {
    if (!pendingProposal) return;
    updateEdit(pendingProposal.edit);
    setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: `${pendingProposal.explanation} Applied locally. Queue the short to render this edit.` }]);
    setPendingProposal(null);
  };

  return <div className="page shorts-workspace-page">
    <form className="shorts-workspace-form" onSubmit={submit}>
    <header className="shorts-workspace-header"><div><div className="eyebrow">Native editing workflow</div><h1>Shorts Editor</h1><p>Turn an authorised video from your Library, a local file, or a supported YouTube URL into a social-ready clip. Choose the exact section, output shape, and subtitle setting, then queue it for rendering in S6_cut.</p></div><div className="shorts-header-actions"><span className={dirty ? "edit-state dirty" : "edit-state"}>{dirty ? "Unsaved edits" : "All changes saved"}</span>{history.length > 0 && <Button type="button" onClick={undo}><RotateCcw size={14} /> Undo</Button>}<Button type="submit" variant="primary" disabled={assistantBusy}><Scissors size={14} /> Queue short</Button></div></header>
    {error && <div className="shorts-global-alert" role="alert"><X size={16} />{error}</div>}
    <main className="shorts-workspace" aria-label="Shorts Editor workspace">
      <section className="shorts-editor-panel" aria-labelledby="editor-panel-title">
        <div className="workspace-panel-heading"><div><span className="panel-kicker">Editor</span><h2 id="editor-panel-title">{contextName}</h2></div><StatusBadge state={selectedRow ? selectedRow.job.state : "local"} label={selectedRow ? selectedRow.job.stageLabel : "Source ready"} /></div>
        {!sourcePreview && <div className="shorts-source-empty"><div className="empty-icon"><Film size={28} /></div><h3>Bring a source into the editor</h3><p>Choose a local file, authorised YouTube URL, or a video from your Library.</p><VideoSourcePicker mode={mode} onModeChange={setMode} file={file} onFile={loadFile} url={url} onUrl={setUrl}><div className="field"><label className="field-label" htmlFor="shorts-source">Library video</label><select id="shorts-source" value={assetId} onChange={(event) => setAssetId(event.target.value)} disabled={!assets.length}><option value="">{assets.length ? "Select Library video" : "No Library videos available"}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><small>{assets.length ? "Private media stays on this machine." : "Add a video in Library first."}</small></div></VideoSourcePicker><div className="trim-inputs shorts-empty-trim"><label>Start <input aria-label="Start seconds" type="number" min="0" step=".1" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>End <input aria-label="End seconds" type="number" min="0" step=".1" value={end} onChange={(event) => setEnd(event.target.value)} placeholder="Source remainder" /></label></div></div>}
        {sourcePreview && <div className="video-editing-stage"><div className={`shorts-video-frame aspect-${aspect.replace(":", "-")}`}><video ref={videoRef} src={sourcePreview} onLoadedMetadata={(event) => setSourceDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} controls={false} /></div><div className="video-controls"><button type="button" className="icon-button" onClick={togglePlay} aria-label={playing ? "Pause preview" : "Play preview"}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><span className="video-time">{formatDuration(currentTime)} / {formatDuration(sourceDuration || Number(end) || 0)}</span><input aria-label="Preview position" type="range" min="0" max={sourceDuration || 1} step=".1" value={Math.min(currentTime, sourceDuration || 1)} onChange={(event) => seek(Number(event.target.value))} /><button type="button" className="icon-button" aria-label="Preview volume"><Volume2 size={16} /></button><button type="button" className="icon-button" aria-label="Expand preview"><Maximize2 size={16} /></button></div><div className="timeline-wrap"><div className="timeline-label"><span>Trim range</span><span>{formatDuration(Number(start) || 0)} – {end ? formatDuration(Number(end)) : "source end"}</span></div><input className="timeline-range" aria-label="Trim start" type="range" min="0" max={sourceDuration || 1} step=".1" value={Math.min(Number(start) || 0, sourceDuration || 1)} onChange={(event) => updateEdit({ start: Number(event.target.value) })} /><div className="trim-inputs"><label>Start <input aria-label="Start seconds" type="number" min="0" step=".1" value={start} onChange={(event) => updateEdit({ start: Number(event.target.value) })} /></label><label>End <input aria-label="End seconds" type="number" min="0" step=".1" value={end} onChange={(event) => { const value = event.target.value; updateEdit({ end: value.trim() ? Number(value) : undefined }); }} placeholder="Source end" /></label><label>Aspect <select aria-label="Aspect ratio" value={aspect} onChange={(event) => updateEdit({ aspect: event.target.value as AspectRatio })}>{aspects.map((value) => <option key={value}>{value}</option>)}</select></label></div><div className="editor-options"><label className="shorts-project-name">Project name <input value={projectName} maxLength={160} onChange={(event) => { setHistory((current) => [...current.slice(-9), editState]); setProjectName(event.target.value); }} placeholder="Optional project name" /></label><label><input type="checkbox" checked={subtitles} onChange={(event) => updateEdit({ subtitles: event.target.checked })} /> Subtitles</label><span>{mode === "url" ? "YouTube preview becomes available after import." : file ? file.name : "Library source"}</span><Button type="button" onClick={() => { setPreviewUrl(null); setFile(null); }}>Change source</Button></div></div></div>}
        {status && <div className="shorts-inline-status" role="status"><Clock3 size={15} />{status}</div>}
      </section>
      <aside className="shorts-right-column">
        <section className="shorts-clips-panel" aria-labelledby="clips-panel-title"><div className="workspace-panel-heading"><div><span className="panel-kicker">Project output</span><h2 id="clips-panel-title">Clips <span className="count-pill">{rows.length}</span></h2></div><select aria-label="Filter clips" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All clips</option><option value="queued">Queued</option><option value="rendering">Rendering</option><option value="complete">Complete</option><option value="failed">Failed</option></select></div><div className="clip-browser">{rows.length ? rows.map((row) => <ClipBrowserItem key={`${row.job.id}-${row.clip.id}`} row={row} active={row.clip.id === selectedClipId} onSelect={() => selectClip(row)} onRetry={() => void retryClip(row.job.id, row.clip.id).then(refresh).catch((cause) => setError(readableError(cause)))} onStop={() => void controlJob(row.job.id, "stop-keep").then(refresh).catch((cause) => setError(readableError(cause)))} />) : <div className="clips-empty"><Film size={24} /><strong>No clips yet</strong><span>Queue a source from the editor and its durable render will appear here.</span></div>}</div></section>
        <section className="shorts-assistant-panel" aria-labelledby="assistant-panel-title"><div className="workspace-panel-heading"><div><span className="panel-kicker">Safe local controls</span><h2 id="assistant-panel-title"><WandSparkles size={17} /> AI editing assistant</h2></div><span className="assistant-context">{contextName}</span></div><div className="assistant-messages" aria-live="polite">{assistantMessages.map((message) => <div key={message.id} className={`assistant-message ${message.role}`}><span>{message.role === "assistant" ? <Sparkles size={13} /> : <MessageSquare size={13} />}</span><p>{message.text}</p></div>)}</div>{pendingProposal && <div className="assistant-proposal" role="status"><strong>Proposal ready</strong><span>{pendingProposal.explanation}</span><div><Button type="button" variant="primary" onClick={applyProposal}>Apply proposal</Button><Button type="button" onClick={() => setPendingProposal(null)}>Reject</Button></div></div>}<div className="assistant-composer"><input aria-label="Editing request" value={assistantInput} onChange={(event) => setAssistantInput(event.target.value)} placeholder="Ask for a trim or aspect change…" disabled={assistantBusy} /><button type="button" onClick={() => void sendAssistant()} aria-label="Send editing request" disabled={assistantBusy || !assistantInput.trim()}><Send size={16} /></button></div><small className="assistant-note">Requests are parsed into bounded edits; shell commands and secret configuration are never exposed.</small></section>
      </aside>
    </main>
    </form>
  </div>;
}

function ClipBrowserItem({ row, active, onSelect, onRetry, onStop }: { row: ClipRow; active: boolean; onSelect: () => void; onRetry: () => void; onStop: () => void }) {
  const status = clipStatus(row.clip, row.job);
  return <article className={`clip-browser-item ${active ? "active" : ""}`}><button type="button" className="clip-select-button" onClick={onSelect}><div className="clip-browser-thumb">{row.clip.previewUrl || row.clip.downloadUrl ? <video src={row.clip.previewUrl || row.clip.downloadUrl || undefined} muted preload="metadata" /> : <Film size={20} />}<span>{String(row.clip.index).padStart(2, "0")}</span></div><div className="clip-browser-info"><strong>{row.clip.title || `Clip ${String(row.clip.index).padStart(2, "0")}`}</strong><span>{formatDuration(row.clip.duration)} · {formatDuration(row.clip.start)}–{formatDuration(row.clip.end)} · {formatDimensions(row.job.processingMode === "fast" ? "9:16" : "9:16", row.clip.width, row.clip.height)}</span><span className="clip-subtitle-state"><Check size={12} /> {row.job.burnSubtitles === false ? "Subtitles off" : "Subtitles enabled"}</span></div></button><div className="clip-browser-actions"><StatusBadge state={status === "complete" ? "complete" : status === "failed" ? "failed" : "active"} label={status} />{status === "failed" && <button type="button" className="icon-button" onClick={onRetry} aria-label="Retry failed clip"><RefreshCw size={14} /></button>}{["queued", "rendering", "active"].includes(status) && <button type="button" className="icon-button" onClick={onStop} aria-label="Stop clip and keep completed outputs"><CircleStop size={14} /></button>}</div></article>;
}
