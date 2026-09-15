from __future__ import annotations

import re
import shutil
import subprocess
from itertools import pairwise
from pathlib import Path

import pytest

from engine.config import Settings
import engine.media as media_module
from engine.media import (
    BACKGROUND_BLUR_FILTER,
    BACKGROUND_BLUR_PERCENT,
    BACKGROUND_BLUR_SIGMA,
    MediaError,
    _fast_crop_scale_filter,
    _source_layout_filter,
    _rational_to_float,
    _rotation_from_stream,
    plan_fast_windows,
    probe,
    render_clip,
    render_fast_clip,
)


@pytest.fixture()
def settings() -> Settings:
    return Settings.from_env()


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


def _require_ffmpeg(settings: Settings) -> None:
    """Skip a test whose fixture is built with the real FFmpeg tools.

    These are the FFmpeg-gated smoke tests described in
    DO-NOT-CHANGE/AGENTS.md section 9: on a host without ffmpeg/ffprobe they
    must skip cleanly rather than fail with a bare FileNotFoundError. Only the
    tests that shell out are gated; the pure-logic tests in this module keep
    running everywhere.
    """
    missing = [name for name, binary in (("ffmpeg", settings.ffmpeg), ("ffprobe", settings.ffprobe))
               if not shutil.which(binary)]
    if missing:
        pytest.skip(f"requires {' and '.join(missing)}")


def _make_source(settings: Settings, tmp: Path, *, duration: float = 3.0, width: int = 640, height: int = 360, rate: float = 30.0, with_audio: bool = True) -> Path:
    """Create a tiny MP4 test source with the given parameters."""
    _require_ffmpeg(settings)
    src = tmp / "source.mp4"
    cmd = [
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={rate}:duration={duration}",
    ]
    if with_audio:
        cmd.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"])
    cmd.extend(["-c:v", "libx264", "-preset", "ultrafast"])
    if with_audio:
        cmd.extend(["-c:a", "aac", "-shortest"])
    cmd.append(str(src))
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return src


# ---------------------------------------------------------------------------
#  _rational_to_float
# ---------------------------------------------------------------------------


def test_rational_to_float() -> None:
    assert _rational_to_float("30/1") == 30.0
    assert _rational_to_float("30000/1001") == 30000.0 / 1001.0
    assert _rational_to_float("50/2") == 25.0
    assert _rational_to_float(None) is None
    assert _rational_to_float("") is None
    assert _rational_to_float("not-a-rational") is None
    assert _rational_to_float("0/0") is None
    assert _rational_to_float("-1/1") is None


# ---------------------------------------------------------------------------
#  _rotation_from_stream
# ---------------------------------------------------------------------------


def test_rotation_from_stream() -> None:
    # No rotation
    assert _rotation_from_stream({"codec_type": "video"}) == 0
    # rotation field
    assert _rotation_from_stream({"rotation": "90"}) == 90
    assert _rotation_from_stream({"rotation": 180}) == 180
    assert _rotation_from_stream({"rotation": 360}) == 0
    # tags.rotate
    assert _rotation_from_stream({"tags": {"rotate": "270"}}) == 270
    assert _rotation_from_stream({"tags": {"rotate": "bad"}}) == 0
    # rotation field takes precedence
    assert _rotation_from_stream({"rotation": "90", "tags": {"rotate": "180"}}) == 90


# ---------------------------------------------------------------------------
#  _fast_crop_scale_filter
# ---------------------------------------------------------------------------


def test_fast_crop_scale_filter_16_9_to_9_16() -> None:
    vf = _fast_crop_scale_filter(1920, 1080, 1080, 1920)
    assert "crop=608:1080" in vf, f"Unexpected: {vf}"
    assert "scale=1080:1920" in vf, f"Unexpected: {vf}"


def test_fast_crop_scale_filter_native_9_16() -> None:
    vf = _fast_crop_scale_filter(1080, 1920, 1080, 1920)
    assert "crop=1080:1920" in vf
    assert "scale=1080:1920" in vf


