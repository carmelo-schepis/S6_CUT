import { useState } from "react";
import type { MusicHookTextFormat, MusicLyricAnimation, MusicTheme } from "../types";

export const LYRIC_ANIMATIONS: { id: MusicLyricAnimation; label: string; note: string }[] = [
  { id: "legacy", label: "Original", note: "Words switch instantly" },
  { id: "slow_fade", label: "Slow fade", note: "Each line fades in and out" },
  { id: "line_crossfade", label: "Line crossfade", note: "Lines blend into each other" },
  { id: "word_build", label: "Word build", note: "Words appear as they are sung" },
];

export const HOOK_TEXT_FORMATS: { id: MusicHookTextFormat; label: string; note: string }[] = [
  { id: "plain", label: "Plain", note: "White text in the upper black area" },
  { id: "white_banner", label: "White banner", note: "Black text on a white strip above the footage" },
];

const THEME_PREVIEW_CLASS: Record<MusicTheme, string> = {
  clean: "theme-clean", warm: "theme-warm", serif: "theme-serif",
  reference_white_sans: "theme-reference-white-sans", reference_yellow_sans: "theme-reference-yellow-sans", reference_white_serif: "theme-reference-white-serif",
  condensed_black: "theme-condensed-black", condensed_white: "theme-condensed-white", handwritten_stack: "theme-handwritten-stack",
};

const FIRST_LINE = ["do", "you", "think"];
const SECOND_LINE = ["that", "i’ve", "forgotten"];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A local CSS sample of the chosen motion. The saved clip is always an FFmpeg render. */
export function LyricAnimationPreview({ animation, theme }: { animation: MusicLyricAnimation; theme: MusicTheme }) {
  const [reduced] = useState(prefersReducedMotion);
  // Reduced motion starts on a still frame; Play is then an explicit request.
  // Changing the animation resets the sample while rendering, not in an effect.
  const [sample, setSample] = useState({ animation, playing: !reduced, run: 0 });
  let current = sample;
  if (sample.animation !== animation) {
    current = { animation, playing: !reduced, run: sample.run + 1 };
    setSample(current);
  }
  const { playing, run } = current;
  const lines = animation === "line_crossfade" || animation === "slow_fade" || animation === "legacy" ? [FIRST_LINE, SECOND_LINE] : [FIRST_LINE];
  return <div className="lyric-preview" data-animation={animation} data-state={playing ? "playing" : "still"}>
    <div key={run} className={`lyric-preview-stage ${THEME_PREVIEW_CLASS[theme]}`} role="img" aria-label={`Sample of the ${LYRIC_ANIMATIONS.find((item) => item.id === animation)?.label ?? "Original"} lyric animation`}>
      {lines.map((words, lineIndex) => <p key={lineIndex} className={`lyric-preview-line line-${lineIndex}`}>
        {words.map((word, wordIndex) => <span key={word} className="lyric-preview-word" style={{ animationDelay: animation === "word_build" ? `${0.3 + wordIndex * 0.45}s` : undefined }}>{word}{" "}</span>)}
      </p>)}
    </div>
    <button type="button" className="button button-quiet" onClick={() => setSample({ animation, playing: true, run: run + 1 })}>{playing ? "Replay preview" : "Play preview"}</button>
  </div>;
}

export function MusicLyricAnimationPicker({ value, theme, onChange }: { value: MusicLyricAnimation; theme: MusicTheme; onChange: (value: MusicLyricAnimation) => void }) {
  return <div className="music-motion-picker">
    <p className="music-theme-group-label">Lyric animation</p>
    <div role="group" aria-label="Lyric animation" className="music-animation-options">
      {LYRIC_ANIMATIONS.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}
    </div>
    <LyricAnimationPreview animation={value} theme={theme} />
    <small className="form-hint">Typography and motion are independent: any style works with any animation. This is a preview of the setting; the finished clip is rendered with the real video pipeline. Animations take effect on new clips only.</small>
  </div>;
}

export function MusicHookFormatPicker({ value, onChange }: { value: MusicHookTextFormat; onChange: (value: MusicHookTextFormat) => void }) {
  return <div className="music-hook-format">
    <p className="music-theme-group-label">Hook text format</p>
    <div role="group" aria-label="Hook text format" className="music-animation-options">
      {HOOK_TEXT_FORMATS.map((item) => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} className={value === item.id ? "active" : ""} onClick={() => onChange(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}
    </div>
    <div className={`hook-format-sample ${value === "white_banner" ? "is-banner" : "is-plain"}`} role="img" aria-label={value === "white_banner" ? "Sample white banner above the footage" : "Sample plain hook text above the footage"}>
      <span>Your hook text here</span>
      <i aria-hidden="true" />
    </div>
  </div>;
}

export const MUSIC_THEME_LABELS: Record<MusicTheme, string> = {
  clean: "Clean sans", warm: "Warm highlight", serif: "Soft serif",
  reference_white_sans: "Reference white sans", reference_yellow_sans: "Reference yellow sans", reference_white_serif: "Reference white serif",
  condensed_black: "Condensed black", condensed_white: "Condensed white", handwritten_stack: "Handwritten stack",
};

/** Read-only, resolved choices for a saved Music job. Omitted options resolve to Original / Plain. */
export function MusicPresentationSummary({ theme, lyricAnimation, hookTextFormat, topText }: {
  theme: MusicTheme; lyricAnimation?: MusicLyricAnimation | null; hookTextFormat?: MusicHookTextFormat | null; topText?: string | null;
}) {
  const animation = LYRIC_ANIMATIONS.find((item) => item.id === (lyricAnimation ?? "legacy"));
  const format = HOOK_TEXT_FORMATS.find((item) => item.id === (hookTextFormat ?? "plain"));
  const hook = topText?.trim() ? topText : null;
  return <div className="inspector-section music-presentation-summary" aria-label="Music presentation">
    <label>Music presentation <span className="readonly-tag">Read-only</span></label>
    <dl className="info-list">
      <dt>Lyric style</dt><dd>{MUSIC_THEME_LABELS[theme]}</dd>
      <dt>Lyric animation</dt><dd>{animation?.label}</dd>
      <dt>Hook text</dt><dd>{hook ?? "Off"}</dd>
      {hook && <><dt>Hook format</dt><dd>{format?.label}</dd></>}
    </dl>
  </div>;
}
