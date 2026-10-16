import { Film, Maximize2, Pause, Play, RotateCcw, SlidersHorizontal, Type, Volume2, VolumeX } from "lucide-react";
import { formatDuration } from "./common";

export type ShortsTextOverlay = { id: string; text: string; color: string; size: number; x: number; y: number; start: number; duration: number };
type Tool = "media" | "filters" | "text";
type PropertyTarget = "video" | "audio" | null;
type Props = {
  activeTool: Tool;
  setActiveTool: (tool: Tool) => void;
  selectedProperty: PropertyTarget;
  setSelectedProperty: (target: PropertyTarget) => void;
  propertiesOpen: boolean;
  setPropertiesOpen: (open: boolean) => void;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  projectName: string;
  setProjectName: (value: string) => void;
  subtitles: boolean;
  setSubtitles: (value: boolean) => void;
  captionWarning: boolean;
  filterPreset: "none" | "warm" | "cool" | "black_white" | "tint" | "monochrome";
  setFilterPreset: (value: Props["filterPreset"]) => void;
  filterIntensity: number;
  setFilterIntensity: (value: number) => void;
  tintColor: string;
  setTintColor: (value: string) => void;
  tintOpacity: number;
  setTintOpacity: (value: number) => void;
  muted: boolean;
  setMuted: (value: boolean) => void;
  previewMuted: boolean;
  onTogglePreviewMute: () => void;
  volume: number;
  setVolume: (value: number) => void;
  overlays: ShortsTextOverlay[];
  invalidOverlays: boolean;
  selectedOverlayId: string | null;
  setSelectedOverlayId: (id: string | null) => void;
  changeOverlays: (change: (items: ShortsTextOverlay[]) => ShortsTextOverlay[]) => void;
  outputDuration: number;
  currentTime: number;
  sourceDuration: number;
  start: number;
  end: number | undefined;
  onTrim: (start: number, end: number | undefined) => void;
  onAspect: (aspect: Props["aspect"]) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  sourceHasAudio: boolean | null;
  onExpand?: () => void;
};

