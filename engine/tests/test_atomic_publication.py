from __future__ import annotations

import asyncio
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from engine import media as media_module
from engine.app import settings
from engine.config import Settings
from engine.database import UNSORTED_FOLDER_ID, Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.media import MediaError
from engine.models import (
    Asset,
    Clip,
    Job,
    LibraryFolder,
    Project,
    ScoreBreakdown,
    now_iso,
)
from engine.providers import ProfileService
from engine.security import SecretVault
from engine.selection import Candidate

SAMPLE_WORDS = [
    {"text": "The", "start": 0.0, "end": 0.3, "confidence": 0.9},
    {"text": "Beatles", "start": 0.3, "end": 0.8, "confidence": 0.9},
    {"text": "changed", "start": 0.8, "end": 1.3, "confidence": 0.9},
    {"text": "popular", "start": 1.3, "end": 1.8, "confidence": 0.9},
    {"text": "music.", "start": 1.8, "end": 2.4, "confidence": 0.9},
]


# -------------------------------------------------------------------
#  Fixture helpers
# -------------------------------------------------------------------


def _tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-atomic-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    test_settings = replace(settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    test_profiles = ProfileService(test_db, vault)
    test_rules = LibraryRules(test_db, tmp_path / "library")
    test_manager = JobManager(test_db, test_rules, test_profiles, test_settings)
    return test_db, test_manager


def _project(db: Database, project_id: str, mode: str = "clip", count: int = 3,
              folder_id: str = UNSORTED_FOLDER_ID) -> None:
    project = Project(
        id=project_id, name=project_id, mode=mode, style="educational",
        state="queued", source_name="source.mp4", source_kind="upload",
        requested_count=count, library_folder_id=folder_id,
    )
    db.save_project(project)


def _source_file(tmp_path: Path, job_id: str) -> Path:
    source = tmp_path / "jobs" / job_id / "source" / "source.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fake-source")
    return source


def _clip_job(db: Database, job_id: str, project_id: str, *, tmp_path: Path,
              mode: str = "fast", count: int = 3, folder_id: str = UNSORTED_FOLDER_ID) -> str:
    _project(db, project_id, count=count, folder_id=folder_id)
    source = _source_file(tmp_path, job_id)
    private: dict[str, object] = {
        "source_path": str(source), "count": count, "min_duration": 10,
        "max_duration": 30, "aspect_ratio": "9:16", "processing_mode": mode,
    }
    job = Job(
        id=job_id, project_id=project_id, library_folder_id=folder_id, mode="clip",
        processing_mode=mode, state="queued", stage="queued", stage_label="Queued",
        progress=0, style="educational",
    )
    db.save_job(job, private)
    return job_id


def _business_folder(business_id: str = "business-1", name: str = "Business 1") -> LibraryFolder:
    return LibraryFolder(
        id=business_id, name=name, system=False,
        created_at=now_iso(), updated_at=now_iso(),
    )


def _generated_assets(db: Database) -> list[Asset]:
    return [a for a in db.list_assets(include_archived=True) if a.origin in ("generated-clip", "script-output")]


# -------------------------------------------------------------------
#  Fake media functions
# -------------------------------------------------------------------


