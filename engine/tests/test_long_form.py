from __future__ import annotations

import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import MediaError, plan_long_form_windows, probe, render_fast_clip
from engine.models import Job, Project


@pytest.fixture
def settings() -> Settings:
    return Settings.from_env()


def _require_ffmpeg(settings: Settings) -> None:
    """Skip a test whose fixture is built with the real FFmpeg tools.

    These are the FFmpeg-gated smoke tests described in
    DO-NOT-CHANGE/AGENTS.md section 9: on a host without ffmpeg/ffprobe they
    must skip cleanly rather than fail with a bare FileNotFoundError. The
    planner tests in this module use no external tools and keep running.
    """
    missing = [name for name, binary in (("ffmpeg", settings.ffmpeg), ("ffprobe", settings.ffprobe))
               if not shutil.which(binary)]
    if missing:
        pytest.skip(f"requires {' and '.join(missing)}")


def test_legacy_project_and_job_default_to_short_form() -> None:
    project = Project.model_validate({
        "schemaVersion": 1, "id": "p", "name": "Legacy", "mode": "clip", "style": "educational",
        "state": "queued", "sourceName": "source.mp4", "sourceKind": "upload", "requestedCount": 2,
    })
    job = Job.model_validate({
        "schemaVersion": 1, "id": "j", "projectId": "p", "mode": "clip", "state": "queued",
        "stage": "queued", "stageLabel": "Queued", "progress": 0, "style": "educational",
    })
    assert project.content_format == "short"
    assert job.content_format == "short"


def test_long_form_planner_is_deterministic_non_overlapping_and_partial() -> None:
    first, warning = plan_long_form_windows(1000, 10, 30, 120, 2)
    second, second_warning = plan_long_form_windows(1000, 10, 30, 120, 2)
    assert first == second
    assert warning == second_warning
    assert len(first) == 10
    assert all(end - start >= 30 and end - start <= 120 for start, end in first)
    assert all(first[index][1] <= first[index + 1][0] for index in range(len(first) - 1))

    partial, partial_warning = plan_long_form_windows(100, 10, 30, 120, 2)
    assert len(partial) < 10
    assert "Reduced" in partial_warning


def test_long_form_render_is_true_landscape_16_9(tmp_path: Path, settings: Settings) -> None:
    runtime = settings
    _require_ffmpeg(runtime)
    source = tmp_path / "source.mp4"
    subprocess.run([
        runtime.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "testsrc2=size=640x360:rate=15:duration=2", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source),
    ], check=True, capture_output=True, text=True)
    output = tmp_path / "long-clip.mp4"
    render_fast_clip(source, output, start=0, end=1.5, aspect="16:9", settings=runtime, has_audio=True)
    metadata = probe(output, runtime)
    assert (metadata["width"], metadata["height"]) == (1920, 1080)
    assert metadata["audio"] is True
    assert not output.with_suffix(".partial.mp4").exists()


def test_long_source_limit_can_exceed_short_limit(tmp_path: Path) -> None:
    runtime = Settings.from_env()
    _require_ffmpeg(runtime)
    source = tmp_path / "source.mp4"
    subprocess.run([
        runtime.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "testsrc2=size=320x180:rate=10:duration=2", "-c:v", "libx264", "-preset", "ultrafast", str(source),
    ], check=True, capture_output=True, text=True)
    short = replace(runtime, max_source_seconds=1)
    long = replace(runtime, max_source_seconds=1, max_long_source_seconds=3)
    with pytest.raises(MediaError, match="limit"):
        probe(source, short)
    assert probe(source, long, max_seconds=long.max_long_source_seconds)["duration"] <= 3


def test_long_form_smart_request_builds_the_pipeline_it_actually_runs(tmp_path: Path) -> None:
    """Long form always renders through the fast pipeline, whatever mode was
    requested, so its checklist must be the fast one. When the two disagreed the
    fast renderer asked for a 'plan' step that only exists on the fast
    checklist and the job died with a raw KeyError."""
    from dataclasses import replace as _replace

    from engine.app import settings as app_settings
    from engine.database import Database
    from engine.jobs import JobManager
    from engine.library import LibraryRules
    from engine.providers import ProfileService
    from engine.security import SecretVault

    runtime = _replace(app_settings, data_path=tmp_path)
    database = Database(tmp_path / "s6-cut.sqlite3")
    manager = JobManager(database, LibraryRules(database, tmp_path / "library"),
                         ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key")), runtime)

    project = Project(id="p-long", name="p-long", mode="clip", style="educational", state="queued",
                      source_name="source.mp4", source_kind="upload", requested_count=2, content_format="long")
    database.save_project(project)
    job = Job(id="j-long", project_id="p-long", mode="clip", processing_mode="smart", content_format="long",
              state="queued", stage="queued", stage_label="Queued", progress=0, style="educational")
    private = {"source_path": str(tmp_path / "source.mp4"), "count": 2, "min_duration": 30, "max_duration": 120,
               "aspect_ratio": "16:9", "processing_mode": "smart", "content_format": "long"}
    database.save_job(job, private)

    manager._init_steps(job, private)
    step_ids = [step.id for step in job.steps]
    assert "plan" in step_ids, f"long form runs the fast pipeline, which needs a 'plan' step; got {step_ids}"