export function ShortsEditorToolbox(props: Props) {
  const playhead = props.outputDuration > 0 ? Math.max(0, Math.min(100, (props.currentTime - props.start) / props.outputDuration * 100)) : 0;
  const selectedOverlay = props.overlays.find((item) => item.id === props.selectedOverlayId);
  const changeOverlay = (patch: Partial<ShortsTextOverlay>) => {
    if (!selectedOverlay) return;
    props.changeOverlays((items) => items.map((item) => item.id === selectedOverlay.id ? { ...item, ...patch } : item));
  };
  const addText = () => {
    const duration = Math.max(0.1, Math.min(3, props.outputDuration || 3));
    const overlay = { id: crypto.randomUUID(), text: "Your text", color: "#ffffff", size: 48, x: 0.5, y: 0.5, start: 0, duration };
    props.changeOverlays((items) => [...items, overlay]);
    props.setSelectedOverlayId(overlay.id);
    props.setSelectedProperty(null);
    props.setActiveTool("text");
    props.setPropertiesOpen(true);
  };
  const selectOverlay = (overlay: ShortsTextOverlay) => {
    props.setSelectedOverlayId(overlay.id);
    props.setSelectedProperty(null);
    props.setActiveTool("text");
  };

  return <div className="shorts-editor-toolbox">
    <div className="shorts-tool-rail" role="tablist" aria-label="Editor tools">
      <button type="button" role="tab" title="Media" aria-selected={props.activeTool === "media"} onClick={() => { props.setActiveTool("media"); props.setSelectedProperty("video"); props.setPropertiesOpen(true); }}><Film size={16} aria-hidden="true" /><span className="sr-only">Media</span></button>
      <button type="button" role="tab" title="Filters" aria-selected={props.activeTool === "filters"} onClick={() => { props.setActiveTool("filters"); props.setSelectedProperty(null); }}><SlidersHorizontal size={16} aria-hidden="true" /><span className="sr-only">Filters</span></button>
      <button type="button" role="tab" title="Text" aria-selected={props.activeTool === "text"} onClick={() => { props.setActiveTool("text"); props.setSelectedProperty(null); }}><Type size={16} aria-hidden="true" /><span className="sr-only">Text</span></button>
    </div>
    <section className="shorts-tool-pane" aria-label={`${props.activeTool === "media" ? "Media" : props.activeTool === "filters" ? "Filters" : "Text"} settings`}>
      {props.activeTool === "media" && <div className="tool-settings-row">
        <strong>Media</strong>
        <label>Project name<input aria-label="Project name" value={props.projectName} maxLength={160} placeholder="Optional project name" onChange={(event) => props.setProjectName(event.target.value)} /></label>
        <label>Aspect ratio<select aria-label="Aspect ratio" value={props.aspect} onChange={(event) => props.onAspect(event.target.value as Props["aspect"])}>{["9:16", "16:9", "1:1", "4:5"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="compact-check"><input type="checkbox" checked={props.subtitles} onChange={(event) => props.setSubtitles(event.target.checked)} /> Subtitles</label>
        {props.captionWarning && <p className="burned-caption-note">This generated video may already contain burned-in captions; the subtitle preference cannot remove them.</p>}
        <p>Change source below the timeline. Source and picture stay linked.</p>
      </div>}
      {props.activeTool === "filters" && <div className="tool-settings-row">
        <strong>Filters</strong>
        <label>Preset<select aria-label="Filter preset" value={props.filterPreset} onChange={(event) => props.setFilterPreset(event.target.value as Props["filterPreset"])}>
          <option value="none">Original</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="black_white">Black &amp; White</option><option value="monochrome">Monochrome</option><option value="tint">Tint</option>
        </select></label>
        {props.filterPreset !== "none" && props.filterPreset !== "monochrome" && <label>Intensity<input aria-label="Filter intensity" type="range" min="0" max="1" step="0.01" value={props.filterIntensity} onChange={(event) => props.setFilterIntensity(Number(event.target.value))} /></label>}
        {props.filterPreset === "tint" && <><label>Tint color<input aria-label="Tint color" type="color" value={props.tintColor} onChange={(event) => props.setTintColor(event.target.value)} /></label><label>Tint transparency<input aria-label="Tint opacity" type="range" min="0" max="100" step="1" value={props.tintOpacity} onChange={(event) => props.setTintOpacity(Number(event.target.value))} /><span>0% = fully opaque · 100% = invisible</span></label></>}
        <button type="button" onClick={() => { props.setFilterPreset("none"); props.setFilterIntensity(1); props.setTintColor("#d58a55"); props.setTintOpacity(0); }}><RotateCcw size={13} /> Reset filter</button>
      </div>}
      {props.activeTool === "text" && <div className="tool-settings-row">
        <strong>Text</strong><button type="button" onClick={addText}>Add text overlay</button>
        {!props.overlays.length && <span>Add a text box to see it on the timeline.</span>}
        {props.invalidOverlays && <p className="shorts-overlay-warning" role="alert">A text overlay falls outside the trimmed output. Adjust its start or duration, or extend the trim.</p>}
        {props.overlays.map((item, index) => <button type="button" key={item.id} aria-label={`Select text overlay ${index + 1}`} aria-pressed={item.id === props.selectedOverlayId} onClick={() => selectOverlay(item)}>Text {index + 1} · {item.text}</button>)}
      </div>}
    </section>
    <button data-property-toggle type="button" className="icon-button property-toggle" aria-label={props.propertiesOpen ? "Hide properties" : "Show properties"} aria-expanded={props.propertiesOpen} onClick={() => props.setPropertiesOpen(!props.propertiesOpen)}>{props.propertiesOpen ? "×" : "+"}</button>
    {props.propertiesOpen && props.selectedProperty === "audio" && <section className="shorts-property-inspector" aria-label="Audio properties">
      <strong>Audio</strong>{props.sourceHasAudio === false ? <p role="status">No audio in this source.</p> : <>
        <label>Export volume<input aria-label="Audio volume" type="range" min="0" max="1" step="0.01" value={props.volume} onChange={(event) => props.setVolume(Number(event.target.value))} /></label>
        <label className="compact-check"><input aria-label="Mute export" type="checkbox" checked={props.muted} onChange={(event) => props.setMuted(event.target.checked)} /> Mute export</label>
      </>}
    </section>}
    {props.propertiesOpen && props.selectedProperty === "video" && <section className="shorts-property-inspector" aria-label="Video properties">
      <strong>Video</strong>
      <label>Start seconds<input aria-label="Video trim start seconds" type="number" min="0" step="0.1" value={props.start} onChange={(event) => props.onTrim(Number(event.target.value), props.end)} /></label>
      <label>End seconds<input aria-label="Video trim end seconds" type="number" min="0" step="0.1" value={props.end ?? ""} placeholder="Source end" onChange={(event) => props.onTrim(props.start, event.target.value.trim() ? Number(event.target.value) : undefined)} /></label>
    </section>}
    {props.propertiesOpen && props.activeTool === "text" && selectedOverlay && <section className="shorts-property-inspector" aria-label="Text properties">
      <div role="group" aria-label={`Text overlay ${props.overlays.indexOf(selectedOverlay) + 1}`}>
        <label>Content<input aria-label="Overlay text" value={selectedOverlay.text} maxLength={500} onChange={(event) => changeOverlay({ text: event.target.value })} /></label>
        <label>Text color<input aria-label="Text color" type="color" value={selectedOverlay.color} onChange={(event) => changeOverlay({ color: event.target.value })} /></label>
        <label>Text size<input aria-label="Text size" type="number" min="8" max="240" value={selectedOverlay.size} onChange={(event) => changeOverlay({ size: Math.max(8, Math.min(240, Number(event.target.value) || 8)) })} /></label>
        <label>Horizontal position<input aria-label="Horizontal position" type="number" min="0" max="1" step="0.01" value={selectedOverlay.x} onChange={(event) => changeOverlay({ x: Math.max(0, Math.min(1, Number(event.target.value))) })} /></label>
        <label>Vertical position<input aria-label="Vertical position" type="number" min="0" max="1" step="0.01" value={selectedOverlay.y} onChange={(event) => changeOverlay({ y: Math.max(0, Math.min(1, Number(event.target.value))) })} /></label>
        <label>Start time<input aria-label="Overlay start seconds" type="number" min="0" step="0.1" value={selectedOverlay.start} onChange={(event) => changeOverlay({ start: Number(event.target.value) })} /></label>
        <label>Duration<input aria-label="Overlay duration seconds" type="number" min="0.1" step="0.1" value={selectedOverlay.duration} onChange={(event) => changeOverlay({ duration: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label>
        <button type="button" aria-label={`Delete text overlay ${props.overlays.indexOf(selectedOverlay) + 1}`} onClick={() => { props.changeOverlays((items) => items.filter((item) => item.id !== selectedOverlay.id)); props.setSelectedOverlayId(null); }}>Delete text</button>
      </div>
    </section>}
    <section className="shorts-track-list" aria-label="Timeline">
      <div className="timeline-scale" aria-hidden="true">{[0, .25, .5, .75, 1].map((position) => <span key={position} style={{ left: `${position * 100}%` }}>{formatDuration(props.outputDuration * position)}</span>)}</div>
      <div role="row" aria-label="Video"><button type="button" className="track-label" onClick={() => { props.setSelectedProperty("video"); props.setSelectedOverlayId(null); props.setPropertiesOpen(true); }}>Video</button><div className="track-lane"><span className="track-block" /><span className="track-playhead" style={{ left: `${playhead}%` }} /></div></div>
      <div role="row" aria-label="Audio"><button type="button" className="track-label" onClick={() => { props.setSelectedProperty("audio"); props.setSelectedOverlayId(null); props.setPropertiesOpen(true); }}>Audio</button><div className="track-lane" onClick={() => { props.setSelectedProperty("audio"); props.setPropertiesOpen(true); }}><span className="track-block">{props.sourceHasAudio === false ? "No audio" : "Source soundtrack"}</span><span className="track-playhead" style={{ left: `${playhead}%` }} /></div></div>
      {props.overlays.length > 0 && <div role="row" aria-label="Text">
        <button type="button" className="track-label" onClick={() => { props.setActiveTool("text"); props.setSelectedProperty(null); props.setPropertiesOpen(true); }}>Text</button>
        <div className="track-lane">{props.overlays.map((item, index) => {
          const left = `${props.outputDuration > 0 ? item.start / props.outputDuration * 100 : 0}%`;
          const width = `${props.outputDuration > 0 ? Math.max(3, item.duration / props.outputDuration * 100) : 10}%`;
          return <button type="button" key={item.id} aria-label={`Select text overlay ${index + 1}`} className="text-duration-block" style={{ left, width }} onClick={() => selectOverlay(item)}>{item.text}</button>;
        })}<span className="track-playhead" style={{ left: `${playhead}%` }} /></div>
      </div>}
    </section>
    <div className="video-controls shorts-bottom-controls">
      <button type="button" className="icon-button" onClick={props.onTogglePlay} aria-label={props.playing ? "Pause preview" : "Play preview"}>{props.playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <button type="button" className="icon-button" aria-label={props.previewMuted ? "Unmute preview" : "Mute preview"} aria-pressed={props.previewMuted} onClick={props.onTogglePreviewMute}>{props.previewMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <span>{formatDuration(Math.max(0, props.currentTime - props.start))} / {formatDuration(props.outputDuration)}</span>
      <input aria-label="Preview position" type="range" min="0" max={Math.max(0.1, props.outputDuration)} step="0.1" value={Math.min(props.outputDuration, Math.max(0, props.currentTime - props.start))} onChange={(event) => props.onSeek(props.start + Number(event.target.value))} />
      {props.onExpand && <button type="button" className="icon-button" aria-label="Expand preview" onClick={props.onExpand}><Maximize2 size={16} /></button>}
      <label>Trim start<input aria-label="Trim start" type="range" min="0" max={Math.max(props.start, props.sourceDuration || 1)} step="0.1" value={props.start} onChange={(event) => props.onTrim(Number(event.target.value), props.end)} /></label>
    </div>
  </div>;
}
