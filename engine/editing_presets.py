"""Selectable editing-style catalog: speech caption presets, picture filters, headings, reactions.

Pure data and validation, no FFmpeg/libass. ``engine.media`` turns these
definitions into ASS events and filter chains; ``engine.app`` validates a
request against them before any download or job exists. IDs are the contract
shared with the frontend (``editingPresentation``), so they are only ever added.

Editorial intent (Funny/Serious/Educational/Hype) stays a separate input: the
default caption preset resolves to whatever that style already rendered.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

EDITING_PRESENTATION_VERSION = 1

DEFAULT_CAPTION_PRESET = "editorial_default"
DEFAULT_VIDEO_FILTER = "existing"
DEFAULT_HEADING_STYLE = "plain"
DEFAULT_EMOJI_MODE = "existing"

CAPTION_PRESET_IDS = (
    "editorial_default", "clean_sentence", "bold_outline", "yellow_focus", "word_pop", "active_word_box",
    "dark_caption_plate", "light_caption_plate", "word_build", "cinematic_serif", "condensed_stack", "karaoke_line",
)
VIDEO_FILTER_IDS = ("existing", "original", "warm", "cool", "vibrant", "black_white", "vintage")
HEADING_STYLE_IDS = ("plain", "dark_box", "white_banner")
EMOJI_MODE_IDS = ("existing", "off", "sparse")

# Filters that actually add a picture grade; the other two only decide whether
# an existing automatic grade is kept (existing) or bypassed (original).
GRADED_FILTERS = frozenset({"warm", "cool", "vibrant", "black_white", "vintage"})

# Fields that only mean something for regular speech clips.
SPEECH_ONLY_FIELDS = ("caption_preset", "heading_style", "emoji_mode")

CAPTION_PRESET_LABELS = {
    "editorial_default": "Editorial default", "clean_sentence": "Clean sentence", "bold_outline": "Bold outline",
    "yellow_focus": "Yellow focus", "word_pop": "Word pop", "active_word_box": "Active word box",
    "dark_caption_plate": "Dark caption plate", "light_caption_plate": "Light caption plate",
    "word_build": "Word build", "cinematic_serif": "Cinematic serif", "condensed_stack": "Condensed stack",
    "karaoke_line": "Karaoke line",
}
VIDEO_FILTER_LABELS = {
    "existing": "Existing look", "original": "Original colour", "warm": "Warm", "cool": "Cool",
    "vibrant": "Vibrant", "black_white": "Black & white", "vintage": "Vintage",
}
HEADING_STYLE_LABELS = {"plain": "Plain", "dark_box": "Dark box", "white_banner": "White banner"}
EMOJI_MODE_LABELS = {"existing": "Existing behaviour", "off": "Off", "sparse": "Sparse"}


@dataclass(frozen=True)
class SpeechPreset:
    """One burned-in speech caption treatment.

    Colours are ASS ``&HAABBGGRR&`` strings. ``emphasis`` selects the motion /
    highlight family; ``plate`` selects a fitted background drawn per line.
    """

    id: str
    fontname: str            # family libass receives
    font_file: str           # bundled face used to measure advances, relative to engine/fonts
    size: int                # px at the 1080 short-edge reference canvas
    primary: str
    outline_color: str
    outline: int
    shadow: int
    bold: int = 0
    italic: int = 0
    uppercase: bool = False
    accent: str = "&H0000D7FF&"           # active/spoken-word emphasis
    neutral: str = "&H00E6E6E6&"          # unspoken words (karaoke)
    emphasis: str = "none"                # none | word_color | word_pop | word_box | word_build | karaoke
    plate: str | None = None              # None | dark | light
    plate_color: str = "&H33000000&"
    box_color: str = "&H0050C800&"        # active-word box
    max_words: int = 4
    max_lines: int = 2
    max_words_per_line: int = 99
    y_fraction: float = 0.74              # block centre as a fraction of canvas height
    fade_in_ms: int = 0
    fade_out_ms: int = 0
    spacing: float = 0.0
    scale_x: int = 100


# Existing bundled faces only; sizes are chosen so the longest group of
# ``max_words`` ordinary words still fits ``max_lines`` at the reference width.
SPEECH_PRESETS: dict[str, SpeechPreset] = {preset.id: preset for preset in (
    SpeechPreset(
        "clean_sentence", "Barlow", "barlow/Barlow-Regular.ttf", 62, "&H00FFFFFF&", "&H00201810&", 2, 1,
        max_words=7, max_lines=2, y_fraction=0.74, fade_in_ms=60, fade_out_ms=60,
    ),
    SpeechPreset(
        "bold_outline", "Montserrat", "montserrat/Montserrat-Bold.ttf", 96, "&H00FFFFFF&", "&H00000000&", 9, 0,
        bold=-1, max_words=3, max_lines=2, y_fraction=0.72,
    ),
    SpeechPreset(
        "yellow_focus", "Montserrat", "montserrat/Montserrat-Bold.ttf", 90, "&H00FFFFFF&", "&H00000000&", 8, 0,
        bold=-1, emphasis="word_color", max_words=4, max_lines=2, y_fraction=0.72,
    ),
    SpeechPreset(
        "word_pop", "Archivo Black", "archivoblack/ArchivoBlack-Regular.ttf", 118, "&H00FFFFFF&", "&H00000000&", 9, 0,
        emphasis="word_pop", max_words=1, max_lines=1, y_fraction=0.64,
    ),
    SpeechPreset(
        "active_word_box", "Barlow", "barlow/Barlow-Bold.ttf", 80, "&H00FFFFFF&", "&H00101010&", 4, 0,
        bold=-1, emphasis="word_box", max_words=4, max_lines=2, y_fraction=0.72,
    ),
    SpeechPreset(
        "dark_caption_plate", "Barlow", "barlow/Barlow-Bold.ttf", 66, "&H00FFFFFF&", "&H00000000&", 0, 0,
        bold=-1, plate="dark", plate_color="&H2E000000&", max_words=6, max_lines=2, y_fraction=0.74,
    ),
    SpeechPreset(
        "light_caption_plate", "Barlow", "barlow/Barlow-Bold.ttf", 66, "&H00141414&", "&H00F2F2F2&", 0, 0,
        bold=-1, plate="light", plate_color="&H0AF2F2F2&", max_words=6, max_lines=2, y_fraction=0.74,
    ),
    SpeechPreset(
        "word_build", "Montserrat", "montserrat/Montserrat-Bold.ttf", 84, "&H00FFFFFF&", "&H00000000&", 7, 0,
        bold=-1, emphasis="word_build", max_words=5, max_lines=2, y_fraction=0.72,
    ),
    SpeechPreset(
        "cinematic_serif", "Lora", "lora/Lora.ttf", 70, "&H00F4F0EA&", "&H00000000&", 1, 4,
        max_words=7, max_lines=2, y_fraction=0.74, fade_in_ms=180, fade_out_ms=220,
    ),
    SpeechPreset(
        "condensed_stack", "Anton", "anton/Anton-Regular.ttf", 128, "&H00FFFFFF&", "&H00000000&", 6, 0,
        uppercase=True, max_words=5, max_lines=3, max_words_per_line=2, y_fraction=0.68, spacing=1.0,
    ),
    SpeechPreset(
        "karaoke_line", "Barlow", "barlow/Barlow-Bold.ttf", 76, "&H00FFFFFF&", "&H00000000&", 6, 1,
        bold=-1, accent="&H0066E0FF&", neutral="&H00DADADA&", emphasis="karaoke", max_words=5, max_lines=2, y_fraction=0.74,
    ),
)}

assert set(SPEECH_PRESETS) == set(CAPTION_PRESET_IDS) - {DEFAULT_CAPTION_PRESET}


def normalize_editing_presentation(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Saved/private mapping -> render-ready snake_case dict, or None when unset or unrecognised.

    Unknown ids from a newer build degrade to the matching default rather than
    raising: losing a render is worse than losing one treatment.
    """
    if not isinstance(value, Mapping) or value.get("version") != EDITING_PRESENTATION_VERSION:
        return None

    def pick(name: str, allowed: Iterable[str], default: str) -> str:
        choice = value.get(name)
        return choice if choice in allowed else default

    return {
        "version": EDITING_PRESENTATION_VERSION,
        "caption_preset": pick("caption_preset", CAPTION_PRESET_IDS, DEFAULT_CAPTION_PRESET),
        "video_filter": pick("video_filter", VIDEO_FILTER_IDS, DEFAULT_VIDEO_FILTER),
        "heading_style": pick("heading_style", HEADING_STYLE_IDS, DEFAULT_HEADING_STYLE),
        "emoji_mode": pick("emoji_mode", EMOJI_MODE_IDS, DEFAULT_EMOJI_MODE),
    }


