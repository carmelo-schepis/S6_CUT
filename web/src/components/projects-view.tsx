import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Film, FolderOpen, Plus, Search, Sparkles, Trash2, Zap } from "lucide-react";
import { createClipJob, createFolder, createScriptJob, deleteProjectEverywhere, listAssets, listFolders, readableError } from "../api";
import { bindRevalidationOnFocus, createBoundedRevalidation, emitLibraryChanged, onLibraryChanged } from "../library-sync";
import { DEFAULT_SUBSCRIBE_ANIMATION, type ContentFormat, type Health, type Job, type LibraryAsset, type LibraryFolder, type ProcessingMode, type Project, type SourceProfile, type Style, type SubscribeAnimationConfig } from "../types";
import { authoritativeJob, projectStatus } from "../project-status";
import { Button, Field, FieldGroup, Progress, Skeleton, StatusBadge, StepBadge, formatAge, resolveOutputAspectRatio, useSingleFlight } from "./common";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";
import { VideoPreviewDialog } from "./video-preview-dialog";
import { VideoSourcePicker } from "./video-source-picker";
import { SubscribeAnimationControl } from "./subscribe-animation-control";
import { RecentClips } from "./recent-clips";

const RECENT_FOLDER_KEY = "s6-cut.recent-library-folder";
const PROVIDER_CALLOUT_DISMISSED_KEY = "s6-cut.provider-callout-dismissed";
const MUSIC_PROFILE_NOTE = "Music / sung vocals always uses Smart transcription locally. VAD disabled; word timestamps retained. Sung words may still be missed or hallucinated, so review outputs.";

// Recent projects is a shortlist, not the whole archive: rendering every
// project produced a 30,000px-tall page once the library passed a hundred.
const RECENT_LIMIT = 12;

const styles: { id: Style; label: string; note: string }[] = [
  { id: "funny", label: "Funny", note: "Punchlines & reactions" },
  { id: "serious", label: "Serious", note: "Complete claims" },
  { id: "educational", label: "Educational", note: "Clear explanations" },
  { id: "hype", label: "Hype", note: "Hooks & high energy" },
];

