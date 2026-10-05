from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import MediaError, _subscribe_animation_inputs, probe, render_fast_clip, render_script
from engine.models import ScriptJobInput, ShortsJobInput, SubscribeAnimationConfig
from engine.subscribe_animation import ANIMATION_ASSET, ANIMATION_DURATION_SECONDS, schedule_subscribe_animation


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
        output, duration=60, aspect="16:9", narration=None, words=[], visuals=[], overlays=[],
        settings=settings, style="serious", content_format="long",
    )

    assert received_content_formats == ["long"]
    assert commands[0][commands[0].index("-preset") + 1] == "medium"
    assert output.read_bytes() == b"rendered"


def _require_ffmpeg(settings: Settings) -> None:
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("subscribe animation media test requires FFmpeg and FFprobe")


def _frame_region(settings: Settings, path: Path, at: float) -> bytes:
    result = subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}", "-i", str(path),
         "-frames:v", "1", "-vf", "crop=iw*0.18:ih*0.08:(iw-ow)/2+iw*0.06:ih*0.08,scale=288:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        check=True, capture_output=True,
    )
    return result.stdout


def _mean_difference(first: bytes, second: bytes) -> float:
    return sum(abs(left - right) for left, right in zip(first, second, strict=True)) / len(first)


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
    args = dict(start=1, end=8, aspect=aspect, settings=settings, has_audio=True, subtitles_enabled=False)
    render_fast_clip(source, enabled, subscribe_animation=ON, **args)
    render_fast_clip(source, disabled, subscribe_animation={"version": 1, "enabled": False, "short_form_lead_seconds": 5}, **args)

    on_meta, off_meta = probe(enabled, settings), probe(disabled, settings)
    from engine.media import dimensions
    assert (on_meta["width"], on_meta["height"]) == dimensions(aspect)
    assert (off_meta["width"], off_meta["height"]) == dimensions(aspect)
    assert on_meta["audio"] and off_meta["audio"]
    assert on_meta["duration"] == pytest.approx(7, abs=.25)
    assert off_meta["duration"] == pytest.approx(7, abs=.25)

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
