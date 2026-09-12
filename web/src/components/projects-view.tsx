import { useEffect, useRef, useState } from "react";
import { FileText, Film, FolderOpen, Plus, Search, Sparkles, Zap } from "lucide-react";
import { createClipJob, createFolder, createScriptJob, listFolders, readableError } from "../api";
import type { ContentFormat, Health, Job, LibraryFolder, ProcessingMode, Project, Style } from "../types";
import { authoritativeJob, projectStatus } from "../project-status";
import { Button, Field, FieldGroup, PageHeader, Progress, Skeleton, StatusBadge, formatAge, resolveOutputAspectRatio, useSingleFlight } from "./common";
import { VideoSourcePicker } from "./video-source-picker";

const RECENT_FOLDER_KEY = "s6-cut.recent-library-folder";

// Recent projects is a shortlist, not the whole archive: rendering every
// project produced a 30,000px-tall page once the library passed a hundred.
const RECENT_LIMIT = 12;

const styles: { id: Style; label: string; note: string }[] = [
  { id: "funny", label: "Funny", note: "Punchlines & reactions" },
  { id: "serious", label: "Serious", note: "Complete claims" },
  { id: "educational", label: "Educational", note: "Clear explanations" },
  { id: "hype", label: "Hype", note: "Hooks & high energy" },
];

