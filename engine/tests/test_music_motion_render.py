"""Real FFmpeg/libass evidence for Music lyric motion and the white hook banner.

Each render is compared with the same clip rendered without any text, so a
changing background can never masquerade as a fade. Source footage is a flat
colour, which makes the measured text opacity a linear ratio.
"""
from __future__ import annotations

import atexit
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from engine.config import Settings
from engine.media import render_clip, render_fast_clip

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("fc-match"), reason="requires ffmpeg and fontconfig")

WIDTH, HEIGHT = 1080, 1920
WORK = Path(tempfile.mkdtemp(prefix="s6-music-motion-"))
atexit.register(shutil.rmtree, WORK, ignore_errors=True)
BACKGROUND = np.array([0x20, 0x30, 0x40], dtype=float)
CLIP_START = 2.0  # non-zero offset: transcript words use source time
DURATION = 5.0
# Clip-local lyric timing: A and B are adjacent (crossfade), C follows a >1.2 s instrumental gap.
LOCAL = [
    ("do", 0.30, 0.60), ("you", 0.65, 0.90), ("think,", 0.95, 1.40),
    ("about", 1.50, 1.80), ("the", 1.85, 2.00), ("way", 2.05, 2.60),
    ("alone", 4.00, 4.60),
]
A_START, B_START, C_START = 0.30, 1.50, 4.00


def source_words() -> list[dict]:
    return [{"text": t, "start": CLIP_START + s, "end": CLIP_START + e} for t, s, e in LOCAL]


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings.from_env()


