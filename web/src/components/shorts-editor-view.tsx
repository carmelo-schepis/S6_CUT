import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, CircleStop, Clock3, Film, GripVertical, MessageSquare, PanelRight, RefreshCw, RotateCcw, Scissors, Send, Sparkles, WandSparkles, X } from "lucide-react";
import { controlJob, createShortsJob, createShortsSourceJob, listAssets, listJobs, readableError, retryClip } from "../api";
import { DEFAULT_SUBSCRIBE_ANIMATION, type Clip, type Job, type LibraryAsset, type SubscribeAnimationConfig } from "../types";
import { Button, StatusBadge, formatDimensions, formatDuration, resolveOutputAspectRatio, useSingleFlight } from "./common";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";
import { VideoSourcePicker, type VideoSourceMode } from "./video-source-picker";
import { SubscribeAnimationControl } from "./subscribe-animation-control";
import { ShortsEditorToolbox, type ShortsTextOverlay as TextOverlay } from "./shorts-editor-toolbox";
import { usePoll } from "../use-poll";

const aspects = ["9:16", "16:9", "1:1", "4:5"] as const;
type AspectRatio = typeof aspects[number];
type EditState = { start: number; end?: number; aspect: AspectRatio; subtitles: boolean; projectName?: string; muted?: boolean; volume?: number; filterPreset?: "none" | "warm" | "cool" | "black_white" | "tint" | "monochrome"; filterIntensity?: number; tintColor?: string; tintOpacity?: number; subscribeAnimation?: SubscribeAnimationConfig };
type ClipRow = { job: Job; clip: Clip };
type AssistantMessage = { id: number; role: "assistant" | "user"; text: string };
type AssistantEdit = { edit: Partial<EditState>; explanation: string };

function sameEditState(left: EditState, right: EditState) {
  return left.start === right.start && left.end === right.end && left.aspect === right.aspect && left.subtitles === right.subtitles && left.muted === right.muted && left.volume === right.volume && left.filterPreset === right.filterPreset && left.filterIntensity === right.filterIntensity && left.tintColor === right.tintColor && left.tintOpacity === right.tintOpacity && (left.projectName || "") === (right.projectName || "") && JSON.stringify(left.subscribeAnimation ?? DEFAULT_SUBSCRIBE_ANIMATION) === JSON.stringify(right.subscribeAnimation ?? DEFAULT_SUBSCRIBE_ANIMATION);
}

function clipStatus(clip: Clip, job: Job) {
  if (clip.state === "complete") return "complete";
  if (clip.state === "failed") return "failed";
  if (job.state === "paused") return "paused";
  return clip.state === "rendering" ? "rendering" : "queued";
}

