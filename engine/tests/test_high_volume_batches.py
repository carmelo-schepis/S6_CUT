from __future__ import annotations

import json
import math
import shutil
import subprocess
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest
from pydantic import ValidationError

from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager, _high_volume_shortfall, _high_volume_smart_candidates, _spread_temporal_items, resolve_batch_target
from engine.library import LibraryRules
from engine.media import (
    MediaError,
    plan_fast_high_volume_windows,
    plan_fast_windows,
    plan_long_form_high_volume_windows,
    plan_long_form_windows,
    probe,
)
from engine.models import Clip, Job, Project, SelectionInput
from engine.providers import ProfileService
from engine.security import SecretVault


@pytest.mark.parametrize("requested", [1, 30, 31, 300, 500])
@pytest.mark.parametrize("duration", [600.0, 1200.0, 1799.9, 1800.0, 7200.0])
def test_high_volume_keeps_requested_target_until_planner_proves_a_shortage(requested, duration) -> None:
    assert resolve_batch_target(requested, "high_volume", duration) == (requested, None)


@pytest.mark.parametrize("invalid", [math.nan, math.inf, -1.0, 0.0])
def test_high_volume_requires_a_valid_ffprobe_duration(invalid) -> None:
    with pytest.raises(MediaError, match="FFprobe source duration"):
        resolve_batch_target(500, "high_volume", invalid)


@pytest.mark.parametrize("planner", [plan_fast_high_volume_windows, plan_long_form_high_volume_windows])
@pytest.mark.parametrize("duration", [600.0, 1200.0, 1799.9, 1800.0, 7200.0])
def test_short_and_landscape_planners_make_500_source_bounded_distinct_windows(planner, duration) -> None:
    windows, warning = planner(duration, 500, 8.0, 15.0)
    again, again_warning = planner(duration, 500, 8.0, 15.0)

    assert windows == again
    assert warning == again_warning == ""
    assert len(windows) == 500
    assert all(8.0 - 1e-6 <= end - start <= 15.0 + 1e-6 for start, end in windows)
    assert all(0 <= start < end <= duration for start, end in windows)
    starts = [start for start, _ in windows]
    assert len(set(starts)) == 500
    assert all(math.isclose(start * 10, round(start * 10), abs_tol=1e-9) for start in starts)
    assert all(right - left >= 0.1 for left, right in zip(starts, starts[1:]))
    assert starts[0] == 0.0
    assert starts[-1] > duration * 0.8
    if duration < 4000:
        assert any(left_end > right_start for (_, left_end), (right_start, _) in zip(windows, windows[1:]))


@pytest.mark.parametrize("planner", [plan_fast_high_volume_windows, plan_long_form_high_volume_windows])
def test_feasibility_shortfall_applies_short_source_fallback_only_after_planning(planner) -> None:
    # 500 is feasible on an under-30-minute source; duration alone never reduces it.
    feasible, warning = planner(1799.9, 500, 8.0, 15.0)
    assert len(feasible) == 500
    assert warning == ""

    # The planner proves that only 421 distinct windows fit; then the explicit
    # under-30-minute policy caps the effective target to min(500, 300, 421).
    possible, warning = planner(50.0, 500, 8.0, 15.0)
    assert len(possible) == 421
    assert "Target: 500. Planned: 421." in warning
    effective, reason = _high_volume_shortfall(500, len(possible), 50.0, "source-timeline")
    assert effective == 300
    assert "under 30 minutes" in reason
    assert "min(requested, 300, valid windows)" in reason
    assert "421 valid windows" in reason
    assert "effective target is 300" in reason

    # A tighter source can provide fewer than 300, so the valid-window count wins.
    possible, _ = planner(18.0, 500, 8.0, 15.0)
    assert len(possible) == 101
    effective, reason = _high_volume_shortfall(500, len(possible), 18.0, "source-timeline")
    assert effective == 101
    assert "effective target is 101" in reason

    too_short, warning = planner(7.99, 500, 8.0, 15.0)
    assert too_short == []
    assert "no window within the requested duration range" in warning
    effective, _ = _high_volume_shortfall(500, len(too_short), 7.99, "source-timeline")
    assert effective == 0


