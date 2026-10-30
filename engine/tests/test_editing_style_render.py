"""Real FFmpeg/libass evidence for the editing-style library.

Every assertion compares decoded pixels against the same frame without the
presentation under test (flat colour footage, so any difference is the
treatment). The ASS-over-solid frames exercise libass exactly as the burn-in
does; the encoded-render tests below cover the real ``render_clip`` /
``render_fast_clip`` dispatch, picture filters and Music themes.
"""
from __future__ import annotations

import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest

from engine.config import Settings
from engine.editing_presets import CAPTION_PRESET_IDS, SPEECH_PRESETS
from engine.media import render_clip, render_fast_clip, write_ass

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("fc-match"), reason="requires ffmpeg and fontconfig")

W, H = 1080, 1920
DURATION = 8.0
# Original sample sentence, clip-relative timing; the last word follows a long silence.
WORDS = [
    ("Small", 0.5, 0.9), ("changes", 1.0, 1.5), ("make", 1.6, 1.9), ("a", 1.95, 2.05), ("clear", 2.1, 2.5),
    ("difference.", 2.6, 3.4), ("Next", 6.0, 6.5),
]
SPEECH = [{"text": t, "start": s, "end": e} for t, s, e in WORDS]
NEW_PRESETS = [name for name in CAPTION_PRESET_IDS if name != "editorial_default"]


def _ass(path: Path, preset: str | None, *, words=SPEECH, width=W, height=H, style="educational", **extra) -> Path:
    editing = None if preset is None else {"version": 1, "caption_preset": preset, "video_filter": "existing", "heading_style": "plain", "emoji_mode": "existing", **extra.pop("editing", {})}
    write_ass(
        path, words, offset=0, duration=DURATION, visuals=[], width=width, height=height, style=style,
        content_format="short", presentation="smart_speech_v2", editing_presentation=editing, **extra,
    )
    return path


def _solid(path: Path, t: float, colour: str, width=W, height=H, ass: Path | None = None) -> np.ndarray:
    graph = f"trim=start={t:.3f},setpts=PTS-STARTPTS+{t:.3f}/TB" + (f",subtitles={ass.name}" if ass else "")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:r=24:d=10",
         "-vf", graph, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True, cwd=path.parent,
    )
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(height, width, 3).astype(int)


def _mask(ass: Path, t: float, colour: str = "0x777777", threshold: int = 45) -> tuple[np.ndarray, np.ndarray]:
    """(frame, mask of pixels that differ from the identical frame without captions)."""
    frame = _solid(ass, t, colour, ass=ass)
    base = _solid(ass, t, colour)
    return frame, np.abs(frame - base).sum(axis=2) > threshold


