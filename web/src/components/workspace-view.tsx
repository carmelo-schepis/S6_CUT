import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Captions, Check, Clock, Download, Eye, FileText, Film, Pause, Play, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, Square, Volume2, Zap } from "lucide-react";
import { changeProjectFolder, controlJob, createZip, getJob, jobEventsUrl, listAssets, listFolders, readableError, retryClip, setClipSelection } from "../api";
import { emitLibraryChanged } from "../library-sync";
import { jobSchema, type Clip, type Health, type Job, type LibraryAsset, type LibraryFolder, type Project } from "../types";
import { Button, EmptyState, IconButton, Progress, Skeleton, StatusBadge, WarningList, formatBytes, formatDimensions, formatDuration, resolveOutputAspectRatio, useSingleFlight } from "./common";
import { jobFacts } from "../status-format";
import { isTerminalJob, ProcessingState } from "./processing-state";
import { ProcessChecklist } from "./process-checklist";

function folderName(folderId: string | null | undefined, folders: LibraryFolder[], project: Project | null): string {
  if (!folderId) {
    // Fall back to project-level folder selection
    const pf = project?.libraryFolderId;
    if (pf) {
      const match = folders.find((f) => f.id === pf);
      if (match) return match.name;
    }
    return "Unsorted";
  }
  const match = folders.find((f) => f.id === folderId);
  return match?.name || "Unsorted";
}

