from __future__ import annotations

from types import SimpleNamespace

import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.jobs import centered_partial_fill_eligible
from engine.media import probe, render_clip, render_fast_clip


@pytest.mark.parametrize("style", ["serious", "hype"])
def test_partial_fill_requires_supported_style_and_authoritative_youtube_metadata(style: str) -> None:
    job = SimpleNamespace(mode="clip", style=style, content_format="short")
    private = {"aspect_ratio": "9:16", "url": "https://youtube.com/watch?v=id", "source_kind": "youtube"}
    assert centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1080})


@pytest.mark.parametrize(
    ("job_style", "private_updates", "metadata"),
    [
        ("educational", {}, {"width": 1920, "height": 1080}),
        ("funny", {}, {"width": 1920, "height": 1080}),
        ("serious", {"aspect_ratio": "1:1"}, {"width": 1920, "height": 1080}),
        ("serious", {"url": None}, {"width": 1920, "height": 1080}),
        ("serious", {"source_kind": "upload", "source_path": "/upload.mp4"}, {"width": 1920, "height": 1080}),
        ("serious", {}, {"width": 1920, "height": 1000}),
        ("hype", {}, {"width": 1080, "height": 1920}),
    ],
)
def test_partial_fill_rejects_ineligible_sources(job_style: str, private_updates: dict, metadata: dict) -> None:
    job = SimpleNamespace(mode="clip", style=job_style, content_format="short")
    private = {"aspect_ratio": "9:16", "url": "https://youtube.com/watch?v=id", "source_kind": "youtube", "youtube_title": "Title", "youtube_creator": "Creator"} | private_updates
    assert not centered_partial_fill_eligible(job, private, metadata)


def test_partial_fill_uses_display_geometry_including_sar_and_rotation() -> None:
    job = SimpleNamespace(mode="clip", style="serious", content_format="short")
    private = {"aspect_ratio": "9:16", "url": "https://www.youtube.com/watch?v=id", "source_kind": "youtube", "source_path": "/immutable/import/source.mp4"}
    # 720x1080 anamorphic 8:3 pixels display as 16:9; autorotation swaps
    # axes and inverts the display SAR.
    assert centered_partial_fill_eligible(job, private, {"width": 720, "height": 1080, "sample_aspect_ratio": 8 / 3})
    assert centered_partial_fill_eligible(job, private, {"width": 1080, "height": 720, "sample_aspect_ratio": 3 / 8, "rotation": 90})
    assert not centered_partial_fill_eligible(job, private, {"width": 720, "height": 1080, "sample_aspect_ratio": 1.0})
    assert not centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1080, "sample_aspect_ratio": 0})
    assert not centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1080, "sample_aspect_ratio": None})
    assert not centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1080, "sample_aspect_ratio": float("nan")})
    assert centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1059})
    assert not centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1058})
    music_job = SimpleNamespace(mode="clip", style="serious", content_format="short", source_profile="music")
    assert not centered_partial_fill_eligible(music_job, private, {"width": 1920, "height": 1080})


