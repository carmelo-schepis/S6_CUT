from __future__ import annotations

import shutil
import subprocess
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

from engine import media as media_module
from engine.app import settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.media import probe
from engine.models import Job, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def _source(path: Path, with_audio: bool):
    command = [
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6",
    ]
    if with_audio:
        command.extend(["-f", "lavfi", "-i", "sine=frequency=440:duration=6"])
    command.extend(["-c:v", "libx264", "-preset", "ultrafast"])
    if with_audio:
        command.extend(["-c:a", "aac", "-shortest"])
    else:
        command.append("-an")
    command.append(str(path))
    subprocess.run(command, check=True, capture_output=True)
    return path


@pytest.mark.parametrize("with_audio", [False, True])
def test_fast_pipeline_real_smoke_never_enters_smart_services(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, with_audio: bool):
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("FFmpeg smoke test requires ffmpeg and ffprobe")
    runtime = replace(settings, data_path=tmp_path, fast_guard_seconds=.1)
    database = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    profiles = ProfileService(database, vault)
    manager = JobManager(database, LibraryRules(database, tmp_path / "library"), profiles, runtime)

    def forbidden(*_: object, **__: object):
        raise AssertionError("Fast mode entered a Smart/provider path")

    monkeypatch.setattr(media_module, "transcribe", forbidden)
    monkeypatch.setattr("engine.jobs.select_candidates", forbidden)
    monkeypatch.setattr(profiles, "synthesize_elevenlabs", forbidden)
    monkeypatch.setattr(profiles, "openrouter_json", forbidden)

    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    source = _source(tmp_path / "source.mp4", with_audio)
    project = Project(
        id=project_id, name="Fast smoke", mode="clip", style="educational", state="queued",
        source_name=source.name, source_kind="upload", requested_count=2, latest_job_id=job_id,
    )
    job = Job(
        id=job_id, project_id=project_id, mode="clip", processing_mode="fast",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational", burn_subtitles=False,
    )
    database.save_project(project)
    database.save_job(job, {
        "source_path": str(source), "processing_mode": "fast", "count": 2,
        "min_duration": 2, "max_duration": 2.5, "aspect_ratio": "9:16", "burn_subtitles": False,
    })

    manager._process(job_id)
    result = database.get_job(job_id)
    assert result is not None
    assert result.state == "complete"
    assert len(result.clips) == 2
    assert all(clip.state == "complete" and clip.score is None for clip in result.clips)
    assert result.clips[0].end <= result.clips[1].start
    assert [step.id for step in result.steps] == ["source", "probe", "plan", "render", "verify", "ready"]
    assert all(step.status == "complete" for step in result.steps)
    assert len(database.list_assets()) == 3
    assert database.get_project(project_id).source_blob_id == result.source_blob_id
    assert all(clip.blob_id for clip in result.clips)
    assert all((tmp_path / database.blob_relative_path(clip.blob_id)).is_file() for clip in result.clips)
    for clip in result.clips:
        output = tmp_path / "jobs" / job_id / "clips" / str(clip.output_name)
        metadata = probe(output, runtime)
        assert abs(metadata["width"] / metadata["height"] - 9 / 16) < .02
        assert metadata["audio"] is with_audio
        assert abs(metadata["duration"] - clip.duration) < .75