function ClipThumb({ clip }: { clip: Clip }) {
  const [failed, setFailed] = useState(false);
  // Try previewUrl first, then downloadUrl as fallback
  const src = clip.previewUrl || clip.downloadUrl;
  if (src && !failed) {
    return (
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        className="clip-thumbnail"
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <>
      <Film size={24} />
      {failed && (
        <button
          className="clip-thumb-retry"
          aria-label="Retry preview"
          onClick={(e) => { e.stopPropagation(); setFailed(false); }}
        >
          <RefreshCw size={12} />
        </button>
      )}
    </>
  );
}

export function WorkspaceView({ project, health, providersLoaded = true, hasSelectedProvider = true, onConfigureProviders = () => undefined, onProjectUpdated, onGoProjects }: { project: Project | null; health?: Health | null; providersLoaded?: boolean; hasSelectedProvider?: boolean; onConfigureProviders?: () => void; onProjectUpdated: () => Promise<void>; onGoProjects: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  // Until the first job response lands the view must not claim "0 clips" or
  // "Preparing project" — the job may already be rendering.
  const [jobFetched, setJobFetched] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<"transcript" | "media">("transcript");
  const [mediaAssets, setMediaAssets] = useState<LibraryAsset[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [detailsTab, setDetailsTab] = useState<"score" | "captions" | "asset" | "info">("score");
  const [boardFilter, setBoardFilter] = useState<"all" | "selected" | "failed">("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingForEngine, setWaitingForEngine] = useState(false);
  const [subscriptionNonce, setSubscriptionNonce] = useState(0);
  const [providerCalloutDismissed, setProviderCalloutDismissed] = useState(false);
  const [stalledCalloutDismissed, setStalledCalloutDismissed] = useState(false);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [previewSource, setPreviewSource] = useState<{ identity: string; url: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [previewStall, setPreviewStall] = useState(false);
  const [previewRetryCount, setPreviewRetryCount] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [safeAreasVisible, setSafeAreasVisible] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const previewStallRef = useRef(false);
  const playbackWatchdogRef = useRef<number | null>(null);
  const clearPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdogRef.current !== null) {
      window.clearInterval(playbackWatchdogRef.current);
      playbackWatchdogRef.current = null;
    }
  }, []);
  const startPlaybackWatchdog = useCallback(() => {
    clearPlaybackWatchdog();
    const player = playerRef.current;
    if (!player) return;
    let lastTime = player.currentTime;
    let lastProgressAt = Date.now();
    playbackWatchdogRef.current = window.setInterval(() => {
      const current = playerRef.current;
      if (current !== player || player.paused || player.ended || player.readyState < 3) {
        clearPlaybackWatchdog();
        return;
      }
      const now = Date.now();
      if (player.currentTime - lastTime >= 0.05) {
        lastTime = player.currentTime;
        lastProgressAt = now;
      } else if (now - lastProgressAt >= 2500) {
        clearPlaybackWatchdog();
        previewStallRef.current = true;
        player.pause();
        setPreviewLoading(false);
        setPreviewPlaying(false);
        setPreviewStall(true);
      }
    }, 250);
  }, [clearPlaybackWatchdog]);
  const pollingRef = useRef<number | null>(null);
  const mediaLoadedKey = useRef<string | null>(null);
  // Track the previous clip states so we can detect new publications
  // and emit a library-changed signal for cross-view revalidation.
  // DO-NOT-CHANGE: this publication detection emits library-changed when a clip completes;
  // the Library screen depends on it for cross-view consistency
  const prevClipStates = useRef<Map<string, Clip["state"]>>(new Map());
  const jobRef = useRef<Job | null>(null);
  const notifiedTerminal = useRef<string | null>(null);
  const singleFlight = useSingleFlight();
  const onProjectUpdatedRef = useRef(onProjectUpdated);

  useEffect(() => { onProjectUpdatedRef.current = onProjectUpdated; }, [onProjectUpdated]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    void listFolders().then(setFolders).catch(() => undefined);
    return () => clearInterval(timer);
  }, []);

  const isStalledSmart = Boolean(
    job &&
    job.processingMode === "smart" &&
    job.state === "active" &&
    !stalledCalloutDismissed &&
    now - new Date(job.updatedAt).getTime() > 90_000,
  );

  useEffect(() => {
    const jobId = project?.latestJobId;
    if (!jobId) return;
    const currentJobId = jobId;
    let disposed = false;
    let terminal = false;
    let polling = false;
    let backoff = 1000;
    let lastUpdatedAt = jobRef.current?.updatedAt || "";
    const update = (next: Job) => {
      if (disposed || (lastUpdatedAt && next.updatedAt < lastUpdatedAt)) return;
      lastUpdatedAt = next.updatedAt;
      const wasTerminal = terminal;
      terminal = isTerminalJob(next);
      if (terminal && !wasTerminal && notifiedTerminal.current !== next.id) {
        notifiedTerminal.current = next.id;
        void onProjectUpdatedRef.current();
      }
      setWaitingForEngine(false);
      setJobFetched(true);
      // Detect newly completed clips and emit library-changed signal
      const prev = jobRef.current;
      if (prev) {
        for (const clip of next.clips) {
          const prevState = prevClipStates.current.get(clip.id);
          if (prevState !== "complete" && clip.state === "complete") {
            // A clip just became complete — library data may have changed
            emitLibraryChanged();
            break;
          }
        }
      }
      // Update stored clip states
      for (const clip of next.clips) {
        prevClipStates.current.set(clip.id, clip.state);
      }
      jobRef.current = next;
      setJob(next);
      setSelectedClipId((current) => {
        const currentClip = next.clips.find((clip) => clip.id === current);
        if (currentClip?.state === "complete") return current;
        return next.clips.find((clip) => clip.state === "complete")?.id || currentClip?.id || next.clips[0]?.id || null;
      });
    };
    function schedulePoll(delay: number) {
      if (disposed || terminal || pollingRef.current) return;
      pollingRef.current = window.setTimeout(() => { pollingRef.current = null; void fetchJob(); }, delay);
    }
    async function fetchJob() {
      try {
        update(await getJob(currentJobId));
        backoff = 1000;
        if (polling && !terminal) schedulePoll(2500);
      } catch {
        if (disposed) return;
        polling = true;
        setJobFetched(true);
        setWaitingForEngine(true);
        schedulePoll(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
    void fetchJob();
    const events = new EventSource(jobEventsUrl(currentJobId));
    events.onmessage = (event) => {
      try { update(jobSchema.parse(JSON.parse(event.data))); } catch { void fetchJob(); }
    };
    events.onerror = () => {
      // Keep EventSource open so the browser can perform its native reconnect.
      // Polling remains an immediate durable-state fallback.
      if (!terminal) {
        polling = true;
        setWaitingForEngine(true);
        schedulePoll(backoff);
      }
    };
    return () => {
      disposed = true;
      events.close();
      if (pollingRef.current) window.clearTimeout(pollingRef.current);
      pollingRef.current = null;
    };
  }, [project?.id, project?.latestJobId, subscriptionNonce]);

  const jobLoaded = jobFetched || !project?.latestJobId;

  const selectedClip = useMemo(() => job?.clips.find((clip) => clip.id === selectedClipId) || null, [job, selectedClipId]);
  // "Selected" means the export selection the Include-in-export checkbox drives,
  // so the filter reads the same flag the ZIP builder does.
  const boardClips = useMemo(() => (job?.clips || []).filter((clip) => (
    boardFilter === "all" ? true : boardFilter === "failed" ? clip.state === "failed" : clip.selected
  )), [boardFilter, job]);
  // Read the publication snapshot, not merely source kind: this prevents old
  // uncredited clips from being presented as if their bytes carried credit.
  const creatorCredit = selectedClip?.creatorCredit || null;
  const selectedPreviewUrl = selectedClip?.previewUrl || selectedClip?.downloadUrl;
  const selectedMediaIdentity = selectedClip?.state === "complete" && selectedPreviewUrl
    ? `${selectedClip.id}:${selectedClip.blobId || selectedClip.outputName || selectedPreviewUrl.split("?")[0]}`
    : null;

  useEffect(() => {
    if (!selectedClip || selectedClip.state !== "complete" || !selectedPreviewUrl || !selectedMediaIdentity) {
      queueMicrotask(() => {
        setPreviewSource(null);
        setPreviewLoading(false);
        setPreviewError(false);
        previewStallRef.current = false;
        setPreviewStall(false);
        setPreviewRetryCount(0);
        clearPlaybackWatchdog();
      });
      return;
    }
    if (previewSource?.identity === selectedMediaIdentity) return;
    clearPlaybackWatchdog();
    queueMicrotask(() => {
      setPreviewSource({ identity: selectedMediaIdentity, url: selectedPreviewUrl });
      setPreviewLoading(true);
      setPreviewError(false);
      previewStallRef.current = false;
      setPreviewStall(false);
      setPreviewRetryCount(0);
      setPreviewPlaying(false);
      setPreviewTime(0);
    });
  }, [clearPlaybackWatchdog, previewSource, selectedClip, selectedMediaIdentity, selectedPreviewUrl]);

  useEffect(() => clearPlaybackWatchdog, [clearPlaybackWatchdog]);

  const refreshPreviewSource = () => {
    if (!selectedPreviewUrl || !selectedMediaIdentity) return;
    setPreviewRetryCount(0);
    clearPlaybackWatchdog();
    setPreviewError(false);
    previewStallRef.current = false;
    setPreviewStall(false);
    setPreviewSource({ identity: selectedMediaIdentity, url: selectedPreviewUrl });
    setPreviewLoading(true);
  };
  const retryPlayback = async () => {
    const player = playerRef.current;
    if (!player) return;
    clearPlaybackWatchdog();
    previewStallRef.current = false;
    setPreviewStall(false);
    setPreviewError(false);
    try {
      await player.play();
      setPreviewPlaying(true);
      startPlaybackWatchdog();
    } catch {
      setPreviewPlaying(false);
    }
  };
  const playMuted = async () => {
    const player = playerRef.current;
    if (!player) return;
    clearPlaybackWatchdog();
    player.muted = true;
    setPreviewMuted(true);
    previewStallRef.current = false;
    setPreviewStall(false);
    setPreviewError(false);
    try {
      await player.play();
      setPreviewPlaying(true);
      startPlaybackWatchdog();
    } catch {
      setPreviewPlaying(false);
    }
  };
  const mediaRecovered = () => {
    setPreviewLoading(false);
    previewStallRef.current = false;
    setPreviewStall(false);
    setPreviewError(false);
  };
  const handlePreviewError = () => {
    clearPlaybackWatchdog();
    setPreviewPlaying(false);
    if (previewRetryCount === 0) {
      setPreviewRetryCount(1);
      setPreviewSource({ identity: selectedMediaIdentity!, url: selectedPreviewUrl! });
      playerRef.current?.load();
      setPreviewLoading(true);
    } else {
      setPreviewLoading(false);
      setPreviewError(true);
    }
  };
  const togglePreviewPlayback = async () => {
    const player = playerRef.current || document.querySelector<HTMLVideoElement>(".viewer-frame video");
    if (!player) return;
    if (player.paused) {
      try {
        await player.play();
        setPreviewPlaying(true);
        startPlaybackWatchdog();
      } catch { setPreviewPlaying(false); }
    } else {
      player.pause();
      clearPlaybackWatchdog();
      setPreviewPlaying(false);
    }
  };

  const relevantMediaAssets = useMemo(() => {
    const clipIds = new Set(job?.clips.map((clip) => clip.id));
    return mediaAssets.filter((asset) => asset.sourceProjectId === project?.id || asset.sourceJobId === job?.id || (asset.sourceClipId != null && clipIds.has(asset.sourceClipId)));
  }, [job, mediaAssets, project?.id]);
  const selectedOutputAsset = relevantMediaAssets.find((asset) => asset.sourceClipId === selectedClip?.id);
  // Both the viewer and clip board must use this same resolved value. Clip
  // dimensions are persisted only after validated publication, while the
  // linked asset aspectRatio covers older records whose Clip lacks dimensions.
  const outputAspectRatio = resolveOutputAspectRatio(
    selectedOutputAsset?.aspectRatio,
    selectedClip?.width ?? selectedOutputAsset?.width,
    selectedClip?.height ?? selectedOutputAsset?.height,
    job?.contentFormat ?? project?.contentFormat,
  );
  const selectedIds = job?.clips.filter((clip) => clip.selected && clip.state === "complete").map((clip) => clip.id) || [];
  const savedCount = job?.clips.filter((clip) => clip.state === "complete" && clip.libraryAssetId).length || 0;
  const providerRelatedFailure = Boolean(job?.error && /openrouter|provider|credential|api key|model|voice/i.test(job.error));
  const providerCouldHelp = providerRelatedFailure || Boolean(job?.state === "failed" && project?.mode === "script" && !hasSelectedProvider);
  const canContinueLocally = providerRelatedFailure && Boolean(project?.mode === "clip" || health?.localTts);

  const act = (action: "pause" | "resume" | "stop-keep" | "retry-failed" | "retry-import" | "switch-fast") => singleFlight(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const next = await controlJob(job.id, action);
      jobRef.current = next;
      setJob(next);
      if (!isTerminalJob(next)) setSubscriptionNonce((value) => value + 1);
      await onProjectUpdated();
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  });

  const toggleClip = async (clip: Clip) => {
    if (!job) return;
    const next = job.clips.filter((item) => item.state === "complete" && (item.id === clip.id ? !item.selected : item.selected)).map((item) => item.id);
    try { setJob(await setClipSelection(job.id, next)); } catch (cause) { setError(readableError(cause)); }
  };

  const retryOneClip = async (clip: Clip) => {
    if (!job || clip.state !== "failed") return;
    setBusy(true);
    try { setJob(await retryClip(job.id, clip.id)); } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };

  const changeFolder = async (folderId: string) => {
    if (!project || folderId === project.libraryFolderId) return;
    const moveExistingAssets = window.confirm("Move this project's existing automatically created Library assets to the new folder? Choose Cancel to change only future outputs.");
    setBusy(true);
    try { await changeProjectFolder(project.id, folderId, moveExistingAssets); await onProjectUpdated(); } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };

  const exportSelected = () => singleFlight(async () => {
    if (!job || !selectedIds.length) return;
    setBusy(true);
    try {
      const result = await createZip(job.id, selectedIds);
      window.location.assign(result.downloadUrl);
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  });

  const mediaKey = project ? `${project.id}:${project.latestJobId || "none"}` : "";
  const loadMedia = useCallback(async (force = false) => {
    if (!project || (!force && mediaLoadedKey.current === mediaKey)) return;
    setMediaLoading(true);
    setMediaError(null);
    try { setMediaAssets(await listAssets()); mediaLoadedKey.current = mediaKey; } catch (cause) { setMediaError(readableError(cause)); } finally { setMediaLoading(false); }
  }, [mediaKey, project]);

  useEffect(() => {
    if (sourceTab !== "media") return;
    const timer = window.setTimeout(() => void loadMedia(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMedia, sourceTab]);

  const moveSourceTab = (next: "transcript" | "media") => setSourceTab(next);
  const handleSourceTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = sourceTab === "transcript" ? "media" : "transcript";
    moveSourceTab(next);
    document.getElementById(`workspace-${next}-tab`)?.focus();
  };

  const selectClipForPreview = (clip: Clip) => {
    setSelectedClipId(clip.id);
    // Scroll the viewer into view on compact screens
    document.querySelector(".viewer-panel")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };

  // The empty Workspace renders nothing else, so this heading is the page's
  // <h1>; with a project loaded the project name carries that role below.
  if (!project) return <div className="page"><EmptyState headingLevel={1} icon={<SlidersHorizontal size={30} />} title="No project selected" action={<Button variant="primary" onClick={onGoProjects}>Choose a project</Button>}>Open a project to review its clips, score decisions, storyboard, and export state.</EmptyState></div>;

  return <div className="workspace-page">
    <div className="workspace-commandbar">
      <div className="workspace-project-context"><span className="mode-chip">{project.mode === "clip" ? <Film size={13} /> : <FileText size={13} />} {project.mode === "clip" ? "Clip mode" : "Script mode"}</span><div className="workspace-project-meta"><h1 className="workspace-project-name" title={project.name}>{project.name}</h1><span className="workspace-source-meta" title={project.sourceName}>{project.sourceName}</span><span className="workspace-secondary-meta">{project.style}{project.mode === "clip" && project.contentFormat === "long" ? " · 16:9 landscape" : ""}{job ? ` · ${job.processingMode} processing` : ""}</span></div></div>
      <div className="workspace-controls">{folders.length > 0 && <div className="workspace-folder-field"><label htmlFor="workspace-business-folder">Business folder</label><select id="workspace-business-folder" value={project.libraryFolderId || folders.find((folder) => folder.system)?.id || ""} disabled={busy} onChange={(event) => void changeFolder(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div>}
        {job && <StatusBadge state={job.state} label={job.stageLabel} />}
        {job && ["active", "queued", "recovered"].includes(job.state) && <Button disabled={busy} onClick={() => act("pause")}><Pause size={15} /> Pause</Button>}
        {job && ["active", "queued", "recovered", "paused"].includes(job.state) && <Button disabled={busy} onClick={() => act("stop-keep")}><Square size={14} /> Stop & keep</Button>}
        {job?.state === "paused" && <Button disabled={busy} onClick={() => act("resume")}><Play size={15} /> Resume</Button>}
        {job && job.clips.some((clip) => clip.state === "failed") && <Button disabled={busy} onClick={() => act("retry-failed")}><RefreshCw size={15} /> Retry failed</Button>}
        {job && (job.downloadProgress || project.sourceKind === "youtube") && ["failed", "stalled", "cancelled_kept"].includes(job.state) && <Button disabled={busy} onClick={() => act("retry-import")}><RefreshCw size={15} /> Retry import</Button>}
        <Button variant="primary" disabled={!selectedIds.length || busy} onClick={exportSelected}><Download size={15} /> Download ZIP <span className="button-count">{selectedIds.length}</span></Button>
      </div>
    </div>

    {waitingForEngine && <div className="workspace-offline" role="status">Waiting for the local engine — progress is preserved.</div>}
    {error && !waitingForEngine && <div className="workspace-alert" role="alert"><AlertTriangle size={16} /> {error}<button onClick={() => setError(null)}>Dismiss</button></div>}
    {isStalledSmart && <div className="stalled-callout" role="status"><Clock size={16} /><div><strong>Smart processing appears stalled</strong><span>This Smart job has not reported progress for over 90 seconds. You can leave this screen — processing will continue in the engine — or switch to a Fast local cut.</span></div><div><Button disabled={busy} onClick={() => act("switch-fast")}><Zap size={14} /> Switch to fast local</Button><Button onClick={() => setStalledCalloutDismissed(true)}>Keep waiting</Button>{job && job.clips.some((clip) => clip.state === "complete") && <Button disabled={busy} onClick={() => act("stop-keep")}><Square size={14} /> Stop & keep outputs</Button>}</div></div>}
    {job?.state === "failed" && <div className="failure-strip" role="alert"><AlertTriangle size={17} /><div><strong>Project failed</strong><span>{job.error || "The engine could not finish this project. Completed outputs, if any, are still preserved."}</span></div><div><Button disabled={busy} onClick={() => act(job.downloadProgress || project.sourceKind === "youtube" ? "retry-import" : "retry-failed")}><RefreshCw size={14} /> {job.downloadProgress || project.sourceKind === "youtube" ? "Retry import" : "Retry failed work"}</Button>{providerCouldHelp && <Button onClick={onConfigureProviders}>Configure providers</Button>}{canContinueLocally && <Button disabled={busy} onClick={() => act("retry-failed")}>Continue with local fallback</Button>}</div></div>}
    {job?.state === "stalled" && <div className="failure-strip" role="alert"><AlertTriangle size={17} /><div><strong>YouTube download stalled</strong><span>{job.downloadProgress?.message || "No bytes arrived during the configured inactivity window. The retained partial download is safe to retry."}</span></div><Button disabled={busy} onClick={() => act("retry-import")}><RefreshCw size={14} /> Retry import</Button></div>}
    {job?.state === "cancelled_kept" && project.sourceKind === "youtube" && <div className="warning-strip" role="status"><AlertTriangle size={14} /><span>{job.downloadProgress ? `Stopped with partial YouTube download retained (${formatBytes(job.downloadProgress.downloadedBytes)}). Retry import to resume it.` : "YouTube import stopped before the download began. Retry import to start it."}</span><Button disabled={busy} onClick={() => act("retry-import")}><RefreshCw size={14} /> Retry import</Button></div>}
    {job && !["complete", "failed", "cancelled_kept"].includes(job.state) && (() => { const facts = jobFacts(job); return <div className="job-strip"><div className="job-strip-text"><strong>{facts.stage}</strong>{facts.detail && <span>{facts.detail}</span>}</div><Progress value={facts.percent} indeterminate={facts.indeterminate} label={facts.stage} /></div>; })()}
    {job && job.steps.length > 0 && <ProcessChecklist steps={job.steps} jobState={job.state} compact={isTerminalJob(job)} />}
    {job && job.warnings.length > 0 && <WarningList warnings={job.warnings} />}

    <div className="workspace-grid">
      <aside className="source-panel panel" aria-label="Source material">
        <div className="panel-tabs" role="tablist" aria-label="Source material">
          <button type="button" role="tab" id="workspace-transcript-tab" aria-controls="workspace-transcript-panel" aria-selected={sourceTab === "transcript"} tabIndex={sourceTab === "transcript" ? 0 : -1} className={sourceTab === "transcript" ? "active" : ""} onClick={() => moveSourceTab("transcript")} onKeyDown={handleSourceTabKeyDown}>{project.mode === "clip" ? "Transcript" : "Script"}</button>
          <button type="button" role="tab" id="workspace-media-tab" aria-controls="workspace-media-panel" aria-selected={sourceTab === "media"} tabIndex={sourceTab === "media" ? 0 : -1} className={sourceTab === "media" ? "active" : ""} onClick={() => moveSourceTab("media")} onKeyDown={handleSourceTabKeyDown}>Media</button>
        </div>
        <div className="source-content">
          {sourceTab === "transcript" ? <div id="workspace-transcript-panel" role="tabpanel" aria-labelledby="workspace-transcript-tab" tabIndex={0}>
            <div className="source-card"><div className="source-icon">{project.mode === "clip" ? <Film /> : <FileText />}</div><div><strong title={project.sourceName}>{project.sourceName}</strong><span>{project.sourceKind} · preserved source</span></div></div>
            {project.mode === "clip" ? <div className="transcript-placeholder">
              {selectedClip ? <><span className="timecode">{formatDuration(selectedClip.start)}</span><p>{selectedClip.openingLine}</p><span className="timecode">{formatDuration(selectedClip.end)}</span><p className="muted">Select another clip to inspect its source range. The full timed-word transcript stays in the project record.</p></> : <p className="muted">{jobLoaded ? "Timed words will appear when transcription completes." : "Loading transcript…"}</p>}
            </div> : <div className="beat-source-list">{job?.beats.map((beat) => <button key={beat.id}><span>{formatDuration(beat.start)}</span><p>{beat.text}</p></button>)}</div>}
          </div> : <div id="workspace-media-panel" role="tabpanel" aria-labelledby="workspace-media-tab" tabIndex={0}>
            {mediaLoading && <p className="source-state" role="status">Loading project media…</p>}
            {mediaError && <div className="source-error" role="alert"><span>{mediaError}</span><Button onClick={() => void loadMedia(true)}><RefreshCw size={14} /> Retry</Button></div>}
            {!mediaLoading && !mediaError && !relevantMediaAssets.length && <EmptyState icon={<Film size={24} />} title="No project media yet">Linked source and generated clip assets will appear here without changing the project or Library.</EmptyState>}
            {!mediaLoading && !mediaError && relevantMediaAssets.length > 0 && <div className="workspace-media-list">{relevantMediaAssets.map((asset) => <WorkspaceMediaAsset key={asset.id} asset={asset} clip={job?.clips.find((item) => item.id === asset.sourceClipId)} />)}</div>}
          </div>}
        </div>
      </aside>

      <section className="viewer-panel panel" aria-label="Output viewer">
        <div className="viewer-toolbar"><span>Output · {outputAspectRatio}</span>{creatorCredit && <span className="viewer-credit" role="note">{creatorCredit}</span>}<div><IconButton label="Toggle safe areas" aria-pressed={safeAreasVisible} onClick={() => setSafeAreasVisible((value) => !value)}><Eye size={15} /></IconButton><IconButton label={previewMuted ? "Unmute preview" : "Mute preview"} aria-pressed={previewMuted} onClick={() => { const player = playerRef.current; if (player) player.muted = !player.muted; setPreviewMuted((value) => !value); }}><Volume2 size={15} /></IconButton></div></div>
        <div className="viewer-stage">
          <div className={`viewer-frame ${project.mode} ${project.contentFormat === "long" ? "landscape" : ""} ${safeAreasVisible ? "show-safe-areas" : ""}`}>
            {previewSource ? <><video
              key={previewSource.identity}
              ref={playerRef}
              src={previewSource.url}
              controls
              preload="auto"
              playsInline
              muted={previewMuted}
              onLoadedMetadata={() => mediaRecovered()}
              onCanPlay={() => mediaRecovered()}
              onPlay={() => { if (!previewStallRef.current) setPreviewPlaying(true); }}
              onPlaying={() => { if (!previewStallRef.current) { setPreviewPlaying(true); startPlaybackWatchdog(); } }}
              onPause={() => { clearPlaybackWatchdog(); setPreviewPlaying(false); }}
              onEnded={() => { clearPlaybackWatchdog(); setPreviewPlaying(false); }}
              onAbort={() => { clearPlaybackWatchdog(); setPreviewPlaying(false); }}
              onEmptied={() => { clearPlaybackWatchdog(); setPreviewPlaying(false); }}
              onWaiting={() => setPreviewLoading(true)}
              onStalled={() => setPreviewLoading(true)}
              onTimeUpdate={(event) => { setPreviewTime(event.currentTarget.currentTime); setPreviewLoading(false); }}
              onError={handlePreviewError}
            />{previewStall ? <div className="viewer-error" role="alert">Playback could not start with this browser’s audio output.<div className="viewer-error-actions"><button type="button" onClick={() => void retryPlayback()}>Retry playback</button><button type="button" onClick={() => void playMuted()}>Play muted</button></div></div> : previewError ? <div className="viewer-error" role="alert">This clip could not be loaded. Its render may be missing from disk.<div className="viewer-error-actions"><button type="button" onClick={refreshPreviewSource}>Retry preview</button></div></div> : previewLoading && <div className="viewer-loading" role="status">Loading preview…</div>}</> : job && (["active", "queued", "paused", "stalled", "recovered"].includes(job.state) || waitingForEngine) ? <ProcessingState job={job} waitingForEngine={waitingForEngine} /> : <div className="viewer-placeholder">
              <div className="safe-area" />
              <img src="/app-icon.png" alt="" />
              <span>{!jobLoaded ? "Loading project…" : job?.state === "failed" ? "Render unavailable" : job?.stageLabel || "Preparing project"}</span>
              {selectedClip?.visualLabel && <div className="visual-card"><Sparkles size={14} />{selectedClip.visualLabel}</div>}
              {selectedClip?.openingLine && <div className="caption-preview">{selectedClip.openingLine.split(" ").slice(0, 7).map((word, index) => <span className={index === 2 ? "active" : ""} key={`${word}-${index}`}>{word} </span>)}</div>}
            </div>}
          </div>
        </div>
        <div className="transport"><IconButton label="Previous frame" onClick={() => { const player = playerRef.current; if (player) player.currentTime = Math.max(0, player.currentTime - 1 / 30); }}><RotateCcw size={15} /></IconButton><button className="play-button" aria-label={previewPlaying ? "Pause" : "Play"} aria-pressed={previewPlaying} onClick={() => void togglePreviewPlayback()}>{previewPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><span className="transport-time">{selectedClip ? `${formatDuration(previewTime)} / ${formatDuration(selectedClip.duration)}` : "0:00 / 0:00"}</span><div className="transport-spacer" /><span>J&nbsp; K&nbsp; L</span></div>
      </section>

      <aside className="inspector-panel panel" aria-label="Clip inspector">
        <div className="panel-title"><strong>Details</strong>{selectedClip && <span>Clip {selectedClip.index}</span>}</div>
        <div className="inspector-tabs">
          {(["score", "captions", "asset", "info"] as const).map((tab) => <button key={tab} className={detailsTab === tab ? "active" : ""} onClick={() => setDetailsTab(tab)}>{tab}</button>)}
        </div>
        <div className="inspector-content">
          <p className="review-hint" role="note">Review and download finished clips here. To change a cut, adjust the project settings and generate a new version.</p>
          {providersLoaded && !hasSelectedProvider && !providerCalloutDismissed && <div className="provider-callout compact"><Sparkles size={15} /><div><strong>Add optional AI providers</strong><span>Connect OpenRouter for enhanced planning and speech narration. Local modes remain available.</span></div><div className="provider-callout-actions"><Button onClick={onConfigureProviders}>Configure providers</Button><Button variant="ghost" onClick={() => setProviderCalloutDismissed(true)}>Continue locally</Button></div></div>}
          {detailsTab === "score" && (selectedClip ? <ScoreInspector clip={selectedClip} /> : <p className="muted">Select a clip to inspect its auditable score.</p>)}
          {detailsTab === "captions" && <><div className="inspector-section"><label>Preset</label><span className="readonly-preset">Editorial highlight<span className="readonly-tag">Read-only</span></span><span className="preset-options">Minimal · High contrast box</span></div><div className="inspector-note"><Captions size={15} /><span>Caption style and timing are fixed when the job is created and burned in from local word timestamps.</span></div></>}
          {detailsTab === "asset" && <><div className="inspector-section"><label>Visual intention</label><strong>{selectedClip?.visualLabel || job?.beats[0]?.concept || "No visual beat selected"}</strong></div><div className="inspector-section"><label>Source</label><span>{selectedClip?.provenance[0]?.provider || job?.beats[0]?.source || "Text-card fallback"}</span></div><div className="inspector-note"><Sparkles size={15} /><span>{selectedClip?.provenance[0]?.matchReason || job?.beats[0]?.matchReason || "A relevant text card is preferred over unrelated media."}</span></div></>}
          {detailsTab === "info" && <dl className="info-list"><dt>Project</dt><dd>{project.id.slice(0, 8)}</dd><dt>Job</dt><dd>{job?.id.slice(0, 8) || "—"}</dd><dt>Mode</dt><dd>{project.mode}</dd><dt>Style</dt><dd>{project.style}</dd><dt>Source</dt><dd>{project.sourceKind}</dd><dt>Storage</dt><dd>Mounted local data</dd></dl>}
        </div>
      </aside>
    </div>

    <section className="board-panel panel">
      <div className="board-header"><div><strong>{project.mode === "clip" ? "Clip board" : "Beat board"}</strong><span>{!jobLoaded ? "Loading…" : project.mode === "clip" ? `${job?.clips.length || 0} planned · ${job?.clips.filter((clip) => clip.state === "complete").length || 0} ready${savedCount ? ` · ${savedCount} saved to Library` : ""}` : `${job?.beats.length || 0} visual beats`}</span></div><div className="board-filters">{([["all", "All"], ["selected", "Selected"], ["failed", "Failed"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={boardFilter === value} className={boardFilter === value ? "active" : ""} onClick={() => setBoardFilter(value)}>{label}</button>)}</div></div>
      {project.mode === "clip" ? <div className="clip-board">{boardClips.map((clip) => <article key={clip.id} className={`clip-tile ${selectedClipId === clip.id ? "active" : ""} ${clip.state}`} onClick={() => setSelectedClipId(clip.id)}>
        <div className="clip-thumb"><span className="clip-number">{String(clip.index).padStart(2, "0")}</span>{clip.state === "complete" ? <><ClipThumb clip={clip} /><span className="score-ring">{clip.score ? Math.round(clip.score.total) : "–"}</span></> : clip.state === "failed" ? <AlertTriangle size={24} /> : <RefreshCw size={24} className="spin" />}</div>
        <div className="clip-tile-body"><strong className="clip-title" title={clip.title || `Cut ${String(clip.index).padStart(2, "0")}`}>{clip.title || `Cut ${String(clip.index).padStart(2, "0")}`}</strong><span className="clip-line" title={clip.openingLine || undefined}>{clip.openingLine || "Candidate clip"}</span><span className="clip-meta">{formatDuration(clip.duration)} · {formatDimensions(outputAspectRatio, clip.width, clip.height)} · {folderName(clip.folderId, folders, project)}</span>{clip.state === "complete" && clip.libraryAssetId && <span className="saved-badge"><Check size={11} /> Saved to Library</span>}{clip.state === "failed" ? <Button disabled={busy} onClick={(event) => { event.stopPropagation(); void retryOneClip(clip); }}><RefreshCw size={12} /> Retry clip</Button> : <div className="clip-actions"><Button className="clip-action" disabled={clip.state !== "complete"} onClick={(event) => { event.stopPropagation(); selectClipForPreview(clip); }}><Eye size={12} /> Preview</Button>{clip.state === "complete" && clip.downloadUrl && <a className="button button-secondary clip-action" href={clip.downloadUrl} download onClick={(event) => event.stopPropagation()}><Download size={12} /> Download</a>}<label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={clip.selected} disabled={clip.state !== "complete"} onChange={() => toggleClip(clip)} /> Include in export</label></div>}</div>
      </article>)}{!boardClips.length && (jobLoaded ? <div className="board-placeholder">{job?.clips.length ? "No clips match this filter." : "Candidates appear here after local transcription and selection."}</div> : <><Skeleton rows={3} className="skeleton-tile" /><Skeleton rows={3} className="skeleton-tile" /><Skeleton rows={3} className="skeleton-tile" /></>)}</div>
        : <div className="beat-board">{job?.beats.map((beat, index) => <article key={beat.id} className="beat-tile"><div className="beat-visual"><span>{String(index + 1).padStart(2, "0")}</span><Sparkles size={22} /></div><div><strong>{beat.concept}</strong><p>{beat.text}</p><span>{formatDuration(beat.start)}–{formatDuration(beat.end)} · {beat.source} · {Math.round(beat.confidence * 100)}%</span></div><StatusBadge state={beat.source === "library" ? "ready" : "fallback"} label={beat.ruleState || beat.source} /></article>)}</div>}
    </section>

  </div>;
}

const mediaOriginLabels: Record<LibraryAsset["origin"], string> = {
  "project-source": "Project source",
  "generated-clip": "Generated clip",
  "script-output": "Script output",
  "manual-import": "Manual import",
};

function WorkspaceMediaAsset({ asset, clip }: { asset: LibraryAsset; clip?: Clip }) {
  const mediaType = asset.mediaType.toLowerCase();
  const preview = mediaType.startsWith("video/") && asset.previewUrl ? <video src={asset.previewUrl} controls muted preload="metadata" aria-label={`${asset.title} preview`} />
    : mediaType.startsWith("image/") && asset.previewUrl ? <img src={asset.previewUrl} alt={`${asset.title} preview`} />
      : mediaType.startsWith("audio/") && asset.previewUrl ? <audio src={asset.previewUrl} controls aria-label={`${asset.title} preview`} />
        : <FileText size={24} aria-hidden="true" />;
  return <article className="workspace-media-card">
    <div className="workspace-media-preview">{preview}</div>
    <div className="workspace-media-card-body"><strong>{asset.title}</strong><span>{mediaOriginLabels[asset.origin]}{clip ? ` · Clip ${clip.index}` : ""}</span><span className="muted">{asset.filename} · {formatDimensions(asset.aspectRatio, asset.width, asset.height)}</span></div>
  </article>;
}

function ScoreInspector({ clip }: { clip: Clip }) {
  if (!clip.score) return <p className="muted">No score recorded for this clip yet.</p>;
  const factors = [
    ["Hook", clip.score.hook], ["Coherence", clip.score.coherence], ["Ending", clip.score.ending],
    ["Energy", clip.score.energy], ["Practical value", clip.score.practicalValue], ["Visual potential", clip.score.visualPotential], ["Completeness", clip.score.completeness],
  ] as const;
  return <><div className="score-total"><span>{Math.round(clip.score.total)}</span><div><strong>Selection score</strong><small>Deterministic local model</small></div></div><p className="score-explanation">{clip.score.explanation}</p><div className="factor-list">{factors.map(([label, value]) => <div key={label}><span>{label}</span><div><i style={{ width: `${value}%` }} /></div><strong>{Math.round(value)}</strong></div>)}</div>{clip.score.penalties > 0 && <div className="penalty"><AlertTriangle size={14} /> Penalties −{Math.round(clip.score.penalties)}</div>}</>;
}
