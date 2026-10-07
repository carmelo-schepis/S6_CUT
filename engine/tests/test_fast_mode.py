from __future__ import annotations

import asyncio
import json
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from engine import media as media_module
from engine.app import app, db, manager, resolve_processing_mode, settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager, SwitchFastError, job_processing_mode
from engine.library import LibraryRules
from engine.media import MediaError
from engine.models import Job, ProfileInput, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def _tmpdir() -> Path:
    # pytest's own tmp_path is unavailable in this environment; use a fresh OS temp dir
    return Path(tempfile.mkdtemp(prefix="s6-cut-fast-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    """An isolated engine cluster rooted at tmp_path so pipeline tests never touch app globals."""
    test_settings = replace(settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    test_profiles = ProfileService(test_db, vault)
    test_rules = LibraryRules(test_db, tmp_path / "library")
    test_manager = JobManager(test_db, test_rules, test_profiles, test_settings)
    return test_db, test_manager


def _clip_job(db_: Database, job_id: str, project_id: str, *, mode: str = "fast", source: Path, count: int = 2, private_extra: dict[str, Any] | None = None) -> None:
    project = Project(
        id=project_id, name=job_id, mode="clip", style="educational",
        state="queued", source_name=source.name, source_kind="upload", requested_count=count,
    )
    db_.save_project(project)
    private: dict[str, object] = {
        "source_path": str(source), "count": count, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": mode,
    }
    if private_extra:
        private.update(private_extra)
    job = Job(
        id=job_id, project_id=project_id, mode="clip", processing_mode=mode,
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    db_.save_job(job, private)


# ---------------------------------------------------------------------------
#  Pure resolution helpers
# ---------------------------------------------------------------------------


def test_resolve_auto_needs_selected_connected_profile() -> None:
    assert resolve_processing_mode("auto", True) == "smart"
    assert resolve_processing_mode("auto", False) == "fast"
    assert resolve_processing_mode("fast", True) == "fast"
    assert resolve_processing_mode("smart", False) == "smart"


def test_job_processing_mode_legacy_defaults_to_smart() -> None:
    payload = {
        "schemaVersion": 1,
        "id": "legacy-1",
        "projectId": "p",
        "mode": "clip",
        "state": "queued",
        "stage": "queued",
        "stageLabel": "Queued",
        "progress": 0,
        "style": "educational",
    }
    job = Job.model_validate_json(json.dumps(payload))
    assert job.processing_mode == "smart"
    # private without processing_mode → smart
    assert job_processing_mode(job, {}) == "smart"
    assert job_processing_mode(job, {"processing_mode": "fast"}) == "fast"
    # private trumps public
    assert job_processing_mode(job, {"processing_mode": "fast"}) == "fast"


# ---------------------------------------------------------------------------
#  Fast pipeline skips all smart components
# ---------------------------------------------------------------------------


def _fake_probe(_: Any, __: Settings) -> dict[str, Any]:
    return {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": False, "audio_codec": None}


def _fake_plan(duration: float, count: int, min_duration: float, max_duration: float, guard: float) -> tuple[list[tuple[float, float]], str | None]:
    return [(0.0, 10.0), (12.0, 22.0)], "only two windows fit"


def _fake_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered-fast-clip")


def test_fast_pipeline_skips_smart_components(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    called: list[str] = []
    monkeypatch.setattr("engine.jobs.transcribe", lambda *a, **kw: called.append("transcribe"))
    monkeypatch.setattr("engine.media.transcribe", lambda *a, **kw: called.append("transcribe"))
    monkeypatch.setattr("engine.selection.select_candidates", lambda *a, **kw: called.append("select"))
    monkeypatch.setattr(LibraryRules, "resolve", lambda *a, **kw: called.append("resolve"))

    source = tmp_path / "source.mp4"
    source.write_bytes(b"fake-video")
    _clip_job(test_db, "fast-skip", "fast-skip-proj", mode="fast", source=source)

    test_manager._process("fast-skip")

    processed = test_db.get_job("fast-skip")
    assert processed is not None
    assert processed.state == "complete"
    assert len(processed.clips) == 2
    assert processed.processing_mode == "fast"
    for clip in processed.clips:
        assert clip.state == "complete"
        assert clip.score is None  # fast mode has no semantic score
        assert clip.output_name is not None
        assert (tmp_path / "jobs" / "fast-skip" / "clips" / clip.output_name).exists()
    assert called == [], f"Smart components were called: {called}"
    assert any("only two windows fit" in w for w in processed.warnings)
    assets = test_db.list_assets()
    assert len(assets) == 3
    assert [asset.origin for asset in assets].count("project-source") == 1
    assert [asset.origin for asset in assets].count("generated-clip") == 2
    assert all(asset.folder_id == processed.library_folder_id for asset in assets)
    assert all(asset.blob_id for asset in assets)


def test_fast_mode_never_transcribes_when_captions_are_requested(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", lambda *_: {
        "duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264",
        "audio": True, "audio_codec": "aac",
    })
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    calls: list[str] = []
    monkeypatch.setattr(media_module, "extract_audio_16k", lambda *args, **kwargs: calls.append("extract"))
    monkeypatch.setattr(media_module, "transcribe", lambda *args, **kwargs: calls.append("transcribe"))

    source = tmp_path / "captioned-source.mp4"
    source.write_bytes(b"fake-video")
    _clip_job(
        test_db, "fast-captions", "fast-captions-proj", mode="fast", source=source,
        private_extra={"burn_subtitles": True, "embed_subtitles": True},
    )

    test_manager._process("fast-captions")

    processed = test_db.get_job("fast-captions")
    assert processed is not None and processed.state == "complete"
    assert calls == []
    assert "Fast mode skips caption transcription and rendering; choose Smart mode for captions." in processed.warnings


def test_validated_youtube_source_and_outputs_register_once_across_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    source = tmp_path / "jobs" / "youtube-job" / "source" / "source-video.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"youtube-video")
    source.with_suffix(".info.json").write_text(json.dumps({"title": "Validated channel title", "channel": "Known Channel"}), encoding="utf-8")
    monkeypatch.setattr("engine.jobs.download_youtube", lambda *_: source)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    project = Project(id="youtube-project", name="YouTube import", mode="clip", style="educational", state="queued", source_name="YouTube import", source_kind="youtube", requested_count=2, latest_job_id="youtube-job")
    job = Job(id="youtube-job", project_id=project.id, mode="clip", processing_mode="fast", state="queued", stage="queued", stage_label="Queued", progress=0, style="educational")
    test_db.save_project(project)
    test_db.save_job(job, {"url": "https://www.youtube.com/watch?v=fixture", "processing_mode": "fast", "count": 2, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16"})

    test_manager._process(job.id)
    assets = test_db.list_assets()
    assert len(assets) == 3
    source_asset = next(asset for asset in assets if asset.origin == "project-source")
    assert source_asset.title == "Validated channel title"
    saved_project = test_db.get_project("youtube-project")
    assert saved_project is not None and saved_project.source_creator == "Known Channel"
    private = test_db.get_job_private(job.id)
    assert private["youtube_creator"] == "Known Channel"
    saved_job = test_db.get_job(job.id)
    assert saved_job is not None
    assert all(clip.creator_credit == "Source: Known Channel" for clip in saved_job.clips)
    assert not source.with_suffix(".info.json").exists()
    test_manager._process(job.id)  # terminal recovery/polling is idempotent
    assert len(test_db.list_assets()) == 3


def test_fast_allows_silent_source(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    render_calls: list[dict[str, Any]] = []

    def spy_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        render_calls.append({"has_audio": has_audio, "start": start})
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"silent-fast-clip")

    monkeypatch.setattr(media_module, "render_fast_clip", spy_render)

    source = tmp_path / "silent.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "silent-fast", "silent-proj", mode="fast", source=source)

    test_manager._process("silent-fast")

    assert len(render_calls) == 2
    assert all(call["has_audio"] is False for call in render_calls)
    processed = test_db.get_job("silent-fast")
    assert processed is not None
    assert processed.state == "complete"


def test_fast_partial_and_retry_only_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    rendered_starts: list[float] = []

    def err_then_ok(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        rendered_starts.append(start)
        if start == 0.0:  # first window fails
            raise MediaError("test-render-boom")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", err_then_ok)

    source = tmp_path / "partial.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "partial-fast", "partial-proj", mode="fast", source=source)

    test_manager._process("partial-fast")
    processed = test_db.get_job("partial-fast")
    assert processed is not None
    assert processed.state == "partial"
    assert processed.clips[0].state == "failed"
    assert "test-render-boom" in processed.clips[0].error
    assert processed.clips[1].state == "complete"
    first_assets = test_db.list_assets()
    assert len([asset for asset in first_assets if asset.origin == "generated-clip"]) == 1
    assert all(asset.source_clip_id != processed.clips[0].id for asset in first_assets)

    # Simulate retry-failed: only the failed clip is set back to queued
    rendered_starts.clear()

    def recording_retry_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        rendered_starts.append(start)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", recording_retry_render)
    original_private = test_db.get_job_private("partial-fast")
    for clip in processed.clips:
        if clip.state == "failed":
            clip.state, clip.error = "queued", None
    processed.state, processed.stage, processed.stage_label = "queued", "queued", "Retrying failed outputs"
    test_manager._reset_steps_for_retry(processed)
    test_db.save_job(processed, original_private)

    test_manager._process("partial-fast")

    final = test_db.get_job("partial-fast")
    assert final is not None
    assert final.state == "complete"
    assert all(clip.state == "complete" for clip in final.clips)
    assert len([asset for asset in test_db.list_assets() if asset.origin == "generated-clip"]) == 2
    # Only the previously-failed first window was re-rendered
    assert rendered_starts == [0.0], f"Expected only clip 1 re-render, got {rendered_starts}"


def test_fast_raises_on_empty_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", lambda *a, **kw: ([], "source too short"))

    source = tmp_path / "short.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "empty-win", "empty-proj", mode="fast", source=source)

    test_manager._process("empty-win")
    processed = test_db.get_job("empty-win")
    assert processed is not None
    assert processed.state == "failed"
    assert "fast cut" in processed.stage_label.lower() or "not contain" in processed.error.lower()


def test_fast_missing_media_capability_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.delattr(media_module, "plan_fast_windows", raising=False)

    source = tmp_path / "cap.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "no-cap", "no-cap-proj", mode="fast", source=source)

    test_manager._process("no-cap")
    processed = test_db.get_job("no-cap")
    assert processed is not None
    assert processed.state == "failed"
    assert "plan_fast_windows" in processed.error


# ---------------------------------------------------------------------------
#  smart_available() logic
# ---------------------------------------------------------------------------


def test_smart_available_requires_selected_connected_profile() -> None:
    from engine.app import profiles as app_profiles

    # Clean slate: no selected+connected profile may leak from other tests
    for existing in db.list_profiles():
        existing.selected = False
        existing.text_status = "not_configured"
        db.save_profile(existing)
    assert app_profiles.smart_available() is False

    created = app_profiles.save(ProfileInput(
        name="Unconnected", text_model_id="openai/test",
        openrouter_key="sk-or-v1-test-key", persistence="session", selected=True,
    ))
    # Saved but never connected → configured only
    assert app_profiles.smart_available() is False

    record = db.get_profile(created.id)
    assert record is not None
    profile, _ = record
    profile.text_status = "connected"
    profile.text_message = "Connected"
    profile.status = "connected"
    db.save_profile(profile)
    assert app_profiles.smart_available() is True

    profile.selected = False
    db.save_profile(profile)
    assert app_profiles.smart_available() is False


# ---------------------------------------------------------------------------
#  switch-fast control
# ---------------------------------------------------------------------------


def test_switch_fast_reuses_source_and_cancels_smart(monkeypatch: pytest.MonkeyPatch) -> None:
    source = Path(settings.data_path) / "jobs" / "switch-old" / "source" / "source.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"source-video")

    project = Project(
        id="switch-proj", name="switch test", mode="clip", style="educational",
        state="queued", source_name="source.mp4", source_kind="upload", requested_count=2,
    )
    db.save_project(project)
    private: dict[str, object] = {
        "source_path": str(source), "count": 2, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": "smart",
    }
    old_job = Job(
        id="switch-old", project_id=project.id, mode="clip", processing_mode="smart",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    db.save_job(old_job, private)

    enqueued: list[str] = []

    async def recording_enqueue(job_id: str, **kw: Any) -> None:
        enqueued.append(job_id)

    monkeypatch.setattr(manager, "enqueue", recording_enqueue)

    async def control() -> Job:
        return await manager.control("switch-old", "switch-fast")

    new_job = asyncio.run(control())

    assert new_job.id != "switch-old"
    assert new_job.mode == "clip"
    assert new_job.processing_mode == "fast"
    assert new_job.project_id == project.id
    assert new_job.state == "queued"

    old = db.get_job("switch-old")
    assert old is not None
    assert old.state == "cancelled_kept"
    assert "Replaced by a fast cut" in old.stage_label

    new_private = db.get_job_private(new_job.id)
    assert new_private["source_path"] == str(source)  # no duplicate upload
    assert new_private["processing_mode"] == "fast"
    assert "transcript" not in new_private

    assert enqueued == [new_job.id]

    proj = db.get_project(project.id)
    assert proj is not None
    assert proj.latest_job_id == new_job.id


def test_switch_fast_refuses_finished_clip_jobs() -> None:
    project = Project(
        id="switch-err-proj", name="err", mode="clip", style="educational",
        state="queued", source_name="x.mp4", source_kind="upload", requested_count=1,
    )
    db.save_project(project)

    done = Job(
        id="switch-done", project_id=project.id, mode="clip", processing_mode="smart",
        state="complete", stage="complete", stage_label="Done", progress=100, style="educational",
    )
    db.save_job(done, {"source_path": "/tmp/fake"})
    with pytest.raises(SwitchFastError, match="finished"):
        asyncio.run(manager.control("switch-done", "switch-fast"))



# ---------------------------------------------------------------------------
#  Auto-resolution through API (integration smoke)
# ---------------------------------------------------------------------------


def test_api_auto_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("engine.app.validate_video_upload", lambda *a, **kw: None)
    monkeypatch.setattr(manager, "_process", lambda job_id: None)
    monkeypatch.setattr("engine.app.profiles.smart_available", lambda: True)

    data = {
        "style": "funny", "count": 2, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": "auto",
    }
    files = {"file": ("clip.mp4", b"fake-video", "video/mp4")}

    with TestClient(app) as client:
        smart = client.post("/api/v1/jobs/clip", data=data, files=files)
        assert smart.status_code == 202, smart.text
        assert smart.json()["job"]["processingMode"] == "smart"

        monkeypatch.setattr("engine.app.profiles.smart_available", lambda: False)
        fast = client.post("/api/v1/jobs/clip", data=data, files=files)
        assert fast.status_code == 202, fast.text
        assert fast.json()["job"]["processingMode"] == "fast"

        # Explicit fast is never upgraded
        data["processing_mode"] = "fast"
        monkeypatch.setattr("engine.app.profiles.smart_available", lambda: True)
        explicit = client.post("/api/v1/jobs/clip", data=data, files=files)
        assert explicit.status_code == 202, explicit.text
        assert explicit.json()["job"]["processingMode"] == "fast"