function isLoadableShort({ job, clip }: ClipRow, assets: LibraryAsset[]) {
  const asset = assets.find((candidate) => candidate.id === clip.libraryAssetId);
  return clip.state === "complete" && job.mode === "clip" && Boolean(asset?.previewUrl && asset.mediaType.toLowerCase().startsWith("video/") && asset.origin === "generated-clip" && asset.sourceClipId === clip.id && asset.sourceJobId === job.id && asset.sourceProjectId === job.projectId);
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

// The clip browser is a scroll pane, not an archive: mounting every clip
// (and its <video>) for a large project made the panel slow to settle.
const CLIP_PAGE = 30;

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
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [filterPreset, setFilterPreset] = useState<EditState["filterPreset"]>("none");
  const [filterIntensity, setFilterIntensity] = useState(1);
  const [tintColor, setTintColor] = useState("#d58a55");
  const [tintOpacity, setTintOpacity] = useState(0);
  const [sourceHasAudio, setSourceHasAudio] = useState<boolean | null>(null);
  const [editorTool, setEditorTool] = useState<"media" | "filters" | "text">("media");
  const [selectedProperty, setSelectedProperty] = useState<"video" | "audio" | null>("video");
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [overlayBaseline, setOverlayBaseline] = useState("[]");
  const [subscribeAnimation, setSubscribeAnimation] = useState<SubscribeAnimationConfig>(DEFAULT_SUBSCRIBE_ANIMATION);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [savedBaseline, setSavedBaseline] = useState<EditState>({ start: 0, end: undefined, aspect: "9:16", subtitles: true, projectName: "", muted: false, volume: 1, filterPreset: "none", filterIntensity: 1, tintColor: "#d58a55", tintOpacity: 0, subscribeAnimation: DEFAULT_SUBSCRIBE_ANIMATION });
  const [history, setHistory] = useState<Array<{ edit: EditState; overlays: TextOverlay[] }>>([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([{ id: 1, role: "assistant", text: "Describe a safe trim or aspect-ratio change. I will propose the edit before applying it." }]);
  const [pendingProposal, setPendingProposal] = useState<AssistantEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipLimit, setClipLimit] = useState(CLIP_PAGE);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dragOverEditor, setDragOverEditor] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragTitle, setDragTitle] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const singleFlight = useSingleFlight();
  const [status, setStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRequestRef = useRef(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const objectUrl = useRef<string | null>(null);
  const sourceLoadingRef = useRef(false);
  const editorPanelRef = useRef<HTMLElement>(null);
  const pointerStart = useRef<{ jobId: string; clipId: string; x: number; y: number; pointerId: number } | null>(null);
  const draggedClipRef = useRef<string | null>(null);
  const pointerFinish = useRef<(event: PointerEvent) => void>(() => undefined);
  const suppressClick = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  // A closed drawer is visibility-hidden, so focus inside it would fall back to <body>.
  const closeDrawer = useCallback(() => { if (drawerRef.current?.contains(document.activeElement)) drawerToggleRef.current?.focus(); setDrawerOpen(false); }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextAssets, nextJobs] = await Promise.all([listAssets(), listJobs()]);
      setAssets(nextAssets.filter((item) => item.mediaType.toLowerCase().startsWith("video/")));
      setJobs(nextJobs.filter((job) => job.mode === "clip"));
      setError(null);
    } catch (cause) { setError(readableError(cause)); }
  }, []);
  useEffect(() => { queueMicrotask(() => void refresh()); return () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [refresh]);
  useEffect(() => {
    const finish = (event: PointerEvent) => {
      if (!pointerStart.current) {
        if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 0);
        return;
      }
      pointerFinish.current(event);
    };
    const cancel = (event: PointerEvent) => {
      if (pointerStart.current?.pointerId !== event.pointerId) return;
      pointerStart.current = null; draggedClipRef.current = null; setDraggingClipId(null); setDragOverEditor(false); setDragPosition(null);
    };
    const move = (event: PointerEvent) => {
      const start = pointerStart.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (!draggedClipRef.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8) {
        draggedClipRef.current = start.clipId;
        setDraggingClipId(start.clipId);
      }
      if (!draggedClipRef.current) return;
      setDragPosition({ x: event.clientX, y: event.clientY });
      const bounds = editorPanelRef.current?.getBoundingClientRect();
      setDragOverEditor(Boolean(bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom));
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pointerStart.current) return;
      suppressClick.current = true;
      pointerStart.current = null; draggedClipRef.current = null; setDraggingClipId(null); setDragOverEditor(false); setDragPosition(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("pointermove", move);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); window.removeEventListener("pointermove", move); window.removeEventListener("keydown", escape); };
  }, []);
  // A queued render is durable but it must not look permanently queued in this
  // screen. Poll only job state (not the larger asset catalogue), and pull the
  // cadence in while a render is unsettled so completed previews appear here.
  const refreshJobs = useCallback(async () => {
    try {
      setJobs((await listJobs()).filter((job) => job.mode === "clip"));
      setError(null);
    } catch (cause) { setError(readableError(cause)); }
  }, []);
  const hasUnsettledJobs = jobs.some((job) => ["queued", "active", "paused", "stalled", "recovered"].includes(job.state));
  usePoll(refreshJobs, hasUnsettledJobs ? 2_000 : 15_000);

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

  const updateEdit = (next: Partial<EditState>) => {
    setHistory((current) => [...current.slice(-9), { edit: editState, overlays: textOverlays }]);
    if (next.start !== undefined) setStart(String(next.start));
    if ("end" in next) setEnd(next.end === undefined ? "" : String(next.end));
    if (next.aspect !== undefined) setAspect(next.aspect);
    if (next.subtitles !== undefined) setSubtitles(next.subtitles);
    if (next.muted !== undefined) setMuted(next.muted);
    if (next.volume !== undefined) setVolume(next.volume);
    if (next.filterPreset !== undefined) setFilterPreset(next.filterPreset);
    if (next.filterIntensity !== undefined) setFilterIntensity(next.filterIntensity);
    if (next.tintColor !== undefined) setTintColor(next.tintColor);
    if (next.tintOpacity !== undefined) setTintOpacity(next.tintOpacity);
  };
  const undo = () => {
    const snapshot = history.at(-1);
    if (!snapshot) return;
    const previous = snapshot.edit;
    setStart(String(previous.start)); setEnd(previous.end === undefined ? "" : String(previous.end)); setAspect(previous.aspect); setSubtitles(previous.subtitles); setProjectName(previous.projectName || ""); setMuted(previous.muted ?? false); setVolume(previous.volume ?? 1); setFilterPreset(previous.filterPreset ?? "none"); setTextOverlays(snapshot.overlays); setFilterIntensity(previous.filterIntensity ?? 1); setTintColor(previous.tintColor ?? "#d58a55"); setTintOpacity(previous.tintOpacity ?? 0); setSubscribeAnimation(previous.subscribeAnimation ?? DEFAULT_SUBSCRIBE_ANIMATION);
    if (snapshot.overlays.length && !selectedOverlayId) { setSelectedOverlayId(snapshot.overlays.at(-1)?.id ?? null); setPropertiesOpen(true); }
    setHistory((current) => current.slice(0, -1));
  };

  const loadFile = (next: File | null, pickerError?: string) => {
    if (pickerError) { setError(pickerError); return; }
    if (next && dirty && !window.confirm("Discard unsaved Shorts Editor changes?")) return;
    playRequestRef.current += 1;
    setError(null); setFile(next); setPreviewUrl(null); setPlaying(false); setCurrentTime(0); setSourceDuration(0); setSourceHasAudio(null);
    if (next) {
      setMode("file"); setAssetId(""); setUrl(""); setSelectedClipId(null); setStart("0"); setEnd(""); setAspect("9:16"); setSubtitles(true); setProjectName(""); setMuted(false); setVolume(1); setFilterPreset("none"); setFilterIntensity(1); setTintColor("#d58a55"); setTintOpacity(0); setSubscribeAnimation(DEFAULT_SUBSCRIBE_ANIMATION); setEditorTool("media"); setSelectedProperty("video"); setPropertiesOpen(true);
      const baseline: EditState = { start: 0, end: undefined, aspect: "9:16", subtitles: true, projectName: "", muted: false, volume: 1, filterPreset: "none", filterIntensity: 1, tintColor: "#d58a55", tintOpacity: 0, subscribeAnimation: DEFAULT_SUBSCRIBE_ANIMATION };
      setSavedBaseline(baseline); setTextOverlays([]); setOverlayBaseline("[]"); setSelectedOverlayId(null); setHistory([]); setPendingProposal(null);
      setAssistantMessages([{ id: Date.now(), role: "assistant", text: `Loaded local video ${next.name}.` }]);
      setStatus(`Loaded local video ${next.name}.`);
    }
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    return singleFlight(async () => {
    if (assistantBusy) return;
    setError(null); setStatus("");
    const from = Number(start); const to = end.trim() === "" ? undefined : Number(end);
    if (!Number.isFinite(from) || from < 0) return setError("Start seconds must be a finite number at least 0.");
    if (to !== undefined && (!Number.isFinite(to) || to <= from)) return setError("End seconds must be blank or greater than start.");
    const outputDuration = (to ?? sourceDuration) - from;
    if (textOverlays.some((item) => item.start >= outputDuration || item.duration <= 0 || item.start + item.duration > outputDuration)) return setError("Text overlay timing must fit inside the trimmed output.");
    if (mode === "file" && !file) return setError("Choose a local video first.");
    if (mode === "url" && !url.trim()) return setError("Paste a supported YouTube URL first.");
    if (mode === "library" && (sourceLoading || !assetId)) return setError("Choose a Library video first.");
    setAssistantBusy(true);
    try {
      setStatus(mode === "file" ? "Uploading and validating source…" : mode === "url" ? "Importing and validating YouTube source…" : "Validating Library source…");
      if (mode === "library") await createShortsJob({ assetId, name: projectName.trim() || undefined, burnSubtitles: subtitles, subscribeAnimation, start: from, end: to, aspectRatio: aspect, muted, volume, filterPreset, filterIntensity, tintColor, tintOpacity, textOverlays });
      else await createShortsSourceJob({ file: mode === "file" ? file || undefined : undefined, url: mode === "url" ? url.trim() : undefined, name: projectName.trim() || undefined, burnSubtitles: subtitles, subscribeAnimation, start: from, end: to, aspectRatio: aspect, muted, volume, filterPreset, filterIntensity, tintColor, tintOpacity, textOverlays });
      setStatus("Short queued successfully."); setSavedBaseline(editState); setOverlayBaseline(JSON.stringify(textOverlays)); setHistory([]); await refresh(); onJobCreated();
    } catch (cause) { setError(readableError(cause)); setStatus(""); } finally { setAssistantBusy(false); }
    });
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

  useEffect(() => {
    const player = videoRef.current;
    if (!player) return;
    player.muted = previewMuted;
    player.volume = Math.max(0, Math.min(1, volume));
  }, [previewMuted, volume, previewUrl, mode, assetId]);
  const seek = (value: number) => { const lower = Number(start) || 0; const upper = end.trim() ? Number(end) : sourceDuration || value; const bounded = Math.max(lower, Math.min(upper, value)); setCurrentTime(bounded); if (videoRef.current) videoRef.current.currentTime = bounded; };
  const togglePlay = () => {
    const player = videoRef.current;
    if (!player) return;
    if (!player.paused) { playRequestRef.current += 1; player.pause(); setPlaying(false); return; }
    setError(null);
    const requestId = ++playRequestRef.current;
    const failPlayback = () => {
      if (playRequestRef.current !== requestId || videoRef.current !== player) return;
      setPlaying(false);
      setError("Preview playback could not start. Try another video or reload the source.");
    };
    try {
      void player.play().then(() => {
        if (playRequestRef.current === requestId && videoRef.current === player && !player.paused) setPlaying(true);
      }).catch(failPlayback);
    } catch {
      failPlayback();
    }
  };
  const toggleMute = () => { const player = videoRef.current; const next = !previewMuted; if (player) player.muted = next; setPreviewMuted(next); };
  const changeOverlays = (change: (items: TextOverlay[]) => TextOverlay[]) => { setHistory((current) => [...current.slice(-9), { edit: editState, overlays: textOverlays }]); setTextOverlays(change); };
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape" && propertiesOpen) { setPropertiesOpen(false); [...document.querySelectorAll<HTMLElement>("[data-property-toggle]")].find((element) => element.getClientRects().length > 0)?.focus(); } }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [propertiesOpen]);
  // Fullscreen is requested on the aspect frame rather than the <video> so the
  // trim overlay and letterboxing expand with the picture.
  const expandPreview = () => { void (frameRef.current || videoRef.current)?.requestFullscreen?.().catch(() => undefined); };
  const sourcePreview = previewUrl || (mode === "library" ? assets.find((item) => item.id === assetId)?.previewUrl || null : null);
  const editState: EditState = { start: Number(start) || 0, end: end.trim() ? Number(end) : undefined, aspect, subtitles, projectName, muted, volume, filterPreset, filterIntensity, tintColor, tintOpacity, subscribeAnimation };
  const dirty = !sameEditState(editState, savedBaseline) || JSON.stringify(textOverlays) !== overlayBaseline;
  const updateSubscribeAnimation = (value: SubscribeAnimationConfig) => { setHistory((current) => [...current.slice(-9), { edit: editState, overlays: textOverlays }]); setSubscribeAnimation(value); };
  const changeSourceMode = (next: VideoSourceMode) => {
    if (next === mode) return;
    if (dirty && !window.confirm("Discard unsaved Shorts Editor changes?")) return;
    playRequestRef.current += 1;
    setMode(next); setFile(null); setPreviewUrl(null); setAssetId(""); setUrl(""); setSelectedClipId(null); setSourceDuration(0); setSourceHasAudio(null); setCurrentTime(0); setPlaying(false);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setStart("0"); setEnd(""); setAspect("9:16"); setSubtitles(true); setProjectName(""); setMuted(false); setVolume(1); setFilterPreset("none"); setFilterIntensity(1); setTintColor("#d58a55"); setTintOpacity(0); setSubscribeAnimation(DEFAULT_SUBSCRIBE_ANIMATION); setEditorTool("media"); setSelectedProperty("video"); setPropertiesOpen(true); setTextOverlays([]); setOverlayBaseline("[]"); setSelectedOverlayId(null); setSelectedProperty("video"); setHistory([]); setPendingProposal(null); setSavedBaseline({ start: 0, end: undefined, aspect: "9:16", subtitles: true, projectName: "", muted: false, volume: 1, filterPreset: "none", filterIntensity: 1, tintColor: "#d58a55", tintOpacity: 0, subscribeAnimation: DEFAULT_SUBSCRIBE_ANIMATION }); setStatus("");
  };
  const overlayOutputDuration = (end.trim() ? Number(end) : sourceDuration) - (Number(start) || 0);
  const invalidOverlays = textOverlays.filter((item) => !Number.isFinite(item.start) || !Number.isFinite(item.duration) || item.start < 0 || item.duration <= 0 || item.start >= overlayOutputDuration || item.start + item.duration > overlayOutputDuration);
  const loadLibrarySource = useCallback(async (id: string, identity?: { jobId: string; clipId: string }) => {
    if (sourceLoadingRef.current) return;
    sourceLoadingRef.current = true;
    try {
      setError(null); setSourceLoading(true);
      const [freshAssets, freshJobs] = await Promise.all([listAssets(), identity ? listJobs() : Promise.resolve(jobs)]);
      const asset = freshAssets.find((item) => item.id === id);
      const freshJob = identity ? freshJobs.find((job) => job.id === identity.jobId && job.mode === "clip") : undefined;
      const freshClip = identity ? freshJob?.clips.find((clip) => clip.id === identity.clipId) : undefined;
      if (!asset || !asset.mediaType.toLowerCase().startsWith("video/") || !asset.previewUrl) {
        setAssets(freshAssets.filter((item) => item.mediaType.toLowerCase().startsWith("video/")));
        setError("This video is no longer available in the Library. Your current editor source and edits are unchanged.");
        return;
      }
      if (identity && (!freshJob || !freshClip || freshClip.state !== "complete" || freshClip.libraryAssetId !== asset.id || asset.origin !== "generated-clip" || asset.sourceClipId !== freshClip.id || asset.sourceJobId !== freshJob.id || asset.sourceProjectId !== freshJob.projectId)) {
        setError("This short is not currently published and available in the Library. Your current editor source and edits are unchanged.");
        return;
      }
      const currentClipAlreadyLoaded = identity && selectedClipId === identity.clipId && assetId === asset.id;
      const sameLibrarySource = !identity && selectedClipId === null && mode === "library" && assetId === asset.id;
      if (currentClipAlreadyLoaded || sameLibrarySource) return;
      if (dirty && !window.confirm("Discard unsaved Shorts Editor changes?")) return;

      const row = freshClip && freshJob ? { clip: freshClip, job: freshJob } : undefined;
      setAssets(freshAssets.filter((item) => item.mediaType.toLowerCase().startsWith("video/")));
      playRequestRef.current += 1;
      setMode("library"); setAssetId(asset.id); setFile(null); setUrl(""); setPreviewUrl(asset.previewUrl);
      setCurrentTime(0); setSourceDuration(0); setSourceHasAudio(null); setPlaying(false);
      if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
      setSelectedClipId(row?.clip.id ?? null);
      const nextAspect = row ? resolveOutputAspectRatio(asset.aspectRatio, asset.width, asset.height, row.job.contentFormat) : "9:16";
      const nextBaseline: EditState = {
        start: 0,
        end: row ? asset.durationSeconds ?? row.clip.duration : undefined,
        aspect: nextAspect,
        subtitles: row ? row.job.burnSubtitles !== false : true,
        projectName: "",
        muted: false,
        volume: 1,
        filterPreset: "none",
        filterIntensity: 1,
        tintColor: "#d58a55",
        tintOpacity: 0,
        subscribeAnimation: DEFAULT_SUBSCRIBE_ANIMATION,
      };
      setStart(String(nextBaseline.start)); setEnd(nextBaseline.end === undefined ? "" : String(nextBaseline.end));
      setAspect(nextBaseline.aspect); setSubtitles(nextBaseline.subtitles); setProjectName(""); setMuted(nextBaseline.muted ?? false); setVolume(nextBaseline.volume ?? 1); setFilterPreset(nextBaseline.filterPreset ?? "none"); setFilterIntensity(1); setTintColor("#d58a55"); setTintOpacity(0); setSubscribeAnimation(DEFAULT_SUBSCRIBE_ANIMATION); setEditorTool("media"); setSelectedProperty("video"); setPropertiesOpen(true);
      setSavedBaseline(nextBaseline); setTextOverlays([]); setOverlayBaseline("[]"); setSelectedOverlayId(null); setHistory([]); setPendingProposal(null);
      setAssistantMessages([{ id: Date.now(), role: "assistant", text: row ? `Loaded ${row.clip.title || `Clip ${row.clip.index}`} from Library. This source is the published generated video.` : `Library source changed to ${asset.title}.` }]);
      setStatus(row ? `Loaded ${row.clip.title || `Clip ${row.clip.index}`} from Library.` : `Loaded ${asset.title} from Library.`);
      closeDrawer();
    } catch (cause) { setError(readableError(cause)); }
    finally { sourceLoadingRef.current = false; setSourceLoading(false); }
  }, [assetId, closeDrawer, dirty, jobs, mode, selectedClipId]);
  useEffect(() => {
    pointerFinish.current = (event) => {
      const pointer = pointerStart.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      const dragged = draggedClipRef.current === pointer.clipId;
      if (dragged) {
        const bounds = editorPanelRef.current?.getBoundingClientRect();
        if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
          const row = jobs.flatMap((job) => job.clips.map((clip) => ({ job, clip }))).find(({ job, clip }) => job.id === pointer.jobId && clip.id === pointer.clipId);
          if (row?.clip.libraryAssetId) void loadLibrarySource(row.clip.libraryAssetId, { jobId: pointer.jobId, clipId: pointer.clipId });
        }
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 0);
      }
      pointerStart.current = null; draggedClipRef.current = null; setDraggingClipId(null); setDragOverEditor(false); setDragPosition(null);
    };
  }, [draggingClipId, jobs, loadLibrarySource]);
  const applyProposal = () => {
    if (!pendingProposal) return;
    updateEdit(pendingProposal.edit);
    setAssistantMessages((current) => [...current, { id: Date.now(), role: "assistant", text: `${pendingProposal.explanation} Applied locally. Queue the short to render this edit.` }]);
    setPendingProposal(null);
  };

  return <div className="page shorts-workspace-page">
    <form className="shorts-workspace-form" onSubmit={submit}>
    <header className="shorts-workspace-header"><div><h1>Editor</h1></div><div className="shorts-header-actions"><span className={dirty ? "edit-state dirty" : "edit-state"}>{dirty ? "Unsaved edits" : "All changes saved"}</span>{history.length > 0 && <Button type="button" onClick={undo}><RotateCcw size={14} /> Undo</Button>}<button ref={drawerToggleRef} type="button" className="button button-secondary" aria-expanded={drawerOpen} aria-controls="shorts-clip-drawer" onClick={() => setDrawerOpen((open) => !open)}><PanelRight size={14} /> Clips &amp; assistant <span className="count-pill">{rows.length}</span></button><Button type="submit" variant="primary" disabled={assistantBusy}><Scissors size={14} /> Queue short</Button></div></header>
    {error && <div className="shorts-global-alert" role="alert"><X size={16} />{error}</div>}
    {/* A <main> here nested a second main landmark inside the shell's
        #main-content. This element only lays out the editor and its drawer — naming it
        would add a redundant region landmark around the aside below, so the
        meaningful names stay on the panels themselves. */}
    <section className="shorts-workspace">
      <section ref={editorPanelRef} className={`shorts-editor-panel ${dragOverEditor ? "clip-drop-active" : ""}`} aria-labelledby="editor-panel-title" onDragOver={(event) => { if (!(event.target instanceof Element && event.target.closest(".drop-zone"))) event.preventDefault(); }} onDrop={(event) => { if (event.target instanceof Element && event.target.closest(".drop-zone")) return; event.preventDefault(); if (event.dataTransfer.types.length) setError("Only completed clips from the Clips panel can be dropped into the Editor."); }}>
        <div className="workspace-panel-heading"><div><h2 id="editor-panel-title">{contextName}</h2></div><StatusBadge state={selectedRow ? selectedRow.job.state : "local"} label={selectedRow ? selectedRow.job.stageLabel : "Source ready"} /></div>
        {dragOverEditor && draggingClipId && <div className="clip-drop-overlay" aria-hidden="true">Drop to edit</div>}
        {!sourcePreview && <div className="shorts-source-empty"><div className="empty-icon"><Film size={28} /></div><h3>Bring a source into the editor</h3><p>Choose a local file, authorised YouTube URL, or a video from your Library.</p><VideoSourcePicker mode={mode} onModeChange={changeSourceMode} file={file} onFile={loadFile} url={url} onUrl={setUrl}><div className="field"><label className="field-label" htmlFor="shorts-source">Library video</label><select id="shorts-source" value={assetId} onChange={(event) => { if (event.target.value) void loadLibrarySource(event.target.value); }} disabled={!assets.length}><option value="">{assets.length ? "Select Library video" : "No Library videos available"}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><small>{assets.length ? "Private media stays on this machine." : "Add a video in Library first."}</small></div></VideoSourcePicker><details className="shorts-collapsible-panel"><summary>Subscribe animation settings</summary><SubscribeAnimationControl value={subscribeAnimation} onChange={updateSubscribeAnimation} /></details><div className="trim-inputs shorts-empty-trim"><label>Start <input aria-label="Start seconds" type="number" min="0" step=".1" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>End <input aria-label="End seconds" type="number" min="0" step=".1" value={end} onChange={(event) => setEnd(event.target.value)} placeholder="Source remainder" /></label><label>Aspect <select aria-label="Aspect ratio" value={aspect} onChange={(event) => updateEdit({ aspect: event.target.value as AspectRatio })}>{aspects.map((value) => <option key={value}>{value}</option>)}</select></label></div>{/* These are job settings rather than preview settings: a YouTube source has no local preview before import, so gating them behind playback would make them unreachable before import. */}<div className="editor-options"><label className="shorts-project-name">Project name <input value={projectName} maxLength={160} onChange={(event) => { setHistory((current) => [...current.slice(-9), { edit: editState, overlays: textOverlays }]); setProjectName(event.target.value); }} placeholder="Optional project name" /></label><label><input type="checkbox" checked={subtitles} onChange={(event) => updateEdit({ subtitles: event.target.checked })} /> Subtitles</label><label>Filter preset <select aria-label="Filter preset" value={filterPreset} onChange={(event) => updateEdit({ filterPreset: event.target.value as EditState["filterPreset"] })}><option value="none">Original</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="black_white">Black &amp; White</option><option value="monochrome">Monochrome</option><option value="tint">Tint</option></select></label>{filterPreset !== "monochrome" && <label>Filter intensity <input aria-label="Filter intensity" type="range" min="0" max="1" step="0.01" value={filterIntensity} onChange={(event) => updateEdit({ filterIntensity: Number(event.target.value) })} /></label>}{filterPreset === "tint" && <><label>Tint color<input aria-label="Tint color" type="color" value={tintColor} onChange={(event) => updateEdit({ tintColor: event.target.value })} /></label><label>Tint transparency<input aria-label="Tint opacity" type="range" min="0" max="100" value={tintOpacity} onChange={(event) => updateEdit({ tintOpacity: Number(event.target.value) })} /><small>0% = fully opaque · 100% = invisible</small></label></>}<label>Output volume <input aria-label="Output volume" type="range" min="0" max="2" step="0.05" value={volume} onChange={(event) => updateEdit({ volume: Number(event.target.value) })} /></label><label><input type="checkbox" checked={muted} onChange={(event) => updateEdit({ muted: event.target.checked })} /> Mute export</label></div></div>}
        {sourcePreview && <div className="video-editing-stage"><details className="shorts-collapsible-panel"><summary>Subscribe animation settings</summary><SubscribeAnimationControl value={subscribeAnimation} onChange={updateSubscribeAnimation} /></details><div className="viewer-header" aria-hidden="true"><span>{contextName}</span><span>{aspect}</span></div><div ref={frameRef} className={`shorts-video-frame aspect-${aspect.replace(":", "-")}`} role="group" aria-label="Video preview"><video ref={videoRef} muted={previewMuted} style={{ filter: filterPreset === "monochrome" ? "grayscale(1)" : filterPreset === "black_white" ? `grayscale(${filterIntensity})` : filterPreset === "warm" ? `sepia(${.35 * filterIntensity}) saturate(${1 + .25 * filterIntensity})` : filterPreset === "cool" ? `hue-rotate(${18 * filterIntensity}deg)` : undefined }} src={sourcePreview} onLoadedMetadata={(event) => { setSourceDuration(event.currentTarget.duration); const media = event.currentTarget as HTMLVideoElement & { audioTracks?: { length: number }; mozHasAudio?: boolean; captureStream?: () => MediaStream }; let audio = media.audioTracks ? media.audioTracks.length > 0 : typeof media.mozHasAudio === "boolean" ? media.mozHasAudio : null; if (audio === null && media.captureStream) { try { audio = media.captureStream().getAudioTracks().length > 0; } catch { audio = null; } } setSourceHasAudio(audio); }} aria-label="Source video preview" onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; setCurrentTime(time); if (end.trim() && time >= Number(end)) { event.currentTarget.pause(); event.currentTarget.currentTime = Number(start) || 0; } }} onPlay={(event) => { if (currentTime < (Number(start) || 0) || (end.trim() && currentTime >= Number(end))) event.currentTarget.currentTime = Number(start) || 0; setPlaying(true); }} onPause={() => setPlaying(false)} controls={false} preload="metadata" playsInline />{filterPreset === "tint" && <div aria-hidden="true" className="shorts-preview-tint" style={{ backgroundColor: tintColor, opacity: (1 - tintOpacity / 100) * filterIntensity }} />}{textOverlays.filter((item) => currentTime - (Number(start) || 0) >= item.start && currentTime - (Number(start) || 0) < item.start + item.duration).map((item) => <button key={item.id} type="button" className={`shorts-text-overlay ${selectedOverlayId === item.id ? "selected" : ""}`} style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, color: item.color, fontSize: `${item.size / 1920 * 100}cqh` }} aria-label={`Text overlay: ${item.text}`} onClick={() => { setSelectedOverlayId(item.id); setSelectedProperty(null); setEditorTool("text"); setPropertiesOpen(true); }} onKeyDown={(event) => { const step = event.shiftKey ? .05 : .01; if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); changeOverlays((items) => items.map((overlay) => overlay.id === item.id ? { ...overlay, x: Math.max(0, Math.min(1, overlay.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))), y: Math.max(0, Math.min(1, overlay.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))) } : overlay)); }} onPointerDown={(event) => { event.preventDefault(); setHistory((current) => [...current.slice(-9), { edit: editState, overlays: textOverlays }]); setSelectedOverlayId(item.id); const frame = frameRef.current; if (!frame) return; const bounds = frame.getBoundingClientRect(); const objectBounds = event.currentTarget.getBoundingClientRect(); const halfWidth = Math.min(.5, objectBounds.width / bounds.width / 2); const halfHeight = Math.min(.5, objectBounds.height / bounds.height / 2); const move = (pointer: PointerEvent) => setTextOverlays((current) => current.map((overlay) => overlay.id === item.id ? { ...overlay, x: Math.max(halfWidth, Math.min(1 - halfWidth, (pointer.clientX - bounds.left) / bounds.width)), y: Math.max(halfHeight, Math.min(1 - halfHeight, (pointer.clientY - bounds.top) / bounds.height)) } : overlay)); const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true }); }}>{item.text}</button>)}</div><ShortsEditorToolbox activeTool={editorTool} setActiveTool={setEditorTool} selectedProperty={selectedProperty} setSelectedProperty={setSelectedProperty} propertiesOpen={propertiesOpen} setPropertiesOpen={setPropertiesOpen} aspect={aspect} projectName={projectName} setProjectName={(value) => { setHistory((items) => [...items.slice(-9), { edit: editState, overlays: textOverlays }]); setProjectName(value); }} subtitles={subtitles} setSubtitles={(value) => updateEdit({ subtitles: value })} captionWarning={Boolean(selectedClipId)} filterPreset={filterPreset || "none"} setFilterPreset={(value) => updateEdit({ filterPreset: value })} filterIntensity={filterIntensity} setFilterIntensity={(value) => { setHistory((items) => [...items.slice(-9), { edit: editState, overlays: textOverlays }]); setFilterIntensity(value); }} tintColor={tintColor} setTintColor={(value) => { setHistory((items) => [...items.slice(-9), { edit: editState, overlays: textOverlays }]); setTintColor(value); }} tintOpacity={tintOpacity} setTintOpacity={(value) => { setHistory((items) => [...items.slice(-9), { edit: editState, overlays: textOverlays }]); setTintOpacity(value); }} muted={muted} setMuted={(value) => updateEdit({ muted: value })} previewMuted={previewMuted} onTogglePreviewMute={toggleMute} volume={volume} setVolume={(value) => updateEdit({ volume: value })} overlays={textOverlays} invalidOverlays={invalidOverlays.length > 0} selectedOverlayId={selectedOverlayId} setSelectedOverlayId={setSelectedOverlayId} changeOverlays={changeOverlays} outputDuration={Math.max(0, (end.trim() ? Number(end) : sourceDuration) - (Number(start) || 0))} currentTime={currentTime} sourceDuration={sourceDuration} start={Number(start) || 0} end={end.trim() ? Number(end) : undefined} onTrim={(nextStart, nextEnd) => updateEdit({ start: nextStart, end: nextEnd })} onAspect={(value) => updateEdit({ aspect: value })} playing={playing} onTogglePlay={togglePlay} onSeek={seek} sourceHasAudio={sourceHasAudio} onExpand={expandPreview} /></div>}
        {sourcePreview && <details className="shorts-source-switcher"><summary>Choose another source</summary><VideoSourcePicker mode={mode} onModeChange={changeSourceMode} file={file} onFile={loadFile} url={url} onUrl={setUrl}><div className="field"><label className="field-label" htmlFor="shorts-source-loaded">Library video</label><select id="shorts-source-loaded" value={assetId} onChange={(event) => { if (event.target.value) void loadLibrarySource(event.target.value); }} disabled={!assets.length || sourceLoading}><option value="">Select another Library video</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><small>Generated shorts are loaded from their published Library asset.</small></div></VideoSourcePicker></details>}
        {status && <div className="shorts-inline-status" role="status"><Clock3 size={15} />{status}</div>}
      </section>
      <aside ref={drawerRef} id="shorts-clip-drawer" className={`shorts-right-column shorts-clip-drawer${drawerOpen ? " open" : ""}${draggingClipId ? " drag-through" : ""}`} aria-label="Clips and editing assistant" onKeyDown={(event) => { if (event.key !== "Escape" || pointerStart.current) return; event.stopPropagation(); closeDrawer(); }}>
        <div className="shorts-drawer-heading"><strong>Clips &amp; assistant</strong><button type="button" className="icon-button" aria-label="Close clips and assistant" onClick={closeDrawer}><X size={16} /></button></div>
        <details className="shorts-collapsible-panel" open><summary>Clips browser</summary><section className="shorts-clips-panel" aria-labelledby="clips-panel-title"><div className="workspace-panel-heading"><div><span className="panel-kicker">Project output</span><h2 id="clips-panel-title">Clips <span className="count-pill">{rows.length}</span></h2></div><select aria-label="Filter clips" value={filter} onChange={(event) => { setFilter(event.target.value); setClipLimit(CLIP_PAGE); }}><option value="all">All clips</option><option value="queued">Queued</option><option value="rendering">Rendering</option><option value="complete">Complete</option><option value="failed">Failed</option></select></div><div className="clip-browser">{rows.length ? rows.slice(0, clipLimit).map((row) => <ClipBrowserItem key={`${row.job.id}-${row.clip.id}`} row={row} eligible={isLoadableShort(row, assets)} active={row.clip.id === selectedClipId} dragging={draggingClipId === row.clip.id} onSelect={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (!isLoadableShort(row, assets) || !row.clip.libraryAssetId) { setError("This short is not currently available in the Library. Your current editor source and edits are unchanged."); return; } void loadLibrarySource(row.clip.libraryAssetId, { jobId: row.job.id, clipId: row.clip.id }); }} onPointerDown={(event) => {
          if (event.button !== 0 || event.target instanceof Element && event.target.closest("a, input, select, textarea, [role=button]")) return;
          suppressClick.current = false;
          if (!isLoadableShort(row, assets) || !row.clip.libraryAssetId) return;
          pointerStart.current = { jobId: row.job.id, clipId: row.clip.id, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
          setDragTitle(row.clip.title || `Clip ${row.clip.index}`);
          draggedClipRef.current = null;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Some browsers cannot capture a synthetic pointer. */ }
        }} onPointerMove={(event) => {
          const pointer = pointerStart.current;
          if (!pointer || pointer.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 8) { draggedClipRef.current = pointer.clipId; setDraggingClipId(pointer.clipId); }
        }} onPointerCancel={() => { pointerStart.current = null; draggedClipRef.current = null; setDraggingClipId(null); setDragOverEditor(false); setDragPosition(null); }} onRetry={() => void retryClip(row.job.id, row.clip.id).then(refresh).catch((cause) => setError(readableError(cause)))} onStop={() => void controlJob(row.job.id, "stop-keep").then(refresh).catch((cause) => setError(readableError(cause)))} />) : <div className="clips-empty"><Film size={24} /><strong>No clips yet</strong><span>Queue a source from the editor and its durable render will appear here.</span></div>}{rows.length > clipLimit && <button type="button" className="show-all-projects" onClick={() => setClipLimit((value) => value + CLIP_PAGE)}>Show {Math.min(CLIP_PAGE, rows.length - clipLimit)} more of {rows.length}</button>}</div></section></details>
        <details className="shorts-collapsible-panel" open><summary>Local editing assistant</summary><section className="shorts-assistant-panel" aria-labelledby="assistant-panel-title"><div className="workspace-panel-heading"><div><span className="panel-kicker">Safe local controls</span><h2 id="assistant-panel-title"><WandSparkles size={17} /> AI editing assistant</h2></div><span className="assistant-context">{contextName}</span></div><div className="assistant-messages" aria-live="polite">{assistantMessages.map((message) => <div key={message.id} className={`assistant-message ${message.role}`}><span>{message.role === "assistant" ? <Sparkles size={13} /> : <MessageSquare size={13} />}</span><p>{message.text}</p></div>)}</div>{pendingProposal && <div className="assistant-proposal" role="status"><strong>Proposal ready</strong><span>{pendingProposal.explanation}</span><div><Button type="button" variant="primary" onClick={applyProposal}>Apply proposal</Button><Button type="button" onClick={() => setPendingProposal(null)}>Reject</Button></div></div>}<div className="assistant-composer"><input aria-label="Editing request" value={assistantInput} onChange={(event) => setAssistantInput(event.target.value)} onKeyDown={(event) => { if (event.key !== "Enter" || event.shiftKey) return; /* The composer lives inside the Queue-short form, so an unhandled Enter would submit that form and queue a render instead of sending the message. */ event.preventDefault(); void sendAssistant(); }} placeholder="Ask for a trim or aspect change…" disabled={assistantBusy} /><button type="button" onClick={() => void sendAssistant()} aria-label="Send editing request" disabled={assistantBusy || !assistantInput.trim()}><Send size={16} /></button></div></section></details>
      </aside>
      {draggingClipId && dragPosition && <div className="clip-drag-ghost" aria-hidden="true" style={{ left: dragPosition.x + 14, top: dragPosition.y + 14 }}><span><Film size={16} /></span><strong>{dragTitle || "Short"}</strong><small>Drag into Editor</small></div>}
    </section>
    </form>
  </div>;
}