def test_long_source_shortfall_uses_real_candidate_capacity_without_short_source_cap() -> None:
    effective, reason = _high_volume_shortfall(500, 173, 1800.0, "timed-transcript")
    assert effective == 173
    assert "under 30 minutes" not in reason
    assert "173 valid windows" in reason
    assert "effective target is 173" in reason


def test_high_volume_smart_shortfall_reduces_count_without_losing_timeline_coverage() -> None:
    starts = [index * 2.0 for index in range(400)]

    reduced = _spread_temporal_items(starts, 300)

    assert len(reduced) == 300
    assert reduced[0] == starts[0]
    assert reduced[-1] == starts[-1]
    assert reduced == sorted(set(reduced))
    assert reduced[149] < starts[200] <= reduced[150]
    assert _spread_temporal_items(starts, 1) == [starts[200]]
    assert _spread_temporal_items(starts, 0) == []


def test_high_volume_smart_search_deduplicates_tenths_and_spreads_over_transcript() -> None:
    words = [
        {"text": f"word{index}", "start": index * 0.05, "end": index * 0.05 + 0.04}
        for index in range(2_000)
    ]
    candidates = _high_volume_smart_candidates(words, "serious", 400, 8.0, 10.0, 500.0)
    again = _high_volume_smart_candidates(words, "serious", 400, 8.0, 10.0, 500.0)

    assert candidates == again
    assert len(candidates) == 400
    starts = [round(candidate.start, 1) for candidate in candidates]
    assert len(set(starts)) == 400
    assert all(right.start - left.start >= 0.1 - 1e-9 for left, right in zip(candidates, candidates[1:]))
    assert max(candidate.start for candidate in candidates) > 80.0
    assert all(8.0 - 1e-6 <= candidate.end - candidate.start <= 10.0 + 1e-6 for candidate in candidates)
    assert all(0 <= candidate.start < candidate.end <= 500.0 for candidate in candidates)
    assert all(left.start < right.end and right.start < left.end for left, right in zip(candidates, candidates[1:]))


def test_high_volume_smart_quality_checks_scale_with_unique_starts(monkeypatch) -> None:
    from engine import jobs as jobs_module

    quality_checks = 0
    original_quality = jobs_module.candidate_quality

    def count_quality_checks(words, minimum_speech_density=0.18):
        nonlocal quality_checks
        quality_checks += 1
        return original_quality(words, minimum_speech_density)

    monkeypatch.setattr(jobs_module, "candidate_quality", count_quality_checks)
    words = [
        {"text": f"word{index}", "start": index * 0.05, "end": index * 0.05 + 0.04}
        for index in range(2_000)
    ]

    candidates = _high_volume_smart_candidates(words, "serious", 500, 8.0, 10.0, 120.0)

    assert len(candidates) == 500
    # Every ordinary speech window is valid, so only one transcript segment per
    # distinct tenth-second start needs the expensive quality scan.
    assert quality_checks < len(words) // 2


def test_high_volume_smart_discards_transcript_words_outside_real_source_duration() -> None:
    words = [
        {"text": f"word{index}", "start": index * 0.5, "end": index * 0.5 + 0.4}
        for index in range(100)
    ]
    candidates = _high_volume_smart_candidates(words, "serious", 500, 8.0, 10.0, 20.0)
    assert candidates
    assert all(candidate.end <= 20.0 for candidate in candidates)
    assert len({round(candidate.start, 1) for candidate in candidates}) == len(candidates)


@pytest.mark.parametrize("planner", [plan_fast_high_volume_windows, plan_long_form_high_volume_windows])
def test_high_volume_planners_report_too_short_source_and_respect_duration_bounds(planner) -> None:
    no_windows, reason = planner(7.99, 200, 8.0, 15.0)
    assert no_windows == []
    assert "no window within the requested duration range" in reason

    windows, _ = planner(600.0, 300, 30.0, 120.0)
    assert len(windows) == 300
    assert all(30.0 - 1e-6 <= end - start <= 120.0 + 1e-6 for start, end in windows)
    assert all(0 <= start < end <= 600.0 for start, end in windows)


def test_high_volume_mode_does_not_change_standard_nonoverlap_planners() -> None:
    for planner, minimum in ((plan_fast_windows, 8.0), (plan_long_form_windows, 30.0)):
        windows, _ = planner(1800.0, 30, minimum, 60.0, 1.0)
        assert len(windows) == 30
        assert all(left_end <= right_start for (_, left_end), (right_start, _) in zip(windows, windows[1:]))