export function ProjectsView({ projects, jobs = [], health, healthChecked = true, loaded = true, providersLoaded = true, hasSelectedProvider = true, onConfigureProviders = () => undefined, onCreated, onOpen, onDeleted = () => undefined, onRefresh, onSelectLibraryAsset }: {
  projects: Project[];
  jobs?: Job[];
  health: Health | null;
  /** False while the very first health read is still outstanding. */
  healthChecked?: boolean;
  loaded?: boolean;
  /** False until /profiles has answered; provider availability is unknown. */
  providersLoaded?: boolean;
  hasSelectedProvider?: boolean;
  onConfigureProviders?: () => void;
  onCreated: (project: Project) => void;
  onOpen: (id: string) => void;
  onDeleted?: (id: string) => void;
  onRefresh: () => Promise<void>;
  onSelectLibraryAsset?: (assetId: string) => void;
}) {
  const [mode, setMode] = useState<"clip" | "script">("clip");
  const [sourceType, setSourceType] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [script, setScript] = useState("");
  const [style, setStyle] = useState<Style>("educational");
  const [count, setCount] = useState(5);
  const [contentFormat, setContentFormat] = useState<ContentFormat>("short");
  const [advanced, setAdvanced] = useState(false);
  const [minDuration, setMinDuration] = useState(20);
  const [maxDuration, setMaxDuration] = useState(60);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [narration, setNarration] = useState<"auto" | "local" | "silent">("auto");
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("auto");
  const [sourceProfile, setSourceProfile] = useState<SourceProfile>("speech");
  const [sourceDuration, setSourceDuration] = useState<{ file: File; seconds: number } | null>(null);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [subscribeAnimation, setSubscribeAnimation] = useState<SubscribeAnimationConfig>(DEFAULT_SUBSCRIBE_ANIMATION);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerCalloutDismissed, setProviderCalloutDismissed] = useState(() => {
    try {
      return localStorage.getItem(PROVIDER_CALLOUT_DISMISSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [libraryFolderId, setLibraryFolderId] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [sourceAssets, setSourceAssets] = useState<LibraryAsset[]>([]);
  const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deleteOpener, setDeleteOpener] = useState<HTMLButtonElement | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const sourceAssetsRevision = useRef(0);
  const scriptInput = useRef<HTMLInputElement>(null);
  const singleFlight = useSingleFlight();

  useEffect(() => {
    if (mode !== "clip" || sourceType !== "file" || !file) return;
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => setSourceDuration(Number.isFinite(video.duration) ? { file, seconds: video.duration } : null);
    video.onerror = () => setSourceDuration(null);
    video.src = objectUrl;
    return () => { URL.revokeObjectURL(objectUrl); video.removeAttribute("src"); };
  }, [file, mode, sourceType]);

  useEffect(() => {
    void listFolders().then((next) => {
      setFolders(next);
      const recent = localStorage.getItem(RECENT_FOLDER_KEY);
      const fallback = next.find((folder) => folder.system || folder.name === "Unsorted") || next[0];
      setLibraryFolderId(next.some((folder) => folder.id === recent) ? recent! : fallback?.id || "");
    }).catch(() => undefined);
  }, []);

  // Source assets carry short-lived, server-signed preview URLs. Keep these
  // separate from the project list: an unavailable Library must never make the
  // workspace's recent-project controls fail.
  const loadSourceAssets = useCallback(async () => {
    const revision = ++sourceAssetsRevision.current;
    try {
      const next = await listAssets({ origin: "project-source" });
      if (revision !== sourceAssetsRevision.current) return;
      setSourceAssets((current) => {
        const previous = new Map(current.map((asset) => [asset.id, asset]));
        return next.map((asset) => {
          const existing = previous.get(asset.id);
          return existing?.blobId === asset.blobId ? { ...asset, previewUrl: existing.previewUrl || asset.previewUrl } : asset;
        });
      });
    } catch { /* Source previews are optional. */ }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadSourceAssets);
  }, [loadSourceAssets]);

  useEffect(() => {
    const revalidation = createBoundedRevalidation(loadSourceAssets);
    const unsubscribeFocus = bindRevalidationOnFocus(() => revalidation.signal());
    const unsubscribeLibrary = onLibraryChanged(() => revalidation.signal());
    return () => { unsubscribeFocus(); unsubscribeLibrary(); revalidation.dispose(); };
  }, [loadSourceAssets]);

  const openSourcePreview = async (project: Project, opener: HTMLButtonElement) => {
    // Fetch immediately before opening as well, so an open dialog never relies
    // on a signed URL that may have expired while this screen remained open.
    const revision = ++sourceAssetsRevision.current;
    try {
      const freshAssets = await listAssets({ origin: "project-source" });
      if (revision !== sourceAssetsRevision.current) return;
      setSourceAssets(freshAssets);
      const asset = freshAssets.find((item) => item.sourceProjectId === project.id && item.mediaType.startsWith("video/") && item.previewUrl);
      if (asset) { setPreviewOpener(opener); setPreviewAsset(asset); }
    } catch { /* The normal project-open control remains available. */ }
  };

  const requestProjectDeletion = (project: Project, opener: HTMLButtonElement) => {
    setDeleteError(null);
    setDeleteOpener(opener);
    setProjectToDelete(project);
  };
  const closeProjectDeletion = () => {
    if (deletingProject) return;
    setProjectToDelete(null);
    queueMicrotask(() => { if (deleteOpener?.isConnected) deleteOpener.focus(); });
  };
  const confirmProjectDeletion = async () => {
    if (!projectToDelete || deletingProject) return;
    setDeletingProject(true);
    setDeleteError(null);
    try {
      await deleteProjectEverywhere(projectToDelete.id);
      onDeleted(projectToDelete.id);
      emitLibraryChanged();
      setProjectToDelete(null);
    } catch (cause) {
      setDeleteError(readableError(cause));
    } finally {
      setDeletingProject(false);
    }
  };

  const addFolder = async () => {
    const name = window.prompt("Business folder name");
    if (!name?.trim()) return;
    try {
      const folder = await createFolder({ name: name.trim() });
      setFolders((current) => [...current, folder]);
      setLibraryFolderId(folder.id);
    } catch (cause) { setError(readableError(cause)); }
  };

  const submit = () => singleFlight(async () => {
    setError(null);
    if (mode === "clip" && sourceType === "file" && !file) return setError("Choose a local video first.");
    if (mode === "clip" && sourceType === "url") {
      if (!url.trim()) return setError("Paste a supported YouTube URL first.");
      try {
        const parsed = new URL(url.trim());
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (parsed.protocol !== "https:" || !["youtube.com", "m.youtube.com", "youtu.be"].includes(hostname)) {
          return setError("Only public HTTPS YouTube URLs are supported.");
        }
      } catch {
        return setError("Only public HTTPS YouTube URLs are supported.");
      }
    }
    if (mode === "script" && script.trim().length < 10) return setError("Add at least 10 characters of script.");
    if (mode === "clip") {
      if (!Number.isFinite(minDuration) || minDuration < 8) return setError("Minimum seconds must be at least 8.");
      if (minDuration > 120) return setError("Minimum seconds must be at most 120.");
      if (!Number.isFinite(maxDuration) || maxDuration <= minDuration) return setError("Maximum seconds must be greater than minimum seconds.");
      if (contentFormat === "short" && maxDuration > 180) return setError("Short-form clips can be at most 180 seconds.");
      if (musicConfigurationMessage) return setError(musicConfigurationMessage);
      if (musicFeasibilityMessage) return setError(musicFeasibilityMessage);
    }
    setSubmitting(true);
    try {
      const result = mode === "clip"
        ? await createClipJob({ file: sourceType === "file" ? file || undefined : undefined, url: sourceType === "url" ? url.trim() : undefined, name: projectName.trim() || undefined, style, count, minDuration, maxDuration, aspectRatio: contentFormat === "long" ? "16:9" : aspectRatio, contentFormat, processingMode: sourceProfile === "music" ? "smart" : processingMode, sourceProfile, burnSubtitles: fastMode ? false : burnSubtitles, subscribeAnimation, libraryFolderId: libraryFolderId || undefined })
        : await createScriptJob({ script, name: projectName.trim() || undefined, style, aspectRatio, contentFormat: aspectRatio === "16:9" ? "long" : "short", narration, subscribeAnimation, libraryFolderId: libraryFolderId || undefined });
      if (libraryFolderId) localStorage.setItem(RECENT_FOLDER_KEY, libraryFolderId);
      onCreated(result.project);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setSubmitting(false);
    }
  });

  const loadScriptFile = async (selected: File | undefined) => {
    if (!selected) return;
    if (!/\.(txt|md)$/i.test(selected.name)) return setError("Script uploads must be .txt or .md files.");
    setScript(await selected.text());
    setError(null);
  };

  // Until /profiles answers we do not know whether a provider is connected, and
  // must not assert that none is: that read can take several seconds, and the
  // claim was wrong for the whole of it whenever a provider was in fact set up.
  const fastMode = sourceProfile === "speech" && (processingMode === "fast" || (processingMode === "auto" && providersLoaded && !hasSelectedProvider));
  const knownSourceDuration = sourceType === "file" && sourceDuration?.file === file ? sourceDuration.seconds : null;
  const musicConfigurationMessage = sourceProfile === "music" && contentFormat !== "short"
    ? "Music / sung vocals is currently available for short clips only. Choose Short form to continue."
    : null;
  const musicFeasibilityMessage = sourceProfile === "music" && knownSourceDuration !== null && Number.isFinite(minDuration) && minDuration > 0 && count > Math.floor((knownSourceDuration + 1e-9) / minDuration)
    ? `This ${knownSourceDuration.toFixed(1)}s source can fit at most ${Math.floor(knownSourceDuration / minDuration)} non-overlapping clips of at least ${minDuration}s. Reduce the count or minimum duration; the requested count will not be changed automatically.`
    : null;
  const modeNote = sourceProfile === "music"
    ? MUSIC_PROFILE_NOTE
    : processingMode === "fast"
    ? "Fast runs deterministically on this machine. It skips transcription and captions."
    : processingMode === "smart"
      ? !providersLoaded ? "Checking connected providers… Smart uses one when available, otherwise local Whisper and deterministic planning."
        : hasSelectedProvider ? "Smart uses the selected provider for enhanced planning."
          : "No provider is connected, so Smart runs on local Whisper and deterministic planning."
      : !providersLoaded ? "Checking connected providers… Auto uses one when available, otherwise a fast local cut."
        : hasSelectedProvider ? "Auto uses a connected provider, otherwise a fast local cut."
          : "No provider is connected, so Auto runs as a fast local cut.";
  // Recent projects is capped so a large history cannot produce a page tens of
  // thousands of pixels tall, but every project stays reachable: searching
  // filters the whole history, not just the visible page.
  const query = projectQuery.trim().toLowerCase();
  const matchingProjects = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query) || project.style.toLowerCase().includes(query))
    : projects;
  const visibleProjects = query || showAllProjects ? matchingProjects : matchingProjects.slice(0, RECENT_LIMIT);

  return <div className="page projects-page">
    {/* Every screen carries exactly one h1. The page introduction that used to
        hold this one was removed with the Projects header, and the create panel
        title is a section heading rather than the page's, so the page name is
        stated for assistive technology only — no visible design changes, and
        the heading ladder below it stays h2 -> h3 with nothing skipped. */}
    <h1 className="sr-only">Projects</h1>
    <section className="create-panel" aria-labelledby="create-title">
      <div className="create-topline">
        <div><h2 id="create-title">Create a project</h2><p>Nothing leaves this machine unless you use a URL or an enabled provider.</p></div>
        <div className="segmented" aria-label="Creation mode">
          <button type="button" aria-pressed={mode === "clip"} className={mode === "clip" ? "active" : ""} onClick={() => { setError(null); setMode("clip"); }}><Film size={15} /> Clip mode</button>
          <button type="button" aria-pressed={mode === "script"} className={mode === "script" ? "active" : ""} onClick={() => { setError(null); setMode("script"); }}><FileText size={15} /> Script mode</button>
        </div>
      </div>

      {providersLoaded && !hasSelectedProvider && !providerCalloutDismissed && <div className="provider-callout"><Sparkles size={17} /><div><strong>Add optional AI providers</strong><span>OpenRouter improves planning and provides optional speech narration. Local modes stay available.</span></div><div className="provider-callout-actions"><Button onClick={onConfigureProviders}>Configure providers</Button><Button variant="ghost" onClick={() => {
        setProviderCalloutDismissed(true);
        try { localStorage.setItem(PROVIDER_CALLOUT_DISMISSED_KEY, "true"); } catch { /* Storage can be unavailable in hardened browsers. */ }
      }}>Continue locally</Button></div></div>}

      <div className="create-grid">
        <div className="create-step source-step">
          <div className="step-label"><StepBadge step={1} /><span className="step-label-text">{mode === "clip" ? "Add source" : "Add script"}</span></div>
          {mode === "clip" ? <VideoSourcePicker mode={sourceType} onModeChange={(next) => { setError(null); setSourceType(next as "file" | "url"); }} file={file} onFile={(next, pickerError) => { setFile(next); setSourceDuration(null); if (pickerError) setError(pickerError); else setError(null); }} url={url} onUrl={setUrl} /> : <div className="script-input-wrap">
            <textarea value={script} onChange={(event) => { setScript(event.target.value); setError(null); }} placeholder="Paste the exact script. S6_cut preserves this source text…" rows={8} />
            <div className="script-meta"><span>{script.length.toLocaleString()} characters</span><input ref={scriptInput} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => loadScriptFile(event.target.files?.[0])} hidden /><button onClick={() => scriptInput.current?.click()}><FolderOpen size={14} /> Upload .txt or .md</button></div>
          </div>}
          {mode === "clip" && healthChecked && <div className="engine-summary">
            <span className={`engine-dot ${health?.status || "offline"}`} aria-hidden="true" />
            <strong>{health?.status === "ready" ? "Local engine ready" : health ? "Local fallback mode" : "Local engine unavailable"}</strong>
            <span className="engine-chips">
              <span className={health?.whisper ? "ok" : "warn"}>Whisper</span>
              <span className={health?.ffmpeg ? "ok" : "warn"}>FFmpeg</span>
              {sourceType === "url" && <span className={health?.ytdlp ? "ok" : "warn"}>YouTube</span>}
            </span>
          </div>}
        </div>

        <div className="create-step style-step">
          <div className="step-label"><StepBadge step={2} /><span className="step-label-text">Choose the output</span></div>
          <FieldGroup title="Editorial style">
            <div className="style-grid">
              {styles.map((item) => <button key={item.id} className={style === item.id ? "style-card active" : "style-card"} onClick={() => setStyle(item.id)} aria-pressed={style === item.id}>
                <span className={`style-swatch ${item.id}`} /><strong>{item.label}</strong><small>{item.note}</small>
              </button>)}
            </div>
          </FieldGroup>

          {mode === "clip" ? <>
            <FieldGroup title="Source audio" hint={sourceProfile === "music" ? MUSIC_PROFILE_NOTE : "Choose speech for spoken content or music for sung vocals and lyrics."}>
              <div className="segmented mode-tabs" aria-label="Source audio profile">
                <button type="button" aria-pressed={sourceProfile === "speech"} className={sourceProfile === "speech" ? "active" : ""} onClick={() => setSourceProfile("speech")}>Speech</button>
                <button type="button" aria-pressed={sourceProfile === "music"} className={sourceProfile === "music" ? "active" : ""} onClick={() => setSourceProfile("music")}>Music / sung vocals</button>
              </div>
            </FieldGroup>
            <FieldGroup title="Format" hint={contentFormat === "long" ? "Landscape scenes are selected across the whole source." : "Vertical clips are selected for short-form viewing."}>
              <div className="segmented mode-tabs format-tabs" aria-label="Content format">
                <button type="button" aria-pressed={contentFormat === "short"} className={contentFormat === "short" ? "active" : ""} onClick={() => { setContentFormat("short"); setAspectRatio("9:16"); }}>Short form · 9:16</button>
                <button type="button" aria-pressed={contentFormat === "long"} className={contentFormat === "long" ? "active" : ""} disabled={sourceProfile === "music"} onClick={() => { setContentFormat("long"); setAspectRatio("16:9"); }}>Long form · 16:9</button>
              </div>
              <Field label={contentFormat === "long" ? "Scenes requested" : "Clips requested"}>
                <div className="count-control"><button onClick={() => setCount(Math.max(1, count - 1))} aria-label="Fewer clips">−</button><strong aria-live="polite">{count}</strong><button onClick={() => setCount(Math.min(30, count + 1))} aria-label="More clips">+</button></div>
              </Field>
            </FieldGroup>

            {sourceProfile === "speech" && <FieldGroup title="Processing mode" hint={modeNote}>
              <div className="segmented mode-tabs processing-mode-tabs" aria-label="Processing mode">
                <button type="button" aria-pressed={processingMode === "auto"} className={processingMode === "auto" ? "active" : ""} onClick={() => setProcessingMode("auto")}><Sparkles size={13} /> <span>Auto</span></button>
                <button type="button" aria-pressed={processingMode === "fast"} className={processingMode === "fast" ? "active" : ""} onClick={() => { setProcessingMode("fast"); setBurnSubtitles(false); }}><Zap size={13} /> <span>Fast</span></button>
                <button type="button" aria-pressed={processingMode === "smart"} className={processingMode === "smart" ? "active" : ""} onClick={() => setProcessingMode("smart")}><Sparkles size={13} /> <span>Smart</span></button>
              </div>
            </FieldGroup>}
          </> : <FieldGroup title="Narration" hint="Automatic uses a local voice when needed, then a clearly labelled silent render.">
            <Field label="Narration source"><select value={narration} onChange={(event) => setNarration(event.target.value as typeof narration)}><option value="auto">Automatic fallback</option><option value="local">Local voice only</option><option value="silent">Silent render (no narration)</option></select></Field>
          </FieldGroup>}
        </div>

        <div className="create-step action-step">
          <div className="step-label"><StepBadge step={3} /><span className="step-label-text">Name and create</span></div>
          <FieldGroup title="Destination">
            <Field label="Project name" hint="Optional. Leave blank for a generated name."><input id="project-name" aria-label="Project name" value={projectName} maxLength={160} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Launch highlights" /></Field>
            <div className="folder-picker"><Field label="Business folder"><select aria-label="Business folder" value={libraryFolderId} onChange={(event) => setLibraryFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Button variant="ghost" onClick={addFolder}><Plus size={13} /> New folder</Button></div>
          </FieldGroup>

          <SubscribeAnimationControl value={subscribeAnimation} onChange={setSubscribeAnimation} longForm={mode === "clip" ? contentFormat === "long" : aspectRatio === "16:9"} />

          {mode === "clip" && <label className="subtitle-toggle"><input type="checkbox" checked={fastMode ? false : burnSubtitles} disabled={fastMode} onChange={(event) => setBurnSubtitles(event.target.checked)} /> <span><strong>Burn in subtitles</strong><small>{fastMode ? "Fast mode skips transcription and captions. Choose Smart mode to enable them." : "Uses local word timing. Fast mode skips captions."}</small></span></label>}

          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>Advanced controls <span aria-hidden="true">{advanced ? "−" : "+"}</span></button>
          {advanced && <div className="advanced-grid">
            <Field label="Aspect"><select value={aspectRatio} disabled={mode === "clip" && contentFormat === "long"} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>1:1</option><option>16:9</option><option>4:5</option></select></Field>
            {mode === "clip" && <><Field label="Minimum seconds"><input type="number" min={8} max={120} value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))} /></Field><Field label="Maximum seconds"><input type="number" min={10} max={contentFormat === "long" ? 1800 : 180} value={maxDuration} onChange={(event) => setMaxDuration(Number(event.target.value))} /></Field></>}
          </div>}

          <div className="create-actions">
            {(musicConfigurationMessage || musicFeasibilityMessage) && <p className="form-error" role="status">{musicConfigurationMessage || musicFeasibilityMessage}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button variant="primary" className="create-button" disabled={submitting || health?.ffmpeg === false || Boolean(musicConfigurationMessage || musicFeasibilityMessage)} onClick={submit}>{submitting ? "Creating…" : <><Plus size={16} /> {mode === "clip" ? `Create ${count} ${contentFormat === "long" ? "landscape clip" : "short clip"}${count === 1 ? "" : "s"}` : "Create script video"}</>}</Button>
          </div>
        </div>

        {/* Its own row of the panel grid, under the action column. Kept out of
            `.create-actions` so the footnote cannot push the Create button off
            the line it shares with the Processing mode control. */}
        <div className="create-note-row"><p className="rights-copy">Only process content you own or are authorised to use.</p></div>
      </div>
    </section>

    <RecentClips onSelectAsset={(assetId) => onSelectLibraryAsset?.(assetId)} />

    <section className="recent-section">
      <div className="section-heading">
        <div><h2>Recent projects</h2><span className="section-count" data-testid="recent-project-count">{query ? `${visibleProjects.length} of ${projects.length}` : visibleProjects.length}</span></div>
        <div className="section-tools">
          <div className="project-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search projects" placeholder="Search projects…" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} /></div>
          <button onClick={() => { void onRefresh(); void loadSourceAssets(); }}>Refresh</button>
        </div>
      </div>
      {!loaded ? <div className="project-grid"><Skeleton rows={4} className="skeleton-card" /><Skeleton rows={4} className="skeleton-card" /><Skeleton rows={4} className="skeleton-card" /></div>
        : matchingProjects.length ? <>
          <div className="project-grid">{visibleProjects.map((project) => {
            const status = projectStatus(project, jobs);
            const outputClip = authoritativeJob(project, jobs)?.clips.find((clip) => clip.width && clip.height);
            const outputAspect = resolveOutputAspectRatio(undefined, outputClip?.width, outputClip?.height, project.contentFormat);
            const sourceAsset = sourceAssets.find((asset) => asset.sourceProjectId === project.id && asset.mediaType.startsWith("video/") && asset.previewUrl);
            return <article className="project-card" key={project.id}>
              {sourceAsset ? <button className="project-source-preview" type="button" aria-label={`Preview source video for ${project.name}`} onClick={(event) => void openSourcePreview(project, event.currentTarget)}>
                <LazyVideoThumbnail key={sourceAsset.blobId} className="project-thumb" src={sourceAsset.previewUrl}><span><Film size={26} /></span>{status.progress !== undefined && <Progress value={status.progress} label={status.label || "Project progress"} />}</LazyVideoThumbnail>
              </button> : <div className={`project-thumb ${project.mode}`} aria-hidden="true"><div className="frame-lines" /><span>{project.mode === "clip" ? <Film size={26} /> : <FileText size={26} />}</span>{status.progress !== undefined && <Progress value={status.progress} label={status.label || "Project progress"} />}</div>}
              <button className="project-card-open" type="button" aria-label={`Open project ${project.name}`} onClick={() => onOpen(project.id)}><div className="project-card-body"><div className="project-card-title"><strong title={project.name}>{project.name}</strong><StatusBadge className="project-card-status" state={status.state} label={status.label || undefined} /></div><p>{project.mode === "clip" ? `${project.requestedCount} ${project.contentFormat === "long" ? "landscape clip" : "short clip"}${project.requestedCount === 1 ? "" : "s"} · ${outputAspect}` : "Script video"} · {project.style}</p><span>{formatAge(project.updatedAt)} · {project.sourceKind === "youtube" ? "Authorised URL" : "Local source"}</span></div></button>
              <button className="project-card-delete" type="button" aria-label={`Delete project ${project.name} everywhere`} onClick={(event) => requestProjectDeletion(project, event.currentTarget)}><Trash2 size={14} aria-hidden="true" /> Delete everywhere</button>
            </article>;
          })}</div>
          {!query && projects.length > RECENT_LIMIT && <button className="show-all-projects" onClick={() => setShowAllProjects(!showAllProjects)} aria-expanded={showAllProjects}>{showAllProjects ? `Show recent ${RECENT_LIMIT}` : `Show all ${projects.length} projects`}</button>}
        </> : query && !matchingProjects.length ? <div className="inline-empty"><Search size={20} /><span>No project matches “{projectQuery.trim()}”.</span><button className="clear-search" onClick={() => setProjectQuery("")}>Clear search</button></div>
          : <div className="inline-empty"><Film size={22} /><span>Your projects will appear here after you create the first cut.</span></div>}
    </section>
    {previewAsset && <VideoPreviewDialog asset={previewAsset} opener={previewOpener} onClose={() => setPreviewAsset(null)} />}
    {projectToDelete && <ProjectDeletionDialog project={projectToDelete} deleting={deletingProject} error={deleteError} onCancel={closeProjectDeletion} onConfirm={() => void confirmProjectDeletion()} />}
  </div>;
}

function ProjectDeletionDialog({ project, deleting, error, onCancel, onConfirm }: { project: Project; deleting: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  return <div className="dialog-backdrop"><section ref={dialogRef} className="confirmation-dialog project-deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="project-deletion-title" aria-describedby="project-deletion-copy">
    <h2 id="project-deletion-title">Delete “{project.name}” everywhere?</h2>
    <p id="project-deletion-copy">This permanently removes the project, all associated jobs and clip history, project-source assets, and generated clips or script outputs associated with this project. Shared content-addressed blobs remain when another durable reference still uses them.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><Button disabled={deleting} onClick={onCancel}>Cancel</Button><Button variant="danger" disabled={deleting} onClick={onConfirm}><Trash2 size={15} aria-hidden="true" />{deleting ? "Deleting…" : "Delete project everywhere"}</Button></div>
  </section></div>;
}