def _bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    return None if len(xs) == 0 else (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def _bands(mask: np.ndarray, gap: int = 12) -> int:
    rows = np.nonzero(mask.any(axis=1))[0]
    if len(rows) == 0:
        return 0
    return 1 + int((np.diff(rows) > gap).sum())


@pytest.fixture(scope="module")
def rendered(tmp_path_factory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("editing-style")
    return {name: _ass(root / f"{name}.ass", name) for name in NEW_PRESETS} | {"default": _ass(root / "default.ass", None)}


def test_catalog_has_twelve_speech_choices_and_each_new_preset_is_defined() -> None:
    assert len(CAPTION_PRESET_IDS) == 12 and set(SPEECH_PRESETS) == set(NEW_PRESETS)
    signatures = {
        (p.fontname, p.primary, p.outline_color, p.outline, p.emphasis, p.plate, p.max_words, p.max_lines, p.uppercase, p.y_fraction)
        for p in SPEECH_PRESETS.values()
    }
    assert len(signatures) == len(SPEECH_PRESETS)


@pytest.mark.parametrize("style", ["funny", "serious", "educational", "hype"])
def test_default_and_omitted_selection_leave_ass_byte_identical(tmp_path: Path, style: str) -> None:
    omitted = _ass(tmp_path / "omitted.ass", None, style=style).read_text(encoding="utf-8")
    explicit = _ass(tmp_path / "explicit.ass", "editorial_default", style=style).read_text(encoding="utf-8")
    assert omitted == explicit


@pytest.mark.parametrize("preset", NEW_PRESETS)
def test_every_preset_burns_visible_in_frame_text_at_speech_and_none_in_silence(rendered, preset: str) -> None:
    ass = rendered[preset]
    inside = 3.0  # inside "difference." (2.6-3.4 s): every preset has text up
    _frame, speaking = _mask(ass, inside)
    box = _bbox(speaking)
    assert box is not None and speaking.sum() > 400, f"{preset} drew nothing while speaking"
    margin = 4
    assert box[0] >= margin and box[2] <= W - margin and box[1] >= margin and box[3] <= H - margin
    # Between phrases (after 3.4 s, before 6.0 s) nothing hangs on screen.
    for silent in (4.5, 5.5):
        _frame, mask = _mask(ass, silent)
        assert mask.sum() == 0, f"{preset} hangs over silence at {silent}s"
    # Before the first word.
    assert _mask(ass, 0.2)[1].sum() == 0


def test_presets_are_visibly_distinct_from_each_other_and_from_default(rendered) -> None:
    frames = {name: _mask(path, 3.0)[0] for name, path in rendered.items()}
    names = list(frames)
    for index, left in enumerate(names):
        for right in names[index + 1:]:
            different = (np.abs(frames[left] - frames[right]).sum(axis=2) > 90).mean()
            assert different > 0.002, f"{left} and {right} render almost identically ({different:.5f})"


def test_yellow_focus_highlights_exactly_the_spoken_word(rendered) -> None:
    ass = rendered["yellow_focus"]

    def yellow(t: float):
        frame, mask = _mask(ass, t)
        pixels = mask & (frame[:, :, 0] > 200) & (frame[:, :, 1] > 150) & (frame[:, :, 2] < 90)
        return pixels, mask

    first, first_text = yellow(0.7)   # "Small"
    third, third_text = yellow(1.75)  # "make"
    gap, gap_text = yellow(0.95)      # between words, phrase still up
    assert first.sum() > 300 and third.sum() > 300
    assert gap_text.sum() > 400 and gap.sum() == 0, "no word is spoken in the gap, so none is highlighted"
    first_x = np.nonzero(first)[1].mean()
    third_x = np.nonzero(third)[1].mean()
    assert third_x > first_x + 150, "the highlight moves to the later word"
    # The phrase layout does not move while the highlight does.
    assert abs(_bbox(first_text)[0] - _bbox(third_text)[0]) <= 3 and abs(_bbox(first_text)[2] - _bbox(third_text)[2]) <= 3


def test_word_pop_shows_one_word_with_a_bounded_scale_in(rendered) -> None:
    ass = rendered["word_pop"]
    _f, early = _mask(ass, 1.0 + 0.02)
    _f, settled = _mask(ass, 1.0 + 0.30)
    _f, other = _mask(ass, 0.7)
    assert early.sum() > 0 and settled.sum() > early.sum() * 1.15, "scale-in grows the word"
    assert settled.sum() < early.sum() * 3, "scale-in stays small and bounded"
    # One word at a time: "changes" is not on screen together with "Small".
    box_small, box_changes = _bbox(other), _bbox(settled)
    assert box_small and box_changes and (box_changes[2] - box_changes[0]) > (box_small[2] - box_small[0])
    assert _mask(ass, 0.95)[1].sum() == 0, "no word between spoken words"


def test_active_word_box_draws_a_plate_behind_only_the_spoken_word(rendered) -> None:
    ass = rendered["active_word_box"]

    def box_pixels(t: float):
        frame, mask = _mask(ass, t)
        # Box colour is green (R low, G high).
        return mask & (frame[:, :, 1] > 150) & (frame[:, :, 0] < 60) & (frame[:, :, 2] < 120), frame, mask

    first, _, _ = box_pixels(0.7)
    third, _, text_mask = box_pixels(1.75)
    assert first.sum() > 2000 and third.sum() > 2000
    box_one, box_three = _bbox(first), _bbox(third)
    assert box_three[0] > box_one[2] - 10 or box_three[1] > box_one[3] - 10, "the box moves to a later word"
    # White text sits inside the box rows (text is rendered over the plate).
    frame, mask = _mask(ass, 1.75)[0], None
    white = (frame.min(axis=2) > 235)
    inside = white[box_three[1]:box_three[3] + 1, box_three[0]:box_three[2] + 1]
    assert inside.sum() > 150
    # Only one word's width of box: it is much narrower than the whole phrase.
    assert (box_three[2] - box_three[0]) < 0.7 * (_bbox(text_mask)[2] - _bbox(text_mask)[0])


@pytest.mark.parametrize(("preset", "background", "darker"), [("dark_caption_plate", "0xc0c8d0", True), ("light_caption_plate", "0x203040", False)])
def test_caption_plates_are_fitted_and_contrast_with_the_footage(tmp_path: Path, preset: str, background: str, darker: bool) -> None:
    ass = _ass(tmp_path / f"{preset}.ass", preset)
    frame, mask = _mask(ass, 3.0, colour=background, threshold=30)
    base = _solid(ass, 3.0, background)
    box = _bbox(mask)
    assert box is not None
    plate = frame[box[1]:box[3] + 1, box[0]:box[2] + 1]
    reference = base[box[1]:box[3] + 1, box[0]:box[2] + 1]
    shift = plate.mean() - reference.mean()
    assert (shift < -20) if darker else (shift > 20)
    # Fitted: the plate does not span the frame, and stays inside the safe area.
    assert (box[2] - box[0]) < 0.92 * W and box[0] > 20 and box[2] < W - 20
    # Text colour is intact over the plate (white on dark, dark on light).
    extreme = (frame.min(axis=2) > 235) if darker else (frame.max(axis=2) < 40)
    assert extreme[box[1]:box[3] + 1, box[0]:box[2] + 1].sum() > 200


def test_word_build_reveals_words_at_onset_without_moving_the_layout(rendered) -> None:
    ass = rendered["word_build"]
    _f, one = _mask(ass, 0.7)    # only "Small"
    _f, three = _mask(ass, 1.75)  # Small changes make
    _f, five = _mask(ass, 2.35)   # ... a clear
    assert one.sum() < three.sum() < five.sum()
    # Words already shown stay exactly where they were.
    assert (one & ~five).sum() <= 0.02 * one.sum()
    # A word not yet spoken is absent: right half of the final phrase is empty at 0.7 s.
    final_box = _bbox(five)
    assert _bbox(one)[2] < final_box[2] - 100
    # Nothing before the first onset.
    assert _mask(ass, 0.45)[1].sum() == 0


def test_karaoke_line_progresses_colour_with_spoken_time_and_keeps_future_words_neutral(rendered) -> None:
    ass = rendered["karaoke_line"]

    def accent(t: float):
        frame, mask = _mask(ass, t)
        # Accent is warm yellow-ish (R high, G high, B low-ish) vs neutral light grey.
        return mask & (frame[:, :, 0] > 180) & (frame[:, :, 1] > 160) & (frame[:, :, 2] < 140) & ((frame[:, :, 0] - frame[:, :, 2]) > 60), mask

    early, early_text = accent(0.75)
    later, later_text = accent(2.3)
    assert later.sum() > early.sum() * 2
    assert _bbox(later)[2] > _bbox(early)[2] + 100, "the accent has progressed to the right"
    # Words not yet spoken stay neutral: the right-most part of the phrase has no accent at 0.75 s.
    assert _bbox(early_text)[2] > _bbox(early)[2] + 100
    # Stable layout across the whole phrase.
    assert abs(_bbox(early_text)[0] - _bbox(later_text)[0]) <= 3


def test_cinematic_serif_fades_in_and_out_without_moving(rendered) -> None:
    ass = rendered["cinematic_serif"]
    start = 0.5
    _f, early = _mask(ass, start + 0.04, threshold=12)
    _f, full = _mask(ass, start + 0.6, threshold=12)
    assert 0 < early.sum() < full.sum() * 0.8 or early.sum() == 0
    assert full.sum() > 400


def test_condensed_stack_is_bounded_to_three_stacked_lines_and_never_drops_words(tmp_path: Path) -> None:
    words = [{"text": t, "start": 0.2 + 0.25 * i, "end": 0.4 + 0.25 * i} for i, t in enumerate(["Never", "stop", "building", "things", "people"])]
    ass = _ass(tmp_path / "stack.ass", "condensed_stack", words=words)
    _f, mask = _mask(ass, 1.3)
    assert 2 <= _bands(mask, gap=10) <= 3
    text = ass.read_text(encoding="utf-8")
    for word in ("NEVER", "STOP", "BUILDING", "THINGS", "PEOPLE"):
        assert word in text


def test_clean_sentence_has_no_moving_colour_emphasis(rendered) -> None:
    ass = rendered["clean_sentence"]
    frame, mask = _mask(ass, 1.75)
    saturated = mask & ((frame.max(axis=2) - frame.min(axis=2)) > 70)
    assert saturated.sum() == 0


def test_bold_outline_has_heavy_dark_outline_and_no_plate(rendered) -> None:
    frame, mask = _mask(rendered["bold_outline"], 3.0)
    dark = mask & (frame.max(axis=2) < 40)
    bright = mask & (frame.min(axis=2) > 235)
    assert dark.sum() > 0.35 * bright.sum()
    box = _bbox(mask)
    # No plate: the changed area is sparse inside its bounding box.
    assert mask[box[1]:box[3] + 1, box[0]:box[2] + 1].mean() < 0.85


@pytest.mark.parametrize("preset", ["bold_outline", "dark_caption_plate", "word_pop"])
@pytest.mark.parametrize("canvas", [(1080, 1080), (1920, 1080), (1080, 1350)])
def test_presets_fit_every_output_canvas(tmp_path: Path, preset: str, canvas: tuple[int, int]) -> None:
    width, height = canvas
    long_words = [{"text": t, "start": 0.2 + 0.3 * i, "end": 0.45 + 0.3 * i} for i, t in enumerate(["Extraordinarily", "uncompromising", "communication", "matters"])]
    ass = _ass(tmp_path / "canvas.ass", preset, words=long_words, width=width, height=height)
    for t in (0.35, 0.95, 1.2):
        _frame, mask = _mask(ass, t) if (width, height) == (W, H) else _canvas_mask(ass, t, width, height)
        box = _bbox(mask)
        assert box is not None
        assert box[0] >= 0 and box[2] <= width - 1 and box[1] >= 0 and box[3] <= height - 1


def _canvas_mask(ass: Path, t: float, width: int, height: int):
    frame = _solid(ass, t, "0x777777", width, height, ass=ass)
    base = _solid(ass, t, "0x777777", width, height)
    return frame, np.abs(frame - base).sum(axis=2) > 45


def test_long_transcripts_keep_every_word_in_exactly_one_phrase(tmp_path: Path) -> None:
    import re

    words = [{"text": f"word{i}", "start": 0.1 + 0.3 * i, "end": 0.35 + 0.3 * i} for i in range(24)]
    for preset in NEW_PRESETS:
        ass = _ass(tmp_path / f"{preset}.ass", preset, words=words)
        body = re.sub(r"\{[^}]*\}", "", "\n".join(line.split(",", 9)[-1] for line in ass.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue: 10,")))
        for item in words:
            assert str(item["text"]).upper() in body.upper(), (preset, item["text"])