def test_legacy_batch_metadata_defaults_and_selection_accepts_500() -> None:
    project = Project.model_validate({
        "schemaVersion": 1, "id": "p", "name": "Legacy", "mode": "clip", "style": "educational",
        "state": "queued", "sourceName": "source.mp4", "sourceKind": "upload", "requestedCount": 30,
    })
    job = Job.model_validate({
        "schemaVersion": 1, "id": "j", "projectId": "p", "mode": "clip", "state": "queued",
        "stage": "queued", "stageLabel": "Queued", "progress": 0, "style": "educational",
    })
    assert project.batch_mode == job.batch_mode == "standard"
    assert project.effective_target is None
    assert job.effective_target is None
    assert job.planned_count == job.successful_count == 0
    assert len(SelectionInput(clip_ids=[str(index) for index in range(500)]).clip_ids) == 500
    with pytest.raises(ValidationError):
        SelectionInput(clip_ids=[str(index) for index in range(501)])
    with pytest.raises(ValidationError):
        Project.model_validate({**project.model_dump(by_alias=True), "requestedCount": 501})
    with pytest.raises(ValidationError):
        Job.model_validate({**job.model_dump(by_alias=True), "requestedCount": 501})


def test_ffprobe_boundary_drives_500_window_feasibility(tmp_path: Path) -> None:
    settings = Settings.from_env()
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("requires FFmpeg and FFprobe for real-duration boundary verification")

    for requested_duration in (1799.9, 1800.0):
        source = tmp_path / f"boundary-{requested_duration}.mp4"
        subprocess.run([
            settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10", "-an", "-t", str(requested_duration),
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(source),
        ], check=True, capture_output=True, text=True)
        duration = float(probe(source, settings)["duration"])
        if requested_duration < 1800:
            assert duration < 1800
        else:
            assert duration >= 1800
        assert resolve_batch_target(500, "high_volume", duration) == (500, None)
        windows, warning = plan_fast_high_volume_windows(duration, 500, 8.0, 15.0)
        assert len(windows) == 500
        assert warning == ""


def _manager(tmp_path: Path) -> tuple[Database, JobManager, Settings]:
    settings = replace(Settings.from_env(), data_path=tmp_path)
    db = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), profiles, settings)
    return db, manager, settings


