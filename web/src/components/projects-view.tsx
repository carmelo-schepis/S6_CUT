import { useEffect, useRef, useState } from "react";
import { FileText, Film, FolderOpen, Plus, Sparkles, Zap } from "lucide-react";
import { createClipJob, createFolder, createScriptJob, listFolders, readableError } from "../api";
import { DEFAULT_SUBSCRIBE_ANIMATION, type ContentFormat, type Health, type LibraryFolder, type ProcessingMode, type Project, type SourceProfile, type Style, type SubscribeAnimationConfig } from "../types";
import { Button, Field, FieldGroup, StepBadge, useSingleFlight } from "./common";
import { VideoSourcePicker } from "./video-source-picker";
import { SubscribeAnimationControl } from "./subscribe-animation-control";
import { RecentClips } from "./recent-clips";

const RECENT_FOLDER_KEY = "s6-cut.recent-library-folder";
const PROVIDER_CALLOUT_DISMISSED_KEY = "s6-cut.provider-callout-dismissed";
const MUSIC_PROFILE_NOTE = "Music / sung vocals always uses Smart transcription locally. VAD disabled; word timestamps retained. Sung words may still be missed or hallucinated, so review outputs.";

const styles: { id: Style; label: string; note: string }[] = [
  { id: "funny", label: "Funny", note: "Punchlines & reactions" },
  { id: "serious", label: "Serious", note: "Complete claims" },
  { id: "educational", label: "Educational", note: "Clear explanations" },
  { id: "hype", label: "Hype", note: "Hooks & high energy" },
];

export function ProjectsView({ health, healthChecked = true, providersLoaded = true, hasSelectedProvider = true, onConfigureProviders = () => undefined, onCreated, onSelectLibraryAsset }: {
  health: Health | null;
  /** False while the very first health read is still outstanding. */
  healthChecked?: boolean;
  /** False until /profiles has answered; provider availability is unknown. */
  providersLoaded?: boolean;
  hasSelectedProvider?: boolean;
  onConfigureProviders?: () => void;
  onCreated: (project: Project) => void;
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

  </div>;
}