def test_fast_crop_scale_filter_upscales_to_delivery_canvas() -> None:
    vf = _fast_crop_scale_filter(720, 1280, 1080, 1920)
    assert "crop=720:1280" in vf
    assert "scale=1080:1920" in vf


def test_fast_crop_scale_filter_4k_downscale() -> None:
    vf = _fast_crop_scale_filter(3840, 2160, 1080, 1920)
    assert "crop=1215:2160" in vf or "crop=1216:2160" in vf
    assert "scale=1080:1920" in vf  # downscaled to target


def test_fast_crop_scale_filter_square() -> None:
    vf = _fast_crop_scale_filter(1080, 1080, 1080, 1920)
    assert "scale=1080:1920" in vf


def test_fast_crop_scale_filter_even_output() -> None:
    """All output dimensions must be even (H.264 yuv420p requirement)."""
    for src_w, src_h, tgt_w, tgt_h in [
        (1920, 1080, 1080, 1920),
        (1440, 1080, 1080, 1920),
        (320, 240, 1080, 1920),
        (640, 360, 1080, 1080),
        (1920, 1080, 1920, 1080),
    ]:
        vf = _fast_crop_scale_filter(src_w, src_h, tgt_w, tgt_h)
        after_scale = vf.split("scale=")[-1].split(",")[0].split(":flags")[0]
        ow, oh = (int(x) for x in after_scale.split(":"))
        assert ow % 2 == 0, f"Odd output width {ow} for {src_w}x{src_h} -> {tgt_w}x{tgt_h}: {vf}"
        assert oh % 2 == 0, f"Odd output height {oh} for {src_w}x{src_h} -> {tgt_w}x{tgt_h}: {vf}"


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ((640, 360), (1080, 1920)),  # landscape -> 9:16
        ((640, 360), (1080, 1080)),  # landscape -> 1:1
        ((640, 360), (1080, 1350)),  # landscape -> 4:5
        ((360, 640), (1920, 1080)),  # portrait -> 16:9
    ],
)
def test_source_layout_uses_identical_undarkened_blurred_fill_for_mismatched_aspects(source, target) -> None:
    vf = _source_layout_filter(*source, *target)
    assert BACKGROUND_BLUR_PERCENT == 30
    assert BACKGROUND_BLUR_SIGMA == 30
    assert BACKGROUND_BLUR_FILTER == "gblur=sigma=30:steps=2"
    assert "split=2[foreground][background]" in vf
    assert BACKGROUND_BLUR_FILTER in vf
    assert "eq=brightness" not in vf
    assert "brightness=" not in vf
    assert "curves=" not in vf
    assert "colorchannelmixer=" not in vf
    assert "vignette=" not in vf
    background = vf.split("[background]", 1)[1].split("[bg]", 1)[0]
    foreground = vf.split(";[foreground]", 1)[1].split("[fg]", 1)[0]
    assert "gblur" in background
    assert "gblur" not in foreground
    assert "force_original_aspect_ratio=decrease" in foreground
    assert f"crop={target[0]}:{target[1]}:(iw-{target[0]})/2:(ih-{target[1]})/2" in background
    assert "setsar=1" in vf
    overscan = re.search(r"scale=(\d+):(\d+):force_original_aspect_ratio=increase", background)
    assert overscan
    assert all(int(value) % 2 == 0 for value in overscan.groups())
    assert int(overscan.group(1)) >= target[0] + 2
    assert int(overscan.group(2)) >= target[1] + 2


def test_source_layout_uses_simple_path_for_native_and_near_native_aspects() -> None:
    for source, target in [
        ((1080, 1920), (1080, 1920)),
        ((1920, 1080), (1920, 1080)),
        ((1920, 1080), (2000, 1100)),  # within the existing 12% near-native threshold
    ]:
        vf = _source_layout_filter(*source, *target)
        assert "split=2" not in vf
        assert "gblur" not in vf
        assert "brightness=" not in vf
        assert "flags=lanczos" in vf
        assert "setsar=1" in vf


