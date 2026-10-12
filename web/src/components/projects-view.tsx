import { useEffect, useState } from "react";
import { Film, Plus, Sparkles, Zap } from "lucide-react";
import { createClipJob, createFolder, listFolders, readableError } from "../api";
import { DEFAULT_SUBSCRIBE_ANIMATION, type BatchMode, type ContentFormat, type Health, type LibraryFolder, type ProcessingMode, type Project, type SourceProfile, type Style, type SubscribeAnimationConfig, type MusicTheme } from "../types";
import { Button, Field, FieldGroup, StepBadge, useSingleFlight } from "./common";
import { VideoSourcePicker } from "./video-source-picker";
import { VideoOnlyDownload } from "./video-only-download";
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
  const [sourceType, setSourceType] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [style, setStyle] = useState<Style>("educational");
  const [count, setCount] = useState(5);
  const [highVolumeCount, setHighVolumeCount] = useState("5");
  const [batchMode, setBatchMode] = useState<BatchMode>("standard");
  const [contentFormat, setContentFormat] = useState<ContentFormat>("short");
  const [advanced, setAdvanced] = useState(false);
  const [minDuration, setMinDuration] = useState(20);
  const [maxDuration, setMaxDuration] = useState(60);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("auto");
  const [sourceProfile, setSourceProfile] = useState<SourceProfile>("speech");
  const [musicTheme, setMusicTheme] = useState<MusicTheme>("clean");
  const [musicTopText, setMusicTopText] = useState("");
  const [sourceDuration, setSourceDuration] = useState<{ file: File; seconds: number } | null>(null);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [hookTextChoice, setHookTextChoice] = useState<boolean | undefined>(undefined);
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
  const singleFlight = useSingleFlight();

  useEffect(() => {
    if (sourceType !== "file" || !file) return;
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => setSourceDuration(Number.isFinite(video.duration) ? { file, seconds: video.duration } : null);
    video.onerror = () => setSourceDuration(null);
    video.src = objectUrl;
    return () => { URL.revokeObjectURL(objectUrl); video.removeAttribute("src"); };
  }, [file, sourceType]);

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
    const rawHighVolumeCount = highVolumeCount.trim();
    const highVolumeCountValue = rawHighVolumeCount === "" ? 1 : Number(rawHighVolumeCount);
    if (batchMode === "high_volume" && rawHighVolumeCount !== "" && !/^-?[0-9]+$/.test(rawHighVolumeCount)) {
      return setError("Requested count must be a whole number from 1 to 500.");
    }
    const requestedCount = batchMode === "high_volume"
      ? Math.min(500, Math.max(1, highVolumeCountValue))
      : count;
    if (sourceType === "file" && !file) return setError("Choose a local video first.");
    if (sourceType === "url") {
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
      if (!Number.isFinite(requestedCount) || !Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > (batchMode === "high_volume" ? 500 : 30)) return setError(batchMode === "high_volume" ? "High-volume batches support 1–500 requested outputs." : "Standard batches support 1–30 requested outputs.");
      setCount(requestedCount);
      if (batchMode === "high_volume") setHighVolumeCount(String(requestedCount));
      if (!Number.isFinite(minDuration) || minDuration < 8) return setError("Minimum seconds must be at least 8.");
      if (minDuration > 120) return setError("Minimum seconds must be at most 120.");
      if (!Number.isFinite(maxDuration) || maxDuration <= minDuration) return setError("Maximum seconds must be greater than minimum seconds.");
      if (contentFormat === "short" && maxDuration > 180) return setError("Short-form clips can be at most 180 seconds.");
      if (sourceProfile === "music" && musicTopText.length > 100) return setError("Top text must be 100 characters or fewer.");
      if (musicConfigurationMessage) return setError(musicConfigurationMessage);
      if (musicFeasibilityMessage) return setError(musicFeasibilityMessage);
    setSubmitting(true);
    try {
      const result = await createClipJob({
          file: sourceType === "file" ? file || undefined : undefined,
          url: sourceType === "url" ? url.trim() : undefined,
          name: projectName.trim() || undefined, style, count: requestedCount, minDuration, maxDuration,
          aspectRatio: contentFormat === "long" ? "16:9" : aspectRatio,
          contentFormat, batchMode,
          processingMode: sourceProfile === "music" ? "smart" : processingMode,
          sourceProfile, burnSubtitles: fastMode ? false : burnSubtitles,
          ...(hookTextEnabled ? { hookText: true } : {}),
          subscribeAnimation, libraryFolderId: libraryFolderId || undefined,
          ...(sourceProfile === "music" ? { musicPresentation: { version: 1 as const, subtitleTheme: musicTheme }, musicTopText } : {}),
        });
      if (libraryFolderId) localStorage.setItem(RECENT_FOLDER_KEY, libraryFolderId);
      onCreated(result.project);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setSubmitting(false);
    }
  });

  // Until /profiles answers we do not know whether a provider is connected, and
  // must not assert that none is: that read can take several seconds, and the
  // claim was wrong for the whole of it whenever a provider was in fact set up.
  const fastMode = sourceProfile === "speech" && (processingMode === "fast" || (processingMode === "auto" && providersLoaded && !hasSelectedProvider));
  const knownSourceDuration = sourceType === "file" && sourceDuration?.file === file ? sourceDuration.seconds : null;
  const hookTextDisabledReason = sourceProfile === "music" ? "Music mode does not support AI hook text; Music keeps its manual Top text."
    : processingMode === "fast" ? "Fast mode does not support AI hook text."
      : contentFormat === "long" ? "Long form does not support AI hook text."
        : batchMode === "high_volume" ? "High-volume batches do not support AI hook text."
          : !providersLoaded ? "Checking connected providers…"
            : !hasSelectedProvider ? "No connected provider; AI hook text is unavailable."
              : null;
  const hookTextEnabled = hookTextDisabledReason === null && hookTextChoice !== false;
  const musicConfigurationMessage = sourceProfile === "music" && contentFormat !== "short"
    ? "Music / sung vocals is currently available for short clips only. Choose Short form to continue."
    : null;
  const rawActiveCount = highVolumeCount.trim();
  const activeCount = batchMode === "high_volume"
    ? rawActiveCount === "" || !/^-?[0-9]+$/.test(rawActiveCount)
      ? 1
      : Math.min(500, Math.max(1, Number(rawActiveCount)))
    : count;
  const musicFeasibilityMessage = sourceProfile === "music" && knownSourceDuration !== null && Number.isFinite(minDuration) && minDuration > 0 && activeCount > Math.floor((knownSourceDuration + 1e-9) / minDuration)
    ? `This ${knownSourceDuration.toFixed(1)}s source can fit at most ${Math.floor(knownSourceDuration / minDuration)} non-overlapping clips of at least ${minDuration}s. Reduce the count or minimum duration; the requested count will not be changed automatically.`
    : null;
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
        <div className="create-mode-controls">
          <div className="segmented" aria-label="Creation mode">
            <button type="button" aria-pressed={sourceProfile === "speech"} className={sourceProfile === "speech" ? "active" : ""} onClick={() => { setError(null); setSourceProfile("speech"); }}><Film size={15} /> Clip mode</button>
            <button type="button" aria-label="Music / sung vocals" aria-pressed={sourceProfile === "music"} className={sourceProfile === "music" ? "active" : ""} onClick={() => { setError(null); setSourceProfile("music"); setBatchMode("standard"); setCount(Math.min(30, batchMode === "high_volume" ? Math.min(500, Math.max(1, Number(highVolumeCount) || 1)) : count)); setContentFormat("short"); setAspectRatio("9:16"); setBurnSubtitles(true); }}><span className="music-mode-icon" aria-hidden="true">♫</span> Music mode</button>
          </div>
        </div>
      </div>

      {providersLoaded && !hasSelectedProvider && !providerCalloutDismissed && <div className="provider-callout"><Sparkles size={17} /><div><strong>Add optional AI providers</strong><span>OpenRouter can improve Smart planning. Local modes stay available.</span></div><div className="provider-callout-actions"><Button onClick={onConfigureProviders}>Configure providers</Button><Button variant="ghost" onClick={() => {
        setProviderCalloutDismissed(true);
        try { localStorage.setItem(PROVIDER_CALLOUT_DISMISSED_KEY, "true"); } catch { /* Storage can be unavailable in hardened browsers. */ }
      }}>Continue locally</Button></div></div>}

      <div className="create-grid">
        <div className="create-step source-step">
          <div className="step-label"><StepBadge step={1} /><span className="step-label-text">Add source</span></div>
          <VideoSourcePicker mode={sourceType} onModeChange={(next) => { setError(null); setSourceType(next as "file" | "url"); }} file={file} onFile={(next, pickerError) => { setFile(next); setSourceDuration(null); if (pickerError) setError(pickerError); else setError(null); }} url={url} onUrl={setUrl} downloadAction={<VideoOnlyDownload url={url} />} />
          {healthChecked && <div className="engine-summary">
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

          <>
            {sourceProfile === "music" && <FieldGroup title="Lyrics presentation" hint={MUSIC_PROFILE_NOTE}>
              <div role="group" aria-label="Lyrics subtitle theme">
              <p className="music-theme-group-label">Current styles</p>
              <div className="music-theme-options">
                <button type="button" aria-label="Clean sans" aria-pressed={musicTheme === "clean"} className={musicTheme === "clean" ? "active" : ""} onClick={() => setMusicTheme("clean")}><span className="theme-clean">i’ve<br />forgotten<br />about</span><strong>Clean sans</strong><small>White · compact</small></button>
                <button type="button" aria-label="Warm highlight" aria-pressed={musicTheme === "warm"} className={musicTheme === "warm" ? "active" : ""} onClick={() => setMusicTheme("warm")}><span className="theme-warm">do you think<br />that i’ve forgotten<br />about</span><strong>Warm highlight</strong><small>Soft yellow accents</small></button>
                <button type="button" aria-label="Soft serif" aria-pressed={musicTheme === "serif"} className={musicTheme === "serif" ? "active" : ""} onClick={() => setMusicTheme("serif")}><span className="theme-serif">do you think<br />that i’ve forgotten<br />about</span><strong>Soft serif</strong><small>Light editorial</small></button>
              </div>
              <p className="music-theme-group-label">Reference styles</p>
              <div className="music-theme-options">
                <button type="button" aria-label="Reference white sans" aria-pressed={musicTheme === "reference_white_sans"} className={musicTheme === "reference_white_sans" ? "active" : ""} onClick={() => setMusicTheme("reference_white_sans")}><span className="theme-reference-white-sans">i’ve<br />forgotten<br />about</span><strong>Reference white sans</strong><small>Light · stacked</small></button>
                <button type="button" aria-label="Reference yellow sans" aria-pressed={musicTheme === "reference_yellow_sans"} className={musicTheme === "reference_yellow_sans" ? "active" : ""} onClick={() => setMusicTheme("reference_yellow_sans")}><span className="theme-reference-yellow-sans">do you think<br />that i’ve forgotten<br />about</span><strong>Reference yellow sans</strong><small>Pale yellow · spaced</small></button>
                <button type="button" aria-label="Reference white serif" aria-pressed={musicTheme === "reference_white_serif"} className={musicTheme === "reference_white_serif" ? "active" : ""} onClick={() => setMusicTheme("reference_white_serif")}><span className="theme-reference-white-serif">do you think<br />that i’ve forgotten<br />about</span><strong>Reference white serif</strong><small>White · editorial</small></button>
              </div>
              </div>
            </FieldGroup>}
            <FieldGroup title="Format">
              <div className="segmented mode-tabs format-tabs" aria-label="Content format">
                <button type="button" aria-pressed={contentFormat === "short"} className={contentFormat === "short" ? "active" : ""} onClick={() => { setContentFormat("short"); setAspectRatio("9:16"); }}>Short form · 9:16</button>
                <button type="button" aria-pressed={contentFormat === "long"} className={contentFormat === "long" ? "active" : ""} disabled={sourceProfile === "music"} onClick={() => { setContentFormat("long"); setAspectRatio("16:9"); }}>Long form · 16:9</button>
              </div>
              <Field label={contentFormat === "long" ? "Scenes requested" : "Clips requested"} hint={batchMode === "high_volume" ? "1–500" : undefined}>
                {batchMode === "standard" ? <div className="count-control"><button type="button" disabled={count <= 1} onClick={() => setCount(Math.max(1, count - 1))} aria-label="Fewer clips">−</button><strong aria-live="polite">{count}</strong><button type="button" disabled={count >= 30} onClick={() => setCount(Math.min(30, count + 1))} aria-label="More clips">+</button></div> : <div className="high-volume-count-field"><input className="high-volume-count-input" aria-label={contentFormat === "long" ? "Scenes requested" : "Clips requested"} type="text" inputMode="numeric" value={highVolumeCount} aria-invalid={highVolumeCount.trim() !== "" && !/^-?[0-9]+$/.test(highVolumeCount.trim())} onChange={(event) => {
                  const value = event.target.value;
                  if (/^-?[0-9]+$/.test(value) && Number(value) > 500) setHighVolumeCount("500");
                  else setHighVolumeCount(value);
                }} onBlur={() => {
                  const value = highVolumeCount.trim();
                  if (value === "") setHighVolumeCount("1");
                  else if (/^-?[0-9]+$/.test(value) && Number(value) < 1) setHighVolumeCount("1");
                }} />{highVolumeCount.trim() !== "" && !/^-?[0-9]+$/.test(highVolumeCount.trim()) && <span className="form-hint" aria-live="polite">Enter a whole number from 1 to 500.</span>}</div>}
              </Field>
            </FieldGroup>
            <FieldGroup title="Batch size" hint={batchMode === "standard" ? "Standard keeps the existing planning behavior and limit of 30." : "High-volume allows up to 500 requested cuts. If the source cannot satisfy the request, the engine explains its effective target."}>
              <div className="segmented mode-tabs" aria-label="Batch size">
                <button type="button" aria-pressed={batchMode === "standard"} className={batchMode === "standard" ? "active" : ""} onClick={() => { const value = highVolumeCount.trim(); const next = value !== "" && /^[0-9]+$/.test(value) ? Number(value) : count; setCount(Math.min(30, Math.max(1, next))); setBatchMode("standard"); }}>Standard · up to 30</button>
                <button type="button" aria-pressed={batchMode === "high_volume"} className={batchMode === "high_volume" ? "active" : ""} disabled={sourceProfile === "music"} onClick={() => { setHighVolumeCount(String(count)); setBatchMode("high_volume"); }}>High-volume · up to 500</button>
              </div>
              {sourceProfile === "music" && <p className="form-hint">Music keeps its existing non-overlapping planner and Standard batch limit.</p>}
              {batchMode === "high_volume" && sourceType === "url" && <p className="form-hint" role="status">The effective target is pending YouTube download and server-side FFprobe validation.</p>}
              {batchMode === "high_volume" && sourceType === "file" && knownSourceDuration === null && <p className="form-hint">Choose a local source to check its duration; FFprobe remains authoritative.</p>}
            </FieldGroup>

            {sourceProfile === "speech" && <FieldGroup title="Processing mode">
              <div className="segmented mode-tabs processing-mode-tabs" aria-label="Processing mode">
                <button type="button" aria-pressed={processingMode === "auto"} className={processingMode === "auto" ? "active" : ""} onClick={() => setProcessingMode("auto")}><Sparkles size={13} /> <span>Auto</span></button>
                <button type="button" aria-pressed={processingMode === "fast"} className={processingMode === "fast" ? "active" : ""} onClick={() => { setProcessingMode("fast"); setBurnSubtitles(false); }}><Zap size={13} /> <span>Fast</span></button>
                <button type="button" aria-pressed={processingMode === "smart"} className={processingMode === "smart" ? "active" : ""} onClick={() => setProcessingMode("smart")}><Sparkles size={13} /> <span>Smart</span></button>
              </div>
            </FieldGroup>}
          </>
        </div>

        <div className="create-step action-step">
          <div className="step-label"><StepBadge step={3} /><span className="step-label-text">Name and create</span></div>
          <FieldGroup title="Destination">
            <Field label="Project name" hint="Optional. Leave blank for a generated name."><input id="project-name" aria-label="Project name" value={projectName} maxLength={160} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Launch highlights" /></Field>
            <div className="folder-picker"><Field label="Business folder"><select aria-label="Business folder" value={libraryFolderId} onChange={(event) => setLibraryFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Button variant="ghost" onClick={addFolder}><Plus size={13} /> New folder</Button></div>
          </FieldGroup>

          {sourceProfile === "music" && <FieldGroup title="Top text" hint="Optional · displayed separately in the upper black area. Up to 100 characters.">
            <Field label="Top text"><input value={musicTopText} maxLength={100} onChange={(event) => setMusicTopText(event.target.value)} placeholder="Leave blank to omit" /></Field>
          </FieldGroup>}

          <SubscribeAnimationControl value={subscribeAnimation} onChange={setSubscribeAnimation} longForm={contentFormat === "long"} />

          {sourceProfile === "speech" && <label className="subtitle-toggle"><input type="checkbox" checked={fastMode ? false : burnSubtitles} disabled={fastMode} onChange={(event) => setBurnSubtitles(event.target.checked)} /> <span><strong>Burn in subtitles</strong><small>{fastMode ? "Fast mode skips transcription and captions. Choose Smart mode to enable them." : "Uses local word timing. Fast mode skips captions."}</small></span></label>}
          <label className="subtitle-toggle"><input type="checkbox" aria-label="Generate AI hook text" checked={hookTextEnabled} disabled={hookTextDisabledReason !== null} onChange={(event) => setHookTextChoice(event.target.checked)} /> <span><strong>AI hook text</strong><small>{hookTextDisabledReason ?? "OpenRouter writes a short curiosity hook shown at the top of each short."}</small></span></label>

          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>Advanced controls <span aria-hidden="true">{advanced ? "−" : "+"}</span></button>
          {advanced && <div className="advanced-grid">
            <Field label="Aspect"><select value={aspectRatio} disabled={contentFormat === "long"} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>1:1</option><option>16:9</option><option>4:5</option></select></Field>
            <Field label="Minimum seconds"><input type="number" min={8} max={120} value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))} /></Field><Field label="Maximum seconds"><input type="number" min={10} max={contentFormat === "long" ? 1800 : 180} value={maxDuration} onChange={(event) => setMaxDuration(Number(event.target.value))} /></Field>
          </div>}

          <div className="create-actions">
            {(musicConfigurationMessage || musicFeasibilityMessage) && <p className="form-error" role="status">{musicConfigurationMessage || musicFeasibilityMessage}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button variant="primary" className="create-button" disabled={submitting || health?.ffmpeg === false || Boolean(musicConfigurationMessage || musicFeasibilityMessage)} onClick={submit}>{submitting ? "Creating…" : <><Plus size={16} /> {`Create ${activeCount} ${contentFormat === "long" ? "landscape clip" : "short clip"}${activeCount === 1 ? "" : "s"}`}</>}</Button>
          </div>
        </div>

      </div>
    </section>

    <RecentClips onSelectAsset={(assetId) => onSelectLibraryAsset?.(assetId)} />

  </div>;
}
