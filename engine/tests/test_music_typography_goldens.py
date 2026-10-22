"""Golden frames for the Music typography themes, lyric motion and hook banner.

Separate from test_caption_goldens.py so the existing Speech and Music goldens
are never touched by this feature. Regenerate deliberately and review the PNGs:

    S6_UPDATE_CAPTION_GOLDENS=1 python -m pytest engine/tests/test_music_typography_goldens.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.media import write_music_ass
from engine.tests.test_caption_goldens import GOLDEN_DIR, GOLDEN_WIDTH, MIN_PSNR_DB, MUSIC_CANVASES, MUSIC_WORDS, _psnr, _require_tools

NEW_THEMES = ("condensed_black", "condensed_white", "handwritten_stack")
LYRICS = [
    ("do", 0.30, 0.60), ("you", 0.65, 0.90), ("think,", 0.95, 1.40),
    ("about", 1.50, 1.80), ("the", 1.85, 2.00), ("way", 2.05, 2.60),
]
MOTION_WORDS = [{"text": t, "start": s, "end": e, "confidence": 0.99} for t, s, e in LYRICS]
# (animation, sample time): fade-in midpoint, crossfade midpoint, partial word build.
MOTION_SAMPLES = {"slow_fade": 0.45, "line_crossfade": 1.80, "word_build": 0.80}
HOOK = "Hook text that wraps onto a second line for the white banner"


def _render(tmp_path: Path, name: str, canvas: str, sample: float, *, words, duration: float, **options) -> Path:
    width, height, _ = MUSIC_CANVASES[canvas]
    ass = tmp_path / f"{name}.ass"
    write_music_ass(ass, words, offset=0.0, duration=duration, width=width, height=height, **options)
    frame = tmp_path / f"{name}.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x101418:s={width}x{height}:d={duration}",
         "-vf", f"subtitles={ass},scale={GOLDEN_WIDTH}:-1:flags=lanczos", "-frames:v", "1", "-ss", str(sample), str(frame), "-y"],
        check=True, capture_output=True,
    )
    return frame


def _check(frame: Path, golden: Path, label: str) -> None:
    if os.environ.get("S6_UPDATE_CAPTION_GOLDENS"):
        golden.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(frame, golden)
        pytest.skip(f"regenerated {golden.name}")
    assert golden.is_file(), f"no golden for {label}; regenerate with S6_UPDATE_CAPTION_GOLDENS=1 and review the frame"
    psnr = _psnr(frame, golden)
    assert psnr >= MIN_PSNR_DB, f"{label} differs from its golden (PSNR {psnr:.1f} dB, floor {MIN_PSNR_DB})"


@pytest.mark.parametrize("canvas", sorted(MUSIC_CANVASES))
@pytest.mark.parametrize("theme", NEW_THEMES)
def test_new_theme_with_original_animation_matches_its_golden(tmp_path: Path, theme: str, canvas: str) -> None:
    _require_tools()
    frame = _render(tmp_path, f"{theme}-{canvas}", canvas, 1.0, words=MUSIC_WORDS, duration=2.0, top_text="Artist — Song", subtitle_theme=theme)
    _check(frame, GOLDEN_DIR / f"music-{theme}-{canvas}.png", f"Music {theme} at {canvas}")


@pytest.mark.parametrize("animation", sorted(MOTION_SAMPLES))
@pytest.mark.parametrize("theme", ("condensed_white", "handwritten_stack"))
def test_lyric_motion_frame_matches_its_golden(tmp_path: Path, theme: str, animation: str) -> None:
    _require_tools()
    frame = _render(tmp_path, f"{theme}-{animation}", "9x16", MOTION_SAMPLES[animation], words=MOTION_WORDS, duration=3.0, subtitle_theme=theme, lyric_animation=animation)
    _check(frame, GOLDEN_DIR / f"music-motion-{theme}-{animation}-9x16.png", f"{theme} {animation}")


@pytest.mark.parametrize("canvas", sorted(MUSIC_CANVASES))
def test_white_banner_frame_matches_its_golden(tmp_path: Path, canvas: str) -> None:
    _require_tools()
    frame = _render(tmp_path, f"banner-{canvas}", canvas, 0.5, words=[], duration=1.0, top_text=HOOK, subtitle_theme="clean", hook_text_format="white_banner", source_dimensions=(1920, 1080))
    _check(frame, GOLDEN_DIR / f"music-banner-{canvas}.png", f"white banner at {canvas}")


def test_every_typography_golden_exists() -> None:
    expected = {f"music-{theme}-{canvas}.png" for theme in NEW_THEMES for canvas in MUSIC_CANVASES}
    expected.update(f"music-motion-{theme}-{animation}-9x16.png" for theme in ("condensed_white", "handwritten_stack") for animation in MOTION_SAMPLES)
    expected.update(f"music-banner-{canvas}.png" for canvas in MUSIC_CANVASES)
    missing = sorted(name for name in expected if not (GOLDEN_DIR / name).is_file())
    assert not missing, f"missing typography goldens: {missing}"
