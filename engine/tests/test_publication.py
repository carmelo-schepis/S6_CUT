"""Tests for the atomic Clip Board + Media Library publication pipeline.

Covers the publication invariant, bidirectional relationship validation,
progressive idempotent publication, folder fallback to Unsorted, accurate
checklists, and legacy backfill repair — without touching the web surface.
"""

from __future__ import annotations

import asyncio
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from engine import media as media_module
from engine.app import app, db as app_db, manager as app_manager, settings as app_settings
from engine.config import Settings
from engine.database import Database, UNSORTED_FOLDER_ID
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.media import MediaError, sha256_file
from engine.models import Clip, Job, LibraryFolder, Project, now_iso
from engine.providers import ProfileService
from engine.security import SecretVault


def _tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-publication-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager, LibraryRules, Settings]:
    """An isolated engine cluster rooted at tmp_path so tests never touch app globals."""
    test_settings = replace(app_settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    test_profiles = ProfileService(test_db, vault)
    test_rules = LibraryRules(test_db, tmp_path / "library")
    test_manager = JobManager(test_db, test_rules, test_profiles, test_settings)
    return test_db, test_manager, test_rules, test_settings


def _fake_probe(_: Any, __: Settings) -> dict[str, Any]:
    return {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": False, "audio_codec": None}


def _fake_plan(duration: float, count: int, min_duration: float, max_duration: float, guard: float) -> tuple[list[tuple[float, float]], str | None]:
    return [(0.0, 10.0), (12.0, 22.0), (24.0, 34.0), (36.0, 46.0), (48.0, 58.0)][:count], None


def _fake_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered-publication-clip")


def _clip_job(
    db_: Database, job_id: str, project_id: str, *,
    mode: str = "fast", source: Path, count: int = 2, folder_id: str = UNSORTED_FOLDER_ID,
) -> None:
    project = Project(
        id=project_id, name="Publication campaign", mode="clip", style="educational",
        state="queued", source_name=source.name, source_kind="upload", requested_count=count,
        library_folder_id=folder_id,
    )
    db_.save_project(project)
    private: dict[str, object] = {
        "source_path": str(source), "count": count, "min_duration": 10, "max_duration": 30,
        "aspect_ratio": "9:16", "processing_mode": mode,
    }
    job = Job(
        id=job_id, project_id=project_id, library_folder_id=folder_id, mode="clip",
        processing_mode=mode, state="queued", stage="queued", stage_label="Queued",
        progress=0, style="educational",
    )
    db_.save_job(job, private)


def _run_fast_job(
    monkeypatch: pytest.MonkeyPatch, test_db: Database, test_manager: JobManager,
    job_id: str, *, folder_id: str = UNSORTED_FOLDER_ID, count: int = 2,
    render_hook: Any = None,
) -> Job:
    source = _tmpdir() / "source.mp4"
    source.write_bytes(b"fake-video")
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)
    if render_hook is None:
        monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    else:
        monkeypatch.setattr(media_module, "render_fast_clip", render_hook)
    _clip_job(test_db, job_id, f"{job_id}-proj", mode="fast", source=source, count=count, folder_id=folder_id)
    test_manager._process(job_id)
    return test_db.get_job(job_id)  # type: ignore[return-value]


def test_every_complete_clip_has_linked_library_asset_and_vice_versa(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 1/12: no ready clip without an asset; no automatic asset without its clip."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "invariant-job", count=2)
    assert job is not None and job.state == "complete"
    generated = [asset for asset in test_db.list_assets() if asset.origin == "generated-clip"]
    assert len(generated) == 2
    for clip in job.clips:
        assert clip.state == "complete"
        assert clip.library_asset_id is not None, "ready clip must carry its Library asset id"
        assert clip.blob_id is not None
        asset = test_db.get_asset(clip.library_asset_id)
        assert asset is not None
        assert asset.source_clip_id == clip.id, "asset must point back to its source clip"
        assert asset.blob_id == clip.blob_id
        assert asset.origin == "generated-clip"
        assert asset.source_job_id == job.id
        assert asset.source_project_id == job.project_id
        assert asset.title == f"Publication campaign — Cut {clip.index:02d}"
        assert asset.duration_seconds == clip.duration


def test_no_asset_for_failed_or_unvalidated_output(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 2: a failed render never registers a Library asset or blob ref."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)

    def failing_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        raise MediaError("render exploded")

    job = _run_fast_job(monkeypatch, test_db, test_manager, "fail-job", count=2, render_hook=failing_render)
    assert job is not None and job.state == "failed"
    assert all(clip.state == "failed" and clip.library_asset_id is None for clip in job.clips)
    # The source registration asset is expected; no generated output asset may exist.
    assert [a for a in test_db.list_assets() if a.origin == "generated-clip"] == []


def test_progressive_publication_after_each_validated_render(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 3/6: clips appear one-by-one in Clip Board and Library, five clips → five assets."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "progressive-job", count=5)
    assert job is not None and job.state == "complete"
    generated = [asset for asset in test_db.list_assets() if asset.origin == "generated-clip"]
    assert len(generated) == 5, "five clips must produce exactly five automatic assets (one per view, shared)"
    clip_ids = {clip.id for clip in job.clips}
    asset_clip_ids = {asset.source_clip_id for asset in generated}
    assert asset_clip_ids == clip_ids
    # Content-addressed deduplication: same bytes → same blob.  Each unique output
    # gets its own blob; identical fake-render bytes coalesce into one.
    assert len(generated) == 5 and all(asset.blob_id for asset in generated)
    # Both views read the same single record set: one asset per clip, never duplicated for All media + folder.
    assert len(test_db.list_assets(folder_id=UNSORTED_FOLDER_ID, origin="generated-clip")) == 5
    assert len(test_db.list_assets(origin="generated-clip")) == 5


def test_business_folder_uses_one_asset_and_one_blob(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 4: with a business folder selected, clips appear there via one shared record/blob."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    folder = LibraryFolder(id="business-1", name="Business 1")
    test_db.save_folder(folder)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "business-job", folder_id="business-1", count=2)
    assert job is not None and job.state == "complete"
    generated = [asset for asset in test_db.list_assets() if asset.origin == "generated-clip"]
    assert generated and all(asset.folder_id == "business-1" for asset in generated)
    # The folder view shows the very same records as All media — no duplicates.
    folder_assets = [a for a in test_db.list_assets(folder_id="business-1") if a.origin == "generated-clip"]
    assert {asset.id for asset in folder_assets} == {asset.id for asset in generated}
    assert {asset.blob_id for asset in folder_assets} == {asset.blob_id for asset in generated}
    # Physical blob exists on disk for each content identity.
    relative = test_db.blob_relative_path(generated[0].blob_id)
    assert relative and (tmp_path / relative).is_file()


def test_no_folder_selected_falls_back_to_unsorted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 5: no selection → generated outputs live in Unsorted."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "unsorted-job", count=2)
    assert job is not None and job.state == "complete"
    generated = [asset for asset in test_db.list_assets() if asset.origin == "generated-clip"]
    assert generated and all(asset.folder_id == UNSORTED_FOLDER_ID for asset in generated)
    unsorted = [a for a in test_db.list_assets(folder_id=UNSORTED_FOLDER_ID) if a.origin == "generated-clip"]
    assert {asset.id for asset in unsorted} == {asset.id for asset in generated}


def test_retry_and_reprocess_never_duplicate_assets(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 7: retries, restarts, duplicate events, polling never create Cut 01 (2)."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "idempotent-job", count=3)
    assert job is not None and job.state == "complete"
    before = len([a for a in test_db.list_assets() if a.origin == "generated-clip"])

    # Simulate engine restart recovery + polling reprocessing of the same terminal job.
    test_manager._process("idempotent-job")
    test_manager._process("idempotent-job")
    job = test_db.get_job("idempotent-job")
    assert job is not None
    after = len([a for a in test_db.list_assets() if a.origin == "generated-clip"])
    assert before == after == 3
    for clip in job.clips:
        matches = [a for a in test_db.list_assets() if a.origin == "generated-clip" and a.source_clip_id == clip.id]
        assert len(matches) == 1, "stable (origin, project, job, clip) identity must not duplicate"

    # Re-publishing the same output directly must return the existing asset id.
    rules = LibraryRules(test_db, tmp_path / "library")
    output = tmp_path / "jobs" / "idempotent-job" / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"same-bytes")
    private = test_db.get_job_private("idempotent-job")
    first = job.clips[0]
    asset = rules.register_managed_video(
        output, title="Publication campaign — Cut 01", origin="generated-clip",
        project_id=job.project_id, job_id=job.id, clip_id=first.id,
        metadata={"duration": first.duration, "width": 1080, "height": 1920},
        folder_id=job.library_folder_id,
    )
    assert asset.id == first.library_asset_id


def test_later_failed_clip_keeps_earlier_published_outputs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 8: partial failure preserves earlier published clips/assets and marks the job partial."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)

    def fail_second(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        if "02-cut" in output.name:
            raise MediaError("second clip boom")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"ok")

    job = _run_fast_job(monkeypatch, test_db, test_manager, "partial-job", count=2, render_hook=fail_second)
    assert job is not None and job.state == "partial"
    assert job.clips[0].state == "complete" and job.clips[1].state == "failed"
    assert job.clips[0].library_asset_id is not None
    assert job.clips[1].library_asset_id is None
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert len(generated) == 1
    assert generated[0].source_clip_id == job.clips[0].id

    # Retry the failed clip: it publishes, the earlier asset is untouched, no duplicates.
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    private = test_db.get_job_private("partial-job")
    for clip in job.clips:
        if clip.state == "failed":
            clip.state, clip.error = "queued", None
    job.state, job.stage_label = "queued", "Retrying failed outputs"
    test_manager._reset_steps_for_retry(job)
    test_db.save_job(job, private)
    test_manager._process("partial-job")
    final = test_db.get_job("partial-job")
    assert final is not None and final.state == "complete"
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert len(generated) == 2
    first_asset = next(a for a in generated if a.source_clip_id == job.clips[0].id)
    assert first_asset.id == job.clips[0].library_asset_id  # idempotent update, not a new asset


def test_archived_folder_falls_back_to_unsorted_with_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 9: archiving/removing the selected folder during processing → Unsorted + warning."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    folder = LibraryFolder(id="folder-to-archive", name="Archive Me")
    test_db.save_folder(folder)
    source = _tmpdir() / "source.mp4"
    source.write_bytes(b"fake-video")
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    original_render = _fake_render

    def archive_then_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        # Archive the folder between planning and publication of the first output.
        test_db.save_folder(test_db.get_folder("folder-to-archive").model_copy(update={"archived": True, "updated_at": now_iso()}))
        original_render(source, output, start=start, end=end, aspect=aspect, has_audio=has_audio, settings=settings)

    monkeypatch.setattr(media_module, "render_fast_clip", archive_then_render)
    _clip_job(test_db, "archive-job", "archive-proj", mode="fast", source=source, count=2, folder_id="folder-to-archive")
    test_manager._process("archive-job")

    job = test_db.get_job("archive-job")
    assert job is not None and job.state == "complete"
    assert any("archived or removed" in warning for warning in job.warnings), job.warnings
    assert job.library_folder_id == "folder-to-archive", "immutable job folder snapshot must remain unchanged"
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert generated and all(a.folder_id == UNSORTED_FOLDER_ID for a in generated)
    assert test_db.list_assets(folder_id="folder-to-archive") == []
    assert test_db.list_assets(folder_id=UNSORTED_FOLDER_ID)


def test_removed_folder_falls_back_to_unsorted_with_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 9b: removing the selected folder during processing → Unsorted + warning."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    folder = LibraryFolder(id="folder-to-remove", name="Remove Me")
    test_db.save_folder(folder)
    source = _tmpdir() / "source.mp4"
    source.write_bytes(b"fake-video")
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    original_render = _fake_render
    removed = False

    def remove_then_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        nonlocal removed
        if not removed:
            test_db.remove_folder("folder-to-remove", UNSORTED_FOLDER_ID)
            removed = True
        original_render(source, output, start=start, end=end, aspect=aspect, has_audio=has_audio, settings=settings)

    monkeypatch.setattr(media_module, "render_fast_clip", remove_then_render)
    _clip_job(test_db, "remove-job", "remove-proj", mode="fast", source=source, count=2, folder_id="folder-to-remove")
    test_manager._process("remove-job")

    job = test_db.get_job("remove-job")
    assert job is not None and job.state == "complete"
    assert any("no longer exists" in warning for warning in job.warnings), job.warnings
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert generated and all(a.folder_id == UNSORTED_FOLDER_ID for a in generated)


def test_checklist_counts_only_atomically_published_outputs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 10: the render row counts published clips (Clip Board + Library committed)."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "checklist-job", count=3)
    assert job is not None and job.state == "complete"
    render_step = next(step for step in job.steps if step.id == "render")
    assert render_step.label == "Clips rendered and saved"
    assert render_step.status == "complete"
    assert render_step.current_item == 3 and render_step.total_items == 3
    published = [clip for clip in job.clips if clip.state == "complete" and clip.library_asset_id is not None]
    assert render_step.current_item == len(published), "checklist counts only published outputs"
    verify = next(step for step in job.steps if step.id == "verify")
    assert verify.status == "complete" and verify.current_item == 3
    ready = next(step for step in job.steps if step.id == "ready")
    assert ready.status == "complete"


def test_legacy_completed_clips_are_backfilled_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 15: legacy completed clips missing library links get exactly one asset each."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)

    # Build a legacy-style job: complete clips with blob refs but no library_asset_id.
    source = _tmpdir() / "source.mp4"
    source.write_bytes(b"fake-video")
    project = Project(id="legacy-proj", name="Legacy campaign", mode="clip", style="educational",
                      state="complete", source_name="source.mp4", source_kind="upload", requested_count=2)
    test_db.save_project(project)
    private = {"source_path": str(source), "count": 2, "min_duration": 10, "max_duration": 30,
               "aspect_ratio": "9:16", "processing_mode": "fast"}
    clips: list[Clip] = []
    for index in (1, 2):
        output = tmp_path / "jobs" / "legacy-job" / "clips" / f"{index:02d}-cut.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"legacy-output")
        rules = LibraryRules(test_db, tmp_path / "library")
        asset = rules.register_managed_video(
            output, title=f"Legacy campaign — Cut {index:02d}", origin="generated-clip",
            project_id="legacy-proj", job_id="legacy-job", clip_id=f"legacy-clip-{index}",
            metadata={"duration": 10.0, "width": 1080, "height": 1920},
        )
        clips.append(Clip(id=f"legacy-clip-{index}", index=index, state="complete", start=0, end=10,
                          duration=10, opening_line=f"Cut {index:02d}", output_name=output.name,
                          blob_id=asset.blob_id))
    job = Job(id="legacy-job", project_id="legacy-proj", mode="clip", processing_mode="fast",
              state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=clips)
    test_db.save_job(job, private)

    repaired = test_manager.repair_publications()
    assert repaired == 2, "both legacy clips need backfilled assets"
    job = test_db.get_job("legacy-job")
    assert job is not None
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert len(generated) == 2
    for clip in job.clips:
        assert clip.library_asset_id is not None
        asset = test_db.get_asset(clip.library_asset_id)
        assert asset is not None and asset.source_clip_id == clip.id

    # Re-run the repair: idempotent, no duplicates.
    assert test_manager.repair_publications() == 0
    assert len([a for a in test_db.list_assets() if a.origin == "generated-clip"]) == 2


def test_asset_exists_but_clip_link_missing_is_reconciled_not_duplicated(monkeypatch: pytest.MonkeyPatch) -> None:
    """Recovery: an asset present for the stable identity is reused by the backfill, never duplicated."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    output = tmp_path / "jobs" / "link-job" / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"link-output")
    rules = LibraryRules(test_db, tmp_path / "library")
    asset = rules.register_managed_video(
        output, title="Link campaign — Cut 01", origin="generated-clip",
        project_id="link-proj", job_id="link-job", clip_id="link-clip-1",
        metadata={"duration": 8.0, "width": 1080, "height": 1920},
    )
    project = Project(id="link-proj", name="Link campaign", mode="clip", style="educational",
                      state="complete", source_name="x.mp4", source_kind="upload", requested_count=1)
    test_db.save_project(project)
    clip = Clip(id="link-clip-1", index=1, state="complete", start=0, end=8, duration=8,
                opening_line="Cut 01", output_name="01-cut.mp4", blob_id=asset.blob_id)
    job = Job(id="link-job", project_id="link-proj", mode="clip", processing_mode="fast",
              state="complete", stage="complete", stage_label="Ready", progress=100,
              style="educational", clips=[clip])
    test_db.save_job(job, {"aspect_ratio": "9:16"})

    repaired = test_manager.repair_publications()
    assert repaired == 1
    job = test_db.get_job("link-job")
    assert job is not None
    assert job.clips[0].library_asset_id == asset.id, "backfill must reuse the existing asset"
    assert len([a for a in test_db.list_assets() if a.origin == "generated-clip"]) == 1


def test_promoted_blob_without_commit_is_reconciled_by_reprocessing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Recovery: blob promoted but transaction never committed — reprocessing completes publication safely."""
    tmp_path = _tmpdir()
    test_db, test_manager, test_rules, _ = _cluster(tmp_path)
    source = _tmpdir() / "source.mp4"
    source.write_bytes(b"fake-video")
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "plan_fast_windows", _fake_plan)

    staged_bytes = b"staged-bytes"

    def staged_render(source: Path, output: Path, *, start: float, end: float, aspect: str, has_audio: bool, settings: Settings) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(staged_bytes)

    monkeypatch.setattr(media_module, "render_fast_clip", staged_render)
    _clip_job(test_db, "staged-job", "staged-proj", mode="fast", source=source, count=1)
    job = test_db.get_job("staged-job")
    assert job is not None

    # Simulate the interrupted stage: the render completed and the blob was
    # promoted to the content-addressed store, but the SQLite transaction
    # (clip fields + asset + job checkpoint) never committed.
    output = tmp_path / "jobs" / "staged-job" / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(staged_bytes)
    from engine.media import sha256_file
    digest = sha256_file(output)
    blob, relative = test_rules._publish_blob(output, digest)
    assert blob.is_file()
    # No asset, no blob row, no clip-output ref: the DB boundary was never crossed.
    assert test_db.list_assets() == []
    assert test_db.blob_relative_path(digest) is None
    assert test_db.blob_reference_count(digest) == 0

    # Reprocessing the same job (engine restart recovery) re-renders and
    # publishes through the atomic pipeline. The pre-promoted blob is reused
    # by content address; exactly one asset and one clip link result.
    test_manager._process("staged-job")
    final = test_db.get_job("staged-job")
    assert final is not None and final.state == "complete"
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert len(generated) == 1
    assert generated[0].blob_id == digest, "content-addressed blob must be reused, not copied again"
    assert generated[0].source_clip_id == final.clips[0].id
    assert final.clips[0].library_asset_id == generated[0].id
    assert test_db.blob_reference_count(digest) >= 2  # asset + clip-output refs


def test_publication_is_atomic_asset_and_job_checkpoint_in_same_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 1: a committed asset always coincides with a committed clip + job checkpoint."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "atomic-job", count=2)
    assert job is not None and job.state == "complete"
    for clip in job.clips:
        asset = test_db.get_asset(clip.library_asset_id)
        assert asset is not None
        # Clip Board and Library states are stored in one durable record set:
        # the persisted job payload carries library_asset_id at the same moment
        # the asset row exists (both written by publish_clip_output).
        persisted_job = test_db.get_job(job.id)
        assert persisted_job is not None
        persisted_clip = next(c for c in persisted_job.clips if c.id == clip.id)
        assert persisted_clip.library_asset_id == asset.id


def test_folder_snapshot_is_immutable_per_job(monkeypatch: pytest.MonkeyPatch) -> None:
    """The worker publishes into the job's folder snapshot, not a live project move."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    folder = LibraryFolder(id="snapshot-folder", name="Snapshot")
    test_db.save_folder(folder)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "snapshot-job", folder_id="snapshot-folder", count=2)
    assert job is not None and job.state == "complete"
    assert job.library_folder_id == "snapshot-folder"
    generated = [a for a in test_db.list_assets() if a.origin == "generated-clip"]
    assert all(a.folder_id == "snapshot-folder" for a in generated)


def test_source_publication_and_exports_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    """Acceptance 10-preserve: source registration + ZIP export still work with the new pipeline."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "export-job", count=2)
    assert job is not None and job.state == "complete"
    sources = [a for a in test_db.list_assets() if a.origin == "project-source"]
    assert len(sources) == 1
    assert sources[0].source_project_id == job.project_id
    assert job.source_blob_id == sources[0].blob_id

    output = test_manager.build_export(job.id, [clip.id for clip in job.clips])
    import zipfile
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        assert names == [
            "Publication campaign/01-01-cut.mp4",
            "Publication campaign/02-02-cut.mp4",
        ]
        assert all(name.casefold().endswith(".mp4") for name in names)


def test_bulk_export_filters_artifacts_sanitizes_unicode_title_and_orders_mp4(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "filtered-export-job", count=3)
    assert job is not None
    project = test_db.get_project(job.project_id)
    assert project is not None
    project.name = "  Café / Launch: Final?  "
    test_db.save_project(project)
    clips_dir = test_settings.data_path / "jobs" / job.id / "clips"
    persisted_job = test_db.get_job(job.id)
    assert persisted_job is not None
    clips = persisted_job.clips
    for clip, filename in zip(clips, ("same.MP4", "same.mp4", "third.mp4")):
        source = clips_dir / str(clip.output_name)
        source.rename(clips_dir / filename)
        clip.output_name = filename
    test_db.save_job(persisted_job, test_db.get_job_private(job.id))
    (clips_dir / "same.ass").write_text("subtitle")
    (clips_dir / "same.srt").write_text("subtitle")
    (clips_dir / "same.vtt").write_text("subtitle")
    (clips_dir / "metadata.json").write_text("metadata")
    (clips_dir / ".DS_Store").write_bytes(b"mac metadata")
    (clips_dir / "third.mp4.partial").write_bytes(b"temporary")
    (clips_dir / "orphan.mp4").write_bytes(b"not a validated clip")
    output = test_manager.build_export(job.id, [clip.id for clip in clips])
    assert output.name == "Café - Launch- Final-.zip"
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        assert names == [
            "Café - Launch- Final-/01-same.mp4",
            "Café - Launch- Final-/02-same.mp4",
            "Café - Launch- Final-/03-third.mp4",
        ]
        assert all(name.casefold().endswith(".mp4") for name in names)
        assert all(archive.getinfo(name).file_size > 0 for name in names)


def test_bulk_export_rejects_missing_completed_mp4(monkeypatch: pytest.MonkeyPatch) -> None:
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "empty-export-job", count=1)
    assert job is not None
    persisted_job = test_db.get_job(job.id)
    assert persisted_job is not None
    source = test_settings.data_path / "jobs" / job.id / "clips" / str(persisted_job.clips[0].output_name)
    incomplete = source.with_name("unfinished.partial.mp4")
    source.rename(incomplete)
    persisted_job.clips[0].output_name = incomplete.name
    test_db.save_job(persisted_job, test_db.get_job_private(job.id))
    with pytest.raises(ValueError, match="No completed MP4"):
        test_manager.build_export(job.id, [persisted_job.clips[0].id])


def test_archive_title_fallback_and_traversal_are_safe() -> None:
    from engine.security import safe_archive_title
    assert safe_archive_title(None) == "s6-cut-videos"
    assert safe_archive_title("../") == "s6-cut-videos"
    assert safe_archive_title("CON") == "s6-cut-videos"
    assert safe_archive_title("  Quarterly   review — 世界  ") == "Quarterly review — 世界"


def test_relationship_validation_detects_orphaned_pairs(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bidirectional validator reports broken Clip ↔ Asset pairs."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, _ = _cluster(tmp_path)
    job = _run_fast_job(monkeypatch, test_db, test_manager, "validate-job", count=1)
    assert job is not None and job.state == "complete"
    clip = job.clips[0]
    asset = test_db.get_asset(clip.library_asset_id)
    assert test_db.validate_clip_asset_relationship(clip, asset) is None

    # A ready clip without a linked asset is invalid.
    orphan = clip.model_copy(update={"library_asset_id": None})
    reason = test_db.validate_clip_asset_relationship(orphan, None)
    assert reason is not None and "no linked Library asset" in reason

    # A clip pointing at a non-existent asset is invalid.
    dangling = clip.model_copy(update={"library_asset_id": "missing-asset"})
    reason = test_db.validate_clip_asset_relationship(dangling, None)
    assert reason is not None and "does not exist" in reason

    # An asset pointing at a different clip is invalid.
    wrong = asset.model_copy(update={"source_clip_id": "some-other-clip"})
    reason = test_db.validate_clip_asset_relationship(clip, wrong)
    assert reason is not None and "does not point back" in reason



def test_repair_publication_api_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """The engine repair endpoint backfills missing links and reports the updated job."""
    tmp_path = _tmpdir()
    test_db, test_manager, test_rules, _ = _cluster(tmp_path)
    output = tmp_path / "jobs" / "api-job" / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"api-output")
    asset = test_rules.register_managed_video(
        output, title="API campaign — Cut 01", origin="generated-clip",
        project_id="api-proj", job_id="api-job", clip_id="api-clip-1",
        metadata={"duration": 8.0, "width": 1080, "height": 1920},
    )
    project = Project(id="api-proj", name="API campaign", mode="clip", style="educational",
                      state="complete", source_name="x.mp4", source_kind="upload", requested_count=1)
    test_db.save_project(project)
    clip = Clip(id="api-clip-1", index=1, state="complete", start=0, end=8, duration=8,
                opening_line="Cut 01", output_name="01-cut.mp4", blob_id=asset.blob_id)
    job = Job(id="api-job", project_id="api-proj", mode="clip", processing_mode="fast",
              state="complete", stage="complete", stage_label="Ready", progress=100,
              style="educational", clips=[clip])
    test_db.save_job(job, {"aspect_ratio": "9:16"})

    # Patch the engine app module to use the isolated cluster for this request.
    import engine.app as app_module
    app_module.db, app_module.manager = test_db, test_manager
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/jobs/api-job/repair-publication")
            assert response.status_code == 200, response.text
            payload = response.json()
            assert payload["clips"][0]["libraryAssetId"] == asset.id
            assert "downloadUrl" in payload["clips"][0]
            again = client.post("/api/v1/jobs/api-job/repair-publication")
            assert again.status_code == 200
            assert again.json()["clips"][0]["libraryAssetId"] == asset.id
    finally:
        app_module.db, app_module.manager = app_db, app_manager


def test_finished_clip_media_survives_job_directory_pruning() -> None:
    """A finished clip must keep playing after retention prunes its job directory.

    Job working directories are transient, but the published output is an
    immutable, still-referenced Library blob. When the job file is gone the
    clip's media URLs must fall back to the durable Library asset instead of
    advertising a link that 404s.
    """
    tmp_path = _tmpdir()
    test_db, test_manager, test_rules, test_settings = _cluster(tmp_path)
    output = tmp_path / "jobs" / "prune-job" / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered-output-bytes")
    asset = test_rules.register_managed_video(
        output, title="Pruned campaign — Cut 01", origin="generated-clip",
        project_id="prune-proj", job_id="prune-job", clip_id="prune-clip-1",
        metadata={"duration": 8.0, "width": 1080, "height": 1920},
    )
    test_db.save_project(Project(id="prune-proj", name="Pruned campaign", mode="clip", style="educational",
                                 state="complete", source_name="x.mp4", source_kind="upload", requested_count=1))
    clip = Clip(id="prune-clip-1", index=1, state="complete", start=0, end=8, duration=8,
                opening_line="Cut 01", output_name="01-cut.mp4", blob_id=asset.blob_id,
                library_asset_id=asset.id)
    test_db.save_job(Job(id="prune-job", project_id="prune-proj", mode="clip", processing_mode="fast",
                         state="complete", stage="complete", stage_label="Ready", progress=100,
                         style="educational", clips=[clip]), {"aspect_ratio": "9:16"})

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = test_db, test_manager, test_settings
    try:
        with TestClient(app) as client:
            live = client.get("/api/v1/jobs/prune-job").json()["clips"][0]
            # A published clip is served from its durable Library copy.
            assert live["downloadUrl"].startswith(f"/api/v1/library/assets/{asset.id}/preview")

            # Retention prunes the job working directory; the blob is untouched.
            output.unlink()
            pruned = client.get("/api/v1/jobs/prune-job").json()["clips"][0]
            assert pruned["state"] == "complete"
            assert pruned["downloadUrl"] == live["downloadUrl"].split("?")[0] + "?" + pruned["downloadUrl"].split("?")[1]
            assert pruned["previewUrl"] == pruned["downloadUrl"]
            # Caption sidecars live beside the job output and go with it.
            assert pruned["captionDownloads"] == []
            # The link must still serve the media, not 404.
            served = client.get(pruned["downloadUrl"])
            assert served.status_code == 200, served.text
            assert served.content == b"rendered-output-bytes"
    finally:
        app_module.db, app_module.manager, app_module.settings = original


def test_single_asset_deletion_removes_an_unreferenced_blob() -> None:
    tmp_path = _tmpdir()
    test_db, test_manager, test_rules, test_settings = _cluster(tmp_path)
    source = tmp_path / "poster.png"
    source.write_bytes(b"single-asset-blob")
    asset = test_rules.register_file(
        source, title="Disposable poster", media_type="image/png", origin="manual-import",
        folder_id=UNSORTED_FOLDER_ID,
    )
    relative = test_db.blob_relative_path(asset.blob_id)
    assert relative and (tmp_path / relative).is_file()

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = test_db, test_manager, test_settings
    try:
        with TestClient(app) as client:
            response = client.delete(f"/api/v1/library/assets/{asset.id}")
            assert response.status_code == 204, response.text
        assert test_db.get_asset(asset.id) is None
        assert not (tmp_path / relative).exists()
    finally:
        app_module.db, app_module.manager, app_module.settings = original


def test_project_deletion_waits_for_worker_and_blocks_stale_job_upserts() -> None:
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    project = Project(id="deleting-project", name="Deleting", mode="clip", style="educational",
                      state="active", source_name="source.mp4", source_kind="upload", requested_count=1)
    job = Job(id="deleting-job", project_id=project.id, mode="clip", processing_mode="fast",
              state="active", stage="render", stage_label="Rendering", progress=50, style="educational")
    test_db.save_project(project)
    test_db.save_job(job, {"aspect_ratio": "9:16"})
    workspace = tmp_path / "jobs" / job.id
    workspace.mkdir(parents=True)
    (workspace / "state.json").write_text("{}")

    async def delete_while_worker_holds_lock() -> None:
        lock = test_manager.job_locks[job.id]
        lock.acquire()
        deletion = asyncio.create_task(test_manager.delete_project(project.id))
        await asyncio.sleep(0)
        assert test_db.get_project(project.id) is not None
        lock.release()
        await deletion

    asyncio.run(delete_while_worker_holds_lock())
    assert test_db.get_project(project.id) is None
    assert test_db.get_job(job.id) is None
    assert not workspace.exists()

    # Simulates a worker's final in-memory checkpoint after deletion. _save must
    # not recreate the database row via its normal upsert path.
    test_manager._save(job, {"aspect_ratio": "9:16"})
    assert test_db.get_job(job.id) is None


def test_retention_prunes_only_old_terminal_workspaces() -> None:
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    test_manager.settings = replace(test_settings, retention_days=30, max_retained_jobs=1)
    current = datetime.now(timezone.utc)
    project = Project(id="retention-project", name="Retention", mode="clip", style="educational",
                      state="complete", source_name="source.mp4", source_kind="upload", requested_count=1)
    test_db.save_project(project)
    recent = Job(id="recent-job", project_id=project.id, mode="clip", processing_mode="fast",
                 state="complete", stage="complete", stage_label="Ready", progress=100, style="educational",
                 updated_at=current.isoformat())
    old = Job(id="old-job", project_id=project.id, mode="clip", processing_mode="fast",
              state="complete", stage="complete", stage_label="Ready", progress=100, style="educational",
              updated_at=(current - timedelta(days=31)).isoformat())
    test_db.save_job(recent, {"aspect_ratio": "9:16"})
    test_db.save_job(old, {"aspect_ratio": "9:16"})
    for job in (recent, old):
        directory = tmp_path / "jobs" / job.id
        directory.mkdir(parents=True)
        (directory / "state.json").write_text("{}")

    assert test_manager.prune_retained_jobs() == 1
    assert (tmp_path / "jobs" / recent.id).is_dir()
    assert not (tmp_path / "jobs" / old.id).exists()
    # Retention removes transient work, not the durable project/job history.
    assert test_db.get_job(recent.id) is not None
    assert test_db.get_job(old.id) is not None


def test_clip_without_recoverable_media_reports_no_download_link() -> None:
    """With neither a job file nor a live Library blob, no link is advertised."""
    tmp_path = _tmpdir()
    test_db, test_manager, _, test_settings = _cluster(tmp_path)
    test_db.save_project(Project(id="gone-proj", name="Gone", mode="clip", style="educational",
                                 state="complete", source_name="x.mp4", source_kind="upload", requested_count=1))
    # A published clip whose Library record has gone and whose job output was
    # pruned has nothing serveable left.
    clip = Clip(id="gone-clip-1", index=1, state="complete", start=0, end=8, duration=8,
                opening_line="Cut 01", output_name="01-cut.mp4", library_asset_id="no-such-asset")
    test_db.save_job(Job(id="gone-job", project_id="gone-proj", mode="clip", processing_mode="fast",
                         state="complete", stage="complete", stage_label="Ready", progress=100,
                         style="educational", clips=[clip]), {"aspect_ratio": "9:16"})

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = test_db, test_manager, test_settings
    try:
        with TestClient(app) as client:
            payload = client.get("/api/v1/jobs/gone-job").json()["clips"][0]
            assert payload["downloadUrl"] is None
            assert payload["previewUrl"] is None
    finally:
        app_module.db, app_module.manager, app_module.settings = original
