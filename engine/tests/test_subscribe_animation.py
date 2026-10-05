from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import MediaError, _subscribe_animation_inputs, probe, render_fast_clip, render_script
from engine.models import ScriptJobInput, ShortsJobInput, SubscribeAnimationConfig
from engine.subscribe_animation import (
    ANIMATION_ASSET,
    ANIMATION_BUTTON_WIDTH,
    ANIMATION_CANVAS_HEIGHT,
    ANIMATION_CANVAS_WIDTH,
    ANIMATION_DURATION_SECONDS,
    schedule_subscribe_animation,
)


ON = {"enabled": True, "version": 1, "short_form_lead_seconds": 5}
ASPECTS = ("9:16", "16:9", "1:1", "4:5")


def test_missing_disabled_and_legacy_settings_are_disabled() -> None:
    assert schedule_subscribe_animation(40) == ()
    assert schedule_subscribe_animation(40, config={"enabled": False, "version": 1}) == ()
    assert schedule_subscribe_animation(40, config={"enabled": True}) == ()
    assert schedule_subscribe_animation(40, config={"enabled": True, "version": 2}) == ()
    assert schedule_subscribe_animation(40, config={**ON, "short_form_lead_seconds": 7}) == ()


def test_short_occurrence_uses_selected_end_relative_lead_and_output_time() -> None:
    assert schedule_subscribe_animation(120, config=ON) == ((115.0, 4.0),)
    assert schedule_subscribe_animation(120, config={**ON, "short_form_lead_seconds": 10}) == ((110.0, 4.0),)
    assert schedule_subscribe_animation(12, config=ON) == ((7.0, 4.0),)
    # The caller passes the trimmed/output duration, never the absolute source end.
    assert schedule_subscribe_animation(9, config={**ON, "short_form_lead_seconds": 10}) == ((0.0, 4.0),)


def test_long_occurrences_are_midpoint_and_thirty_seconds_before_end() -> None:
    assert schedule_subscribe_animation(120, content_format="long", config=ON) == ((60.0, 4.0), (90.0, 4.0))
    assert schedule_subscribe_animation(40, content_format="long", config=ON) == ((10.0, 4.0), (20.0, 4.0))


def test_long_occurrences_fall_back_to_one_in_last_five_seconds_if_too_close() -> None:
    assert schedule_subscribe_animation(60, content_format="long", config=ON) == ((55.0, 4.0),)
    assert schedule_subscribe_animation(70, content_format="long", config=ON) == ((65.0, 4.0),)
    assert schedule_subscribe_animation(72, content_format="long", config=ON) == ((36.0, 4.0), (42.0, 4.0))


def test_exceptionally_short_outputs_shorten_cycle_and_keep_it_inside_output() -> None:
    assert schedule_subscribe_animation(2.5, config=ON) == ((0.0, 2.5),)
    assert schedule_subscribe_animation(2.5, content_format="long", config=ON) == ((0.0, 2.5),)
    assert all(start >= 0 and start + cycle <= 2.5 for start, cycle in schedule_subscribe_animation(2.5, content_format="long", config=ON))


def test_versioned_request_validation_and_legacy_defaults() -> None:
    assert ScriptJobInput(script="A valid script body").subscribe_animation == SubscribeAnimationConfig()
    assert ShortsJobInput(asset_id="asset", start=0).subscribe_animation.enabled is False
    resolved = SubscribeAnimationConfig.model_validate({"enabled": True, "version": 1, "shortFormLeadSeconds": 10})
    assert resolved.enabled and resolved.short_form_lead_seconds == 10
    try:
        SubscribeAnimationConfig(enabled=True, short_form_lead_seconds=7)
    except ValueError:
        pass
    else:
        raise AssertionError("unsupported animation lead passed validation")


def test_bundled_animation_asset_is_present_and_scheduled_inputs_restart_independently() -> None:
    assert ANIMATION_DURATION_SECONDS == 4
    assert ANIMATION_ASSET.is_file()
    command = ["ffmpeg", "-i", "source.mp4"]
    occurrences = _subscribe_animation_inputs(command, ON, 120, "long", 1920, 1080, 1)
    assert [(item[0], item[1], item[2]) for item in occurrences] == [(1, 60, 4), (2, 90, 4)]
    assert command.count("-i") == 3
    assert command[-1] == str(ANIMATION_ASSET)
    assert _subscribe_animation_inputs(["ffmpeg", "-i", "source.mp4"], None, 120, "long", 1920, 1080, 1) == []


