"""Every caption face a preset names must actually be installed.

Without this the failure mode is invisible: libass substitutes DejaVu Sans for
a missing family and emboldens it synthetically, so all four styles render in
one smeared face and the output merely looks cheap. These tests turn that into
a reportable fault.
"""
from __future__ import annotations

import shutil

import pytest

from engine.media import _SUBTITLE_PRESETS, caption_font_mismatches, resolve_font_family

REQUESTED = sorted({str(preset["fontname"]) for preset in _SUBTITLE_PRESETS.values()})


def _require_fontconfig() -> None:
    """Skip where fontconfig is absent, the way the ffmpeg-gated smoke tests do."""
    if not shutil.which("fc-match"):
        pytest.skip("requires fontconfig (fc-match)")


def test_presets_name_the_vendored_display_faces() -> None:
    # Guards the preset table itself, so a face can never be referenced before
    # it is vendored and installed. Runs without fontconfig.
    assert set(REQUESTED) == {"Anton", "Archivo Black", "Barlow"}


@pytest.mark.parametrize("requested", REQUESTED)
def test_each_caption_face_resolves_to_itself(requested: str) -> None:
    _require_fontconfig()
    resolved = resolve_font_family(requested)
    families = {part.strip().casefold() for part in resolved.split(",") if part.strip()}
    assert requested.casefold() in families, (
        f"{requested!r} resolved to {resolved!r}: the font is not installed in this image, "
        "so captions would silently render in a substituted face"
    )


def test_no_caption_face_is_silently_substituted() -> None:
    _require_fontconfig()
    assert caption_font_mismatches() == {}


def test_a_face_that_does_not_exist_is_reported_rather_than_accepted() -> None:
    # Proves the probe can actually fail: fontconfig always returns *something*,
    # so the check has to compare families rather than trust a non-empty answer.
    _require_fontconfig()
    resolved = resolve_font_family("S6 Cut Definitely Not Installed")
    assert resolved, "fontconfig substitutes rather than returning nothing"
    assert "s6 cut definitely not installed" not in resolved.casefold()


def test_styles_using_a_real_heavy_face_do_not_ask_for_synthetic_bold() -> None:
    # Archivo Black and Anton are already black/heavy; bold: -1 on top of them
    # makes libass embolden a heavy face again and smears the outline.
    for style in ("funny", "hype"):
        preset = _SUBTITLE_PRESETS[style]
        assert preset["bold"] == 0, f"{style} double-bolds {preset['fontname']}"