def test_recovered_high_volume_job_reuses_its_persisted_source_windows(monkeypatch, tmp_path: Path) -> None:
    from engine import jobs as jobs_module
    from engine import media as media_module

    db, manager, settings = _manager(tmp_path)
    project = Project(
        id="recovered-project", name="Recovered", mode="clip", style="serious", state="recovered",
        source_name="source.mp4", source_kind="upload", requested_count=500, batch_mode="high_volume",
        effective_target=3, cap_explanation="A test fixture persisted a 3-window feasible plan.",
    )
    db.save_project(project)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"fixture source")
    clip_dir = tmp_path / "jobs" / "recovered-job" / "clips"
    clip_dir.mkdir(parents=True)
    first_output = clip_dir / "01-cut.mp4"
    first_output.write_bytes(b"already published")
    persisted_windows = [(0.0, 8.0), (20.0, 28.0), (40.0, 48.0)]
    clips = [
        Clip(
            id=f"clip-{index}", index=index, state="complete" if index == 1 else "queued",
            start=start, end=end, duration=end - start, opening_line=f"Window {index}",
            output_name="01-cut.mp4" if index == 1 else None,
        )
        for index, (start, end) in enumerate(persisted_windows, start=1)
    ]
    job = Job(
        id="recovered-job", project_id=project.id, mode="clip", processing_mode="fast", content_format="short",
        state="recovered", stage="render", stage_label="Recovered render", progress=50, style="serious",
        requested_count=500, batch_mode="high_volume", effective_target=3,
        cap_explanation=project.cap_explanation, planned_count=3, successful_count=1, clips=clips,
    )
    private = {
        "source_path": str(source), "count": 500, "min_duration": 8.0, "max_duration": 15.0,
        "aspect_ratio": "16:9", "processing_mode": "fast", "content_format": "short",
        "batch_mode": "high_volume", "effective_target": 3, "cap_explanation": project.cap_explanation,
    }
    db.save_job(job, private)

    def fake_probe(path: Path, _: Settings) -> dict[str, object]:
        if path == source:
            return {"duration": 100.0, "width": 1920, "height": 1080, "audio": True}
        raise MediaError("test output probe fallback")

    def fake_render(_: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(f"rendered {start}-{end}".encode())

    def unexpected_replan(*_: object, **__: object):
        raise AssertionError("recovery must reuse the already persisted clip windows")

    monkeypatch.setattr(jobs_module, "probe", fake_probe)
    monkeypatch.setattr(media_module, "render_fast_clip", fake_render)
    monkeypatch.setattr(media_module, "plan_fast_high_volume_windows", unexpected_replan)
    manager._process(job.id)

    recovered = db.get_job(job.id)
    assert recovered is not None
    assert recovered.state == "complete"
    assert recovered.requested_count == 500
    assert recovered.effective_target == recovered.planned_count == recovered.successful_count == 3
    assert [(clip.start, clip.end) for clip in recovered.clips] == persisted_windows
    assert all(clip.state == "complete" for clip in recovered.clips)
    assert (clip_dir / "01-cut.mp4").read_bytes() == b"already published"
    stored_project = db.get_project(project.id)
    assert stored_project is not None
    assert stored_project.requested_count == 500
    assert stored_project.effective_target == 3
    assert stored_project.cap_explanation == project.cap_explanation
    assert db.get_job_private(job.id)["count"] == 500


def test_export_builds_a_500_output_zip_with_matching_manifest_and_credits(tmp_path: Path) -> None:
    db, manager, settings = _manager(tmp_path)
    project = Project(
        id="export-project", name="Five Hundred Outputs", mode="clip", style="serious", state="complete",
        source_name="Sintel — Blender", source_kind="youtube", source_creator="Blender",
        requested_count=500, batch_mode="high_volume", effective_target=500,
    )
    db.save_project(project)
    output_dir = settings.data_path / "jobs" / "export-job" / "clips"
    output_dir.mkdir(parents=True)
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("requires FFmpeg and FFprobe to create and validate MP4 publication fixtures")
    media_fixture = tmp_path / "valid-output-fixture.mp4"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=10", "-t", "1",
        "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(media_fixture),
    ], check=True, capture_output=True, text=True)
    assert probe(media_fixture, settings)["video_codec"] == "h264"
    clips = []
    for index in range(1, 501):
        name = f"{index:03d}-cut.mp4"
        output = output_dir / name
        shutil.copyfile(media_fixture, output)
        clip_id = f"clip-{index}"
        asset = manager.rules.register_managed_video(
            output, title=f"Published fixture {index}", origin="generated-clip",
            project_id=project.id, job_id="export-job", clip_id=clip_id, metadata={},
        )
        start = (index - 1) / 10
        clips.append(Clip(
            id=clip_id, index=index, state="complete", start=start, end=start + 10,
            duration=10, opening_line=f"Window {index}", output_name=name, title=f"Clip {index}",
            creator_credit="Source: Test Fixture", selected=True, library_asset_id=asset.id, blob_id=asset.blob_id,
        ))
    job = Job(
        id="export-job", project_id=project.id, mode="clip", processing_mode="fast", content_format="short",
        state="complete", stage="complete", stage_label="Complete", progress=100, style="serious",
        requested_count=500, batch_mode="high_volume", effective_target=500,
        planned_count=500, successful_count=500, total_items=500, current_item=500, clips=clips,
    )
    db.save_job(job, {})

    archive_path = manager.build_export(job.id, [clip.id for clip in clips])
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.namelist()
        manifest = json.loads(archive.read("Five Hundred Outputs/manifest.json"))
        credits = json.loads(archive.read("Five Hundred Outputs/credits.json"))

    video_entries = [name for name in entries if name.endswith(".mp4")]
    manifest_outputs = manifest["outputs"]
    credit_entries = credits["credits"]
    assert len(video_entries) == len(manifest_outputs) == len(credit_entries) == 500
    assert len(entries) == 503
    assert {entry["filename"] for entry in manifest_outputs} == {Path(name).name for name in video_entries}
    assert {entry["filename"] for entry in credit_entries} == {Path(name).name for name in video_entries}
    assert all(entry["creator_credit"] == "Source: Test Fixture" for entry in credit_entries)
    assert all(db.get_asset(clip.library_asset_id).source_clip_id == clip.id for clip in clips)
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None