def test_bundled_animation_asset_keeps_high_resolution_alpha_video_contract() -> None:
    settings = Settings.from_env()
    _require_ffmpeg(settings)
    metadata = probe(ANIMATION_ASSET, settings)
    assert (metadata["width"], metadata["height"]) == (ANIMATION_CANVAS_WIDTH, ANIMATION_CANVAS_HEIGHT)
    assert metadata["video_codec"] == "qtrle"
    assert metadata["pixel_format"] == "argb"
    assert metadata["frame_rate"] == 30
    assert metadata["duration"] == pytest.approx(ANIMATION_DURATION_SECONDS, abs=.01)
    assert ANIMATION_BUTTON_WIDTH / ANIMATION_CANVAS_WIDTH == pytest.approx(.66796875)


def test_missing_enabled_animation_asset_fails_clearly(monkeypatch, tmp_path: Path) -> None:
    import engine.media as media_module

    monkeypatch.setattr(media_module, "ANIMATION_ASSET", tmp_path / "not-installed.mov")
    with pytest.raises(MediaError, match="Subscribe animation is enabled.*asset is unavailable"):
        _subscribe_animation_inputs(["ffmpeg", "-i", "source.mp4"], ON, 40, "short", 1080, 1920, 1)


def test_long_script_render_uses_long_caption_recipe_and_delivery_preset(monkeypatch, tmp_path: Path) -> None:
    import engine.media as media_module

    settings = Settings.from_env()
    output = tmp_path / "long-script.mp4"
    received_content_formats = []
    commands = []
    words = [
        {"text": "A", "start": 0.1, "end": 0.3, "confidence": 0.9},
        {"text": "verified", "start": 0.3, "end": 0.7, "confidence": 0.9},
        {"text": "long", "start": 0.7, "end": 1.0, "confidence": 0.9},
        {"text": "caption", "start": 1.0, "end": 1.4, "confidence": 0.9},
    ]
    write_ass = media_module.write_ass

    def capture_write_ass(*args, **kwargs):
        received_content_formats.append(kwargs.get("content_format"))
        write_ass(*args, **kwargs)

    def fake_run(command, *, cwd, timeout):
        commands.append(command)
        Path(command[-1]).write_bytes(b"rendered")

    monkeypatch.setattr(media_module, "write_ass", capture_write_ass)
    monkeypatch.setattr(media_module, "run", fake_run)
    monkeypatch.setattr(media_module, "probe", lambda path, settings: {"width": 1920, "height": 1080, "audio": False})

    render_script(
        output, duration=60, aspect="16:9", narration=None, words=words, visuals=[], overlays=[],
        settings=settings, style="serious", content_format="long",
    )

    actual_ass = output.with_suffix(".ass").read_text(encoding="utf-8")
    expected_long_ass = tmp_path / "expected-long.ass"
    write_ass(expected_long_ass, words, offset=0, duration=60, visuals=[], width=1920, height=1080, style="serious", content_format="long")
    expected_short_ass = tmp_path / "expected-short.ass"
    write_ass(expected_short_ass, words, offset=0, duration=60, visuals=[], width=1920, height=1080, style="serious", content_format="short")

    assert received_content_formats == ["long"]
    assert "A VERIFIED LONG" in actual_ass
    assert actual_ass == expected_long_ass.read_text(encoding="utf-8")
    assert actual_ass != expected_short_ass.read_text(encoding="utf-8")
    assert commands[0][commands[0].index("-preset") + 1] == "medium"
    assert output.read_bytes() == b"rendered"


def _require_ffmpeg(settings: Settings) -> None:
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("subscribe animation media test requires FFmpeg and FFprobe")


def _frame_region(settings: Settings, path: Path, at: float) -> bytes:
    result = subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}", "-i", str(path),
         "-frames:v", "1", "-vf", "crop=iw*0.60:ih*0.24:(iw-ow)/2:ih*0.06,scale=288:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        check=True, capture_output=True,
    )
    return result.stdout


def _mean_difference(first: bytes, second: bytes) -> float:
    return sum(abs(left - right) for left, right in zip(first, second, strict=True)) / len(first)


def _full_frame(settings: Settings, path: Path, at: float, width: int, height: int) -> bytes:
    result = subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}", "-i", str(path),
         "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
        check=True, capture_output=True,
    )
    assert len(result.stdout) == width * height * 3
    return result.stdout


def _pixel_bounds(frame: bytes, width: int, height: int, matches) -> tuple[int, int, int, int]:
    xs, ys = [], []
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 3
            if matches(*frame[offset:offset + 3]):
                xs.append(x)
                ys.append(y)
    assert xs, "expected visible animation pixels"
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


