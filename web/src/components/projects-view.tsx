import { useEffect, useRef, useState } from "react";
import { FileText, Film, FolderOpen, Plus, Sparkles, Zap } from "lucide-react";
import { createClipJob, createFolder, createScriptJob, listFolders, readableError } from "../api";
import type { ContentFormat, Health, Job, LibraryFolder, ProcessingMode, Project, Style } from "../types";
import { projectStatus } from "../project-status";
import { Button, Field, PageHeader, Progress, StatusBadge, formatAge } from "./common";
import { VideoSourcePicker } from "./video-source-picker";

const RECENT_FOLDER_KEY = "s6-cut.recent-library-folder";

const styles: { id: Style; label: string; note: string }[] = [
  { id: "funny", label: "Funny", note: "Punchlines & reactions" },
  { id: "serious", label: "Serious", note: "Complete claims" },
  { id: "educational", label: "Educational", note: "Clear explanations" },
  { id: "hype", label: "Hype", note: "Hooks & high energy" },
];

export function ProjectsView({ projects, jobs = [], health, hasSelectedProvider = true, onConfigureProviders = () => undefined, onCreated, onOpen, onRefresh }: {
  projects: Project[];
  jobs?: Job[];
  health: Health | null;
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
  const scriptInput = useRef<HTMLInputElement>(null);

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

  const submit = async () => {
    setError(null);
    if (mode === "clip" && sourceType === "file" && !file) return setError("Choose a local video first.");
    if (mode === "clip" && sourceType === "url" && !url.trim()) return setError("Paste a supported YouTube URL first.");
    if (mode === "script" && script.trim().length < 10) return setError("Add at least 10 characters of script.");
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
  };

  const loadScriptFile = async (selected: File | undefined) => {
    if (!selected) return;
    if (!/\.(txt|md)$/i.test(selected.name)) return setError("Script uploads must be .txt or .md files.");
    setScript(await selected.text());
  };

  return <div className="page projects-page">
    <PageHeader eyebrow="Local-first studio" title="Make the first cut" description="Add a source, choose an editorial style, and review clips as they finish." actions={<StatusBadge state={health?.status === "ready" ? "ready" : "fallback"} label={health?.status === "ready" ? "All local tools ready" : "Some local tools unavailable"} />} />

    <section className="create-panel" aria-labelledby="create-title">
      <div className="create-topline">
        <div><span className="step-number">01</span><div><h2 id="create-title">Create a project</h2><p>Nothing leaves this machine unless you use a URL or enabled provider.</p></div></div>
        <div className="segmented" aria-label="Creation mode">
          <button type="button" aria-pressed={mode === "clip"} className={mode === "clip" ? "active" : ""} onClick={() => setMode("clip")}><Film size={15} /> Clip mode</button>
          <button type="button" aria-pressed={mode === "script"} className={mode === "script" ? "active" : ""} onClick={() => setMode("script")}><FileText size={15} /> Script mode</button>
        </div>
      </div>

      {!hasSelectedProvider && !providerCalloutDismissed && <div className="provider-callout"><Sparkles size={17} /><div><strong>Add optional AI providers</strong><span>Connect OpenRouter for enhanced planning and ElevenLabs for premium narration. Local fallbacks remain available.</span></div><div className="provider-callout-actions"><Button onClick={onConfigureProviders}>Configure providers</Button><Button variant="ghost" onClick={() => setProviderCalloutDismissed(true)}>Continue locally</Button></div></div>}

      <div className="create-grid">
        <div className="create-step source-step">
          <div className="step-label"><span>1</span>{mode === "clip" ? "Add source" : "Add script"}</div>
          {mode === "clip" ? <VideoSourcePicker mode={sourceType} onModeChange={(next) => setSourceType(next as "file" | "url")} file={file} onFile={(next, pickerError) => { setFile(next); if (pickerError) setError(pickerError); else setError(null); }} url={url} onUrl={setUrl} /> : <div className="script-input-wrap">
            <textarea value={script} onChange={(event) => setScript(event.target.value)} placeholder="Paste the exact script. S6_cut preserves this source text…" rows={8} />
            <div className="script-meta"><span>{script.length.toLocaleString()} characters</span><input ref={scriptInput} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => loadScriptFile(event.target.files?.[0])} hidden /><button onClick={() => scriptInput.current?.click()}><FolderOpen size={14} /> Upload .txt or .md</button></div>
          </div>}
        </div>

        <div className="create-step style-step">
          <div className="step-label"><span>2</span>Pick style</div>
          <div className="style-grid">
            {styles.map((item) => <button key={item.id} className={style === item.id ? "style-card active" : "style-card"} onClick={() => setStyle(item.id)} aria-pressed={style === item.id}>
              <span className={`style-swatch ${item.id}`} /><strong>{item.label}</strong><small>{item.note}</small>
            </button>)}
          </div>
          {mode === "clip" ? <Field label={contentFormat === "long" ? "Scenes requested" : "Clips requested"}><div className="count-control"><button onClick={() => setCount(Math.max(1, count - 1))} aria-label="Fewer clips">−</button><strong>{count}</strong><button onClick={() => setCount(Math.min(30, count + 1))} aria-label="More clips">+</button></div></Field>
            : <Field label="Narration" hint="ElevenLabs is optional. Automatic uses local voice when needed, then a clearly labelled silent render."><select value={narration} onChange={(event) => setNarration(event.target.value as typeof narration)}><option value="auto">Automatic fallback</option><option value="local">Local voice only</option><option value="silent">Silent render (no narration)</option></select></Field>}
        </div>

        <div className="create-step action-step">
          <div className="step-label"><span>3</span>Create</div>
          <div className="engine-summary">
            <div><span className={`engine-dot ${health?.status || "offline"}`} /><strong>{health?.status === "ready" ? "Local engine ready" : "Local fallback mode"}</strong></div>
            <ul>
              <li>{health?.whisper ? "Local Whisper word timing" : "Whisper installs in the engine image"}</li>
              <li>{health?.ffmpeg ? "FFmpeg render available" : "Rendering unavailable in this runtime"}</li>
              <li>Deterministic {style} selection</li>
            </ul>
          </div>
          {mode === "clip" && <><div className="mode-field format-field"><div className="step-label"><span>Format</span></div>
            <div className="segmented mode-tabs format-tabs" aria-label="Content format">
              <button type="button" aria-pressed={contentFormat === "short"} className={contentFormat === "short" ? "active" : ""} onClick={() => { setContentFormat("short"); setAspectRatio("9:16"); }}><Film size={13} /> <span>Short form · 9:16</span></button>
              <button type="button" aria-pressed={contentFormat === "long"} className={contentFormat === "long" ? "active" : ""} onClick={() => { setContentFormat("long"); setAspectRatio("16:9"); }}><Film size={13} /> <span>Long form · 16:9</span></button>
            </div>
            <div className="mode-note format-note">
              <span className="mode-note-icon" aria-hidden="true"><Film size={12} /></span>
              <span className="mode-note-copy">{contentFormat === "long" ? "Landscape scenes are selected across the complete source." : "Vertical clips are selected for short-form viewing."}</span>
            </div>
          </div><div className="mode-field"><div className="step-label"><span>Mode</span></div>
            <div className="segmented mode-tabs processing-mode-tabs" aria-label="Processing mode">
              <button type="button" aria-pressed={processingMode === "auto"} className={processingMode === "auto" ? "active" : ""} onClick={() => setProcessingMode("auto")}><Sparkles size={13} /> <span>Auto</span></button>
              <button type="button" aria-pressed={processingMode === "fast"} className={processingMode === "fast" ? "active" : ""} onClick={() => setProcessingMode("fast")}><Zap size={13} /> <span>Fast</span></button>
              <button type="button" aria-pressed={processingMode === "smart"} className={processingMode === "smart" ? "active" : ""} onClick={() => setProcessingMode("smart")}><Sparkles size={13} /> <span>Smart</span></button>
            </div>
            <div className="mode-note" role="note">
              <span className="mode-note-icon" aria-hidden="true">{processingMode === "smart" ? <Sparkles size={12} /> : <Zap size={12} />}</span>
              <span className="mode-note-copy">{processingMode === "smart" && !hasSelectedProvider
                ? <><strong>Smart local mode.</strong> No connected provider is selected, so Smart will use local Whisper and deterministic planning.</>
                : processingMode === "smart"
                  ? <>Smart uses the selected provider for enhanced planning.</>
                  : processingMode === "auto"
                    ? hasSelectedProvider
                      ? <>Auto uses a provider when connected, otherwise Fast local.</>
                      : <>No provider selected — this will run as a <strong>Fast local cut</strong>.</>
                    : <>Fast runs deterministically on this machine — no provider needed.</>}</span>
            </div>
          </div></>}
          <Field label="Project name" hint="Optional. Leave blank for a generated name."><input id="project-name" aria-label="Project name" value={projectName} maxLength={160} onChange={(event) => setProjectName(event.target.value)} placeholder="QA Browser Test" /></Field>
          <div className="folder-picker"><Field label="Business folder"><select aria-label="Business folder" value={libraryFolderId} onChange={(event) => setLibraryFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Button variant="ghost" onClick={addFolder}><Plus size={13} /> Create folder</Button></div>
          {mode === "clip" && <label className="subtitle-toggle"><input type="checkbox" checked={burnSubtitles} onChange={(event) => setBurnSubtitles(event.target.checked)} /> <span><strong>Burn in subtitles</strong><small>Accurate local word timing; enabled by default. Fast transcribes selected windows only.</small></span></label>}
          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>Advanced controls <span>{advanced ? "−" : "+"}</span></button>
          {advanced && <div className="advanced-grid">
            <Field label="Aspect"><select value={aspectRatio} disabled={mode === "clip" && contentFormat === "long"} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>1:1</option><option>16:9</option><option>4:5</option></select></Field>
            {mode === "clip" && <><Field label="Minimum seconds"><input type="number" min={8} max={contentFormat === "long" ? 600 : 120} value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))} /></Field><Field label="Maximum seconds"><input type="number" min={10} max={contentFormat === "long" ? 1800 : 180} value={maxDuration} onChange={(event) => setMaxDuration(Number(event.target.value))} /></Field></>}
          </div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button variant="primary" className="create-button" disabled={submitting || health?.ffmpeg === false} onClick={submit}>{submitting ? "Creating…" : <><Plus size={17} /> {mode === "clip" ? `Create ${count} ${contentFormat === "long" ? "landscape clips" : "short clips"}` : "Create script video"}</>}</Button>
          <p className="rights-copy">Only process content you own or are authorised to use.</p>
        </div>
      </div>
    </section>

    <section className="recent-section">
      <div className="section-heading"><div><span className="step-number">02</span><h2>Recent projects</h2></div><button onClick={() => onRefresh()}>Refresh</button></div>
      {projects.length ? <div className="project-grid">{projects.map((project) => { const status = projectStatus(project, jobs); return <button className="project-card" key={project.id} onClick={() => onOpen(project.id)}>
        <div className={`project-thumb ${project.mode}`}><div className="frame-lines" /><span>{project.mode === "clip" ? <Film size={26} /> : <FileText size={26} />}</span>{status.progress !== undefined && <Progress value={status.progress} label={status.label || "Project progress"} />}</div>
        <div className="project-card-body"><div className="project-card-title"><strong>{project.name}</strong><StatusBadge state={status.state} label={status.label || undefined} /></div><p>{project.mode === "clip" ? `${project.requestedCount} ${project.contentFormat === "long" ? "landscape clips" : "short clips"} · ${project.contentFormat === "long" ? "16:9" : "9:16"}` : "Script video"} · {project.style}</p><span>{formatAge(project.updatedAt)} · {project.sourceKind === "youtube" ? "Authorised URL" : "Local source"}</span></div>
      </button>; })}</div> : <div className="inline-empty"><Film size={22} /><span>Your projects will appear here after you create the first cut.</span></div>}
    </section>
  </div>;
}