def speech_preset(value: Mapping[str, Any] | None) -> SpeechPreset | None:
    """The new speech preset a saved choice selects; None means the editorial default."""
    normalized = normalize_editing_presentation(value)
    return SPEECH_PRESETS.get(normalized["caption_preset"]) if normalized else None


def video_filter_choice(value: Mapping[str, Any] | None) -> str:
    normalized = normalize_editing_presentation(value)
    return normalized["video_filter"] if normalized else DEFAULT_VIDEO_FILTER


def heading_style_choice(value: Mapping[str, Any] | None) -> str:
    normalized = normalize_editing_presentation(value)
    return normalized["heading_style"] if normalized else DEFAULT_HEADING_STYLE


def emoji_mode_choice(value: Mapping[str, Any] | None) -> str:
    normalized = normalize_editing_presentation(value)
    return normalized["emoji_mode"] if normalized else DEFAULT_EMOJI_MODE


def validate_editing_request(
    config: Any, *, source_profile: str, content_format: str, mode: str, batch_mode: str, burn_subtitles: bool,
) -> None:
    """Reject selections the chosen job cannot honour. Raises ``ValueError`` with a user-facing message.

    Called before any source is downloaded or stored. ``config`` is an
    ``EditingPresentationConfig``; ``model_fields_set`` distinguishes a field the
    client supplied from one that merely took its default.
    """
    supplied = set(getattr(config, "model_fields_set", set()))
    if source_profile == "music":
        speech_only = sorted(name for name in SPEECH_ONLY_FIELDS if name in supplied)
        if speech_only:
            raise ValueError("Subtitle style, heading style and emoji options are only available for Speech clips; Music uses its own lyric theme options.")
        return
    needs_captions = (
        (config.caption_preset or DEFAULT_CAPTION_PRESET) != DEFAULT_CAPTION_PRESET
        or (config.emoji_mode or DEFAULT_EMOJI_MODE) != DEFAULT_EMOJI_MODE
    )
    if not needs_captions:
        return
    # Smart Long form is supported: the renderer scales to the 16:9 canvas. Headings keep
    # their own (short-form only) hook-text eligibility, enforced by the caller.
    if mode != "smart":
        raise ValueError("Subtitle styles and emoji options are unavailable in Fast mode, which skips captions; video filters still work.")
    if not burn_subtitles:
        raise ValueError("Turn on burned-in subtitles to use a subtitle style or emoji option.")
    # High-volume Smart short batches are supported: one saved choice applies to every output.
    del batch_mode


def sanitize_for_uncaptioned_path(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Keep only what a caption-free render can honour (the picture filter)."""
    normalized = normalize_editing_presentation(value)
    if normalized is None:
        return None
    return {**normalized, "caption_preset": DEFAULT_CAPTION_PRESET, "emoji_mode": DEFAULT_EMOJI_MODE, "heading_style": DEFAULT_HEADING_STYLE}


def manifest_summary(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Additive export metadata: ids with their human labels, only for jobs that chose a presentation."""
    normalized = normalize_editing_presentation(value)
    if normalized is None:
        return None
    return {
        "version": EDITING_PRESENTATION_VERSION,
        "caption_preset": {"id": normalized["caption_preset"], "label": CAPTION_PRESET_LABELS[normalized["caption_preset"]]},
        "video_filter": {"id": normalized["video_filter"], "label": VIDEO_FILTER_LABELS[normalized["video_filter"]]},
        "heading_style": {"id": normalized["heading_style"], "label": HEADING_STYLE_LABELS[normalized["heading_style"]]},
        "emoji_mode": {"id": normalized["emoji_mode"], "label": EMOJI_MODE_LABELS[normalized["emoji_mode"]]},
    }