@pytest.mark.parametrize("aspect", ASPECTS)
def test_real_ffmpeg_animation_is_visible_motion_and_keeps_media_contracts(tmp_path: Path, aspect: str) -> None:
    settings = Settings.from_env()
    _require_ffmpeg(settings)
    source = tmp_path / "static-source.mp4"
    subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:r=24:d=9",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=9",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source)],
        check=True, capture_output=True,
    )
    enabled = tmp_path / f"enabled-{aspect.replace(':', '-')}.mp4"
    disabled = tmp_path / f"disabled-{aspect.replace(':', '-')}.mp4"
    args = dict(
        start=1, end=8, aspect=aspect, settings=settings, has_audio=True,
        words=[{"text": "A readable caption", "start": 2.2, "end": 4.8, "confidence": 0.9}],
        creator_credit="Source: S6_CUT", subtitles_enabled=True,
    )
    render_fast_clip(source, enabled, subscribe_animation=ON, **args)
    render_fast_clip(source, disabled, subscribe_animation={"version": 1, "enabled": False, "short_form_lead_seconds": 5}, **args)

    on_meta, off_meta = probe(enabled, settings), probe(disabled, settings)
    from engine.media import dimensions
    assert (on_meta["width"], on_meta["height"]) == dimensions(aspect)
    assert (off_meta["width"], off_meta["height"]) == dimensions(aspect)
    assert on_meta["audio"] and off_meta["audio"]
    assert on_meta["duration"] == pytest.approx(7, abs=.25)
    assert off_meta["duration"] == pytest.approx(7, abs=.25)

    width, height = dimensions(aspect)
    early_on = _full_frame(settings, enabled, 2.45, width, height)
    early_off = _full_frame(settings, disabled, 2.45, width, height)
    left, top, right, bottom = _pixel_bounds(
        early_on, width, height, lambda red, green, blue: red > green * 1.35 and red > blue * 1.35 and red > 80,
    )
    visible_width_fraction = (right - left) / width
    expected_width = (0.40, 0.50) if aspect == "16:9" else (0.55, 0.65)
    assert expected_width[0] <= visible_width_fraction <= expected_width[1]
    assert abs((left + right) / 2 - width / 2) <= width * 0.02
    assert 0 <= top < bottom <= height and top < height * 0.20

    # Pointer travel/click, sparkle, and subscribed state all stay within the
    # render canvas; disabled output remains unchanged at matching timestamps.
    for at in (2.45, 3.10, 3.60):
        on_frame = _full_frame(settings, enabled, at, width, height)
        off_frame = early_off if at == 2.45 else _full_frame(settings, disabled, at, width, height)
        difference = _pixel_bounds(
            bytes(abs(left - right) for left, right in zip(on_frame, off_frame, strict=True)),
            width, height, lambda red, green, blue: red + green + blue > 90,
        )
        diff_left, diff_top, diff_right, diff_bottom = difference
        assert width * 0.02 < diff_left < diff_right < width * 0.98
        assert height * 0.04 < diff_top < diff_bottom < height * 0.50

    # The source is trimmed from t=1 through t=8; output-relative timing starts
    # at t=2. Compare identical output timestamps and verify cursor travel,
    # click/subscribed state, and disappearance instead of merely nonblank frames.
    baseline_before = _frame_region(settings, disabled, 1.8)
    animation_early = _frame_region(settings, enabled, 2.45)
    animation_late = _frame_region(settings, enabled, 2.95)
    subscribed = _frame_region(settings, enabled, 3.6)
    after = _frame_region(settings, enabled, 6.4)
    assert _mean_difference(baseline_before, animation_early) > 2
    assert _mean_difference(animation_early, animation_late) > 1
    assert _mean_difference(animation_late, subscribed) > 1
    assert _mean_difference(baseline_before, after) < 2


def test_smart_caption_render_composites_the_same_silent_animation(tmp_path: Path) -> None:
    from engine.media import render_clip

    settings = Settings.from_env()
    _require_ffmpeg(settings)
    source = tmp_path / "caption-source.mp4"
    subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:r=24:d=9",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=9",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source)],
        check=True, capture_output=True,
    )
    enabled, disabled = tmp_path / "smart-enabled.mp4", tmp_path / "smart-disabled.mp4"
    words = [{"text": "A verified caption", "start": 1.4, "end": 2.2, "confidence": 0.9}]
    common = dict(
        start=1, end=8, aspect="9:16", words=words, visuals=[], overlays=[], settings=settings, has_audio=True,
    )
    render_clip(source, enabled, subscribe_animation=ON, **common)
    render_clip(source, disabled, subscribe_animation={"version": 1, "enabled": False, "short_form_lead_seconds": 5}, **common)

    on_meta, off_meta = probe(enabled, settings), probe(disabled, settings)
    assert on_meta["duration"] == pytest.approx(7, abs=.25)
    assert off_meta["duration"] == pytest.approx(7, abs=.25)
    assert on_meta["audio"] and off_meta["audio"]
    assert _mean_difference(_frame_region(settings, enabled, 2.45), _frame_region(settings, disabled, 2.45)) > 1
