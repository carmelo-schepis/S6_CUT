"""Edit recipes: what a style actually means, in one place.

A style used to be a caption typography dict and nothing else. A recipe is the
whole edit — captions, look, pacing and which sources the mode accepts — keyed
by (style, content_format) so long form and shorts can differ without a second
table to keep in sync.

This module is deliberately inert on arrival. Every look is identity, every
pacing rule restates what `plan_fast_windows` already does, and the caption
values are the previous preset table moved verbatim, so the rendered output is
unchanged. The structure exists first; the visual change lands against it with
golden frames to review.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping

# The canvas the caption metrics were authored against (9:16 at 1080x1920).
CAPTION_REFERENCE_SHORT_EDGE = 1080


@dataclass(frozen=True)
class CaptionTreatment:
    """Burned-in caption typography.

    Field names match the ASS style fields they feed so the projection back to
    the legacy preset dict stays one-to-one and reviewable.
    """

    fontname: str
    font: int
    outline: int
    shadow: int
    primary: str
    highlight: str
    outline_color: str
    back_color: str
    border_style: int
    bold: int
    italic: int
    spacing: int
    group: int
    margin_v: int
    # A render-time treatment only: the .srt/.vtt sidecars keep true casing.
    uppercase: bool = False


@dataclass(frozen=True)
class LookTreatment:
    """Grade, vignette, grain and punch-in. Defaults are the identity look.

    `is_identity` is what keeps this phase honest: while every recipe leaves
    these at their defaults the renderer must not add a single filter, so the
    output is byte-identical to the version before recipes existed.
    """

    punch_in: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    gamma: float = 1.0
    vignette: float | None = None
    grain: float = 0.0
    # Opacity of a bottom scrim drawn before the captions, 0 for none. This is
    # what replaces the opaque caption panel: legibility over unpredictable
    # footage was the box's real job, and a band behind the whole caption area
    # does it without a slab hugging the text.
    scrim: float = 0.0
    # Fraction of frame height the scrim covers.
    scrim_height: float = 0.26
    # Pinned so a grained look stays deterministic, as window planning is.
    grain_seed: int = 20260918

    def has_picture_filters(self) -> bool:
        """Whether the render chain needs any filter at all.

        The scrim is deliberately excluded: it is drawn by libass into the
        subtitle file, not by a filter. Including it here made every
        scrim-only mode round-trip the frame through yuv444p and back for no
        grade, which cost real time on the shorts path.
        """
        return (
            self.contrast != 1.0 or self.saturation != 1.0 or self.gamma != 1.0
            or self.vignette is not None or self.grain != 0.0
        )

    def is_identity(self) -> bool:
        """Whether this look changes nothing at all, scrim included."""
        return not self.has_picture_filters() and self.punch_in == 1.0 and self.scrim == 0.0


@dataclass(frozen=True)
class PacingRule:
    """How the timeline is cut. Mirrors what `plan_fast_windows` already takes."""

    min_seconds: float = 8.0
    max_seconds: float = 30.0
    guard_seconds: float = 0.0


@dataclass(frozen=True)
class SourcePolicy:
    """Which source kinds a mode accepts.

    Declared now even though nothing gates on it yet, so a mode that needs
    third-party permission has somewhere to say so later.
    """

    kinds: frozenset[str] = frozenset({"upload", "youtube"})

    def accepts(self, source_kind: str) -> bool:
        return source_kind in self.kinds


@dataclass(frozen=True)
class EditRecipe:
    caption: CaptionTreatment
    look: LookTreatment = LookTreatment()
    pacing: PacingRule = PacingRule()
    source: SourcePolicy = SourcePolicy()


_BASE_RECIPES: dict[str, EditRecipe] = {
    # Meme-caption treatment: oversized, heavy white type with a hard black
    # stroke and no panel so reactions and punchlines stay visually punchy.
    "funny": EditRecipe(caption=CaptionTreatment(
        fontname="Archivo Black", font=86, outline=4, shadow=3,
        primary="&H00FFFFFF&", highlight="&H0000D7FF&", outline_color="&H00000000&",
        back_color="&HA0000000&", border_style=1, bold=0, italic=0,
        spacing=0, group=4, margin_v=220,
    ), look=LookTreatment(scrim=0.3)),
    # Calm, editorial type: lighter weight, warm emphasis, and longer thought
    # groups suit claims and serious dialogue without meme-like treatment.
    "serious": EditRecipe(caption=CaptionTreatment(
        fontname="Barlow", font=64, outline=2, shadow=2,
        primary="&H00F4F5F7&", highlight="&H00D6A56A&", outline_color="&H00201810&",
        back_color="&HA8000000&", border_style=1, bold=-1, italic=0,
        spacing=0, group=6, margin_v=250,
    ), look=LookTreatment(scrim=0.34)),
    # A readable learning label: medium-bold sans with a restrained dark box
    # and cool highlight to maintain contrast over both light and dark footage.
    "educational": EditRecipe(caption=CaptionTreatment(
        fontname="Barlow", font=68, outline=3, shadow=2,
        primary="&H00F1F2F4&", highlight="&H0077D6FF&", outline_color="&H00101010&",
        back_color="&HA0000000&", border_style=1, bold=-1, italic=0,
        spacing=0, group=6, margin_v=245,
    ), look=LookTreatment(scrim=0.34)),
    # Fast, kinetic hook treatment: compact groups, italic type, and a blue
    # edge/highlight distinguish it from Funny's white-on-black meme look.
    "hype": EditRecipe(caption=CaptionTreatment(
        fontname="Anton", font=80, outline=3, shadow=3,
        primary="&H00FFFFFF&", highlight="&H0048B8FF&", outline_color="&H00301008&",
        back_color="&HA0000000&", border_style=1, bold=0, italic=0,
        spacing=2, group=3, margin_v=210,
    ), look=LookTreatment(scrim=0.3)),
}

DEFAULT_STYLE = "educational"

# Per-format deltas merged over the base recipe. Long form is explicitly
# authored; short sizing is applied by the renderer after canvas scaling so
# legacy callers that omit content_format keep their original treatment.
_FORMAT_OVERRIDES: dict[str, dict[str, Mapping[str, Any]]] = {
    "short": {},
    # Long form is watched further from the screen and reads as a speech edit:
    # heavier, uppercase, tighter tracking, longer thought groups. Casing is a
    # render treatment only — write_caption_sidecars keeps the true transcript.
    "long": {
        # Desaturated and contrastier with a soft vignette: the motivational
        # register the long-form request described.
        "serious": {
            "caption": {"uppercase": True, "font": 68, "group": 7, "spacing": 1},
            "look": {"contrast": 1.12, "saturation": 0.82, "vignette": 0.6283, "grain": 0.03, "scrim": 0.38, "punch_in": 1.05},
        },
        # Punchier and more saturated, stronger vignette.
        "hype": {
            "caption": {"uppercase": True, "font": 84, "group": 3, "spacing": 3},
            "look": {"contrast": 1.14, "saturation": 1.22, "vignette": 0.7854, "scrim": 0.38, "punch_in": 1.08},
        },
        # Warmer and brighter; keeps the meme energy without a grade that fights it.
        "funny": {
            "caption": {"font": 88, "group": 4},
            "look": {"contrast": 1.05, "saturation": 1.12, "gamma": 1.04, "scrim": 0.38},
        },
        # Deliberately neutral: an explainer should not be graded at all.
        "educational": {"caption": {"font": 70, "group": 7}, "look": {"scrim": 0.34}},
    },
}


def known_styles() -> tuple[str, ...]:
    return tuple(_BASE_RECIPES)


def recipe_for(style: str | None, content_format: str | None = None) -> EditRecipe:
    """The recipe for a mode, with any per-format delta applied.

    An unknown style resolves to the default rather than raising: a job may
    hold a value written by a newer build, and a render is a worse thing to
    lose than an exact treatment.
    """
    base = _BASE_RECIPES.get(style or "", _BASE_RECIPES[DEFAULT_STYLE])
    delta = _FORMAT_OVERRIDES.get(content_format or "", {}).get(style or "")
    if not delta:
        return base
    caption = replace(base.caption, **dict(delta.get("caption", {})))
    look = replace(base.look, **dict(delta.get("look", {})))
    pacing = replace(base.pacing, **dict(delta.get("pacing", {})))
    source = replace(base.source, **dict(delta.get("source", {})))
    return EditRecipe(caption=caption, look=look, pacing=pacing, source=source)


def caption_preset(style: str | None, content_format: str | None = None) -> dict[str, Any]:
    """The recipe's caption treatment in the legacy preset shape.

    `write_ass` and its tests read a plain mapping; keeping that projection
    means the recipe table became the single source of truth without touching
    a single caller.
    """
    caption = recipe_for(style, content_format).caption
    return {
        "fontname": caption.fontname, "font": caption.font, "outline": caption.outline,
        "shadow": caption.shadow, "primary": caption.primary, "highlight": caption.highlight,
        "outline_color": caption.outline_color, "back_color": caption.back_color,
        "border_style": caption.border_style, "bold": caption.bold, "italic": caption.italic,
        "spacing": caption.spacing, "group": caption.group, "margin_v": caption.margin_v,
        "uppercase": caption.uppercase,
    }
