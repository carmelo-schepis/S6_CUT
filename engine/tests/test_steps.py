from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from engine import media as media_module
from engine.app import settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager, QueueFullError, _probe_detail, _source_quality_warnings
from engine.library import LibraryRules
from engine.media import MediaError
from engine.models import Clip, Job, ProcessingStep, Project, ScoreBreakdown
from engine.providers import ProfileService
from engine.openrouter_tts import TTSResult
from engine.security import SecretVault
from engine.selection import Candidate


def test_probe_detail_tolerates_legacy_metadata() -> None:
    assert _probe_detail({"duration": 120, "width": 1920, "height": 1080, "frame_rate": "29.97"}) == "Source validated — 120.0s at 1920×1080 / 29.97 fps"
    assert _probe_detail({"duration": 120, "width": 1920, "height": 1080}) == "Source validated — 120.0s at 1920×1080"
    assert _probe_detail({"duration": "120"}) == "Source validated — 120.0s"
    assert _probe_detail({"duration": 120, "frame_rate": float("nan")}) == "Source validated — 120.0s"


def test_source_quality_warnings_are_rotation_aware_and_idempotent_inputs() -> None:
    assert _source_quality_warnings({"width": 640, "height": 360, "rotation": 0})
    assert not _source_quality_warnings({"width": 720, "height": 1280, "rotation": 0})
    assert not _source_quality_warnings({"width": 1920, "height": 1080, "rotation": 0})
    assert not _source_quality_warnings({"width": 0, "height": 360})

SAMPLE_WORDS = [
    {"text": "The", "start": 0.0, "end": 0.3, "confidence": 0.9},
    {"text": "Beatles", "start": 0.3, "end": 0.8, "confidence": 0.9},
    {"text": "changed", "start": 0.8, "end": 1.3, "confidence": 0.9},
    {"text": "popular", "start": 1.3, "end": 1.8, "confidence": 0.9},
    {"text": "music.", "start": 1.8, "end": 2.4, "confidence": 0.9},
]

FAST_IDS = ["source", "probe", "plan", "render", "verify", "ready"]
SMART_IDS = ["source", "probe", "audio", "transcribe", "openrouter", "local_planning", "select", "boundaries", "render", "verify", "ready"]
SCRIPT_IDS = ["validate", "planning", "script_generation", "narration", "tts", "local_voice", "align", "plan", "assets", "render", "verify", "ready"]


