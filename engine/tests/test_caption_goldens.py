"""Golden frames for burned-in captions.

A caption change is a visual change, and a visual change that nobody looks at
is a regression waiting to ship. These render the real ASS pipeline through
libass onto a fixed canvas and compare the result with a committed frame, so
every typography change shows up as an intentional, reviewable diff instead of
a number moving in a preset.

Regenerate deliberately, never to make a red test green:

    S6_UPDATE_CAPTION_GOLDENS=1 python -m pytest engine/tests/test_caption_goldens.py

then look at the changed PNGs before committing them.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.media import write_ass
from engine.recipes import known_styles

GOLDEN_DIR = Path(__file__).parent / "goldens" / "captions"
# The two canvases the complaint is about: a short and the long-form frame.
CANVASES = {"9x16": (1080, 1920, "short"), "16x9": (1920, 1080, "long")}
# Goldens are stored downscaled: caption face, weight, size, colour, box and
# placement all survive it, while the files stay small enough to review in a
# diff. Full-size frames would be megabytes each.
GOLDEN_WIDTH = 480
# PSNR in dB against the golden. An identical render reports inf; encoder drift
# between builds stays far above this floor, while a real caption change lands
# around 20-40 dB (two different styles on the same canvas measure ~21).
MIN_PSNR_DB = 45.0

WORDS = [
    {"text": text, "start": index * 0.4, "end": index * 0.4 + 0.39, "confidence": 0.99}
    for index, text in enumerate(["Stay", "hungry,", "stay", "foolish"])
]


def _require_tools() -> None:
    """Skip cleanly where the media tools are absent, per DO-NOT-CHANGE §9."""
    missing = [name for name in ("ffmpeg", "fc-match") if not shutil.which(name)]
    if missing:
        pytest.skip(f"requires {' and '.join(missing)}")


def _render(tmp_path: Path, style: str, canvas: str) -> Path:
    width, height, content_format = CANVASES[canvas]
    ass = tmp_path / f"{style}-{canvas}.ass"
    write_ass(
        ass, WORDS, offset=0.0, duration=1.6, visuals=[], width=width, height=height,
        style=style, content_format=content_format,
    )
    frame = tmp_path / f"{style}-{canvas}.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x101418:s={width}x{height}:d=1.6",
         "-vf", f"subtitles={ass},scale={GOLDEN_WIDTH}:-1:flags=lanczos", "-frames:v", "1", "-ss", "0.6",
         str(frame), "-y"],
        check=True, capture_output=True,
    )
    return frame


def _psnr(left: Path, right: Path) -> float:
    """PSNR in dB between two frames; inf when they are byte-identical.

    ffmpeg reports this on stderr, so it is read from there. An earlier version
    of this helper parsed a metadata filter that printed nothing, silently
    scored every comparison as a perfect match and made the whole suite
    decorative — hence the explicit parse failure below.
    """
    result = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(left), "-i", str(right), "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    )
    matches = re.findall(r"average:([0-9.]+|inf)", result.stderr)
    if not matches:
        raise AssertionError(f"could not read a PSNR from ffmpeg: {result.stderr[-400:]}")
    return float("inf") if matches[-1] == "inf" else float(matches[-1])


@pytest.mark.parametrize("canvas", sorted(CANVASES))
@pytest.mark.parametrize("style", sorted(known_styles()))
def test_caption_frame_matches_its_golden(tmp_path: Path, style: str, canvas: str) -> None:
    _require_tools()
    frame = _render(tmp_path, style, canvas)
    golden = GOLDEN_DIR / f"{style}-{canvas}.png"

    if os.environ.get("S6_UPDATE_CAPTION_GOLDENS"):
        golden.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(frame, golden)
        pytest.skip(f"regenerated {golden.name}")

    assert golden.is_file(), (
        f"no golden for {style} at {canvas}; regenerate with "
        "S6_UPDATE_CAPTION_GOLDENS=1 and review the frame before committing"
    )
    psnr = _psnr(frame, golden)
    assert psnr >= MIN_PSNR_DB, (
        f"{style} at {canvas} differs from its golden (PSNR {psnr:.1f} dB, floor {MIN_PSNR_DB}). "
        "If the change is intended, regenerate the goldens and review the frames."
    )


def test_every_style_and_canvas_has_a_golden() -> None:
    # Catches a style added without a golden, which would otherwise only fail
    # the first time someone happened to run the suite with ffmpeg installed.
    expected = {f"{style}-{canvas}.png" for style in known_styles() for canvas in CANVASES}
    missing = sorted(name for name in expected if not (GOLDEN_DIR / name).is_file())
    assert not missing, f"missing caption goldens: {missing}"
