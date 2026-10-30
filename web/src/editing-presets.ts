import type { CaptionPreset, EditingPresentationConfig, EmojiMode, HeadingStyle, Style, VideoFilter } from "./types";

/** Original sample sentence shared by every regular subtitle card. */
export const SAMPLE_SENTENCE = ["Small", "changes", "make", "a", "clear", "difference."] as const;

export type CaptionMotion = "none" | "focus" | "pop" | "box" | "build" | "karaoke";

export type CaptionPresetDefinition = {
  id: CaptionPreset;
  label: string;
  /** Short card caption. */
  note: string;
  /** Visual family: selects the CSS treatment. The engine render is authoritative. */
  family: string;
  motion: CaptionMotion;
  /** Words per phrase; a phrase is replaced as the next one starts. */
  group: number;
  /** Optional line split inside one phrase, e.g. a bounded three-line stack. */
  lines?: readonly number[];
  /** Word shown as spoken in still frames. */
  stillIndex: number;
  font: string;
  backing: string;
  emphasis: string;
  placement: string;
};

export const CAPTION_PRESETS: readonly CaptionPresetDefinition[] = [
  { id: "editorial_default", label: "Editorial default", note: "Follows Editorial style", family: "editorial", motion: "focus", group: 3, stillIndex: 2, font: "By Editorial style", backing: "Today’s outline", emphasis: "Spoken word highlighted", placement: "Lower third, short groups" },
  { id: "clean_sentence", label: "Clean sentence", note: "Sentence case · calm", family: "clean", motion: "none", group: 6, stillIndex: 5, font: "Barlow", backing: "Soft shadow, no plate", emphasis: "None", placement: "Lower third, whole phrase" },
  { id: "bold_outline", label: "Bold outline", note: "Heavy white · dark edge", family: "bold-outline", motion: "none", group: 3, stillIndex: 2, font: "Montserrat Bold", backing: "Strong dark outline", emphasis: "None", placement: "Lower third, up to 3 words" },
  { id: "yellow_focus", label: "Yellow focus", note: "Spoken word in yellow", family: "yellow-focus", motion: "focus", group: 4, stillIndex: 1, font: "Montserrat Bold", backing: "Dark outline", emphasis: "Exactly the spoken word is yellow", placement: "Lower third, up to 4 words" },
  { id: "word_pop", label: "Word pop", note: "One word, small pop", family: "word-pop", motion: "pop", group: 1, stillIndex: 4, font: "Archivo Black", backing: "Dark outline", emphasis: "One word at a time, bounded scale-in", placement: "Centre-lower, one word" },
  { id: "active_word_box", label: "Active word box", note: "Plate behind spoken word", family: "word-box", motion: "box", group: 4, stillIndex: 1, font: "Barlow Bold", backing: "Green plate on the spoken word", emphasis: "Boxed word", placement: "Lower third, stable phrase" },
  { id: "dark_caption_plate", label: "Dark caption plate", note: "White on dark plate", family: "dark-plate", motion: "none", group: 6, stillIndex: 5, font: "Barlow Bold", backing: "Fitted dark plate", emphasis: "None", placement: "Lower third, up to 2 lines" },
  { id: "light_caption_plate", label: "Light caption plate", note: "Dark on light plate", family: "light-plate", motion: "none", group: 6, stillIndex: 5, font: "Barlow Bold", backing: "Fitted light plate", emphasis: "None", placement: "Lower third, up to 2 lines" },
  { id: "word_build", label: "Word build", note: "Words appear as spoken", family: "word-build", motion: "build", group: 5, stillIndex: 3, font: "Montserrat Bold", backing: "Dark outline", emphasis: "Words appear at their onsets", placement: "Lower third, stable layout" },
  { id: "cinematic_serif", label: "Cinematic serif", note: "Serif · gentle fade", family: "cinematic", motion: "none", group: 6, stillIndex: 5, font: "Lora", backing: "Subtle shadow", emphasis: "Fade between phrases", placement: "Lower third, whole phrase" },
  { id: "condensed_stack", label: "Condensed stack", note: "Narrow caps · 3 lines", family: "condensed", motion: "none", group: 5, lines: [2, 2, 1], stillIndex: 4, font: "Anton", backing: "Dark outline", emphasis: "None", placement: "Upper-lower third, up to 3 lines" },
  { id: "karaoke_line", label: "Karaoke line", note: "Colour follows the words", family: "karaoke", motion: "karaoke", group: 5, stillIndex: 1, font: "Barlow Bold", backing: "Dark outline", emphasis: "Sung words keep the accent", placement: "Lower third, stable short line" },
];

