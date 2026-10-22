"""Every caption face a preset names must actually be installed.

Without this the failure mode is invisible: libass substitutes DejaVu Sans for
a missing family and emboldens it synthetically, so all four styles render in
one smeared face and the output merely looks cheap. These tests turn that into
a reportable fault.
"""
from __future__ import annotations

import shutil
import subprocess

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


@pytest.mark.parametrize("face", [False, True])
@pytest.mark.parametrize("failure", ["timeout", "empty", "exit"])
def test_font_lookup_recovers_after_transient_failure(monkeypatch, face, failure):
    from engine import media

    calls = []
    def lookup(command, **kwargs):
        calls.append(command)
        if len(calls) == 1:
            if failure == "timeout":
                raise subprocess.TimeoutExpired(command, 10)
            return subprocess.CompletedProcess(command, 1 if failure == "exit" else 0, stdout="")
        return subprocess.CompletedProcess(command, 0, stdout="QA Font|Black" if face else "QA Font")

    media._fontconfig_output.cache_clear()
    monkeypatch.setattr(media.subprocess, "run", lookup)
    resolve = lambda: media.resolve_font_face("QA Font", "Black") if face else media.resolve_font_family("QA Font")
    try:
        assert resolve() == ""
        expected = "QA Font|Black" if face else "QA Font"
        assert resolve() == expected
        assert resolve() == expected
        assert len(calls) == 2
    finally:
        media._fontconfig_output.cache_clear()


# --- Music typography faces ---------------------------------------------------

ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]


def test_music_faces_are_vendored_with_licences_and_matching_checksums() -> None:
    import hashlib
    import json

    provenance = {entry["name"]: entry for entry in json.loads((ROOT / "third_party_provenance.json").read_text())["runtimeComponents"]}
    for name, relative in (("Oswald Regular", "engine/fonts/oswald/Oswald-Regular.ttf"), ("Gaegu Bold", "engine/fonts/gaegu/Gaegu-Bold.ttf")):
        entry = provenance[name]
        assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == entry["sha256"]
        assert "45e3d5269e4a17d823f6d84470bc084dc5ae46f6" in entry["source"] and entry["licence"].startswith("SIL Open Font")
        assert (ROOT / entry["licenceFile"]).is_file()
        for vendored in entry["vendoredAt"].split("; "):
            assert (ROOT / vendored).is_file(), vendored


def test_oswald_is_a_static_regular_instance_so_libass_never_picks_an_axis() -> None:
    data = (ROOT / "engine/fonts/oswald/Oswald-Regular.ttf").read_bytes()
    assert b"fvar" not in data[:2048] and b"gvar" not in data[:2048]


def test_roboto_condensed_still_has_only_the_light_face() -> None:
    # A Regular face under the same family would silently change every
    # existing reference render, which request weight 400 and get Light.
    assert sorted(path.name for path in (ROOT / "engine/fonts/roboto_condensed").glob("*.ttf")) == ["RobotoCondensed-Light.ttf"]


def test_music_exact_faces_resolve_in_fontconfig() -> None:
    _require_fontconfig()
    from engine.media import MUSIC_EXACT_FACES, resolve_font_face

    for family, requested_style, expected_style in MUSIC_EXACT_FACES:
        face = resolve_font_face(family, requested_style)
        families, _, style = face.partition("|")
        assert family.casefold() in {part.strip().casefold() for part in families.split(",")}, face
        assert style.split(",")[0].strip().casefold() == expected_style.casefold(), face


def test_libass_selects_the_vendored_music_font_files(tmp_path) -> None:
    _require_fontconfig()
    if not shutil.which("ffmpeg"):
        pytest.skip("requires ffmpeg")
    from engine.media import write_music_ass

    selected: dict[str, str] = {}
    for theme, family in (("condensed_black", "Oswald"), ("handwritten_stack", "Gaegu"), ("reference_white_sans", "Roboto Condensed"), ("reference_white_serif", "Bodoni Moda"), ("serif", "Lora")):
        ass = tmp_path / f"{theme}.ass"
        write_music_ass(ass, [{"text": "Hello", "start": 0.0, "end": 0.8}], offset=0, duration=1, width=1080, height=1920, subtitle_theme=theme)
        result = subprocess.run(
            ["ffmpeg", "-v", "info", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=1", "-vf", f"subtitles={ass}", "-frames:v", "1", "-f", "null", "-"],
            capture_output=True, text=True, check=True,
        )
        lines = [line for line in result.stderr.splitlines() if "fontselect:" in line and f"({family}," in line]
        assert lines, f"libass never selected {family} for {theme}"
        selected[family] = lines[-1]
    assert "/oswald/Oswald-Regular.ttf" in selected["Oswald"]
    assert "/gaegu/Gaegu-Bold.ttf" in selected["Gaegu"]
    assert "RobotoCondensed-Light.ttf" in selected["Roboto Condensed"]
    assert "BodoniModa-Variable.ttf" in selected["Bodoni Moda"] and "Lora.ttf" in selected["Lora"]