@lru_cache(maxsize=None)
def make_source(name: str, size: str, colour: str = "0x203040", duration: float = 9) -> Path:
    name = f"{name}-{colour}-{duration:g}"
    path = WORK / f"{name}.mp4"
    if not path.exists():
        subprocess.run([settings().ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s={size}:r=30:d={duration:g}", "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


@lru_cache(maxsize=None)
def render(key: str) -> Path:
    """Render one fixture; key encodes the variant so results are cached per module run."""
    parts = dict(item.split("=", 1) for item in key.split(";"))
    output = WORK / f"out-{abs(hash(key))}.mp4"
    long_clip = parts.get("long", "0") == "1"
    duration = float(parts.get("dur", DURATION))
    start = 0.0 if long_clip else CLIP_START
    source = make_source(parts.get("src", "wide"), parts.get("size", "1280x720"), parts.get("colour", "0x203040"), start + duration + 1 if long_clip else 9)
    text = parts.get("text", "1") == "1"
    kwargs: dict = dict(
        start=start, end=start + duration, aspect="9:16", settings=settings(), has_audio=False, content_format="short",
        subtitles_enabled=text, music_theme=parts.get("theme", "condensed_white"), music_treatment="color",
    )
    if parts.get("credit") == "1":
        kwargs["creator_credit"] = "Source: Controlled Creator"
    if "anim" in parts:
        kwargs["music_lyric_animation"] = parts["anim"]
    if "hook" in parts:
        kwargs["music_top_text"] = parts["hook"] or None
        kwargs["music_hook_text_format"] = parts.get("fmt", "white_banner")
    if "sub" in parts:
        kwargs["subscribe_animation"] = {"enabled": True, "version": 1, "short_form_lead_seconds": int(parts["sub"])}
    if parts.get("path", "clip") == "fast":
        render_fast_clip(source, output, words=[{"text": t, "start": s, "end": e} for t, s, e in LOCAL], **kwargs)
    else:
        render_clip(source, output, words=source_words(), visuals=[], overlays=[], **kwargs)
    return output


def frame(video: Path, seconds: float) -> np.ndarray:
    png = video.with_suffix(f".{int(seconds * 1000)}.png")
    subprocess.run([settings().ffmpeg, "-v", "error", "-y", "-ss", f"{seconds:.3f}", "-i", str(video), "-frames:v", "1", str(png)], check=True)
    return np.asarray(Image.open(png).convert("RGB"), dtype=float)


def key(**fields: str) -> str:
    return ";".join(f"{name}={value}" for name, value in fields.items())


def diff(video: Path, baseline: Path, seconds: float) -> np.ndarray:
    return np.abs(frame(video, seconds) - frame(baseline, seconds)).mean(axis=2)


def hold_mask(video: Path, baseline: Path, seconds: float, threshold: float = 60) -> np.ndarray:
    return diff(video, baseline, seconds) > threshold


def coverage(video: Path, baseline: Path, seconds: float, mask: np.ndarray, full: float) -> float:
    """Mean text opacity (0..1) inside ``mask`` at ``seconds``."""
    return float(diff(video, baseline, seconds)[mask].mean() / full)


def full_level(video: Path, baseline: Path, seconds: float, mask: np.ndarray) -> float:
    return float(diff(video, baseline, seconds)[mask].mean())


NO_TEXT = key(text="0", theme="condensed_white")


@pytest.fixture(scope="module")
def baseline() -> Path:
    return render(NO_TEXT)


def dilate(mask: np.ndarray, radius: int = 6) -> np.ndarray:
    out = mask.copy()
    for dy in range(-radius, radius + 1, 2):
        for dx in range(-radius, radius + 1, 2):
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def monotone(series: list[float], *, rising: bool, slack: float = 0.04) -> bool:
    pairs = zip(series, series[1:])
    return all((later >= earlier - slack) if rising else (later <= earlier + slack) for earlier, later in pairs)


@pytest.mark.parametrize("path", ["clip", "fast"])
def test_slow_fade_ramps_opacity_progressively_through_both_renderers(baseline: Path, path: str) -> None:
    video = render(key(anim="slow_fade", path=path))
    mask = hold_mask(video, baseline, 0.9)  # steady hold of block A
    assert mask.sum() > 2000
    full = full_level(video, baseline, 0.9, mask)
    rise = [coverage(video, baseline, A_START + offset, mask, full) for offset in (0.0, 0.08, 0.16, 0.24, 0.32, 0.5)]
    assert rise[0] < 0.1, "block must not be visible at its first word onset"
    assert monotone(rise, rising=True) and 0.1 < rise[2] < 0.9 and rise[-1] > 0.9, rise
    fall = [coverage(video, baseline, t, mask, full) for t in (1.1, 1.2, 1.3, 1.4, 1.48)]
    assert monotone(fall, rising=False) and fall[0] > 0.9 and fall[-1] < 0.25, fall
    # Slow fade never overlaps blocks: when B appears A has already gone.
    b_only = hold_mask(video, baseline, 2.2) & ~dilate(mask)
    assert coverage(video, baseline, 1.52, mask, full) < 0.1
    assert coverage(video, baseline, B_START - 0.02, b_only, full) < 0.08


def test_line_crossfade_midpoint_contains_both_blocks_and_alpha_changes_progressively(baseline: Path) -> None:
    video = render(key(anim="line_crossfade"))
    a_mask = hold_mask(video, baseline, 1.2)
    b_mask = hold_mask(video, baseline, 2.2)
    a_only, b_only = a_mask & ~dilate(b_mask, 3), b_mask & ~dilate(a_mask, 3)
    assert a_only.sum() > 300 and b_only.sum() > 300
    full_a, full_b = full_level(video, baseline, 1.2, a_only), full_level(video, baseline, 2.2, b_only)
    # Before B's first word nothing of B is visible; A is fully readable.
    assert coverage(video, baseline, B_START - 0.05, b_only, full_b) < 0.08
    assert coverage(video, baseline, B_START - 0.05, a_only, full_a) > 0.9
    offsets = (0.0, 0.15, 0.3, 0.45, 0.6, 0.75)
    a_series = [coverage(video, baseline, B_START + off, a_only, full_a) for off in offsets]
    b_series = [coverage(video, baseline, B_START + off, b_only, full_b) for off in offsets]
    assert monotone(a_series, rising=False), a_series
    assert monotone(b_series, rising=True), b_series
    assert 0.15 < a_series[2] < 0.85 and 0.15 < b_series[2] < 0.85, (a_series, b_series)  # both on screen mid-transition
    assert a_series[-1] < 0.1 and b_series[-1] > 0.9  # only B remains after the overlap
    # The long instrumental gap is genuinely empty and C starts only at its word.
    assert coverage(video, baseline, 3.6, a_mask | b_mask, full_a) < 0.05
    c_mask = hold_mask(video, baseline, 4.4)
    assert coverage(video, baseline, C_START - 0.05, c_mask, full_level(video, baseline, 4.4, c_mask)) < 0.08


def test_word_build_never_shows_future_words_and_keeps_earlier_words_in_place(baseline: Path) -> None:
    video = render(key(anim="word_build", path="fast"))
    all_mask = hold_mask(video, baseline, 1.2)  # "do you think," fully built, before the fade
    full = full_level(video, baseline, 1.2, all_mask)
    do_only = hold_mask(video, baseline, 0.62)  # "do" settled; "you" onset is 0.65
    assert 100 < do_only.sum() < all_mask.sum() / 2
    future = all_mask & ~dilate(do_only)
    assert coverage(video, baseline, 0.62, future, full) < 0.06, "future words must not be visible yet"
    assert (do_only & ~dilate(all_mask)).sum() <= 0.02 * do_only.sum(), "earlier words must not move when later ones arrive"
    through_you = hold_mask(video, baseline, 0.92)  # "do you"; "think" onset is 0.95
    you_only = through_you & ~dilate(do_only)
    think_only = all_mask & ~dilate(through_you)
    assert you_only.sum() > 100 and think_only.sum() > 100
    assert coverage(video, baseline, 0.92, think_only, full) < 0.06
    ramp = [coverage(video, baseline, 0.65 + off, you_only, full_level(video, baseline, 1.2, you_only)) for off in (0.0, 0.05, 0.1, 0.15, 0.25)]
    assert ramp[0] < 0.1 and monotone(ramp, rising=True) and ramp[-1] > 0.9, ramp
    # The finished block fades out as a whole; C is empty before its onset.
    fade = [coverage(video, baseline, t, all_mask, full) for t in (1.25, 1.35, 1.45)]
    assert monotone(fade, rising=False) and fade[0] > fade[-1] + 0.2, fade
    c_mask = hold_mask(video, baseline, 4.4)
    assert coverage(video, baseline, C_START - 0.05, c_mask, full_level(video, baseline, 4.4, c_mask)) < 0.06


def test_original_keeps_the_legacy_instant_word_swap(baseline: Path) -> None:
    video = render(key(anim="legacy"))
    mask = hold_mask(video, baseline, 0.45)
    assert mask.sum() > 100
    full = full_level(video, baseline, 0.45, mask)
    assert coverage(video, baseline, A_START + 0.05, mask, full) > 0.9  # no fade-in


@pytest.mark.parametrize("theme", ["condensed_black", "handwritten_stack"])
def test_other_new_themes_fade_with_their_own_colours_and_faces(baseline: Path, theme: str) -> None:
    # A mid-grey background so black lettering has contrast of its own.
    video = render(key(theme=theme, anim="slow_fade", colour="0x909090"))
    plain = render(key(theme=theme, text="0", colour="0x909090"))
    mask = hold_mask(video, plain, 0.9)
    assert mask.sum() > 1500
    frame_hold = frame(video, 0.9)
    text_pixels = frame_hold[mask]
    if theme == "condensed_black":
        assert (text_pixels.mean(axis=1) < 60).mean() > 0.3, "black lettering expected"
    else:
        assert (text_pixels > 200).mean() > 0.3, "white handwritten lettering expected"
    full = full_level(video, plain, 0.9, mask)
    assert coverage(video, plain, A_START, mask, full) < 0.1 < coverage(video, plain, A_START + 0.16, mask, full) < 0.95


# --- hook banner ----------------------------------------------------------------

def footage_rows(source_size: tuple[int, int]) -> tuple[int, int]:
    from engine.media import _music_layout_geometry

    _, scaled, top = _music_layout_geometry(WIDTH, HEIGHT, source_size)
    return top, top + scaled


def strip_rows(image: np.ndarray, footage_top: int) -> tuple[int, int] | None:
    """Contiguous full-white rows ending just above the footage, via the left margin."""
    white = (image[:, 3, :] > 240).all(axis=1)
    bottom = footage_top
    while bottom > 0 and not white[bottom - 1]:
        break
    if not white[footage_top - 1]:
        return None
    top = footage_top - 1
    while top > 0 and white[top - 1]:
        top -= 1
    return top, footage_top


def test_white_banner_pixels_strip_text_and_untouched_footage() -> None:
    wide = (1280, 720)
    footage_top, footage_bottom = footage_rows(wide)
    banner = render(key(text="0", hook="Hook line that wraps across two lines of the banner", anim="legacy"))
    none = render(key(text="0"))
    image = frame(banner, 1.0)
    rows = strip_rows(image, footage_top)
    assert rows is not None and rows[1] == footage_top and footage_top - rows[0] >= 80
    top, bottom = rows
    assert (image[top:bottom, 3, :] > 240).all() and (image[top:bottom, WIDTH - 4, :] > 240).all()  # full width
    assert image[: max(0, top - 2), :, :].max() < 30, "above the strip stays black"
    strip = image[top:bottom]
    dark = (strip.mean(axis=2) < 100)
    ys, xs = np.nonzero(dark)
    assert dark.sum() > 400, "black text expected on the strip"
    assert abs((xs.min() + xs.max()) / 2 - WIDTH / 2) < WIDTH * 0.06, "text is horizontally centred"
    assert xs.min() > WIDTH * 0.03 and xs.max() < WIDTH * 0.97
    assert ys.min() >= 4 and ys.max() <= (bottom - top) - 4, "text must sit inside the strip with padding"
    bands = np.nonzero(np.diff((dark.any(axis=1)).astype(int)) == 1)[0]
    assert 1 <= len(bands) + int(dark[0].any()) <= 3, "wrapped onto up to three lines"
    reference = frame(none, 1.0)
    assert np.abs(image[footage_top:footage_bottom] - reference[footage_top:footage_bottom]).mean() < 0.5, "banner must not cover footage"


@pytest.mark.parametrize(("theme", "animation"), (("condensed_black", "word_build"), ("condensed_white", "line_crossfade")))
def test_white_banner_with_creator_credit_renders_and_credit_fades(theme: str, animation: str) -> None:
    """Exercise creator-attributed and control renders through the real FFmpeg renderer."""
    source_size = (1920, 1080)
    footage_top, footage_bottom = footage_rows(source_size)
    common = dict(long="1", dur="21", src="credit-wide", size="1920x1080", colour="0x203040",
                  text="1", hook="she never stopped loving him", fmt="white_banner", theme=theme, anim=animation)
    credited = render(key(**common, credit="1"))
    control = render(key(**common, credit="0"))

    for moment in (1.0, 12.0, 20.0):
        image = frame(credited, moment)
        rows = strip_rows(image, footage_top)
        assert rows is not None and rows[1] == footage_top and rows[1] - rows[0] >= 80, (theme, animation, moment)
        top, bottom = rows
        assert (image[top:bottom, 3, :] > 240).all()
        assert (image[top:bottom, WIDTH - 4, :] > 240).all()
        dark = image[top:bottom].mean(axis=2) < 100
        ys, xs = np.nonzero(dark)
        assert len(xs) > 400
        assert abs((xs.min() + xs.max()) / 2 - WIDTH / 2) < WIDTH * 0.06
        assert image[:max(0, top - 2)].max() < 30
        assert np.abs(image[footage_top:footage_bottom] - frame(control, moment)[footage_top:footage_bottom]).mean() < 0.5

    # Credit remains visible at 1 s and has completed its established 8 s + 1 s fade by 12 s.
    for moment, expected_visible in ((1.0, True), (12.0, False), (20.0, False)):
        actual = frame(credited, moment)[1750:1900, 500:1070]
        plain = frame(control, moment)[1750:1900, 500:1070]
        changed = np.abs(actual - plain).max(axis=2) > 8
        count = int(changed.sum())
        if expected_visible:
            assert count > 30, (theme, animation, moment, count)
        else:
            assert count < 10, (theme, animation, moment, count)

    # The actual render emitted burn-in and downloadable ASS. The creator credit
    # belongs only to the burn-in track; both scripts must have canonical times.
    burn = credited.with_name(f"{credited.stem}.burn.ass").read_text(encoding="utf-8")
    downloadable = credited.with_suffix(".ass").read_text(encoding="utf-8")
    assert "Dialogue: 2,0:00:00.00,0:00:09.00,Credit," in burn
    assert "Source: Controlled Creator" in burn and "Source: Controlled Creator" not in downloadable
    import re
    for ass in (burn, downloadable):
        for event in (line for line in ass.splitlines() if line.startswith("Dialogue:")):
            fields = event.split(",", 3)
            assert re.fullmatch(r"\d+:\d{2}:\d{2}\.\d{2}", fields[1]), event
            assert re.fullmatch(r"\d+:\d{2}:\d{2}\.\d{2}", fields[2]), event
    parser = subprocess.run([settings().ffmpeg, "-hide_banner", "-loglevel", "warning", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=24:d=1", "-vf", f"subtitles={credited.with_name(f'{credited.stem}.burn.ass')}", "-frames:v", "1", "-f", "null", "-"], capture_output=True, text=True)
    assert parser.returncode == 0, parser.stderr
    assert "Bad timestamp" not in parser.stderr


def test_unchecked_or_blank_hook_leaves_no_strip() -> None:
    footage_top, _ = footage_rows((1280, 720))
    for variant in (key(text="0"), key(text="0", hook="", fmt="white_banner")):
        image = frame(render(variant), 1.0)
        assert image[:footage_top].max() < 30, variant
    # Plain format keeps the existing white-on-black text, with no white rectangle.
    plain = frame(render(key(text="0", hook="Plain hook", fmt="plain")), 1.0)
    assert plain[:footage_top, 3, :].max() < 30 and plain[:footage_top].max() > 200


def test_hundred_character_hook_stays_readable_inside_three_lines() -> None:
    hook = " ".join(["Word"] * 20) + "!"
    assert len(hook) == 100
    footage_top, _ = footage_rows((1280, 720))
    image = frame(render(key(text="0", hook=hook)), 1.0)
    rows = strip_rows(image, footage_top)
    assert rows is not None
    strip = image[rows[0]:rows[1]]
    dark = strip.mean(axis=2) < 100
    line_starts = int(np.sum(np.diff(dark.any(axis=1).astype(int)) == 1) + int(dark[0].any()))
    assert 2 <= line_starts <= 3
    _, xs = np.nonzero(dark)
    assert xs.min() > WIDTH * 0.03 and xs.max() < WIDTH * 0.97
    # Text height stays readable: the tallest line is at least 24 px.
    line_rows = np.nonzero(dark.any(axis=1))[0]
    assert (line_rows.max() - line_rows.min()) >= 24


def test_subscribe_animation_never_covers_the_banner_when_there_is_room() -> None:
    footage_top, _ = footage_rows((1280, 720))
    with_anim = render(key(text="0", hook="Hook text over wide footage", sub="5"))
    without = render(key(text="0", hook="Hook text over wide footage"))
    animated = frame(with_anim, 1.5)  # animation is playing for the whole 5 s clip
    reference = frame(without, 1.5)
    rows = strip_rows(animated, footage_top)
    assert rows is not None, "banner stays up throughout"
    assert np.abs(animated[rows[0]:rows[1]] - reference[rows[0]:rows[1]]).mean() < 0.5, "animation must not cover the hook"
    # The animation itself did render (it differs from the plain frame above the strip).
    assert np.abs(animated[:rows[0]] - reference[:rows[0]]).mean() > 0.05


def test_banner_yields_to_the_subscribe_animation_when_no_room_remains() -> None:
    tall = (1080, 1920)
    footage_top, _ = footage_rows(tall)
    source = key(text="0", hook="Hook text over tall footage", src="tall", size="1080x1920", sub="5", dur="8")
    video = render(source)  # the animation starts at 3.0 s
    before, during = frame(video, 1.5), frame(video, 3.6)
    assert strip_rows(before, footage_top) is not None, "banner is up before the animation starts"
    assert strip_rows(during, footage_top) is None, "banner yields once the animation plays"