def _tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-steps-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    test_settings = replace(settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    test_profiles = ProfileService(test_db, vault)
    test_rules = LibraryRules(test_db, tmp_path / "library")
    test_manager = JobManager(test_db, test_rules, test_profiles, test_settings)
    return test_db, test_manager


def _project(db_: Database, project_id: str, mode: str = "clip", count: int = 3) -> None:
    project = Project(
        id=project_id, name=project_id, mode=mode, style="educational",
        state="queued", source_name="source.mp4", source_kind="upload",
        requested_count=count,
    )
    db_.save_project(project)


def _clip_job(db_: Database, job_id: str, project_id: str, *, mode: str = "fast", source: Path, count: int = 3) -> None:
    _project(db_, project_id, count=count)
    private: dict[str, object] = {
        "source_path": str(source), "count": count, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": mode,
    }
    job = Job(
        id=job_id, project_id=project_id, mode="clip", processing_mode=mode,
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    db_.save_job(job, private)


def _script_job(db_: Database, job_id: str, project_id: str, *, script: str, narration: str = "auto") -> None:
    _project(db_, project_id, mode="script")
    job = Job(
        id=job_id, project_id=project_id, mode="script",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    db_.save_job(job, {"script": script, "aspect_ratio": "9:16", "narration": narration})


def _fake_probe(_: Any, __: Settings) -> dict[str, Any]:
    return {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": True, "audio_codec": "aac"}


def _fake_plan(duration: float, count: int, min_duration: float, max_duration: float, guard: float) -> tuple[list[tuple[float, float]], str | None]:
    return [(0.0, 10.0), (12.0, 22.0), (24.0, 34.0)], ""


def _fake_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered")


def _fake_render_clip(source: Path, output: Path, *, start: float, end: float, aspect: str, words: list[dict[str, Any]], visuals: list[Any], overlays: list[Any], settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered-clip")


def _fake_transcribe(_: Any, __: Settings, **___: Any) -> dict[str, Any]:
    return {"language": "en", "words": SAMPLE_WORDS, "segments": [{"start": 0.0, "end": 2.4, "text": "The Beatles changed popular music."}]}


def _fake_extract(source: Path, settings: Settings, *, output: Path | None = None) -> Path:
    target = output or source.with_suffix(".wav")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"audio")
    return target


def _fake_select(words: list[dict[str, Any]], style: str, count: int, minimum: float, maximum: float) -> list[Candidate]:
    score = ScoreBreakdown(hook=80, coherence=80, ending=80, energy=70, practical_value=75, visual_potential=80, completeness=85, penalties=0, total=80, explanation="fixture")
    return [
        Candidate(0.0, 2.4, SAMPLE_WORDS, score),
        Candidate(3.0, 5.4, SAMPLE_WORDS, score),
        Candidate(6.0, 8.4, SAMPLE_WORDS, score),
    ]


def _fake_render_script(output: Path, *, duration: float, aspect: str, narration: Path | None, words: list[dict[str, Any]], visuals: list[Any], overlays: list[Any], settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"script-video")


def _assert_step_invariants(job: Job) -> None:
    """Enforce the accuracy invariants from the processing checklist spec."""
    active = [step for step in job.steps if step.status == "active"]
    assert len(active) <= 1
    for step in job.steps:
        if step.status == "pending":
            assert step.completed_at is None, f"{step.id} pending with a completion timestamp"
        else:
            assert step.completed_at is not None, f"{step.id} terminal without a completion timestamp"
        if step.current_item is not None and step.total_items is not None:
            assert step.current_item <= step.total_items
    if job.state in {"queued", "active", "paused", "recovered"}:
        ready = next((step for step in job.steps if step.id == "ready"), None)
        if ready:
            assert ready.status != "complete"


# ---------------------------------------------------------------------------
#  Model + migration
# ---------------------------------------------------------------------------


def test_processing_step_model_validates_fields() -> None:
    step = ProcessingStep(id="source", label="Source received")
    assert step.status == "pending"
    assert step.completed_at is None
    assert step.current_item is None
    assert step.model_dump(by_alias=True)["currentItem"] is None
    with pytest.raises(ValueError):
        ProcessingStep(id="s", label="X", status="done")
    with pytest.raises(ValueError):
        ProcessingStep(id="s", label="X", status="active", current_item=-1)


def test_legacy_job_without_steps_loads_empty() -> None:
    payload = {
        "schemaVersion": 1, "id": "legacy-load", "projectId": "p", "mode": "clip",
        "state": "queued", "stage": "queued", "stageLabel": "Queued", "progress": 0,
        "style": "educational", "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
    }
    job = Job.model_validate_json(json.dumps(payload))
    assert job.steps == []


def test_legacy_complete_job_keeps_empty_steps(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "legacy-done-proj")
    job = Job(
        id="legacy-done", project_id="legacy-done-proj", mode="clip", processing_mode="fast",
        state="complete", stage="complete", stage_label="Done", progress=100, style="educational",
    )
    test_db.save_job(job, {"source_path": "/nonexistent"})
    loaded = test_db.get_job("legacy-done")
    test_manager._init_steps(loaded, test_db.get_job_private("legacy-done"))
    assert loaded.steps == []


def test_legacy_active_smart_job_restores_only_proven_steps(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "legacy-resume-proj")
    job_id = "legacy-resume"
    source = tmp_path / "jobs" / job_id / "source" / "source.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fake")
    output_dir = tmp_path / "jobs" / job_id / "clips"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "01-clip.mp4").write_bytes(b"x")
    (output_dir / "02-clip.mp4").write_bytes(b"x")
    clips = [
        Clip(id="c1", index=1, state="complete", start=0, end=10, duration=10, opening_line="One", output_name="01-clip.mp4"),
        Clip(id="c2", index=2, state="complete", start=12, end=22, duration=10, opening_line="Two", output_name="02-clip.mp4"),
    ]
    private: dict[str, object] = {
        "source_path": str(source), "count": 2, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": "smart", "transcript": _fake_transcribe(source, settings),
    }
    job = Job(
        id=job_id, project_id="legacy-resume-proj", mode="clip", processing_mode="smart",
        state="active", stage="render", stage_label="Rendering", progress=50,
        style="educational", clips=clips,
    )
    test_db.save_job(job, private)
    loaded = test_db.get_job(job_id)
    test_manager._init_steps(loaded, test_db.get_job_private(job_id))
    assert [step.id for step in loaded.steps] == SMART_IDS
    steps = {step.id: step for step in loaded.steps}
    for step_id in ("source", "transcribe", "local_planning", "select", "boundaries"):
        assert steps[step_id].status == "complete", step_id
        assert steps[step_id].completed_at is not None
    assert steps["probe"].status == "pending"
    assert steps["audio"].status == "skipped"
    assert "history unavailable" in steps["audio"].detail
    assert steps["render"].current_item == 2
    assert steps["render"].total_items == 2
    assert steps["verify"].status == "pending"
    assert steps["ready"].status == "pending"


def test_legacy_active_fast_job_restores_probe_and_plan_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "legacy-fast-proj")
    job_id = "legacy-fast"
    clips = [
        Clip(id="c1", index=1, state="queued", start=0, end=10, duration=10, opening_line="Fast cut 1"),
        Clip(id="c2", index=2, state="queued", start=12, end=22, duration=10, opening_line="Fast cut 2"),
    ]
    job = Job(
        id=job_id, project_id="legacy-fast-proj", mode="clip", processing_mode="fast",
        state="recovered", stage="render", stage_label="Recovered", progress=40,
        style="educational", clips=clips,
    )
    test_db.save_job(job, {"source_path": "/mounted/source.mp4", "processing_mode": "fast"})
    loaded = test_db.get_job(job_id)
    test_manager._init_steps(loaded, test_db.get_job_private(job_id))
    steps = {step.id: step for step in loaded.steps}
    assert [step.id for step in loaded.steps] == FAST_IDS
    assert steps["probe"].status == "pending"
    assert steps["source"].status == "pending"
    assert steps["plan"].status == "complete"
    # no transcript → nothing transcription-related is proven; no audio step exists in fast mode
    assert "transcribe" not in steps
    assert steps["render"].status == "pending"
    assert steps["render"].total_items == 2


# ---------------------------------------------------------------------------
#  Fast checklist
# ---------------------------------------------------------------------------


def test_fast_checklist_exact_and_no_irrelevant_steps(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    source = tmp_path / "fast.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "fast-ck", "fast-ck-proj", mode="fast", source=source, count=3)

    test_manager._process("fast-ck")
    job = test_db.get_job("fast-ck")
    assert job is not None
    assert job.state == "complete"
    assert [step.id for step in job.steps] == FAST_IDS
    assert [step.label for step in job.steps] == [
        "Source received", "Video validated", "Cut points planned", "Clips rendered and saved", "Outputs verified", "Project ready",
    ]
    for step in job.steps:
        assert step.status == "complete"
        assert step.completed_at is not None
    forbidden = {"audio", "transcribe", "select", "boundaries", "tts", "local_voice", "openrouter", "llm_planning"}
    assert not (forbidden & {step.id for step in job.steps})
    render_step = next(step for step in job.steps if step.id == "render")
    assert (render_step.current_item, render_step.total_items) == (3, 3)
    assert render_step.detail == "3 of 3 rendered"
    verify_step = next(step for step in job.steps if step.id == "verify")
    assert verify_step.detail == "3 of 3 outputs verified"
    ready_step = next(step for step in job.steps if step.id == "ready")
    assert ready_step.detail == "Project ready"


def test_render_item_increments_after_each_validated_output(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    source = tmp_path / "incr.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "incr-fast", "incr-fast-proj", mode="fast", source=source, count=3)

    snapshots: list[int] = []
    original_save = test_manager._save

    def spy_save(job: Job, private: dict[str, Any] | None = None) -> None:
        original_save(job, private)
        if job.id == "incr-fast" and job.stage == "render":
            step = next((item for item in job.steps if item.id == "render"), None)
            if step and step.current_item is not None and step.current_item not in snapshots:
                snapshots.append(step.current_item)

    monkeypatch.setattr(test_manager, "_save", spy_save)
    test_manager._process("incr-fast")

    assert snapshots == [1, 2, 3]
    job = test_db.get_job("incr-fast")
    render_step = next(step for step in job.steps if step.id == "render")
    assert (render_step.current_item, render_step.total_items) == (3, 3)


def test_partial_checklist_keeps_successes_and_detail(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    def err_second(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        if abs(end - 22.0) < 0.01:
            raise MediaError("boom-second-window")
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", err_second)

    source = tmp_path / "partial.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "partial-ck", "partial-ck-proj", mode="fast", source=source, count=3)

    test_manager._process("partial-ck")
    job = test_db.get_job("partial-ck")
    assert job is not None
    assert job.state == "partial"
    _assert_step_invariants(job)
    steps = {step.id: step for step in job.steps}
    for step_id in ("source", "probe", "plan"):
        assert steps[step_id].status == "complete", step_id
    assert steps["render"].status == "complete"
    assert "2 of 3 rendered" in steps["render"].detail
    assert "1 failed" in steps["render"].detail
    assert steps["verify"].status == "complete"
    assert "2 of 3 outputs verified" in steps["verify"].detail
    assert steps["ready"].status == "complete"
    assert "(partial)" in steps["ready"].detail
    failed_clip = next(clip for clip in job.clips if clip.state == "failed")
    assert failed_clip.error == "boom-second-window"
    assert failed_clip.selected is False
    assert len([clip for clip in job.clips if clip.state == "complete"]) == 2


# ---------------------------------------------------------------------------
#  Smart checklist
# ---------------------------------------------------------------------------


def test_smart_transcription_completes_only_after_persisted(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)

    source = tmp_path / "smart.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "smart-ck", "smart-ck-proj", mode="smart", source=source, count=3)

    captured: dict[str, bool] = {}
    original_complete = test_manager.complete_step

    def spy_complete(job: Job, step_id: str, **kwargs: Any) -> None:
        if step_id == "transcribe":
            captured["transcript_persisted"] = test_db.get_job_private("smart-ck").get("transcript") is not None
        original_complete(job, step_id, **kwargs)

    monkeypatch.setattr(test_manager, "complete_step", spy_complete)

    test_manager._process("smart-ck")
    job = test_db.get_job("smart-ck")
    assert job is not None
    assert job.state == "complete"
    assert captured.get("transcript_persisted") is True, "transcribe completed before the transcript was persisted"
    assert [step.id for step in job.steps] == SMART_IDS
    steps = {step.id: step for step in job.steps}
    assert steps["transcribe"].status == "complete"
    assert "segments" in steps["transcribe"].detail
    private = test_db.get_job_private("smart-ck")
    assert private["transcript"]["language"] == "en"
    assert steps["openrouter"].status == "skipped"
    assert steps["openrouter"].detail == "No connected provider; used local planning"
    assert steps["local_planning"].status == "complete"
    assets = test_db.list_assets()
    assert len([asset for asset in assets if asset.origin == "generated-clip"]) == len(job.clips)
    assert all(clip.blob_id for clip in job.clips)
    _assert_step_invariants(job)


def test_openrouter_failure_records_local_planning_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)

    async def provider_failure(*_: Any, **__: Any):
        raise RuntimeError("provider response unavailable")

    monkeypatch.setattr(test_manager.profiles, "openrouter_json", provider_failure)
    source = tmp_path / "smart-provider.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "smart-provider", "smart-provider-proj", mode="smart", source=source, count=3)
    job = test_db.get_job("smart-provider")
    private = test_db.get_job_private("smart-provider")
    private["use_openrouter"] = True
    job.steps = test_manager._smart_steps(True)
    test_db.save_job(job, private)

    test_manager._process("smart-provider")
    result = test_db.get_job("smart-provider")
    assert result.state == "complete"
    steps = {step.id: step for step in result.steps}
    assert steps["openrouter"].status == "failed"
    assert "unreadable response" in steps["openrouter"].detail
    assert steps["local_planning"].status == "complete"
    assert steps["select"].status == "complete"


def test_music_downloaded_source_rejects_impossible_count_after_probe(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    source = tmp_path / "downloaded-music.mp4"
    source.write_bytes(b"downloaded-fixture")
    _clip_job(test_db, "music-feasible", "music-feasible-proj", mode="smart", source=source, count=11)
    job = test_db.get_job("music-feasible")
    private = test_db.get_job_private(job.id)
    job.source_profile = "music"
    private["url"] = "https://www.youtube.com/watch?v=fixture"
    test_db.save_job(job, private)

    test_manager._process("music-feasible")
    result = test_db.get_job("music-feasible")
    assert result is not None
    assert result.state == "failed"
    assert "at most 10" in (result.error or "")
    assert result.clips == []


def test_music_smart_path_replaces_sparse_checkpoint_and_keeps_bounded_windows(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr(media_module, "is_whisper_model_cached", lambda *_args, **_kwargs: True)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)
    source = tmp_path / "music-source.mp4"
    source.write_bytes(b"fixture")
    _clip_job(test_db, "music-checkpoint", "music-checkpoint-proj", mode="smart", source=source, count=5)
    job = test_db.get_job("music-checkpoint")
    private = test_db.get_job_private(job.id)
    job.source_profile = "music"
    private["transcript"] = {"language": "en", "words": [{"text": "old", "start": 0, "end": 1}], "segments": []}
    private["transcript_cache_key"] = "transcript:v2:legacy"
    test_db.save_job(job, private)
    calls: list[dict[str, Any]] = []
    lyric_words = []
    for line in range(8):
        start = float(line * 12)
        lyric_words.extend([
            {"text": f"Lyric{line}", "start": start, "end": start + 4, "confidence": .9},
            {"text": "continues", "start": start + 4.2, "end": start + 9, "confidence": .9},
        ])

    def music_transcribe(_: Path, __: Settings, **kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"language": "en", "words": lyric_words, "segments": [{"start": 0, "end": 93, "text": "sung words"}]}

    monkeypatch.setattr(media_module, "transcribe", music_transcribe)
    test_manager._process("music-checkpoint")
    result = test_db.get_job("music-checkpoint")
    saved = test_db.get_job_private("music-checkpoint")
    assert result.state == "complete"
    assert calls and calls[0]["profile"] == "music"
    assert saved["transcript_cache_key"].startswith("transcript:v3:")
    assert saved["transcript"]["words"][0]["text"] == "Lyric0"
    assert len(result.clips) == 4
    assert all(10 <= clip.duration <= 30 for clip in result.clips)
    assert all(left.end <= right.start for left, right in zip(result.clips, result.clips[1:]))
    assert any("instead of 5" in warning and "no clips were padded or duplicated" in warning for warning in result.warnings), result.warnings
    transcription_step = next(step for step in result.steps if step.id == "transcribe")
    assert "lyric coverage is not guaranteed" in transcription_step.detail
    provider_step = next(step for step in result.steps if step.id == "openrouter")
    assert provider_step.detail == "Music profile stays local; provider planning skipped"


def test_smart_transcription_reports_real_incremental_checkpoints(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)
    snapshots: list[tuple[int | None, int | None]] = []

    def progressive_transcribe(_: Path, __: Settings, *, progress_callback, cancellation_callback, **___: Any):
        assert cancellation_callback() is False
        for fraction in (.25, .5, .8):
            progress_callback(fraction, "ignored transcript text")
            persisted = test_db.get_job("smart-progress")
            step = next(item for item in persisted.steps if item.id == "transcribe")
            assert step.status == "active"
            assert step.completed_at is None
            snapshots.append((step.current_item, step.total_items))
        return _fake_transcribe(None, settings)

    monkeypatch.setattr(media_module, "transcribe", progressive_transcribe)
    source = tmp_path / "smart-progress.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "smart-progress", "smart-progress-proj", mode="smart", source=source, count=3)
    test_manager._process("smart-progress")

    assert snapshots == [(25, 100), (50, 100), (80, 100)]
    result = test_db.get_job("smart-progress")
    assert result.state == "complete"
    assert next(step for step in result.steps if step.id == "transcribe").status == "complete"


def test_switch_fast_cancels_active_transcription_without_resurrecting_job(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    entered = threading.Event()

    def cancellable_transcribe(_: Path, __: Settings, *, cancellation_callback, **___: Any):
        entered.set()
        deadline = time.time() + 5
        while time.time() < deadline:
            if cancellation_callback():
                raise media_module.TranscriptionCancelled("switched")
            time.sleep(.01)
        raise AssertionError("Smart transcription was not cancelled")

    monkeypatch.setattr(media_module, "transcribe", cancellable_transcribe)
    source = tmp_path / "switch-progress.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "switch-progress", "switch-progress-proj", mode="smart", source=source, count=3)
    worker = threading.Thread(target=test_manager._process, args=("switch-progress",))
    worker.start()
    assert entered.wait(2)
    replacement = asyncio.run(test_manager.control("switch-progress", "switch-fast"))
    worker.join(5)

    assert not worker.is_alive()
    old = test_db.get_job("switch-progress")
    assert old.state == "cancelled_kept"
    assert all(step.status != "active" for step in old.steps)
    assert replacement.processing_mode == "fast"
    assert test_db.get_job_private(replacement.id)["source_path"] == str(source)


def test_smart_failed_clip_partial_keeps_transcription_checks(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)

    def err_middle(source: Path, output: Path, *, start: float, end: float, aspect: str, words: list[dict[str, Any]], visuals: list[Any], overlays: list[Any], settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        if abs(start - 3.0) < 0.01:
            raise MediaError("smart-render-boom")
        output.write_bytes(b"ok")

    monkeypatch.setattr("engine.jobs.render_clip", err_middle)

    source = tmp_path / "smart-partial.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "smart-partial", "smart-partial-proj", mode="smart", source=source, count=3)

    test_manager._process("smart-partial")
    job = test_db.get_job("smart-partial")
    assert job is not None
    assert job.state == "partial"
    _assert_step_invariants(job)
    steps = {step.id: step for step in job.steps}
    # validated upstream work stays checked
    for step_id in ("source", "probe", "audio", "transcribe", "local_planning", "select", "boundaries"):
        assert steps[step_id].status == "complete", step_id
    assert steps["render"].status == "complete"
    assert "1 failed" in steps["render"].detail


# ---------------------------------------------------------------------------
#  Script checklist + narration fallbacks
# ---------------------------------------------------------------------------


def _script_pipeline_fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("engine.jobs.probe_audio", lambda *a, **kw: {"duration": 6.0, "audio_codec": "wav"})
    monkeypatch.setattr(
        "engine.jobs.transcribe",
        lambda *a, **kw: {
            "words": [
                {"text": text, "start": index * 0.9, "end": (index + 1) * 0.9, "confidence": 0.9}
                for index, text in enumerate(["The", "Beatles", "changed", "popular", "music", "forever."])
            ]
        },
    )
    monkeypatch.setattr("engine.jobs.render_script", _fake_render_script)


def test_script_tts_failure_local_fallback_records_both(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)

    def fail_tts(self: ProfileService, text: str, output: Path, **kwargs: Any):
        raise MediaError("openrouter-tts-api-down")

    monkeypatch.setattr(ProfileService, "synthesize_openrouter", fail_tts)
    monkeypatch.setattr("engine.jobs.available", lambda *a: True)

    def fake_local(text: str, output: Path, settings: Settings) -> Path:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"local-narration")
        return output

    monkeypatch.setattr("engine.jobs.synthesize_local", fake_local)
    _script_pipeline_fakes(monkeypatch)

    script = "The Beatles changed popular music forever."
    _script_job(test_db, "script-fallback", "script-fallback-proj", script=script, narration="auto")
    test_manager._process("script-fallback")

    job = test_db.get_job("script-fallback")
    assert job is not None
    assert job.state == "complete"
    _assert_step_invariants(job)
    steps = {step.id: step for step in job.steps}
    assert [step.id for step in job.steps] == SCRIPT_IDS
    assert steps["tts"].status == "failed"
    assert "openrouter-tts-api-down" in steps["tts"].detail
    assert steps["tts"].completed_at is not None
    assert steps["local_voice"].status == "complete"
    assert steps["narration"].status == "complete"
    assert any("used the local voice fallback" in warning for warning in job.warnings)
    for step_id in ("validate", "align", "plan", "assets", "render", "verify", "ready"):
        assert steps[step_id].status == "complete", step_id


def test_script_tts_success_records_only_that_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)

    def ok_tts(self: ProfileService, text: str, output: Path, **kwargs: Any):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"openrouter-narration")
        return TTSResult(model="free/speech", voice="alloy")

    monkeypatch.setattr(ProfileService, "synthesize_openrouter", ok_tts)
    _script_pipeline_fakes(monkeypatch)

    script = "The Beatles changed popular music forever."
    _script_job(test_db, "script-premium", "script-premium-proj", script=script, narration="auto")
    test_manager._process("script-premium")

    job = test_db.get_job("script-premium")
    assert job is not None
    assert job.state == "complete"
    steps = {step.id: step for step in job.steps}
    assert steps["tts"].status == "complete"
    assert steps["local_voice"].status == "skipped"
    assert steps["local_voice"].detail == "OpenRouter narration succeeded"
    assert steps["narration"].status == "complete"


def test_script_reuses_completed_openrouter_narration_without_regenerating(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _script_pipeline_fakes(monkeypatch)
    candidate = tmp_path / "jobs" / "script-reuse" / "narration-openrouter.mp3"
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_bytes(b"completed-openrouter-audio")
    def forbidden(*args: Any, **kwargs: Any):
        raise AssertionError("completed narration must be reused")
    monkeypatch.setattr(ProfileService, "synthesize_openrouter", forbidden)
    _script_job(test_db, "script-reuse", "script-reuse-proj", script="The Beatles changed popular music forever.", narration="auto")
    test_manager._process("script-reuse")
    job = test_db.get_job("script-reuse")
    assert job and {step.id: step for step in job.steps}["tts"].detail == "Reused completed OpenRouter narration"


def test_script_silent_marks_narration_steps_skipped(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.render_script", _fake_render_script)

    script = "The Beatles changed popular music forever."
    _script_job(test_db, "script-silent", "script-silent-proj", script=script, narration="silent")
    test_manager._process("script-silent")

    job = test_db.get_job("script-silent")
    assert job is not None
    assert job.state == "complete"
    _assert_step_invariants(job)
    steps = {step.id: step for step in job.steps}
    assert steps["narration"].status == "skipped"
    assert steps["narration"].detail == "Silent render selected"
    assert steps["planning"].status == "skipped"
    assert steps["script_generation"].status == "skipped"
    assert steps["tts"].status == "skipped"
    assert steps["local_voice"].status == "skipped"
    assert steps["render"].status == "complete"
    assert steps["verify"].status == "complete"
    outputs = [asset for asset in test_db.list_assets() if asset.origin == "script-output"]
    assert len(outputs) == 1
    assert outputs[0].title == "script-silent-proj — Script video"
    assert job.clips[0].blob_id == outputs[0].blob_id


# ---------------------------------------------------------------------------
#  Controls: pause / stop-keep / retry / switch-fast
# ---------------------------------------------------------------------------


def _control_job(test_db: Database, test_manager: JobManager, job_id: str, mode: str = "fast") -> None:
    _project(test_db, f"{job_id}-proj")
    job = Job(
        id=job_id, project_id=f"{job_id}-proj", mode="clip", processing_mode=mode,
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    test_db.save_job(job, {"processing_mode": mode})


def test_pause_preserves_active_step(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _control_job(test_db, test_manager, "pause-ck")
    job = test_db.get_job("pause-ck")
    job.steps = test_manager._fast_steps()
    render = job.steps[3]
    render.status = "active"
    render.detail = "Rendering clip 2 of 5"
    render.current_item = 1
    render.total_items = 5
    test_db.save_job(job, test_db.get_job_private("pause-ck"))

    result = asyncio.run(test_manager.control("pause-ck", "pause"))
    assert result.state == "paused"
    assert result.steps[3].status == "active"
    assert result.steps[3].detail.startswith("Paused — ")
    # completed source/probe/plan rows are untouched
    assert result.steps[0].status == "pending"


def test_stop_keep_skips_pending_and_preserves_terminal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _control_job(test_db, test_manager, "stop-keep-ck")
    job = test_db.get_job("stop-keep-ck")
    job.steps = test_manager._fast_steps()
    job.steps[0].status = "complete"
    job.steps[0].completed_at = "2026-01-01T00:00:00Z"
    job.steps[1].status = "active"
    job.steps[1].started_at = "2026-01-01T00:00:00Z"
    job.steps[1].detail = "Running FFprobe validation"
    test_db.save_job(job, test_db.get_job_private("stop-keep-ck"))

    result = asyncio.run(test_manager.control("stop-keep-ck", "stop-keep"))
    assert result.state == "cancelled_kept"
    assert result.steps[0].status == "complete"
    assert result.steps[0].completed_at == "2026-01-01T00:00:00Z"
    assert result.steps[1].status == "skipped"
    assert result.steps[1].detail == "Stopped by user"
    for step in result.steps[2:]:
        assert step.status == "skipped"
        assert step.detail == "Stopped by user"
        assert step.completed_at is not None


def test_retry_import_requeues_stopped_attempt_and_deduplicates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "youtube-retry-project")
    job = Job(
        id="youtube-retry", project_id="youtube-retry-project", mode="clip", processing_mode="fast",
        state="cancelled_kept", stage="source", stage_label="Stopped; completed outputs kept", progress=5, style="educational",
    )
    private = {"url": "https://www.youtube.com/watch?v=fixture", "processing_mode": "fast"}
    test_db.save_job(job, private)

    result = asyncio.run(test_manager.control("youtube-retry", "retry-import"))
    assert result.state == "queued"
    assert result.stage_label == "Retrying YouTube import"
    assert test_db.get_job("youtube-retry").state == "queued"
    assert test_manager.queue.qsize() == 1

    called: list[str] = []
    monkeypatch.setattr(test_manager, "_process_clip", lambda current, _: called.append(current.id))
    test_manager._process("youtube-retry")
    assert called == ["youtube-retry"]

    with pytest.raises(MediaError, match="already queued or running"):
        asyncio.run(test_manager.control("youtube-retry", "retry-import"))
    assert test_manager.queue.qsize() == 1


def test_retry_resets_only_render_verify_ready(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    def err_second(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        if abs(end - 22.0) < 0.01:
            raise MediaError("retry-me")
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", err_second)

    source = tmp_path / "retry.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "retry-ck", "retry-ck-proj", mode="fast", source=source, count=3)
    test_manager._process("retry-ck")
    assert test_db.get_job("retry-ck").state == "partial"

    result = asyncio.run(test_manager.control("retry-ck", "retry-failed"))
    assert result.state == "queued"
    steps = {step.id: step for step in result.steps}
    for step_id in ("source", "probe", "plan"):
        assert steps[step_id].status == "complete", step_id
    for step_id in ("render", "verify", "ready"):
        assert steps[step_id].status == "pending", step_id
        assert steps[step_id].detail == "Retrying failed outputs"
        assert steps[step_id].completed_at is None
    assert steps["render"].current_item == 2
    assert steps["render"].total_items == 3
    assert len([clip for clip in result.clips if clip.state == "queued"]) == 1
    assert len([clip for clip in result.clips if clip.state == "complete"]) == 2

    # retry run re-renders only the failed clip and completes
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    test_manager._process("retry-ck")
    final = test_db.get_job("retry-ck")
    assert final is not None
    assert final.state == "complete"
    final_steps = {step.id: step for step in final.steps}
    assert final_steps["render"].status == "complete"
    assert final_steps["render"].detail == "3 of 3 rendered"
    assert all(clip.state == "complete" for clip in final.clips)
    assert all(step.status == "complete" for step in final.steps)
    _assert_step_invariants(final)


def test_switch_fast_initializes_checklist_and_skips_replaced(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "sw-proj")
    source = tmp_path / "jobs" / "sw-old" / "source" / "source.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"source")
    old = Job(
        id="sw-old", project_id="sw-proj", mode="clip", processing_mode="smart",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
        steps=test_manager._smart_steps(),
    )
    old.steps[0].status = "complete"
    old.steps[0].completed_at = "2026-01-01T00:00:00Z"
    test_db.save_job(old, {"source_path": str(source), "processing_mode": "smart"})

    new_job = asyncio.run(test_manager.control("sw-old", "switch-fast"))
    assert [step.id for step in new_job.steps] == FAST_IDS
    assert all(step.status == "pending" for step in new_job.steps)

    old_after = test_db.get_job("sw-old")
    assert old_after is not None
    assert old_after.state == "cancelled_kept"
    assert old_after.steps[0].status == "complete"
    assert all(step.status == "skipped" for step in old_after.steps[1:])
    assert all(step.detail == "Replaced by a fast cut of the same source" for step in old_after.steps[1:] if step.id != "openrouter")


def test_switch_fast_queue_full_leaves_original_untouched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    source = tmp_path / "queue-source.mp4"
    source.write_bytes(b"source")
    _clip_job(test_db, "queue-smart", "queue-smart-proj", mode="smart", source=source)
    while not test_manager.queue.full():
        test_manager.queue.put_nowait(f"block-{test_manager.queue.qsize()}")

    with pytest.raises(QueueFullError):
        asyncio.run(test_manager.control("queue-smart", "switch-fast"))

    original = test_db.get_job("queue-smart")
    assert original.state == "queued"
    assert original.processing_mode == "smart"
    assert len([job for job in test_db.list_jobs() if job.project_id == original.project_id]) == 1


def test_url_import_marks_source_step(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)

    def fake_download(url: str, target_dir: Path, settings: Settings) -> Path:
        target_dir.mkdir(parents=True, exist_ok=True)
        source = target_dir / "source.mp4"
        source.write_bytes(b"downloaded")
        return source

    monkeypatch.setattr("engine.jobs.download_youtube", fake_download)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _project(test_db, "url-proj")
    job = Job(
        id="url-1", project_id="url-proj", mode="clip", processing_mode="fast",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    test_db.save_job(job, {"url": "https://www.youtube.com/watch?v=abc123", "count": 3, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16", "processing_mode": "fast"})

    test_manager._process("url-1")
    job = test_db.get_job("url-1")
    assert job is not None
    assert job.state == "complete"
    steps = {step.id: step for step in job.steps}
    assert steps["source"].status == "complete"
    assert "YouTube" in steps["source"].detail
    assert test_db.get_job_private("url-1")["source_path"]


def test_url_import_downloads_into_the_job_source_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The imported source lands in ``jobs/<job id>/source/``.

    Operator tooling and the QA harnesses locate the imported media by this
    layout, so the directory handed to ``download_youtube`` is a contract, not
    an implementation detail.
    """
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    seen: dict[str, Path] = {}

    def fake_download(url: str, target_dir: Path, settings: Settings) -> Path:
        seen["target_dir"] = target_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        source = target_dir / "source-abc123.mp4"
        source.write_bytes(b"downloaded")
        return source

    monkeypatch.setattr("engine.jobs.download_youtube", fake_download)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _project(test_db, "url-dir-proj")
    job = Job(
        id="url-dir-1", project_id="url-dir-proj", mode="clip", processing_mode="fast",
        state="queued", stage="queued", stage_label="Queued", progress=0, style="educational",
    )
    test_db.save_job(job, {"url": "https://www.youtube.com/watch?v=abc123", "count": 1, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16", "processing_mode": "fast"})

    test_manager._process("url-dir-1")

    expected = test_manager.settings.data_path / "jobs" / "url-dir-1" / "source"
    assert seen["target_dir"] == expected
    stored = Path(test_db.get_job_private("url-dir-1")["source_path"])
    assert stored.parent == expected
    assert stored.name.startswith("source-")


# ---------------------------------------------------------------------------
#  Invariants
# ---------------------------------------------------------------------------


def test_start_step_enforces_single_active(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _control_job(test_db, test_manager, "enforce-ck")
    job = test_db.get_job("enforce-ck")
    job.steps = test_manager._fast_steps()
    test_db.save_job(job, test_db.get_job_private("enforce-ck"))

    loaded = test_db.get_job("enforce-ck")
    test_manager.start_step(loaded, "probe")
    with pytest.raises(RuntimeError, match="still active"):
        test_manager.start_step(loaded, "plan")
    # the same step may be re-touched idempotently
    test_manager.start_step(loaded, "probe")


def test_ready_gate_never_complete_while_paused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _control_job(test_db, test_manager, "gate-ck")
    job = test_db.get_job("gate-ck")
    job.steps = test_manager._fast_steps()
    test_db.save_job(job, test_db.get_job_private("gate-ck"))

    result = asyncio.run(test_manager.control("gate-ck", "pause"))
    assert result.state == "paused"
    ready = next(step for step in result.steps if step.id == "ready")
    assert ready.status != "complete"
    assert ready.completed_at is None


def test_step_invariants_hold_for_all_modes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)

    # fast complete
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    source = tmp_path / "inv-fast.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "inv-fast", "inv-fast-proj", mode="fast", source=source, count=3)
    test_manager._process("inv-fast")
    _assert_step_invariants(test_db.get_job("inv-fast"))

    # smart complete
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)
    smart_source = tmp_path / "inv-smart.mp4"
    smart_source.write_bytes(b"fake")
    _clip_job(test_db, "inv-smart", "inv-smart-proj", mode="smart", source=smart_source, count=3)
    test_manager._process("inv-smart")
    _assert_step_invariants(test_db.get_job("inv-smart"))

    # script silent complete
    monkeypatch.setattr("engine.jobs.render_script", _fake_render_script)
    _script_job(test_db, "inv-script", "inv-script-proj", script="The Beatles changed popular music forever.", narration="silent")
    test_manager._process("inv-script")
    _assert_step_invariants(test_db.get_job("inv-script"))


def test_completed_steps_never_revert_on_polling(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    source = tmp_path / "poll.mp4"
    source.write_bytes(b"fake")
    _clip_job(test_db, "poll", "poll-proj", mode="fast", source=source, count=3)
    test_manager._process("poll")

    first = test_db.get_job("poll")
    second = test_db.get_job("poll")
    assert [(step.id, step.status) for step in first.steps] == [(step.id, step.status) for step in second.steps]
    assert all(step.status == "complete" for step in second.steps)