def test_render_paths_use_shared_source_layout_filter(monkeypatch: pytest.MonkeyPatch, settings: Settings, tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    calls: list[tuple[int, int, int, int]] = []
    metadata = {"width": 640, "height": 360, "rotation": 0, "audio": False, "duration": 2.0}

    def fake_probe(path: Path, __: Settings):
        return metadata if path == source else {**metadata, "width": 1080, "height": 1920, "duration": 1.0}

    def fake_layout(src_width: int, src_height: int, target_width: int, target_height: int):
        calls.append((src_width, src_height, target_width, target_height))
        return "scale=1080:1920,setsar=1[base]"

    def fake_run(command: list[str], **_: object):
        Path(command[-1]).write_bytes(b"rendered")

    monkeypatch.setattr(media_module, "probe", fake_probe)
    monkeypatch.setattr(media_module, "run", fake_run)
    monkeypatch.setattr(media_module, "_source_layout_filter", fake_layout)
    render_fast_clip(source, tmp_path / "fast.mp4", start=0, end=1, aspect="9:16", settings=settings, has_audio=False)
    render_clip(source, tmp_path / "smart.mp4", start=0, end=1, aspect="9:16", words=[], visuals=[], overlays=[], settings=settings, has_audio=False)
    assert calls == [(640, 360, 1080, 1920), (640, 360, 1080, 1920)]


@pytest.mark.parametrize("dimensions", [(0, 360), (640, 0), (-1, 360), (640, -1), ("bad", 360), (640, float("inf"))])
def test_source_layout_rejects_invalid_source_dimensions(dimensions: tuple[object, object]) -> None:
    with pytest.raises(MediaError, match="Invalid source"):
        _source_layout_filter(*dimensions, 1080, 1920)


def test_source_layout_rejects_odd_yuv420p_target() -> None:
    with pytest.raises(MediaError, match="even"):
        _source_layout_filter(641, 361, 1081, 1920)


# ---------------------------------------------------------------------------
#  plan_fast_windows
# ---------------------------------------------------------------------------


def test_plan_fast_windows_deterministic() -> None:
    a, _ = plan_fast_windows(100.0, 4, 10, 30, 5)
    b, _ = plan_fast_windows(100.0, 4, 10, 30, 5)
    assert a == b


def test_plan_fast_windows_non_overlapping() -> None:
    windows, _ = plan_fast_windows(100.0, 4, 10, 30, 5)
    for (_, e1), (s2, _) in pairwise(windows):
        assert e1 <= s2, f"Overlap: {e1} > {s2}"


def test_plan_fast_windows_respects_bounds() -> None:
    windows, _ = plan_fast_windows(100.0, 4, 10, 30, 5)
    for s, e in windows:
        assert 10.0 <= e - s <= 30.0, f"Duration {e-s:.3f} outside [10, 30]"


def test_plan_fast_windows_too_short() -> None:
    windows, warning = plan_fast_windows(5.0, 3, 10, 20, 0)
    assert windows == [(0.0, 5.0)]
    assert "shorter than the minimum" in warning


def test_plan_fast_windows_count_reduced() -> None:
    windows, warning = plan_fast_windows(20.0, 4, 6, 6, 0)
    assert len(windows) == 3
    assert "Reduced" in warning


def test_plan_fast_windows_unused_time_distributed() -> None:
    windows, warning = plan_fast_windows(100.0, 4, 10, 15, 0)
    assert len(windows) == 4
    assert windows[0][0] > 0
    assert 100 - windows[-1][1] == pytest.approx(windows[0][0])
    assert "distributed" in warning


def test_plan_fast_windows_guard_gaps() -> None:
    windows, _ = plan_fast_windows(60.0, 3, 5, 20, 2)
    assert len(windows) == 3
    for (_, e1), (s2, _) in pairwise(windows):
        assert s2 - e1 >= 2 - 0.001


def test_plan_fast_windows_zero_guard() -> None:
    windows, _ = plan_fast_windows(30.0, 3, 5, 15, 0)
    assert len(windows) == 3
    for (_, e1), (s2, _) in pairwise(windows):
        assert abs(s2 - e1) < 0.001, f"Guard 0 should touch: {e1} vs {s2}"


def test_plan_fast_windows_exact_fit() -> None:
    windows, warning = plan_fast_windows(60.0, 2, 20, 40, 10)
    assert len(windows) == 2
    assert warning == ""


def test_plan_fast_windows_zero_duration() -> None:
    assert plan_fast_windows(0, 5, 10, 30, 0) == ([], "")


def test_plan_fast_windows_negative_input() -> None:
    assert plan_fast_windows(-1, 0, 10, 30, 0) == ([], "")


def test_plan_fast_windows_warning_shape() -> None:
    """Warning must be a string (falsy when empty) for parent integration."""
    _, warning = plan_fast_windows(100.0, 4, 10, 30, 5)
    assert isinstance(warning, str)
    _, warning = plan_fast_windows(5.0, 3, 10, 20, 0)
    assert isinstance(warning, str)
    assert warning  # non-empty


# ---------------------------------------------------------------------------
#  probe extension (frame_rate, rotation)
# ---------------------------------------------------------------------------


def test_probe_includes_frame_rate(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path, rate=30.0)
    meta = probe(src, settings)
    assert "frame_rate" in meta
    assert meta["frame_rate"] == 30.0


def test_probe_includes_rotation(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path)
    meta = probe(src, settings)
    assert "rotation" in meta
    assert meta["rotation"] == 0


def test_probe_preserves_existing_keys(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path)
    meta = probe(src, settings)
    for key in ("duration", "width", "height", "video_codec", "audio", "audio_codec"):
        assert key in meta, f"Missing existing key: {key}"


# ---------------------------------------------------------------------------
#  render_fast_clip (requires ffmpeg)
# ---------------------------------------------------------------------------


def test_render_fast_clip_9_16_with_audio(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path, duration=3.0, with_audio=True)
    out = tmp_path / "clip.mp4"
    render_fast_clip(src, out, start=0.5, end=2.0, aspect="9:16", settings=settings, has_audio=True)
    assert out.exists()
    meta = probe(out, settings)
    assert meta["audio"] is True
    assert abs(meta["width"] / meta["height"] - 9 / 16) < 0.02


def test_render_fast_clip_16_9_no_audio(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path, duration=3.0, with_audio=False)
    out = tmp_path / "clip.mp4"
    render_fast_clip(src, out, start=0.0, end=1.5, aspect="16:9", settings=settings, has_audio=False)
    meta = probe(out, settings)
    assert meta["audio"] is False
    assert meta["width"] == 1920 and meta["height"] == 1080


def test_render_fast_clip_1_1(settings: Settings, tmp_path: Path) -> None:
    src = _make_source(settings, tmp_path, duration=3.0, with_audio=True)
    out = tmp_path / "square.mp4"
    render_fast_clip(src, out, start=0.2, end=1.2, aspect="1:1", settings=settings, has_audio=True)
    meta = probe(out, settings)
    assert meta["audio"] is True
    assert abs(meta["width"] / meta["height"] - 1.0) < 0.02


def test_render_fast_clip_atomic(settings: Settings, tmp_path: Path) -> None:
    """No .partial.mp4 remains after success; the final output exists."""
    src = _make_source(settings, tmp_path, duration=3.0, with_audio=True)
    out = tmp_path / "clip.mp4"
    partial = out.with_suffix(".partial.mp4")
    render_fast_clip(src, out, start=0.5, end=2.0, aspect="9:16", settings=settings, has_audio=True)
    assert not partial.exists()
    assert out.exists()


def test_render_fast_clip_upscales_source_to_delivery_canvas(settings: Settings, tmp_path: Path) -> None:
    """Small vertical sources still satisfy the delivery canvas contract."""
    src = _make_source(settings, tmp_path, duration=3.0, width=720, height=1280, rate=30, with_audio=True)
    out = tmp_path / "clip.mp4"
    render_fast_clip(src, out, start=0.5, end=2.0, aspect="9:16", settings=settings, has_audio=True)
    meta = probe(out, settings)
    assert meta["width"] == 1080
    assert meta["height"] == 1920
    assert abs(meta["width"] / meta["height"] - 9 / 16) < 0.02


def test_render_clip_overlay_does_not_extend_requested_duration(settings: Settings, tmp_path: Path):
    src = _make_source(settings, tmp_path, duration=2.0, with_audio=True)
    out = tmp_path / "smart-overlay.mp4"
    render_clip(
        src,
        out,
        start=0,
        end=1,
        aspect="9:16",
        words=[],
        visuals=[("Visual", 0, .8)],
        overlays=[(src, 0, .8)],
        settings=settings,
        has_audio=True,
    )
    assert probe(out, settings)["duration"] == pytest.approx(1, abs=.1)


def test_render_fast_clip_raises_on_missing_audio(settings: Settings, tmp_path: Path) -> None:
    """has_audio=True but source has no audio stream → must raise."""
    src = _make_source(settings, tmp_path, duration=3.0, with_audio=False)
    out = tmp_path / "clip.mp4"
    with pytest.raises(MediaError, match="audio"):
        render_fast_clip(src, out, start=0.5, end=2.0, aspect="9:16", settings=settings, has_audio=True)


def _gray_frame(settings: Settings, path: Path, timestamp: float, filters: str):
    size = 64
    result = subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{timestamp:.3f}", "-i", str(path),
         "-frames:v", "1", "-vf", f"{filters},scale={size}:{size}:flags=bilinear,format=gray", "-f", "rawvideo", "pipe:1"],
        check=True,
        capture_output=True,
    )
    return result.stdout, size, size


