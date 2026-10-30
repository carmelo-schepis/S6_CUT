"""Encoded-render and libass evidence for picture filters, headings, emoji modes,
Smart Long form captions and the three new Music themes (each with all four
lyric animations).

Footage is synthetic: saturated colour bars for grading, flat colour wherever
text or plates are measured, so every measured difference is the treatment.
"""
from __future__ import annotations

import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest

from engine.config import Settings
from engine.media import _caption_emoji_plan, render_clip, render_fast_clip, write_ass, write_music_ass

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("fc-match"), reason="requires ffmpeg and fontconfig")

SETTINGS = Settings.from_env()
W, H = 1080, 1920
WORDS = [{"text": t, "start": s, "end": e} for t, s, e in [("Small", 0.4, 0.8), ("changes", 0.9, 1.4), ("make", 1.5, 1.8), ("a", 1.85, 1.95), ("clear", 2.0, 2.4), ("difference.", 2.5, 3.3)]]
BARS = "smptebars"


@pytest.fixture(scope="module")
def work(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("editing-media")


@lru_cache(maxsize=None)
def _source(root: str, name: str, lavfi: str, size: str, seconds: int = 6) -> Path:
    path = Path(root) / f"{name}.mp4"
    if not path.exists():
        subprocess.run([SETTINGS.ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"{lavfi}=s={size}:r=30:d={seconds}" if lavfi == BARS else f"{lavfi}:s={size}:r=30:d={seconds}",
                        "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def bars(work: Path, size: str = "1280x720") -> Path:
    return _source(str(work), f"bars-{size}", BARS, size)


def flat(work: Path, colour: str = "0x777777", size: str = "1280x720") -> Path:
    return _source(str(work), f"flat-{colour}-{size}", f"color=c={colour}", size)


def frame(video: Path, seconds: float, width: int = W, height: int = H) -> np.ndarray:
    out = subprocess.run([SETTINGS.ffmpeg, "-v", "error", "-ss", f"{seconds:.3f}", "-i", str(video), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.uint8).reshape(height, width, 3).astype(int)


def saturation(image: np.ndarray) -> float:
    return float((image.max(axis=2) - image.min(axis=2)).mean() / 255)


def warmth(image: np.ndarray) -> float:
    return float((image[:, :, 0] - image[:, :, 2]).mean())


def speech_render(work: Path, name: str, editing: dict | None, *, words=None, source: Path | None = None, **kwargs) -> Path:
    output = work / f"{name}.mp4"
    render_clip(
        source or bars(work), output, start=0.0, end=4.0, aspect="9:16", words=words or [], visuals=[], overlays=[], settings=SETTINGS,
        has_audio=False, content_format="short", presentation="smart_speech_v2", reaction_policy="ironic_v1",
        subtitles_enabled=bool(words), editing_presentation=editing, **kwargs,
    )
    return output


def edit(**fields) -> dict:
    return {"version": 1, **fields}


# --- picture filters -----------------------------------------------------------------


@pytest.fixture(scope="module")
def graded(work) -> dict[str, np.ndarray]:
    names = ("existing", "original", "warm", "cool", "vibrant", "black_white", "vintage")
    renders = {name: frame(speech_render(work, f"speech-{name}", edit(video_filter=name)), 1.0) for name in names}
    renders["omitted"] = frame(speech_render(work, "speech-omitted", None), 1.0)
    return renders


def test_seven_filters_have_their_measured_effect_on_saturated_footage(graded) -> None:
    base = graded["existing"]
    assert saturation(base) > 0.25, "fixture must be saturated for grading to be measurable"
    assert warmth(graded["warm"]) > warmth(base) + 1.0
    assert warmth(graded["cool"]) < warmth(base) - 1.0
    assert saturation(graded["vibrant"]) > saturation(base) * 1.1
    assert saturation(graded["black_white"]) < 0.02
    assert np.abs(graded["vintage"] - base).mean() > 3 and saturation(graded["vintage"]) < saturation(base)


def test_existing_and_original_leave_regular_speech_footage_unchanged_and_match_omitted(graded) -> None:
    assert np.abs(graded["existing"] - graded["omitted"]).max() <= 2
    assert np.abs(graded["original"] - graded["omitted"]).max() <= 2


def test_captions_and_graphics_are_not_graded_so_white_stays_white_under_warm(work) -> None:
    # The existing Warm grade lifts shadows; keep the footage in the shadow
    # range so this test can measure the change without changing grade code.
    source = flat(work, "0x302820")
    ass_free = frame(speech_render(work, "warm-nocap", edit(video_filter="warm"), source=source), 3.0)
    video = speech_render(work, "warm-cap", edit(caption_preset="bold_outline", video_filter="warm"), words=WORDS, source=source)
    image = frame(video, 3.0)
    changed = np.abs(image - ass_free).sum(axis=2) > 60
    white = changed & (image.min(axis=2) > 235)
    assert white.sum() > 300, "subtitle text keeps its pure white under a Warm grade"
    assert warmth(ass_free) > 0, "while the footage itself is warmed"


def test_vintage_grain_is_deterministic(work) -> None:
    first = frame(speech_render(work, "vintage-a", edit(video_filter="vintage")), 1.0)
    second = frame(speech_render(work, "vintage-b", edit(video_filter="vintage")), 1.0)
    assert np.array_equal(first, second)


# --- Music filter override ----------------------------------------------------------


def music_render(work: Path, name: str, editing: dict | None, treatment: str) -> Path:
    output = work / f"{name}.mp4"
    render_clip(
        bars(work, "640x360"), output, start=0.0, end=3.0, aspect="9:16", words=[], visuals=[], overlays=[], settings=SETTINGS, has_audio=False,
        content_format="short", music_theme="clean", music_treatment=treatment, subtitles_enabled=False, editing_presentation=editing,
    )
    return output


def footage_band(image: np.ndarray) -> np.ndarray:
    # The fitted Music band sits around the vertical centre; the black pad above/below is excluded.
    return image[H // 2 - 150:H // 2 + 150]


def test_explicit_music_filter_overrides_the_automatic_grayscale_assignment(work) -> None:
    automatic_gray = frame(music_render(work, "m-gray", None, "grayscale"), 1.0)
    automatic_color = frame(music_render(work, "m-color", None, "color"), 1.0)
    assert saturation(footage_band(automatic_gray)) < 0.02 and saturation(footage_band(automatic_color)) > 0.2
    # Existing look keeps whatever was assigned.
    assert saturation(footage_band(frame(music_render(work, "m-exist-gray", edit(video_filter="existing"), "grayscale"), 1.0))) < 0.02
    for explicit in ("original", "warm", "cool", "vibrant", "vintage"):
        image = footage_band(frame(music_render(work, f"m-{explicit}", edit(video_filter=explicit), "grayscale"), 1.0))
        assert saturation(image) > 0.2, f"{explicit} must not start from the assigned grayscale image"
    warm = footage_band(frame(music_render(work, "m-warm2", edit(video_filter="warm"), "grayscale"), 1.0))
    assert warmth(warm) > warmth(footage_band(automatic_color)) + 1.0
    forced_gray = footage_band(frame(music_render(work, "m-bw", edit(video_filter="black_white"), "color"), 1.0))
    assert saturation(forced_gray) < 0.02


# --- Fast / Long form paths ----------------------------------------------------------


def fast_render(work: Path, name: str, editing: dict | None, *, style="educational", content_format=None, aspect="9:16", words=None, size="1280x720", subtitles=False, source: Path | None = None) -> Path:
    output = work / f"{name}.mp4"
    render_fast_clip(
        source or bars(work, size), output, start=0.0, end=4.0, aspect=aspect, settings=SETTINGS, has_audio=False, words=words, style=style,
        subtitles_enabled=subtitles, content_format=content_format, editing_presentation=editing,
    )
    return output


def test_fast_path_applies_the_filter_without_captions_and_original_bypasses_the_style_look(work) -> None:
    width, height = 1920, 1080
    plain = frame(fast_render(work, "f-plain", None, style="serious", content_format="long", aspect="16:9"), 1.0, width, height)
    original = frame(fast_render(work, "f-orig", edit(video_filter="original"), style="serious", content_format="long", aspect="16:9"), 1.0, width, height)
    mono = frame(fast_render(work, "f-bw", edit(video_filter="black_white"), style="serious", content_format="long", aspect="16:9"), 1.0, width, height)
    warm = frame(fast_render(work, "f-warm", edit(video_filter="warm"), style="serious", content_format="long", aspect="16:9"), 1.0, width, height)
    assert saturation(original) > saturation(plain) * 1.1, "Long-form Serious desaturates; Original colour drops that grade"
    assert saturation(mono) < 0.02
    assert warmth(warm) > warmth(original) + 1.0


def test_smart_long_form_burns_a_subtitle_style_on_the_landscape_canvas(work) -> None:
    width, height = 1920, 1080
    source = flat(work, size="1920x1080")
    words = [{"text": item["text"], "start": item["start"], "end": item["end"]} for item in WORDS]
    clean = frame(fast_render(work, "long-none", edit(video_filter="existing"), content_format="long", aspect="16:9", words=words, subtitles=False, source=source), 3.0, width, height)
    styled = fast_render(work, "long-plate", edit(caption_preset="dark_caption_plate"), content_format="long", aspect="16:9", words=words, subtitles=True, source=source)
    image = frame(styled, 3.0, width, height)
    changed = np.abs(image - clean).sum(axis=2) > 45
    ys, xs = np.nonzero(changed)
    assert len(xs) > 2000, "Long form carries the saved style"
    assert xs.min() >= 0 and xs.max() < width and ys.min() >= 0 and ys.max() < height
    assert image[changed].mean() < clean[changed].mean() + 255  # sanity
    assert styled.with_suffix(".srt").exists() and "difference" in styled.with_suffix(".srt").read_text(encoding="utf-8")


# --- headings --------------------------------------------------------------------------


def _top_frame(tmp: Path, name: str, heading: str, hook: str | None, *, end: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    ass = tmp / f"{name}.ass"
    write_ass(
        ass, [], offset=0, duration=6, visuals=[], width=W, height=H, style="educational", content_format="short", presentation="smart_speech_v2",
        hook_text=hook, hook_end_time=end, editing_presentation={"version": 1, "heading_style": heading},
    )
    run = lambda graph: np.frombuffer(subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=0x777777:s={W}x{H}:r=24:d=10", "-vf", graph, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, check=True, cwd=tmp).stdout, dtype=np.uint8).reshape(H, W, 3).astype(int)
    image = run(f"trim=start=1,setpts=PTS-STARTPTS+1/TB,subtitles={ass.name}")
    base = run("trim=start=1,setpts=PTS-STARTPTS+1/TB")
    return image, np.abs(image - base).sum(axis=2) > 45


def test_heading_styles_draw_distinct_backgrounds_and_blank_heading_draws_nothing(tmp_path: Path) -> None:
    hook = "Most people get this completely wrong"
    plain, plain_mask = _top_frame(tmp_path, "plain", "plain", hook)
    box, box_mask = _top_frame(tmp_path, "box", "dark_box", hook)
    banner, banner_mask = _top_frame(tmp_path, "banner", "white_banner", hook)
    assert plain_mask.sum() > 500 and box_mask.sum() > 500 and banner_mask.sum() > 500
    # Banner: a full-width white strip with dark text, inside the top quarter.
    rows = np.nonzero((banner.min(axis=2) > 245).mean(axis=1) > 0.8)[0]
    assert len(rows) > 40 and rows.min() >= int(H * 0.04) and rows.max() <= int(H * 0.25)
    assert (banner[rows[0]:rows[-1] + 1].max(axis=2) < 60).any(), "black headline text on the strip"
    # Dark box: fitted dark rectangle (not full width) with white text, no white strip.
    dark = box_mask & (box.max(axis=2) < 70)
    ys, xs = np.nonzero(dark)
    assert dark.sum() > 3000 and (xs.max() - xs.min()) < 0.97 * W and ys.max() < H * 0.35
    assert (box_mask & (box.min(axis=2) > 235)).sum() > 300
    assert not ((box.min(axis=2) > 245).mean(axis=1) > 0.8).any()
    # Plain keeps its original look: the soft top scrim spans the full width.
    assert (plain_mask.any(axis=0)).mean() > 0.95
    for heading in ("plain", "dark_box", "white_banner"):
        for blank in (None, "", "   "):
            assert _top_frame(tmp_path, f"blank-{heading}", heading, blank)[1].sum() == 0


def test_headings_yield_to_the_subscribe_animation_start(tmp_path: Path) -> None:
    for heading in ("plain", "dark_box", "white_banner"):
        write_ass(tmp_path / f"{heading}.ass", [], offset=0, duration=6, visuals=[], width=W, height=H, hook_text="Heading", hook_end_time=2.0,
                  presentation="smart_speech_v2", editing_presentation={"version": 1, "heading_style": heading})
        events = [line for line in (tmp_path / f"{heading}.ass").read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue: 5,") or line.startswith("Dialogue: 4,")]
        assert events and all(",0:00:02.00," in line for line in events)


# --- emoji -------------------------------------------------------------------------


def _plan(words, mode, style="funny", duration=10.0, preset="editorial_default"):
    editing = {"version": 1, "emoji_mode": mode, "caption_preset": preset}
    return _caption_emoji_plan(words, W, H, duration, offset=0, style=style, presentation="smart_speech_v2", music_theme=None, reaction_policy="ironic_v1", editing_presentation=editing)


def test_emoji_modes_off_sparse_existing_plan_generated_reactions_deterministically() -> None:
    words = [{"text": t, "start": 0.3 + 0.35 * i, "end": 0.6 + 0.35 * i} for i, t in enumerate("that was hilarious and then we went home early yesterday evening again".split())]
    existing, off, sparse = _plan(words, "existing"), _plan(words, "off"), _plan(words, "sparse")
    assert existing and not off and 0 < len(sparse) <= len(existing)
    assert _plan(words, "sparse") == sparse, "deterministic"
    quiet = [{"text": t, "start": 0.3 + 0.4 * i, "end": 0.65 + 0.4 * i} for i, t in enumerate("water table maintenance schedule review".split())]
    assert _plan(quiet, "sparse") == [], "no eligible cue means no generated emoji"
    assert _plan(quiet, "off") == [] and _plan(quiet, "existing") != [], "existing Funny cadence is unchanged"


def test_emoji_off_keeps_literal_glyph_as_caption_text_and_draws_no_artwork(work) -> None:
    words = [{"text": "That", "start": 0.3, "end": 0.7}, {"text": "😂", "start": 0.8, "end": 1.2}, {"text": "was", "start": 1.3, "end": 1.6}, {"text": "funny", "start": 1.7, "end": 2.2}]
    source = flat(work)

    def burn(name: str, mode: str, preset: str):
        return speech_render(work, name, edit(emoji_mode=mode, caption_preset=preset), words=words, source=source)

    yellow = lambda image: ((image[:, :, 0] > 200) & (image[:, :, 1] > 150) & (image[:, :, 2] < 90)).sum()
    for preset in ("editorial_default", "bold_outline"):
        existing = burn(f"emoji-ex-{preset}", "existing", preset)
        off = burn(f"emoji-off-{preset}", "off", preset)
        assert _plan(words, "existing", preset=preset), "literal emoji gets Fluent artwork by default"
        assert _plan(words, "off", preset=preset) == [], "Off adds no artwork overlays"
        art, text = frame(existing, 1.0), frame(off, 1.0)
        assert yellow(art) > 500, f"{preset}: default shows the colourful artwork"
        # The active spoken word can itself be yellow, so compare identical
        # frames with only emoji mode changed instead of treating all yellow
        # pixels as reaction artwork.
        assert np.abs(art - text).sum() > 20_000, f"{preset}: Existing includes reaction artwork that Off omits"
        # Literal glyph remains in caption text: burn ASS has the glyph, with no image-slot placeholders; sidecars keep it too.
        burn_ass = off.with_suffix(".burn.ass") if off.with_suffix(".burn.ass").exists() else off.with_suffix(".ass")
        content = burn_ass.read_text(encoding="utf-8")
        assert "😂" in content and r"\h\h\h\h" not in content
        assert "😂" in off.with_suffix(".srt").read_text(encoding="utf-8") and "😂" in off.with_suffix(".vtt").read_text(encoding="utf-8")


# --- Music themes x animations ----------------------------------------------------------

LYRICS = [{"text": t, "start": s, "end": e} for t, s, e in [("do", 0.4, 0.7), ("you", 0.75, 1.0), ("think", 1.05, 1.5), ("about", 1.6, 1.9), ("the", 1.95, 2.1), ("way", 2.15, 2.7)]]
MUSIC_THEMES = ("karaoke_focus", "soft_glow", "lyric_plate")
ANIMATIONS = (None, "slow_fade", "line_crossfade", "word_build")


def _music_frames(tmp: Path, theme: str, animation: str | None, t: float, colour="0x203040"):
    ass = tmp / f"{theme}-{animation}.ass"
    if not ass.exists():
        write_music_ass(ass, LYRICS, offset=0, duration=6, width=W, height=H, subtitle_theme=theme, lyric_animation=animation)
    run = lambda graph: np.frombuffer(subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c={colour}:s={W}x{H}:r=24:d=10", "-vf", graph, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, check=True, cwd=tmp).stdout, dtype=np.uint8).reshape(H, W, 3).astype(int)
    stamp = f"trim=start={t},setpts=PTS-STARTPTS+{t}/TB"
    return run(f"{stamp},subtitles={ass.name}"), run(stamp)


@pytest.mark.parametrize("animation", ANIMATIONS)
@pytest.mark.parametrize("theme", MUSIC_THEMES)
def test_new_music_theme_renders_with_every_animation_and_leaves_silence_empty(tmp_path: Path, theme: str, animation: str | None) -> None:
    image, base = _music_frames(tmp_path, theme, animation, 2.4)  # inside the lyric block, after the sung "way" begins
    changed = np.abs(image - base).sum(axis=2) > 45
    ys, xs = np.nonzero(changed)
    assert len(xs) > 800, f"{theme}/{animation} drew nothing"
    assert xs.min() >= 0 and xs.max() < W and ys.min() >= 0 and ys.max() < H
    centre = (ys.min() + ys.max()) / 2
    assert H * 0.3 < centre < H * 0.7, "lyrics stay in the Music band"
    image, base = _music_frames(tmp_path, theme, animation, 5.5)
    assert (np.abs(image - base).sum(axis=2) > 45).sum() == 0, f"{theme}/{animation} hangs over the instrumental gap"


def test_karaoke_focus_accents_only_the_sung_word_and_is_independent_of_animation(tmp_path: Path) -> None:
    for animation in ANIMATIONS:
        image, base = _music_frames(tmp_path, "karaoke_focus", animation, 1.25)  # "think" is sung
        changed = np.abs(image - base).sum(axis=2) > 45
        accent = changed & (image[:, :, 0] > 180) & (image[:, :, 1] > 150) & (image[:, :, 2] < 130)
        white = changed & (image.min(axis=2) > 225)
        assert accent.sum() > 300 and white.sum() > 300, f"karaoke_focus/{animation}: accent word and neutral words"


def test_soft_glow_has_a_bounded_halo_around_restrained_white_text(tmp_path: Path) -> None:
    for animation in ANIMATIONS:
        image, base = _music_frames(tmp_path, "soft_glow", animation, 2.4)
        delta = np.abs(image - base).sum(axis=2)
        core = delta > 400
        halo = (delta > 12) & (delta <= 400)
        assert core.sum() > 300 and halo.sum() > core.sum() * 0.5, f"soft_glow/{animation}: soft halo present"
        ys, xs = np.nonzero(delta > 12)
        assert xs.min() > 20 and xs.max() < W - 20, "glow stays inside the safe frame"


def test_lyric_plate_draws_a_fitted_translucent_dark_plate_with_readable_text(tmp_path: Path) -> None:
    for animation in ANIMATIONS:
        image, base = _music_frames(tmp_path, "lyric_plate", animation, 2.4, colour="0xc0c8d0")
        changed = np.abs(image - base).sum(axis=2) > 45
        ys, xs = np.nonzero(changed)
        plate = image[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        assert plate.mean() < base[ys.min():ys.max() + 1, xs.min():xs.max() + 1].mean() - 25, "dark plate over light footage"
        assert (xs.max() - xs.min()) < 0.9 * W
        assert (changed & (image.min(axis=2) > 235)).sum() > 300, "white lyric text is readable on the plate"


def test_new_themes_encode_through_render_clip_with_a_non_default_animation(work) -> None:
    source = flat(work, "0x203040")
    for theme in MUSIC_THEMES:
        output = work / f"music-{theme}.mp4"
        render_clip(source, output, start=0.0, end=4.0, aspect="9:16", words=LYRICS, visuals=[], overlays=[], settings=SETTINGS, has_audio=False,
                    content_format="short", music_theme=theme, music_treatment="color", music_lyric_animation="word_build", subtitles_enabled=True,
                    editing_presentation=edit(video_filter="vintage"))
        clean = work / f"music-{theme}-clean.mp4"
        render_clip(source, clean, start=0.0, end=4.0, aspect="9:16", words=[], visuals=[], overlays=[], settings=SETTINGS, has_audio=False,
                    content_format="short", music_theme=theme, music_treatment="color", subtitles_enabled=False, editing_presentation=edit(video_filter="vintage"))
        assert (np.abs(frame(output, 2.4) - frame(clean, 2.4)).sum(axis=2) > 45).sum() > 800