def test_probe_keeps_invalid_sar_ineligible_instead_of_defaulting_to_square_pixels(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import json
    from engine import media as media_module

    settings = Settings.from_env()
    for sample_aspect_ratio, expected in (("0:1", None), ("N/A", 1.0)):
        payload = {"streams": [{"codec_type": "video", "width": 1920, "height": 1080,
                              "sample_aspect_ratio": sample_aspect_ratio}], "format": {"duration": "1"}}
        monkeypatch.setattr(media_module, "run", lambda *_args, **_kwargs: SimpleNamespace(stdout=json.dumps(payload)))
        metadata = probe(tmp_path / "source.mp4", settings)
        assert metadata["sample_aspect_ratio"] == expected


def test_caption_rerender_retains_authoritative_partial_fill_option(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import engine.jobs as jobs_module
    from engine import media as media_module
    from engine.jobs import JobManager
    from engine.models import Clip, Job

    captured: dict = {}
    monkeypatch.setattr(jobs_module, "probe", lambda *_args, **_kwargs: {"audio": True, "width": 1920, "height": 1080, "sample_aspect_ratio": 1.0, "rotation": 0})
    monkeypatch.setattr(media_module, "render_fast_clip", lambda _source, _output, **kwargs: captured.update(kwargs))
    manager = object.__new__(JobManager)
    manager.settings = SimpleNamespace(data_path=tmp_path)
    manager._source = lambda *_args: tmp_path / "immutable-source.mp4"
    manager._save = lambda *_args: None
    manager._publish_output = lambda job, clip, *_args: (job, clip, None)
    clip = Clip(id="partial-fill-clip", index=1, state="complete", start=1, end=3, duration=2, opening_line="original caption")
    job = Job(
        id="partial-fill-job", project_id="partial-fill-project", mode="clip", state="active",
        stage="render", stage_label="Rendering", progress=50, style="serious", clips=[clip],
    )
    request = {"clip_id": clip.id, "revision": 1, "run_id": "partial-fill-caption-rerender"}
    private = {
        "url": "https://www.youtube.com/watch?v=authoritative",
        "source_kind": "youtube",
        "source_path": "/immutable/import/source.mp4",
        "aspect_ratio": "9:16",
        "source_metadata": {"width": 1920, "height": 1080, "rotation": 0, "sample_aspect_ratio": 1},
        "caption_rerender": request,
        "caption_overrides": {clip.id: {"revision": 1, "cues": [{"id": "cue", "start": 0.2, "end": 0.8, "text": "edited caption"}]}},
    }

    manager._process_caption_rerender(job, private, request)

    assert captured["centered_partial_fill"] is True
    assert captured["style"] == "serious"
    assert "caption_rerender" not in private


def test_partial_fill_eligibility_survives_retry_and_fast_switch_snapshots() -> None:
    from engine.models import Job

    job = Job(id="partial-fill-state", project_id="p", mode="clip", state="active", stage="render",
              stage_label="Rendering", progress=50, style="hype")
    private = {"url": "https://www.youtube.com/watch?v=authoritative", "source_kind": "youtube", "source_path": "/immutable/import/source.mp4", "aspect_ratio": "9:16"}
    metadata = {"width": 1920, "height": 1080}
    retry_job = job.model_copy(update={"state": "failed"})
    switched_job = job.model_copy(update={"processing_mode": "fast"})
    rerender_private = private | {"caption_rerender": {"run_id": "rerender"}}
    assert all(centered_partial_fill_eligible(snapshot, rerender_private, metadata)
               for snapshot in (job, retry_job, switched_job))


def test_source_kind_snapshot_is_refreshed_from_persisted_project(tmp_path: Path) -> None:
    from engine.jobs import JobManager

    source = tmp_path / "source.mp4"
    source.touch()
    manager = object.__new__(JobManager)
    manager.db = SimpleNamespace(get_project=lambda _project_id: SimpleNamespace(source_kind="upload"))
    manager._register_source = lambda *_args: None
    manager.complete_step = lambda *_args, **_kwargs: None
    private = {"source_kind": "youtube", "source_path": str(source)}

    assert manager._source(SimpleNamespace(project_id="project"), private) == source
    assert private["source_kind"] == "upload"


def test_source_kind_snapshot_without_persisted_project_fails_closed(tmp_path: Path) -> None:
    from engine.jobs import JobManager

    source = tmp_path / "source.mp4"
    source.touch()
    manager = object.__new__(JobManager)
    manager.db = SimpleNamespace(get_project=lambda _project_id: None)
    manager._register_source = lambda *_args: None
    manager.complete_step = lambda *_args, **_kwargs: None
    private = {"source_kind": "youtube", "source_path": str(source)}

    assert manager._source(SimpleNamespace(project_id="deleted-project"), private) == source
    assert "source_kind" not in private


def test_partial_fill_rejects_long_form() -> None:
    job = SimpleNamespace(mode="clip", style="serious", content_format="long")
    private = {"aspect_ratio": "9:16", "url": "https://youtube.com/watch?v=id", "source_kind": "youtube"}
    assert not centered_partial_fill_eligible(job, private, {"width": 1920, "height": 1080})


def test_rendered_fast_and_smart_partial_fill_geometry(tmp_path: Path) -> None:
    settings = Settings.from_env()
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("requires FFmpeg and FFprobe for rendered pixel verification")

    source = tmp_path / "moving-markers.mp4"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i",
        "color=c=0x303030:size=640x360:rate=12:duration=2,"
        "drawbox=x=100:y=0:w=120:h=360:color=0xA0A0A0:t=fill,"
        "scroll=horizontal=0.05:vertical=0,"
        "drawbox=x=0:y=0:w=640:h=3:color=white:t=fill,"
        "drawbox=x=0:y=357:w=640:h=3:color=white:t=fill,"
        "drawbox=x=16:y=150:w=24:h=24:color=0xFF00FF:t=fill,"
        "drawbox=x=308:y=150:w=24:h=24:color=red:t=fill,"
        "drawbox=x=600:y=150:w=24:h=24:color=0xFF00FF:t=fill,"
        "noise=alls=5:allf=t+u",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source),
    ], check=True, capture_output=True)

    rendered = []
    caption_words = [{"start": 0.3, "end": 1.4, "text": "Keep captions inside the foreground"}]
    for mode in ("fast", "smart"):
        output = tmp_path / f"{mode}.mp4"
        common = dict(start=0.1, end=1.9, aspect="9:16", settings=settings, has_audio=True, centered_partial_fill=True,
                      creator_credit="Source: Regression fixture")
        if mode == "fast":
            render_fast_clip(source, output, **common, words=caption_words, style="serious", subtitles_enabled=True)
        else:
            render_clip(source, output, **common, words=caption_words, visuals=[], overlays=[], style="serious")
        metadata = probe(output, settings)
        assert (metadata["width"], metadata["height"]) == (1080, 1920)
        assert metadata["audio"] is True
        assert metadata["duration"] == pytest.approx(1.8, abs=0.15)
        subprocess.run([settings.ffmpeg, "-v", "error", "-i", str(output), "-f", "null", "-"], check=True, capture_output=True)
        frame_data = subprocess.run([
            settings.ffmpeg, "-v", "error", "-ss", "0.8", "-i", str(output),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], check=True, capture_output=True).stdout
        assert len(frame_data) == 1080 * 1920 * 3
        rendered.append(frame_data)

    def pixel(frame: bytes, x: int, y: int) -> tuple[int, int, int]:
        offset = (y * 1080 + x) * 3
        return tuple(frame[offset:offset + 3])

    def is_red(value: tuple[int, int, int]) -> bool:
        red, green, blue = value
        return red > 170 and green < 90 and blue < 90

    def is_magenta(value: tuple[int, int, int]) -> bool:
        red, green, blue = value
        return red > 170 and green < 90 and blue > 170

    black_tolerance = 12  # Allow minor RGB noise from H.264 encoding.
    geometry = []
    for frame in rendered:
        assert len(frame) == 1080 * 1920 * 3

        # Captions and creator credit are positioned in the foreground, and
        # the post-subtitle mask keeps every decoded sample in both pads black.
        top_band = frame[:239 * 1080 * 3]
        bottom_band = frame[1680 * 1080 * 3:]
        assert max(top_band) <= black_tolerance, "rows above the foreground must be black"
        assert max(bottom_band) <= black_tolerance, "rows below the foreground must be black"
        assert max(max(pixel(frame, x, 239)) for x in range(1080)) <= black_tolerance
        assert max(max(pixel(frame, x, 1680)) for x in range(1080)) <= black_tolerance

        # The white source-edge bars are 3/360 of the source height, hence
        # about 12 output rows after scaling to the 1440px foreground.
        assert min(pixel(frame, 540, 240)) > 190
        assert min(pixel(frame, 540, 250)) > 190
        assert min(pixel(frame, 540, 1670)) > 190
        assert min(pixel(frame, 540, 1679)) > 190

        # The center source marker remains centered by a symmetric horizontal
        # crop. Its two magenta edge markers are outside that crop.
        assert is_red(pixel(frame, 540, 928))
        red_points = [(x, y) for y in range(830, 950, 2) for x in range(480, 600, 2) if is_red(pixel(frame, x, y))]
        assert red_points
        red_left, red_right = min(x for x, _ in red_points), max(x for x, _ in red_points)
        red_top, red_bottom = min(y for _, y in red_points), max(y for _, y in red_points)
        red_width, red_height = red_right - red_left, red_bottom - red_top
        assert red_width == pytest.approx(red_height, abs=5), "center marker should retain its proportions"
        assert 490 <= red_left <= 510 and 570 <= red_right <= 590
        assert 838 <= red_top <= 842 and 932 <= red_bottom <= 938
        assert abs((red_left + red_right) / 2 - 540) <= 2, "center crop must be horizontally symmetric"
        assert not any(is_magenta(pixel(frame, x, 928)) for x in range(0, 1080, 12))

        # The hard red-to-grey transitions on the marker prove the foreground
        # detail was scaled, not softened like a background blur.
        marker_edge = max(
            sum(abs(a - b) for a, b in zip(pixel(frame, x, 928), pixel(frame, x + 1, 928)))
            for x in range(red_left - 2, red_right + 2)
        )
        assert marker_edge > 80, "the foreground retains a distinct sharp edge after the Serious treatment"
        geometry.append((red_left, red_right, red_top, red_bottom))

    assert all(abs(fast - smart) <= 2 for fast, smart in zip(*geometry)), (
        "Fast and Smart must place the foreground geometry identically"
    )

    # Fast/Smart use the same geometry; independent encodes can differ by a few
    # RGB levels, so assert a low average decoded-frame error, not byte identity.
    frame_difference = sum(abs(a - b) for a, b in zip(rendered[0], rendered[1]))
    assert frame_difference < len(rendered[0]) * 4
