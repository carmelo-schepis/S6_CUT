import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  CAPTION_PRESETS, EDITORIAL_FONT, EMOJI_MODES, HEADING_STYLES, SAMPLE_SENTENCE, VIDEO_FILTERS, labelOf,
  type CaptionPresetDefinition,
} from "../editing-presets";
import type { CaptionPreset, EditingPresentationConfig, EmojiMode, HeadingStyle, Style, VideoFilter } from "../types";

/** Time each sample word stays the spoken one. */
const WORD_MS = 520;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Splits the phrase holding `active` into rows; a bounded stack uses `lines`. */
function sampleGroup(preset: CaptionPresetDefinition, editorialStyle: Style): number {
  if (preset.id !== "editorial_default") return preset.group;
  // Keep this sample aligned with the smart_speech_v2 renderer's intent-specific
  // phrase sizes. Serious uses a stable six-word phrase without colour emphasis.
  return { serious: 6, educational: 4, funny: 3, hype: 3 }[editorialStyle];
}

function phraseOf(preset: CaptionPresetDefinition, active: number, editorialStyle: Style) {
  const count = SAMPLE_SENTENCE.length;
  const group = sampleGroup(preset, editorialStyle);
  const phrase = Math.floor(Math.min(active, count - 1) / group);
  const first = phrase * group;
  const indexes = Array.from({ length: Math.min(group, count - first) }, (_, offset) => first + offset);
  if (!preset.lines) return { phrase, rows: [indexes] };
  const rows: number[][] = [];
  let cursor = 0;
  for (const size of preset.lines) { rows.push(indexes.slice(cursor, cursor + size)); cursor += size; }
  return { phrase, rows: rows.filter((row) => row.length) };
}

/** The sample sentence in one preset's treatment, with `active` as the spoken word. */
export function CaptionSample({ preset, active, editorialStyle, playing = false, className = "" }: {
  preset: CaptionPresetDefinition; active: number; editorialStyle: Style; playing?: boolean; className?: string;
}) {
  const { phrase, rows } = phraseOf(preset, active, editorialStyle);
  const editorialEmphasis = preset.id === "editorial_default" && editorialStyle === "serious" ? "none" : preset.emphasis;
  return <span className={`caption-sample caption-${preset.family} ${className}`} data-editorial={editorialStyle} data-editorial-emphasis={editorialEmphasis} data-play={playing ? "true" : "false"} data-motion={preset.motion}>
    <span className="cap-phrase" key={phrase}>
      {rows.map((row, rowIndex) => <span className="cap-row" key={rowIndex}>
        {row.map((index) => <Fragment key={index}>{index !== row[0] && " "}<span className="cap-word" data-state={index < active ? "past" : index === active ? "active" : "future"}>{SAMPLE_SENTENCE[index]}</span></Fragment>)}
      </span>)}
    </span>
  </span>;
}

/** A small stand-in frame so grading is visible on something coloured. Never the user's source. */
function SampleFrame({ filter, className = "", children }: { filter: VideoFilter; className?: string; children?: ReactNode }) {
  return <div className={`style-frame ${className}`}>
    <div className="style-footage" data-filter={filter} aria-hidden="true"><i /><b /></div>
    {children}
  </div>;
}

export function VideoFilterPicker({ value, onChange, existingNote, label = "Video filter" }: {
  value: VideoFilter; onChange: (value: VideoFilter) => void; existingNote: string; label?: string;
}) {
  return <div className="video-filter-picker">
    <div role="group" aria-label={label} className="video-filter-options">
      {VIDEO_FILTERS.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}>
        <span className="style-footage filter-swatch" data-filter={item.id} aria-hidden="true"><i /><b /></span>
        <strong>{item.label}</strong><small>{item.id === "existing" ? existingNote : item.note}</small>
      </button>)}
    </div>
    <div className="video-filter-selected">
      <SampleFrame filter={value} className="filter-frame" />
      <small className="form-hint">Style sample: a stand-in picture shows the {labelOf(VIDEO_FILTERS, value, "Existing look").toLowerCase()} grade; it is not a render of your video. Captions, headings and graphics are added after grading and keep their own colours.</small>
    </div>
  </div>;
}

export type HeadingSample = { enabled: boolean; text: string; style: HeadingStyle };

function HeadingSampleBar({ text, style }: { text: string; style: HeadingStyle }) {
  return <span className={`heading-sample heading-${style}`}>{text}</span>;
}

