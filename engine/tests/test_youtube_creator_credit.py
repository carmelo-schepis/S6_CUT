from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.jobs import _source_clip_visual_metadata, youtube_creator_credit
from engine.library import ResolvedVisual
from engine.media import dimensions, probe, render_fast_clip
from engine.models import Asset, Job


def _job(content_format: str = "short"):
    return Job(
        id="job", project_id="project", mode="clip", state="queued", stage="queued",
        stage_label="Queued", progress=0, style="educational", content_format=content_format,
    )


def test_credit_uses_persisted_creator_only_for_short_youtube_jobs():
    job = _job()
    assert youtube_creator_credit(job, {"url": "https://www.youtube.com/watch?v=fixture", "youtube_creator": "  Maker  Name  "}) == "Source: Maker Name"
    assert youtube_creator_credit(job, {"url": "https://www.youtube.com/watch?v=fixture"}) == "Source: YouTube"
    assert youtube_creator_credit(job, {"youtube_creator": "Maker Name"}) is None
    assert youtube_creator_credit(_job("long"), {"url": "https://www.youtube.com/watch?v=fixture", "youtube_creator": "Maker Name"}) is None


def test_credit_accepts_unicode_and_punctuation_for_renderer_sanitization():
    creator = "频道 🎬 · Maker {One}"
    assert youtube_creator_credit(_job(), {"url": "https://youtu.be/fixture", "youtube_creator": creator}) == f"Source: {creator}"


def test_source_clip_visual_metadata_only_keeps_real_composited_library_assets(tmp_path: Path):
    asset_path = tmp_path / "matched.png"
    asset_path.write_bytes(b"asset")
    asset = Asset(
        id="asset-1", title="Matched media", media_type="image", filename=asset_path.name,
        content_hash="hash-1", licence="User supplied", attribution="Artist",
    )
    matched = ResolvedVisual("Matched media", "library", 1.0, "matched", asset, asset_path)
    overlays, provenance = _source_clip_visual_metadata(matched, 4)
    assert overlays == [(asset_path, .65, 3.4)]
    assert [item.provider for item in provenance] == ["personal-library"]
    assert provenance[0].content_hash == "hash-1"

    fallback = ResolvedVisual("GPT", "text-card", .55, "no match")
    assert _source_clip_visual_metadata(fallback, 4) == ([], [])
    assert _source_clip_visual_metadata(matched, 1) == ([], [])


def _frame(path: Path, timestamp: float, settings: Settings) -> bytes:
    result = subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-vf", "scale=270:480,format=gray", "-f", "rawvideo", "pipe:1"],
        check=True,
        capture_output=True,
    )
    return result.stdout


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg smoke test requires ffmpeg and ffprobe")
def test_fast_youtube_credit_is_burned_into_beginning_middle_and_end(tmp_path: Path) -> None:
    settings = Settings.from_env()
    source = tmp_path / "source.mp4"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "testsrc2=size=640x360:rate=15:duration=3", "-c:v", "libx264", "-preset", "ultrafast", str(source),
    ], check=True, capture_output=True)
    plain = tmp_path / "plain.mp4"
    credited = tmp_path / "credited.mp4"
    render_fast_clip(source, plain, start=0, end=3, aspect="9:16", settings=settings, has_audio=False, subtitles_enabled=False)
    render_fast_clip(source, credited, start=0, end=3, aspect="9:16", settings=settings, has_audio=False, subtitles_enabled=False, creator_credit="Source: Creator 🎬 {One} !?")
    metadata = probe(credited, settings)
    assert (metadata["width"], metadata["height"]) == dimensions("9:16")
    assert not credited.with_suffix(".partial.mp4").exists()
    assert "Credit" not in credited.with_suffix(".ass").read_text(encoding="utf-8")
    assert "Credit" in credited.with_suffix(".burn.ass").read_text(encoding="utf-8")

    for timestamp in (0.2, 1.5, 2.8):
        before = _frame(plain, timestamp, settings)
        after = _frame(credited, timestamp, settings)
        assert len(before) == len(after) == 270 * 480
        # Credit is placed in one lower corner. A sizable pixel delta at every
        # sampled time proves it is in the encoded frames, not browser chrome.
        corner_deltas = []
        for left in (True, False):
            x0, x1 = (0, 86) if left else (184, 270)
            y0 = 345
            corner_deltas.append(sum(abs(after[y * 270 + x] - before[y * 270 + x]) for y in range(y0, 480) for x in range(x0, x1)))
        assert max(corner_deltas) > 10_000
