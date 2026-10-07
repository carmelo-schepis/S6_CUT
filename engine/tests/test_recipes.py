"""The recipe table is the single definition of what a style means.

Phase 1 is a refactor with no visual change, so most of these assert that the
new structure still describes exactly today's output: identity looks, the same
caption values, and a legacy preset projection that callers cannot tell apart
from the dict it replaced.
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from engine.media import _SUBTITLE_PRESETS, _subtitle_preset
from engine.recipes import (
    DEFAULT_STYLE,
    CaptionTreatment,
    EditRecipe,
    LookTreatment,
    PacingRule,
    SourcePolicy,
    caption_preset,
    known_styles,
    recipe_for,
)

PRESET_KEYS = {
    "fontname", "font", "outline", "shadow", "primary", "highlight", "outline_color",
    "back_color", "border_style", "bold", "italic", "spacing", "group", "margin_v",
    "uppercase",
}


def test_the_four_shipped_styles_have_recipes() -> None:
    assert set(known_styles()) == {"funny", "serious", "educational", "hype"}


def test_the_base_recipes_are_ungraded_but_still_legible() -> None:
    """Shorts add no picture filter, yet no longer rely on an opaque panel.

    The scrim is drawn by libass rather than by a filter, so a short costs the
    same to render as it did before the caption panel was removed while still
    keeping text readable over unpredictable footage.
    """
    for style in known_styles():
        look = recipe_for(style).look
        assert not look.has_picture_filters(), f"{style} shorts would be graded"
        assert look.punch_in == 1.0, f"{style} shorts would zoom"
        assert look.scrim > 0.0, f"{style} shorts lost the panel with nothing replacing it"


def test_an_unknown_style_falls_back_rather_than_raising() -> None:
    # A job may hold a value written by a newer build; losing the render is
    # worse than losing the exact treatment.
    assert recipe_for("no-such-style") == recipe_for(DEFAULT_STYLE)
    assert recipe_for(None) == recipe_for(DEFAULT_STYLE)
    assert recipe_for("") == recipe_for(DEFAULT_STYLE)


def test_the_legacy_preset_projection_matches_the_recipe() -> None:
    for style in known_styles():
        preset = caption_preset(style)
        caption = recipe_for(style).caption
        assert set(preset) == PRESET_KEYS
        assert preset["fontname"] == caption.fontname
        assert preset["font"] == caption.font
        assert preset["border_style"] == caption.border_style
        # And the module-level table callers still read is that same projection.
        assert _SUBTITLE_PRESETS[style] == preset
        assert _subtitle_preset(style) == preset


def test_shorts_use_the_base_recipe_and_long_form_overrides_it() -> None:
    # Shorts are the base treatment; long form is where the speech-edit look
    # lives, so every mode must actually differ there rather than inheriting.
    for style in known_styles():
        assert recipe_for(style, "short") == recipe_for(style), f"{style} shorts drifted from the base"
        assert recipe_for(style, "long") != recipe_for(style), f"{style} long form is not differentiated"


def test_long_form_grades_differ_while_the_explainer_stays_ungraded() -> None:
    looks = {style: recipe_for(style, "long").look for style in known_styles()}

    # The explainer is deliberately ungraded — no contrast, saturation,
    # vignette or grain — but it still gets the scrim, because legibility over
    # unpredictable footage is not a look, it is what the old opaque caption
    # panel was actually for.
    explainer = looks["educational"]
    assert (explainer.contrast, explainer.saturation, explainer.gamma) == (1.0, 1.0, 1.0)
    assert explainer.vignette is None and explainer.grain == 0.0
    assert explainer.scrim > 0.0

    # Every long-form mode carries the scrim, and the graded modes are each
    # visibly different from one another.
    assert all(look.scrim > 0.0 for look in looks.values()), "a long-form mode lost its scrim"
    signatures = {(look.contrast, look.saturation, look.gamma, look.vignette, look.grain) for look in looks.values()}
    assert len(signatures) == len(looks), "two long-form modes grade identically"


def test_uppercase_is_a_long_form_treatment_only() -> None:
    # The sidecars keep true casing; this only affects what is burned in.
    for style in known_styles():
        assert recipe_for(style, "short").caption.uppercase is False
    assert recipe_for("serious", "long").caption.uppercase is True
    assert recipe_for("hype", "long").caption.uppercase is True


def test_styles_stay_mutually_distinct_per_format() -> None:
    for content_format in ("short", "long"):
        captions = {style: caption_preset(style, content_format) for style in known_styles()}
        rendered = {tuple(sorted(value.items())) for value in captions.values()}
        assert len(rendered) == len(captions), f"two styles look identical in {content_format} form"


def test_recipes_are_immutable() -> None:
    # Frozen so a caller cannot quietly retune one mode for everybody.
    recipe = recipe_for("funny")
    with pytest.raises(FrozenInstanceError):
        recipe.caption.font = 10  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        recipe.look.contrast = 2.0  # type: ignore[misc]


def test_a_look_is_not_identity_once_anything_is_asked_for() -> None:
    assert LookTreatment().is_identity()
    assert not LookTreatment(punch_in=1.06).is_identity()
    assert not LookTreatment(contrast=1.1).is_identity()
    assert not LookTreatment(vignette=0.6).is_identity()
    assert not LookTreatment(grain=0.4).is_identity()


def test_grain_carries_a_pinned_seed() -> None:
    # Window planning is deterministic and the look chain must not undo that.
    assert isinstance(LookTreatment().grain_seed, int)
    assert LookTreatment().grain_seed == LookTreatment().grain_seed


def test_source_policy_accepts_clip_source_kinds() -> None:
    policy = SourcePolicy()
    for kind in ("upload", "youtube"):
        assert policy.accepts(kind)
    assert not policy.accepts("script")
    assert not policy.accepts("archival")
    for style in known_styles():
        assert recipe_for(style).source.accepts("youtube")


def test_a_recipe_needs_only_a_caption_to_be_valid() -> None:
    recipe = EditRecipe(caption=CaptionTreatment(
        fontname="Barlow", font=60, outline=3, shadow=1, primary="&H00FFFFFF&",
        highlight="&H0077D6FF&", outline_color="&H00101010&", back_color="&H00000000&",
        border_style=1, bold=0, italic=0, spacing=0, group=5, margin_v=200,
    ))
    assert recipe.look == LookTreatment()
    assert recipe.pacing == PacingRule()
    assert recipe.source == SourcePolicy()