export function ProjectsView({ projects, jobs = [], health, healthChecked = true, loaded = true, providersLoaded = true, hasSelectedProvider = true, onConfigureProviders = () => undefined, onCreated, onOpen, onRefresh }: {
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
  onRefresh: () => Promise<void>;
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
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerCalloutDismissed, setProviderCalloutDismissed] = useState(false);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [libraryFolderId, setLibraryFolderId] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const scriptInput = useRef<HTMLInputElement>(null);
  const singleFlight = useSingleFlight();

  useEffect(() => {
    void listFolders().then((next) => {
      setFolders(next);
      const recent = localStorage.getItem(RECENT_FOLDER_KEY);
      const fallback = next.find((folder) => folder.system || folder.name === "Unsorted") || next[0];
      setLibraryFolderId(next.some((folder) => folder.id === recent) ? recent! : fallback?.id || "");
    }).catch(() => undefined);
  }, []);

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
      if (!Number.isFinite(maxDuration) || maxDuration <= minDuration) return setError("Maximum seconds must be greater than minimum seconds.");
      if (contentFormat === "short" && maxDuration > 180) return setError("Short-form clips can be at most 180 seconds.");
    }
    setSubmitting(true);
    try {
      const result = mode === "clip"
        ? await createClipJob({ file: sourceType === "file" ? file || undefined : undefined, url: sourceType === "url" ? url.trim() : undefined, name: projectName.trim() || undefined, style, count, minDuration, maxDuration, aspectRatio: contentFormat === "long" ? "16:9" : aspectRatio, contentFormat, processingMode, burnSubtitles, libraryFolderId: libraryFolderId || undefined })
        : await createScriptJob({ script, name: projectName.trim() || undefined, style, aspectRatio, narration, libraryFolderId: libraryFolderId || undefined });
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
  const modeNote = processingMode === "fast"
    ? "Fast runs deterministically on this machine. No provider needed."
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
    <PageHeader eyebrow="Local-first studio" title="Make the first cut" description="Add a source, choose an editorial style, and review clips as they finish." actions={health
      ? <StatusBadge state={health.status === "ready" ? "ready" : "fallback"} label={health.status === "ready" ? "All local tools ready" : "Some local tools unavailable"} />
      : healthChecked ? <StatusBadge state="offline" label="Local tools unavailable" /> : undefined} />

    <section className="create-panel" aria-labelledby="create-title">
      <div className="create-topline">
        <div><h2 id="create-title">Create a project</h2><p>Nothing leaves this machine unless you use a URL or an enabled provider.</p></div>
        <div className="segmented" aria-label="Creation mode">
          <button type="button" aria-pressed={mode === "clip"} className={mode === "clip" ? "active" : ""} onClick={() => { setError(null); setMode("clip"); }}><Film size={15} /> Clip mode</button>
          <button type="button" aria-pressed={mode === "script"} className={mode === "script" ? "active" : ""} onClick={() => { setError(null); setMode("script"); }}><FileText size={15} /> Script mode</button>
        </div>
      </div>

      {providersLoaded && !hasSelectedProvider && !providerCalloutDismissed && <div className="provider-callout"><Sparkles size={17} /><div><strong>Add optional AI providers</strong><span>OpenRouter improves planning and provides optional speech narration. Local modes stay available.</span></div><div className="provider-callout-actions"><Button onClick={onConfigureProviders}>Configure providers</Button><Button variant="ghost" onClick={() => setProviderCalloutDismissed(true)}>Continue locally</Button></div></div>}

      <div className="create-grid">
        <div className="create-step source-step">
          <div className="step-label"><span>1</span>{mode === "clip" ? "Add source" : "Add script"}</div>
          {mode === "clip" ? <VideoSourcePicker mode={sourceType} onModeChange={(next) => { setError(null); setSourceType(next as "file" | "url"); }} file={file} onFile={(next, pickerError) => { setFile(next); if (pickerError) setError(pickerError); else setError(null); }} url={url} onUrl={setUrl} /> : <div className="script-input-wrap">
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
          <div className="step-label"><span>2</span>Choose the output</div>
          <FieldGroup title="Editorial style">
            <div className="style-grid">
              {styles.map((item) => <button key={item.id} className={style === item.id ? "style-card active" : "style-card"} onClick={() => setStyle(item.id)} aria-pressed={style === item.id}>
                <span className={`style-swatch ${item.id}`} /><strong>{item.label}</strong><small>{item.note}</small>
              </button>)}
            </div>
          </FieldGroup>

          {mode === "clip" ? <>
            <FieldGroup title="Format" hint={contentFormat === "long" ? "Landscape scenes are selected across the whole source." : "Vertical clips are selected for short-form viewing."}>
              <div className="segmented mode-tabs format-tabs" aria-label="Content format">
                <button type="button" aria-pressed={contentFormat === "short"} className={contentFormat === "short" ? "active" : ""} onClick={() => { setContentFormat("short"); setAspectRatio("9:16"); }}>Short form · 9:16</button>
                <button type="button" aria-pressed={contentFormat === "long"} className={contentFormat === "long" ? "active" : ""} onClick={() => { setContentFormat("long"); setAspectRatio("16:9"); }}>Long form · 16:9</button>
              </div>
              <Field label={contentFormat === "long" ? "Scenes requested" : "Clips requested"}>
                <div className="count-control"><button onClick={() => setCount(Math.max(1, count - 1))} aria-label="Fewer clips">−</button><strong aria-live="polite">{count}</strong><button onClick={() => setCount(Math.min(30, count + 1))} aria-label="More clips">+</button></div>
              </Field>
            </FieldGroup>

            <FieldGroup title="Processing mode" hint={modeNote}>
              <div className="segmented mode-tabs processing-mode-tabs" aria-label="Processing mode">
                <button type="button" aria-pressed={processingMode === "auto"} className={processingMode === "auto" ? "active" : ""} onClick={() => setProcessingMode("auto")}><Sparkles size={13} /> <span>Auto</span></button>
                <button type="button" aria-pressed={processingMode === "fast"} className={processingMode === "fast" ? "active" : ""} onClick={() => setProcessingMode("fast")}><Zap size={13} /> <span>Fast</span></button>
                <button type="button" aria-pressed={processingMode === "smart"} className={processingMode === "smart" ? "active" : ""} onClick={() => setProcessingMode("smart")}><Sparkles size={13} /> <span>Smart</span></button>
              </div>
            </FieldGroup>
          </> : <FieldGroup title="Narration" hint="Automatic uses a local voice when needed, then a clearly labelled silent render.">
            <Field label="Narration source"><select value={narration} onChange={(event) => setNarration(event.target.value as typeof narration)}><option value="auto">Automatic fallback</option><option value="local">Local voice only</option><option value="silent">Silent render (no narration)</option></select></Field>
          </FieldGroup>}
        </div>

        <div className="create-step action-step">
          <div className="step-label"><span>3</span>Name and create</div>
          <FieldGroup title="Destination">
            <Field label="Project name" hint="Optional. Leave blank for a generated name."><input id="project-name" aria-label="Project name" value={projectName} maxLength={160} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Launch highlights" /></Field>
            <div className="folder-picker"><Field label="Business folder"><select aria-label="Business folder" value={libraryFolderId} onChange={(event) => setLibraryFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Button variant="ghost" onClick={addFolder}><Plus size={13} /> New folder</Button></div>
          </FieldGroup>

          {mode === "clip" && <label className="subtitle-toggle"><input type="checkbox" checked={burnSubtitles} onChange={(event) => setBurnSubtitles(event.target.checked)} /> <span><strong>Burn in subtitles</strong><small>Uses local word timing. Fast mode transcribes selected windows only.</small></span></label>}

          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>Advanced controls <span aria-hidden="true">{advanced ? "−" : "+"}</span></button>
          {advanced && <div className="advanced-grid">
            <Field label="Aspect"><select value={aspectRatio} disabled={mode === "clip" && contentFormat === "long"} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>1:1</option><option>16:9</option><option>4:5</option></select></Field>
            {mode === "clip" && <><Field label="Minimum seconds"><input type="number" min={8} max={contentFormat === "long" ? 600 : 120} value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))} /></Field><Field label="Maximum seconds"><input type="number" min={10} max={contentFormat === "long" ? 1800 : 180} value={maxDuration} onChange={(event) => setMaxDuration(Number(event.target.value))} /></Field></>}
          </div>}

          <div className="create-actions">
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button variant="primary" className="create-button" disabled={submitting || health?.ffmpeg === false} onClick={submit}>{submitting ? "Creating…" : <><Plus size={17} /> {mode === "clip" ? `Create ${count} ${contentFormat === "long" ? "landscape clip" : "short clip"}${count === 1 ? "" : "s"}` : "Create script video"}</>}</Button>
            <p className="rights-copy">Only process content you own or are authorised to use.</p>
          </div>
        </div>
      </div>
    </section>

    <section className="recent-section">
      <div className="section-heading">
        <div><h2>Recent projects</h2>{projects.length > 0 && <span className="section-count">{query ? `${matchingProjects.length} of ${projects.length}` : projects.length}</span>}</div>
        <div className="section-tools">
          {projects.length > RECENT_LIMIT && <div className="project-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search projects" placeholder="Search projects…" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} /></div>}
          <button onClick={() => onRefresh()}>Refresh</button>
        </div>
      </div>
      {!loaded ? <div className="project-grid"><Skeleton rows={4} className="skeleton-card" /><Skeleton rows={4} className="skeleton-card" /><Skeleton rows={4} className="skeleton-card" /></div>
        : matchingProjects.length ? <>
          <div className="project-grid">{visibleProjects.map((project) => {
            const status = projectStatus(project, jobs);
            const outputClip = authoritativeJob(project, jobs)?.clips.find((clip) => clip.width && clip.height);
            const outputAspect = resolveOutputAspectRatio(undefined, outputClip?.width, outputClip?.height, project.contentFormat);
            return <button className="project-card" key={project.id} onClick={() => onOpen(project.id)}>
              <div className={`project-thumb ${project.mode}`}><div className="frame-lines" /><span>{project.mode === "clip" ? <Film size={26} /> : <FileText size={26} />}</span>{status.progress !== undefined && <Progress value={status.progress} label={status.label || "Project progress"} />}</div>
              <div className="project-card-body"><div className="project-card-title"><strong title={project.name}>{project.name}</strong><StatusBadge state={status.state} label={status.label || undefined} /></div><p>{project.mode === "clip" ? `${project.requestedCount} ${project.contentFormat === "long" ? "landscape clip" : "short clip"}${project.requestedCount === 1 ? "" : "s"} · ${outputAspect}` : "Script video"} · {project.style}</p><span>{formatAge(project.updatedAt)} · {project.sourceKind === "youtube" ? "Authorised URL" : "Local source"}</span></div>
            </button>;
          })}</div>
          {!query && projects.length > RECENT_LIMIT && <button className="show-all-projects" onClick={() => setShowAllProjects(!showAllProjects)} aria-expanded={showAllProjects}>{showAllProjects ? `Show recent ${RECENT_LIMIT}` : `Show all ${projects.length} projects`}</button>}
        </> : query && !matchingProjects.length ? <div className="inline-empty"><Search size={20} /><span>No project matches “{projectQuery.trim()}”.</span><button className="clear-search" onClick={() => setProjectQuery("")}>Clear search</button></div>
          : <div className="inline-empty"><Film size={22} /><span>Your projects will appear here after you create the first cut.</span></div>}
    </section>
  </div>;
}