function ClipBrowserItem({ row, eligible, active, dragging, onSelect, onPointerDown, onPointerMove, onPointerCancel, onRetry, onStop }: { row: ClipRow; eligible: boolean; active: boolean; dragging: boolean; onSelect: () => void; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerCancel: () => void; onRetry: () => void; onStop: () => void }) {
  const status = clipStatus(row.clip, row.job);
  return <article className={`clip-browser-item ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}><button type="button" className="clip-select-button" onClick={onSelect} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerCancel={onPointerCancel} aria-disabled={!eligible} aria-pressed={active} aria-label={`${eligible ? "Load" : "Unavailable"} ${row.clip.title || `Clip ${row.clip.index}`} ${eligible ? "into editor. Drag into Editor or select." : "in Editor"}`}>{row.clip.previewUrl || row.clip.downloadUrl ? <LazyVideoThumbnail key={row.clip.id} className="clip-browser-thumb" src={row.clip.previewUrl || row.clip.downloadUrl}><span>{String(row.clip.index).padStart(2, "0")}</span></LazyVideoThumbnail> : <div className="clip-browser-thumb"><Film size={20} /><span>{String(row.clip.index).padStart(2, "0")}</span></div>}<div className="clip-browser-info"><strong>{row.clip.title || `Clip ${String(row.clip.index).padStart(2, "0")}`}</strong><span>{formatDuration(row.clip.duration)} · {formatDuration(row.clip.start)}–{formatDuration(row.clip.end)} · {formatDimensions(resolveOutputAspectRatio(undefined, row.clip.width, row.clip.height, row.job.contentFormat), row.clip.width, row.clip.height)}</span><span className="clip-subtitle-state"><Check size={12} /> {row.job.burnSubtitles === false ? "Subtitles off" : "Subtitles enabled"}</span><span className="clip-drag-hint">{eligible ? <><GripVertical size={12} /> Drag into Editor</> : "Not available to edit"}</span></div></button><div className="clip-browser-actions"><StatusBadge state={status === "complete" ? "complete" : status === "failed" ? "failed" : "active"} label={status} />{status === "failed" && <button type="button" className="icon-button" onClick={onRetry} aria-label="Retry failed clip"><RefreshCw size={14} /></button>}{["queued", "rendering", "active"].includes(status) && <button type="button" className="icon-button" onClick={onStop} aria-label="Stop clip and keep completed outputs"><CircleStop size={14} /></button>}</div></article>;
}