export function SpeechSubtitleStyleControls({ value, onChange, editorialStyle, videoFilter, heading, emojiMode, disabledReason }: {
  value: CaptionPreset; onChange: (value: CaptionPreset) => void; editorialStyle: Style; videoFilter: VideoFilter;
  heading: HeadingSample; emojiMode: EmojiMode; disabledReason: string | null;
}) {
  const selected = CAPTION_PRESETS.find((item) => item.id === value) ?? CAPTION_PRESETS[0];
  const [reduced] = useState(prefersReducedMotion);
  // Reduced motion starts on a still frame and Play is then an explicit request.
  // Choosing another style restarts the sample while rendering, not in an effect.
  const [sample, setSample] = useState<{ id: CaptionPreset; step: number | null; run: number }>({ id: selected.id, step: reduced ? null : 0, run: 0 });
  let current = sample;
  if (sample.id !== selected.id) {
    current = { id: selected.id, step: reduced ? null : 0, run: sample.run + 1 };
    setSample(current);
  }
  const { step, run } = current;
  const playing = step !== null && step < SAMPLE_SENTENCE.length;
  useEffect(() => {
    if (step === null || step >= SAMPLE_SENTENCE.length) return;
    const timer = window.setTimeout(() => setSample((now) => now.run === run && now.step !== null ? { ...now, step: now.step + 1 } : now), WORD_MS);
    return () => window.clearTimeout(timer);
  }, [step, run]);

  if (disabledReason) return <p className="form-hint" role="status">{disabledReason}</p>;
  const shownIndex = playing ? step : selected.stillIndex;
  const font = selected.id === "editorial_default" ? EDITORIAL_FONT[editorialStyle] : selected.font;
  return <div className="speech-style">
    <div role="group" aria-label="Subtitle style" className="speech-style-options">
      {CAPTION_PRESETS.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}>
        <span className="speech-style-chip" aria-hidden="true"><CaptionSample preset={item} active={item.stillIndex} editorialStyle={editorialStyle} className="caption-card" /></span>
        <strong>{item.label}</strong><small>{item.note}</small>
      </button>)}
    </div>
    <div className="speech-style-selected">
      <SampleFrame filter={videoFilter} className="speech-frame">
        {heading.enabled && <HeadingSampleBar text={heading.text} style={heading.style} />}
        {emojiMode === "sparse" && <img className="reaction-sample" src="/style-samples/reaction-sample.png" alt="" aria-hidden="true" width={256} height={256} />}
        <span className="speech-frame-caption" role="img" aria-label={`Style sample: ${selected.label}. ${font}. ${selected.backing}. ${selected.emphasis}.`}>
          <CaptionSample preset={selected} active={shownIndex} editorialStyle={editorialStyle} playing={playing} />
        </span>
      </SampleFrame>
      <div className="speech-style-detail">
        <strong>{selected.label}</strong>
        <dl className="info-list">
          <dt>Font</dt><dd>{font}</dd>
          <dt>Outline / background</dt><dd>{selected.backing}</dd>
          <dt>Emphasis</dt><dd>{selected.id === "editorial_default" && editorialStyle === "serious" ? "None; stable colour" : selected.emphasis}</dd>
          <dt>Placement</dt><dd>{selected.id === "editorial_default" ? `Lower third, ${sampleGroup(selected, editorialStyle)}-word phrases` : selected.placement}</dd>
        </dl>
        <button type="button" className="button button-quiet" onClick={() => setSample({ id: selected.id, step: 0, run: run + 1 })}>{step === null ? "Play sample" : "Replay sample"}</button>
        <small className="form-hint">Style sample: “{SAMPLE_SENTENCE.join(" ")}” This is an illustration, not a render of your video. Editorial style still decides which moments are chosen.</small>
      </div>
    </div>
  </div>;
}

export function HeadingStyleControls({ value, onChange }: { value: HeadingStyle; onChange: (value: HeadingStyle) => void }) {
  return <div className="heading-style-picker">
    <div role="group" aria-label="Heading appearance" className="heading-style-options">
      {HEADING_STYLES.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}>
        <span className="heading-style-chip" aria-hidden="true"><HeadingSampleBar text="Your heading" style={item.id} /></span>
        <strong>{item.label}</strong><small>{item.note}</small>
      </button>)}
    </div>
    <small className="form-hint">Applies only when Hook text is ticked. Choosing an appearance never turns heading text on or writes any.</small>
  </div>;
}

export function EmojiModeControls({ value, onChange, disabledReason }: { value: EmojiMode; onChange: (value: EmojiMode) => void; disabledReason: string | null }) {
  return <div className="emoji-mode-picker">
    {disabledReason ? <p className="form-hint" role="status">{disabledReason}</p> : <>
      <div role="group" aria-label="Emoji reactions" className="heading-style-options">
        {EMOJI_MODES.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}
      </div>
      <small className="form-hint">Off only stops generated reaction artwork; emoji typed in the speech stay in the captions. Sparse adds reactions only where a cue is found.</small>
    </>}
  </div>;
}

/** Read-only saved choices; omitted values resolve to the existing behaviour. */
export function EditingPresentationSummary({ presentation, music = false }: { presentation: EditingPresentationConfig; music?: boolean }) {
  return <div className="inspector-section editing-presentation-summary" aria-label="Editing style">
    <label>Editing style <span className="readonly-tag">Read-only</span></label>
    <dl className="info-list">
      {!music && <><dt>Subtitle style</dt><dd>{labelOf(CAPTION_PRESETS, presentation.captionPreset ?? "editorial_default", "Editorial default")}</dd></>}
      <dt>Video filter</dt><dd>{labelOf(VIDEO_FILTERS, presentation.videoFilter ?? "existing", "Existing look")}</dd>
      {!music && <><dt>Heading appearance</dt><dd>{labelOf(HEADING_STYLES, presentation.headingStyle ?? "plain", "Plain")}</dd>
        <dt>Emoji reactions</dt><dd>{labelOf(EMOJI_MODES, presentation.emojiMode ?? "existing", "Existing behaviour")}</dd></>}
    </dl>
  </div>;
}
