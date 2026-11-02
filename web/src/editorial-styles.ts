import type { SourceProfile, Style } from "./types";

export type EditorialStyleOption = { id: Style; label: string; note: string };

export const SPEECH_EDITORIAL_STYLES: readonly EditorialStyleOption[] = [
  { id: "funny", label: "Funny", note: "Punchlines & reactions" },
  { id: "serious", label: "Serious", note: "Complete claims" },
  { id: "educational", label: "Educational", note: "Clear explanations" },
  { id: "hype", label: "Hype", note: "Hooks & high energy" },
];

// Music reuses the four style ids the API already accepts; the engine gives each
// one its own lyric weighting when the source profile is music.
export const MUSIC_EDITORIAL_STYLES: readonly EditorialStyleOption[] = [
  { id: "hype", label: "Chorus", note: "Big hooks & catchy lines" },
  { id: "funny", label: "Energy", note: "Intense, punchy vocals" },
  { id: "serious", label: "Storytelling", note: "Verses with varied lyrics" },
  { id: "educational", label: "Clear lyrics", note: "Steady, easy-to-follow lines" },
];

export const DEFAULT_MUSIC_EDITORIAL_STYLE: Style = "hype";

/** Music jobs show their music label; speech keeps the stored style text unchanged. */
export function editorialStyleLabel(style: Style, sourceProfile?: SourceProfile | null): string {
  if (sourceProfile !== "music") return style;
  return MUSIC_EDITORIAL_STYLES.find((item) => item.id === style)?.label ?? style;
}