export const DEFAULT_CAPTION_PRESET: CaptionPreset = "editorial_default";

export const EDITORIAL_FONT: Record<Style, string> = {
  hype: "Montserrat ExtraBold Italic", funny: "Archivo Black", educational: "Barlow Bold", serious: "Barlow Regular",
};

export const VIDEO_FILTERS: readonly { id: VideoFilter; label: string; note: string }[] = [
  { id: "existing", label: "Existing look", note: "Keeps the current look" },
  { id: "original", label: "Original colour", note: "No creative grade" },
  { id: "warm", label: "Warm", note: "Amber highlights" },
  { id: "cool", label: "Cool", note: "Blue cast" },
  { id: "vibrant", label: "Vibrant", note: "Richer colour" },
  { id: "black_white", label: "Black & white", note: "Monochrome footage" },
  { id: "vintage", label: "Vintage", note: "Faded with fine grain" },
];
export const DEFAULT_VIDEO_FILTER: VideoFilter = "existing";

export const HEADING_STYLES: readonly { id: HeadingStyle; label: string; note: string }[] = [
  { id: "plain", label: "Plain", note: "White text above the footage" },
  { id: "dark_box", label: "Dark box", note: "White text on a dark box" },
  { id: "white_banner", label: "White banner", note: "Black text on a white strip" },
];
export const DEFAULT_HEADING_STYLE: HeadingStyle = "plain";

export const EMOJI_MODES: readonly { id: EmojiMode; label: string; note: string }[] = [
  { id: "existing", label: "Existing behaviour", note: "Today’s reaction rules" },
  { id: "off", label: "Off", note: "No generated reactions" },
  { id: "sparse", label: "Sparse", note: "A few well-placed reactions" },
];
export const DEFAULT_EMOJI_MODE: EmojiMode = "existing";

export const labelOf = <T extends { id: string; label: string }>(items: readonly T[], id: string | null | undefined, fallback: string): string =>
  items.find((item) => item.id === id)?.label ?? fallback;

/**
 * Speech selections to submit. Only non-default values are sent so an untouched
 * form keeps the engine's existing behaviour; captions and emoji are left out
 * when captions cannot be burned, and the heading style when hook text is
 * ineligible for the chosen path.
 */
export function speechEditingPresentation(input: {
  captionPreset: CaptionPreset; videoFilter: VideoFilter; headingStyle: HeadingStyle; emojiMode: EmojiMode;
  captionsAvailable: boolean; headingAvailable: boolean;
}): EditingPresentationConfig | undefined {
  const selected: Omit<EditingPresentationConfig, "version"> = {
    ...(input.captionsAvailable && input.captionPreset !== DEFAULT_CAPTION_PRESET ? { captionPreset: input.captionPreset } : {}),
    ...(input.videoFilter !== DEFAULT_VIDEO_FILTER ? { videoFilter: input.videoFilter } : {}),
    ...(input.headingAvailable && input.headingStyle !== DEFAULT_HEADING_STYLE ? { headingStyle: input.headingStyle } : {}),
    ...(input.captionsAvailable && input.emojiMode !== DEFAULT_EMOJI_MODE ? { emojiMode: input.emojiMode } : {}),
  };
  return Object.keys(selected).length ? { version: 1, ...selected } : undefined;
}

/** Music shares only the picture filter; speech-only keys are never sent for it. */
export function musicEditingPresentation(videoFilter: VideoFilter): EditingPresentationConfig | undefined {
  return videoFilter !== DEFAULT_VIDEO_FILTER ? { version: 1, videoFilter } : undefined;
}