def _fake_probe(_: Any, __: Settings) -> dict[str, Any]:
    return {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": True, "audio_codec": "aac"}


def _fake_plan(duration: float, count: int, min_duration: float, max_duration: float,
               guard: float) -> tuple[list[tuple[float, float]], str | None]:
    windows = [(12.0 * i, 12.0 * i + 10.0) for i in range(count)]
    return windows, ""


def _fake_render(source: Path, output: Path, *, start: float, end: float, aspect: str,
                 has_audio: bool, settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(f"rendered-{end}".encode())


def _fake_render_clip(source: Path, output: Path, *, start: float, end: float, aspect: str,
                      words: list[dict[str, Any]], visuals: list[Any], overlays: list[Any],
                      settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(f"rendered-smart-{end}".encode())


def _fake_transcribe(_: Any, __: Settings, **___: Any) -> dict[str, Any]:
    return {"language": "en", "words": SAMPLE_WORDS, "segments": [{"start": 0.0, "end": 2.4, "text": "The Beatles changed popular music."}]}


def _fake_extract(source: Path, settings: Settings, *, output: Path | None = None) -> Path:
    target = output or source.with_suffix(".wav")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"audio")
    return target


def _fake_select(words: list[dict[str, Any]], style: str, count: int, minimum: float,
                 maximum: float) -> list[Candidate]:
    score = ScoreBreakdown(hook=80, coherence=80, ending=80, energy=70, practical_value=75,
                           visual_potential=80, completeness=85, penalties=0, total=80, explanation="fixture")
    return [
        Candidate(0.0, 2.4, SAMPLE_WORDS, score),
        Candidate(3.0, 5.4, SAMPLE_WORDS, score),
        Candidate(6.0, 8.4, SAMPLE_WORDS, score),
    ]


def _assert_step_invariants(job: Job) -> None:
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


# -------------------------------------------------------------------
#  1. Complete clip requires linked library asset
# -------------------------------------------------------------------


def test_complete_clip_requires_linked_library_asset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _clip_job(test_db, "invariant", "invariant-proj", tmp_path=tmp_path, mode="fast", count=3, folder_id=UNSORTED_FOLDER_ID)
    test_manager._process("invariant")

    job = test_db.get_job("invariant")
    assert job is not None
    assert job.state == "complete"

    # Every complete clip has a linked library asset
    for clip in job.clips:
        assert clip.state == "complete"
        assert clip.library_asset_id is not None, f"Clip {clip.index} missing library_asset_id"
        origin = "generated-clip"
        asset = test_db.get_generated_asset(origin, job.project_id, job.id, clip.id)
        assert asset is not None, f"No asset for clip {clip.index}"
        assert asset.id == clip.library_asset_id, f"Asset id mismatch for clip {clip.index}"
        assert asset.source_clip_id == clip.id

    # Reverse: every generated asset maps to a complete clip
    for asset in _generated_assets(test_db):
        clip = next((c for c in job.clips if c.id == asset.source_clip_id), None)
        assert clip is not None, f"Orphan generated asset {asset.id}"
        assert clip.state == "complete"
        assert clip.library_asset_id == asset.id


def test_smart_clip_publishes_through_same_atomic_boundary(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)
    monkeypatch.setattr(media_module, "is_whisper_model_cached", lambda _: False)

    _clip_job(test_db, "smart-inv", "smart-inv-proj", tmp_path=tmp_path, mode="smart", count=3)
    test_manager._process("smart-inv")

    job = test_db.get_job("smart-inv")
    assert job is not None
    assert job.state == "complete"

    for clip in job.clips:
        assert clip.state == "complete"
        assert clip.library_asset_id is not None
        asset = test_db.get_generated_asset("generated-clip", job.project_id, job.id, clip.id)
        assert asset is not None
        assert asset.id == clip.library_asset_id


# -------------------------------------------------------------------
#  2. Failed / unvalidated output never creates an asset
# -------------------------------------------------------------------


def test_failed_output_never_creates_asset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    def _fail_all(source: Path, output: Path, **_: Any) -> None:
        raise MediaError("render-failed")

    monkeypatch.setattr(media_module, "render_fast_clip", _fail_all)

    _clip_job(test_db, "fail-all", "fail-all-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("fail-all")

    job = test_db.get_job("fail-all")
    assert job is not None
    assert job.state == "failed"
    assert _generated_assets(test_db) == []
    for clip in job.clips:
        assert clip.state == "failed"
        assert clip.library_asset_id is None


# -------------------------------------------------------------------
#  3. Progressive publication
# -------------------------------------------------------------------


def test_progressive_publication_publishes_each_output_independently(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    snapshots: dict[str, Any] = {}
    render_calls = {"n": 0}

    def spy_render(source: Path, output: Path, *, start: float, end: float, aspect: str,
                   has_audio: bool, settings: Settings) -> None:
        render_calls["n"] += 1
        if render_calls["n"] == 2:
            # Second render starting — clip 1 should already be published
            mid_assets = [a for a in test_db.list_assets(include_archived=True) if a.origin == "generated-clip"]
            mid_job = test_db.get_job("progressive")
            assert mid_job is not None
            clip1 = next((c for c in mid_job.clips if c.index == 1), None)
            steps = {s.id: s for s in mid_job.steps}
            snapshots.update({
                "asset_count": len(mid_assets),
                "clip1_state": clip1.state if clip1 else None,
                "clip1_library_asset_id": clip1.library_asset_id if clip1 else None,
                "ready_step_status": steps.get("ready", None).status if steps.get("ready") else None,
            })
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(f"rendered-{end}".encode())

    monkeypatch.setattr(media_module, "render_fast_clip", spy_render)

    _clip_job(test_db, "progressive", "progressive-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("progressive")

    # At the moment clip 2 started rendering:
    assert snapshots.get("asset_count") == 1, "Clip 1 should have published its asset before clip 2 started"
    assert snapshots.get("clip1_state") == "complete", "Clip 1 should be complete before clip 2 renders"
    assert snapshots.get("clip1_library_asset_id") is not None, "Clip 1 must have a linked library asset"
    assert snapshots.get("ready_step_status") != "complete", "Ready step must not complete before all clips are terminal"

    # Final state: all three clips published
    job = test_db.get_job("progressive")
    assert job is not None
    assert job.state == "complete"
    assert len(_generated_assets(test_db)) == 3
    assert all(c.library_asset_id is not None for c in job.clips if c.state == "complete")


# -------------------------------------------------------------------
#  4. Business folder: one asset visible in All media and the folder
# -------------------------------------------------------------------


def test_selected_business_folder_single_asset_visible_in_all_and_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    folder = _business_folder("business-1", "Acme")
    test_db.save_folder(folder)
    _clip_job(test_db, "folder-test", "folder-proj", tmp_path=tmp_path, mode="fast", count=3, folder_id="business-1")
    test_manager._process("folder-test")

    job = test_db.get_job("folder-test")
    assert job is not None
    assert job.state == "complete"

    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 3
    # All generated assets logically belong to the business folder
    assert all(a.folder_id == "business-1" for a in generated), "All generated assets should be in the business folder"

    # Visible through All media (default list_assets)
    all_media = {a.id for a in test_db.list_assets()}
    assert all(a.id in all_media for a in generated), "Each generated asset must be visible in All media"

    # Visible through the business folder filter
    folder_assets = test_db.list_assets(folder_id="business-1")
    folder_ids = {a.id for a in folder_assets}
    assert all(a.id in folder_ids for a in generated), "Each generated asset must be visible in the business folder filter"

    # One physical blob per asset (distinct content written by render)
    blob_ids = {a.blob_id for a in generated}
    assert len(blob_ids) == 3, "Each generated asset should have its own blob (distinct content)"

    # Blob files exist on disk
    for a in generated:
        rel = test_db.blob_relative_path(a.blob_id)
        assert rel, f"Blob {a.blob_id} has no relative path"
        assert (tmp_path / rel).is_file(), f"Blob file missing for {a.blob_id}"


# -------------------------------------------------------------------
#  5. No folder → Unsorted
# -------------------------------------------------------------------


def test_no_folder_selected_publishes_every_clip_to_unsorted_single_asset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _clip_job(test_db, "unsorted-test", "unsorted-proj", tmp_path=tmp_path, mode="fast", count=3,
              folder_id=UNSORTED_FOLDER_ID)
    test_manager._process("unsorted-test")

    job = test_db.get_job("unsorted-test")
    assert job is not None and job.state == "complete"

    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 3
    assert all(a.folder_id == UNSORTED_FOLDER_ID for a in generated), "Every generated asset should be in Unsorted"

    # Visible in All media
    all_ids = {a.id for a in test_db.list_assets()}
    assert all(a.id in all_ids for a in generated)
    # Visible in the Unsorted folder filter
    unsorted_ids = {a.id for a in test_db.list_assets(folder_id=UNSORTED_FOLDER_ID)}
    assert all(a.id in unsorted_ids for a in generated)


# -------------------------------------------------------------------
#  6. Five clips produce exactly five linked assets, no duplicates
# -------------------------------------------------------------------


def test_five_clip_job_creates_exactly_five_linked_assets(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _clip_job(test_db, "five-clips", "five-clips-proj", tmp_path=tmp_path, mode="fast", count=5)
    test_manager._process("five-clips")

    job = test_db.get_job("five-clips")
    assert job is not None and job.state == "complete"

    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 5
    assert len({a.source_clip_id for a in generated}) == 5, "Each asset should reference a distinct clip"
    # The unique database index prevents duplicate assets for the same identity
    clip_ids = [c.id for c in job.clips]
    for a in generated:
        assert a.source_clip_id in clip_ids


# -------------------------------------------------------------------
#  7. Retry updates existing asset with new blob, no duplicates
# -------------------------------------------------------------------


def test_retry_updates_existing_asset_with_new_blob_without_duplicates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    render_state = {"n": 0}

    def _fail_second(source: Path, output: Path, *, start: float, end: float, aspect: str,
                     has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        render_state["n"] += 1
        if abs(end - 22.0) < 0.01:
            raise MediaError("boom-second")
        output.write_bytes(b"validated-v1")

    monkeypatch.setattr(media_module, "render_fast_clip", _fail_second)

    _clip_job(test_db, "retry-test", "retry-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("retry-test")
    assert test_db.get_job("retry-test").state == "partial"

    # Capture asset id for clip 2 before retry
    job_before = test_db.get_job("retry-test")
    clip2_before = next(c for c in job_before.clips if c.index == 2)
    assert clip2_before.state == "failed"

    # Retry: swap to a render that writes different bytes for the retried clip
    render_state["n"] = 0

    def _render_retry(source: Path, output: Path, *, start: float, end: float, aspect: str,
                      has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        render_state["n"] += 1
        # Only the retried clip (clip 2) re-renders; completed clips are skipped
        output.write_bytes(b"validated-v2")

    monkeypatch.setattr(media_module, "render_fast_clip", _render_retry)
    asyncio.run(test_manager.control("retry-test", "retry-failed"))
    test_manager._process("retry-test")

    job = test_db.get_job("retry-test")
    assert job is not None and job.state == "complete"

    # Still exactly 3 assets, no duplicates
    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 3

    # Clip 2 has exactly one asset, same id as before (idempotent)
    clip2 = next(c for c in job.clips if c.index == 2)
    assert clip2.state == "complete"
    assert clip2.library_asset_id is not None
    asset2 = test_db.get_generated_asset("generated-clip", job.project_id, job.id, clip2.id)
    assert asset2 is not None and asset2.id == clip2.library_asset_id
    # The blob content reflects the new render (different bytes)
    rel = test_db.blob_relative_path(asset2.blob_id)
    assert rel is not None
    assert (tmp_path / rel).read_bytes() == b"validated-v2", "Retried clip should use the new blob content"


# -------------------------------------------------------------------
#  8. Restart / reprocessing never duplicates assets
# -------------------------------------------------------------------


def test_restart_and_reprocessing_never_duplicate_assets(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    _clip_job(test_db, "restart-ck", "restart-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("restart-ck")

    # Snapshot asset ids
    first_ids = {a.id for a in _generated_assets(test_db)}
    assert len(first_ids) == 3

    # Simulate a crash mid-batch: the engine restarted after clips 1-2 were
    # published but before clip 3 published, so the job returns as `recovered`.
    job = test_db.get_job("restart-ck")
    assert job is not None
    for step in job.steps:
        if step.id in {"render", "verify", "ready"}:
            step.status = "pending"
            step.detail = None
            step.completed_at = None
    job.clips = [
        c.model_copy(update={"state": "queued", "blob_id": None, "library_asset_id": None, "error": None, "selected": False})
        if c.index == 3 else c
        for c in job.clips
    ]
    job.state = "recovered"
    job.stage = "render"
    job.stage_label = "Recovered after engine restart"
    test_db.save_job(job, test_db.get_job_private("restart-ck"))

    # Recovery re-runs the worker; completed clips are skipped, clip 3 is
    # republished through the same stable identity.
    test_manager._process("restart-ck")

    # Still exactly 3 assets with the same ids — recovery never duplicates.
    after_ids = {a.id for a in _generated_assets(test_db)}
    assert len(after_ids) == 3
    assert after_ids == first_ids, "Asset ids must remain unchanged after restart recovery"
    final = test_db.get_job("restart-ck")
    assert final is not None and final.state == "complete"
    assert all(c.library_asset_id is not None for c in final.clips)

    # Reads (get_job, list_assets, etc.) never create records
    before_count = len(_generated_assets(test_db))
    test_db.get_job("restart-ck")
    test_db.list_jobs()
    test_db.list_assets()
    assert len(_generated_assets(test_db)) == before_count, "Reads must not mutate asset count"


# -------------------------------------------------------------------
#  9. Partial: later failed clip leaves earlier published outputs intact
# -------------------------------------------------------------------


def test_later_failed_clip_keeps_earlier_published_outputs_partial(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    def _fail_third(source: Path, output: Path, *, start: float, end: float, aspect: str,
                    has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        if abs(end - 34.0) < 0.01:
            raise MediaError("boom-third")
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", _fail_third)

    _clip_job(test_db, "partial-ck", "partial-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("partial-ck")

    job = test_db.get_job("partial-ck")
    assert job is not None
    assert job.state == "partial"

    generated = [a for a in _generated_assets(test_db)]
    # Clips 1 and 2 are complete and have assets; clip 3 is failed without asset
    assert len(generated) == 2
    for clip in job.clips:
        if clip.index in (1, 2):
            assert clip.state == "complete"
            assert clip.library_asset_id is not None
            asset = test_db.get_generated_asset("generated-clip", job.project_id, job.id, clip.id)
            assert asset is not None, f"Missing asset for successful clip {clip.index}"
            # Blob file remains on disk for both successful clips
            rel = test_db.blob_relative_path(asset.blob_id)
            assert rel and (tmp_path / rel).is_file(), f"Blob file missing for clip {clip.index}"
        else:
            assert clip.state == "failed"
            assert clip.library_asset_id is None
            assert test_db.get_generated_asset("generated-clip", job.project_id, job.id, clip.id) is None


# -------------------------------------------------------------------
#  10. Archived folder → Unsorted + warning
# -------------------------------------------------------------------


def test_archived_selected_folder_falls_back_to_unsorted_with_warning(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    folder = _business_folder("business-1", "Campaign")
    test_db.save_folder(folder)

    _clip_job(test_db, "archive-fallback", "archive-proj", tmp_path=tmp_path, mode="fast",
              count=3, folder_id="business-1")

    # Archive the folder after job creation (simulating mid-processing change)
    test_db.save_folder(folder.model_copy(update={"archived": True}))

    test_manager._process("archive-fallback")

    job = test_db.get_job("archive-fallback")
    assert job is not None
    assert job.state == "complete", "Job must complete even when the selected folder is archived"

    # Warning attached to the job
    assert any("archived" in w.lower() or "Unsorted" in w for w in job.warnings), f"No archive/Unsorted warning in {job.warnings}"

    # All generated assets fall back to Unsorted
    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 3
    assert all(a.folder_id == UNSORTED_FOLDER_ID for a in generated), "Generated assets must land in Unsorted"

    # Visible in All media (default list_assets excludes archived folders)
    all_ids = {a.id for a in test_db.list_assets()}
    assert all(a.id in all_ids for a in generated), "Generated assets must be visible in All media"


# -------------------------------------------------------------------
#  11. Removed folder → visible folder + warning
# -------------------------------------------------------------------


def test_removed_selected_folder_publishes_to_visible_folder_with_warning(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)

    folder = _business_folder("business-1", "Campaign")
    test_db.save_folder(folder)

    _clip_job(test_db, "remove-fallback", "remove-proj", tmp_path=tmp_path, mode="fast",
              count=3, folder_id="business-1")

    # Remove the folder (moves existing assets to Unsorted, creates redirect)
    test_db.remove_folder("business-1", UNSORTED_FOLDER_ID)

    test_manager._process("remove-fallback")

    job = test_db.get_job("remove-fallback")
    assert job is not None
    assert job.state == "complete", "Job must complete even when the selected folder is removed"

    # Warning attached to the job
    assert any("removed" in w.lower() or "no longer exists" in w.lower() or "Unsorted" in w
               for w in job.warnings), f"No removal warning in {job.warnings}"

    # Assets are visible in All media (not in a hidden folder)
    generated = [a for a in _generated_assets(test_db)]
    assert len(generated) == 3
    all_ids = {a.id for a in test_db.list_assets()}
    assert all(a.id in all_ids for a in generated), "All generated assets must remain visible after folder removal"


# -------------------------------------------------------------------
#  12. Checklist counts reflect published outputs
# -------------------------------------------------------------------


def test_checklist_counts_reflect_published_outputs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    def _fail_second_render(source: Path, output: Path, *, start: float, end: float, aspect: str,
                            has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        if abs(end - 22.0) < 0.01:
            raise MediaError("boom")
        output.write_bytes(b"ok")

    monkeypatch.setattr(media_module, "render_fast_clip", _fail_second_render)

    _clip_job(test_db, "checklist-ck", "checklist-proj", tmp_path=tmp_path, mode="fast", count=3)
    test_manager._process("checklist-ck")

    job = test_db.get_job("checklist-ck")
    assert job is not None
    steps = {s.id: s for s in job.steps}

    # Partial: 2 of 3 rendered, 2 of 3 verified, ready complete with "(partial)"
    assert steps["render"].status == "complete"
    assert steps["render"].current_item == 2
    assert steps["render"].total_items == 3
    assert "2 of 3" in steps["render"].detail

    assert steps["verify"].status == "complete"
    assert steps["verify"].current_item == 2
    assert steps["verify"].total_items == 3

    assert steps["ready"].status == "complete"
    assert "(partial)" in steps["ready"].detail

    # Published count never exceeds linked assets
    linked = len(_generated_assets(test_db))
    assert linked == 2
    assert steps["render"].current_item == linked == len([c for c in job.clips if c.state == "complete"])

    # Full success case: all 3 rendered and saved
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    new_job = Job(
        id="full-ck", project_id="full-proj", library_folder_id=UNSORTED_FOLDER_ID,
        mode="clip", processing_mode="fast", state="queued", stage="queued",
        stage_label="Queued", progress=0, style="educational",
    )
    _project(test_db, "full-proj", count=3)
    test_db.save_job(new_job, {"source_path": str(_source_file(tmp_path, "full-ck")),
                               "count": 3, "min_duration": 10, "max_duration": 30,
                               "aspect_ratio": "9:16", "processing_mode": "fast"})
    test_manager._process("full-ck")

    final = test_db.get_job("full-ck")
    assert final is not None and final.state == "complete"
    final_steps = {s.id: s for s in final.steps}
    assert final_steps["render"].current_item == 3
    assert final_steps["verify"].current_item == 3
    assert final_steps["ready"].status == "complete"
    _assert_step_invariants(final)


# -------------------------------------------------------------------
#  13. Legacy backfill: completed clips without assets are backfilled once
# -------------------------------------------------------------------


def test_legacy_completed_clips_are_backfilled_exactly_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "legacy-proj", count=2)

    # Create blob files on disk and register them in the blob store
    # (simulate a legacy run where the blob was promoted but the asset was lost)
    clip1_src = tmp_path / "temp" / "clips" / "01-legacy.mp4"
    clip2_src = tmp_path / "temp" / "clips" / "02-legacy.mp4"
    clip1_src.parent.mkdir(parents=True)
    clip1_src.write_bytes(b"legacy-clip-one")
    clip2_src.write_bytes(b"legacy-clip-two")

    # Publish each into the blob store via a temp asset, then remove the asset
    metadata = {"duration": 10.0, "width": 1080, "height": 1920}
    for i, (src, clip_id) in enumerate([(clip1_src, "legacy-c1"), (clip2_src, "legacy-c2")], 1):
        # Create a temp asset to register the blob, then delete it
        temp_asset = test_manager.rules.register_managed_video(
            src, title=f"Temp {i}", origin="manual-import",
            project_id="legacy-proj", job_id="legacy-job", clip_id=clip_id,
            metadata=metadata, folder_id=UNSORTED_FOLDER_ID,
        )
        assert temp_asset.blob_id is not None
        # Store the blob_id for the legacy clip
        if i == 1:
            clip1_blob = temp_asset.blob_id
        else:
            clip2_blob = temp_asset.blob_id
        # Delete the asset so the blob exists but no generated asset links to this clip
        test_db.delete_asset(temp_asset.id)

    # Now build a legacy job with complete clips that have blob_id and output_name
    # but no library_asset_id
    output_dir = tmp_path / "jobs" / "legacy-job" / "clips"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "01-legacy.mp4").write_bytes(b"legacy-clip-one")
    (output_dir / "02-legacy.mp4").write_bytes(b"legacy-clip-two")

    clips = [
        Clip(id="legacy-c1", index=1, state="complete", start=0, end=10, duration=10,
             opening_line="Legacy one", output_name="01-legacy.mp4", blob_id=clip1_blob),
        Clip(id="legacy-c2", index=2, state="complete", start=12, end=22, duration=10,
             opening_line="Legacy two", output_name="02-legacy.mp4", blob_id=clip2_blob),
    ]
    job = Job(id="legacy-job", project_id="legacy-proj", mode="clip", state="complete",
              stage="complete", stage_label="Done", progress=100, style="educational",
              clips=clips)
    test_db.save_job(job, {"processing_mode": "fast", "aspect_ratio": "9:16"})

    # No generated assets yet
    assert _generated_assets(test_db) == []

    # Backfill creates a linked asset for each clip
    backfilled_job, count, ids = test_db.backfill_missing_assets(job)
    assert count == 2, f"Expected 2 backfilled, got {count}"
    assert len(ids) == 2

    # Save the updated job (as repair_publications would)
    test_db.save_job(backfilled_job, test_db.get_job_private("legacy-job"))

    # Each clip now has a linked library asset
    for clip in backfilled_job.clips:
        assert clip.library_asset_id is not None, f"Clip {clip.index} missing library_asset_id after backfill"
        asset = test_db.get_generated_asset("generated-clip", "legacy-proj", "legacy-job", clip.id)
        assert asset is not None, f"Asset missing for clip {clip.index} after backfill"
        assert asset.id == clip.library_asset_id

    # Exactly 2 generated assets, no duplicates
    assert len(_generated_assets(test_db)) == 2

    # Second backfill call creates nothing (idempotent)
    backfilled_job, count2, _ = test_db.backfill_missing_assets(backfilled_job)
    assert count2 == 0, f"Expected 0 on second backfill, got {count2}"
    assert len(_generated_assets(test_db)) == 2


def test_repair_publications_is_idempotent_on_startup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Simulate engine startup repair_publications scanning all jobs."""
    tmp_path = _tmpdir()
    test_db, test_manager = _cluster(tmp_path)
    _project(test_db, "repair-proj", count=1)

    # Create a blob on disk without a linked generated asset
    src = tmp_path / "temp" / "clip.mp4"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"repair-me")
    metadata = {"duration": 10.0, "width": 1080, "height": 1920}
    temp_asset = test_manager.rules.register_managed_video(
        src, title="Temp", origin="manual-import",
        project_id="repair-proj", job_id="repair-job", clip_id="repair-c1",
        metadata=metadata, folder_id=UNSORTED_FOLDER_ID,
    )
    blob_id = temp_asset.blob_id
    test_db.delete_asset(temp_asset.id)

    # Legacy job with complete clip, blob_id, but no library_asset_id
    output_dir = tmp_path / "jobs" / "repair-job" / "clips"
    output_dir.mkdir(parents=True)
    (output_dir / "01-repair.mp4").write_bytes(b"repair-me")
    clips = [Clip(id="repair-c1", index=1, state="complete", start=0, end=10, duration=10,
                  opening_line="Repair", output_name="01-repair.mp4", blob_id=blob_id)]
    job = Job(id="repair-job", project_id="repair-proj", mode="clip", state="complete",
              stage="complete", stage_label="Done", progress=100, style="educational",
              clips=clips)
    test_db.save_job(job, {"processing_mode": "fast", "aspect_ratio": "9:16"})

    # First repair
    repaired = test_manager.repair_publications()
    assert repaired == 1, f"Expected 1 repaired, got {repaired}"
    assert len(_generated_assets(test_db)) == 1

    # Second repair (idempotent)
    repaired2 = test_manager.repair_publications()
    assert repaired2 == 0, f"Expected 0 on second repair, got {repaired2}"
    assert len(_generated_assets(test_db)) == 1