def _edge_energy(frame: bytes, width: int, height: int) -> float:
    total = 0
    for y in range(height - 1):
        for x in range(width - 1):
            index = y * width + x
            total += abs(frame[index] - frame[index + 1]) + abs(frame[index] - frame[index + width])
    return total / max(1, (width - 1) * (height - 1) * 2)


@pytest.mark.parametrize("aspect", ["9:16", "1:1", "4:5"])
def test_mismatched_fast_render_has_bright_blurred_fill(settings: Settings, tmp_path: Path, aspect: str) -> None:
    """Decode synthetic motion to prove blur is limited to the background copy."""
    _require_ffmpeg(settings)
    source = _make_source(settings, tmp_path, duration=2.5, width=640, height=360, with_audio=False)
    output = tmp_path / f"{aspect.replace(':', '-')}.mp4"
    render_fast_clip(source, output, start=0, end=2, aspect=aspect, settings=settings, has_audio=False, subtitles_enabled=False)
    target_width, target_height = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}[aspect]
    result = probe(output, settings)
    assert (result["width"], result["height"]) == (target_width, target_height)

    fit_scale = min(target_width / 640, target_height / 360)
    fit_height = round(360 * fit_scale)
    band_height = max(2, (target_height - fit_height) // 2 - 4)
    foreground = f"crop={target_width}:{fit_height}:0:{(target_height - fit_height) // 2}"
    background = [
        f"crop={target_width}:{band_height}:0:0",
        f"crop={target_width}:{band_height}:0:{target_height - band_height}",
    ]
    ratios = []
    background_edges = []
    foreground_edges = []
    for timestamp in (0.2, 1.0, 1.8):
        source_frame, _, _ = _gray_frame(settings, source, timestamp, "null")
        source_luminance = sum(source_frame) / len(source_frame)
        foreground_frame, width, height = _gray_frame(settings, output, timestamp, foreground)
        foreground_edges.append(_edge_energy(foreground_frame, width, height))
        for crop in background:
            frame, width, height = _gray_frame(settings, output, timestamp, crop)
            ratios.append((sum(frame) / len(frame)) / max(1, source_luminance))
            background_edges.append(_edge_energy(frame, width, height))
            assert sum(frame) / len(frame) > 8, "blurred fill must not produce black edge bands"
    assert min(ratios) >= 0.72, f"undarkened background/source luminance ratios were {ratios}"
    assert sum(background_edges) / len(background_edges) < sum(foreground_edges) / len(foreground_edges) * 0.9