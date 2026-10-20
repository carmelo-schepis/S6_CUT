from __future__ import annotations

from pathlib import Path

from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Clip, Job, Project


def test_overlay_choices_are_snapshotted_before_render_and_survive_inventory_changes(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    manager = object.__new__(JobManager)
    manager.db, manager.rules, manager.settings = db, rules, Settings.from_env()
    manager.settings = manager.settings.__class__(**{**manager.settings.__dict__, "data_path": tmp_path})
    manager._save = lambda *_args: None
    image = tmp_path / "campaign.png"
    image.write_bytes(b"approved")
    first = rules.register_file(
        image, title="Campaign mark", media_type="image/png", origin="manual-import",
        folder_id="00000000-0000-0000-0000-000000000001", triggers=["campaign"], policy="required",
    ).model_copy(update={"video_overlay_eligible": True})
    db.save_asset(first)
    clip = Clip(id="clip-1", index=1, state="queued", start=0, end=5, duration=5, opening_line="campaign")
    job = Job(
        id="job-1", project_id="project-1", mode="clip", state="active", stage="render",
        stage_label="Rendering", progress=50, style="serious", library_overlays_enabled=True, clips=[clip],
    )
    private = {"library_overlays_enabled": True, "source_hash": "source-video"}
    words = [{"text": "campaign", "start": .1, "end": 1.0}]

    snapshot = manager._snapshot_video_overlays(job, private, words)
    later = first.model_copy(update={"id": "later", "title": "Campaign priority", "content_hash": "later" * 8, "blob_id": "later" * 8})
    db.save_asset(later)
    resumed = manager._snapshot_video_overlays(job, private, words)
    overlays, provenance = manager._video_overlay_for_clip(job, clip, private)

    assert snapshot[clip.id]["asset_id"] == first.id
    assert resumed == snapshot
    assert len(overlays) == 1 and overlays[0][1:] == (.65, 3.4)
    assert provenance[0].content_hash == first.content_hash


def test_source_only_regeneration_keeps_old_output_and_copies_saved_range(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    settings = Settings.from_env()
    settings = settings.__class__(**{**settings.__dict__, "data_path": tmp_path})
    manager = JobManager(db, rules, None, settings)
    source = tmp_path / "jobs" / "old-job" / "source" / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"immutable source")
    old_output = tmp_path / "jobs" / "old-job" / "clips" / "01-cut.mp4"
    old_output.parent.mkdir(parents=True)
    old_output.write_bytes(b"old contaminated output")
    project = Project(
        id="project-1", name="Project", mode="clip", style="serious", state="complete",
        source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="old-job",
    )
    clip = Clip(
        id="clip-old", index=1, state="complete", start=12, end=18, duration=6,
        opening_line="A saved phrase", output_name="01-cut.mp4", blob_id="old-output",
        hook_text="Keep this approved text", provenance=[],
    )
    old_job = Job(
        id="old-job", project_id=project.id, mode="clip", state="complete", stage="complete",
        stage_label="Ready", progress=100, style="serious", processing_mode="fast",
        library_overlays_enabled=True, clips=[clip],
    )
    db.save_project(project)
    db.save_job(old_job, {"source_path": str(source), "processing_mode": "fast", "library_overlays_enabled": True})

    regenerated = manager.create_source_only_rerender(old_job, [clip.id])
    saved = db.get_job(regenerated.id)
    saved_project = db.get_project(project.id)

    assert saved and saved_project
    assert saved_project.latest_job_id == regenerated.id
    assert saved.state == "queued" and saved.library_overlays_enabled is False
    assert saved.execution_policy == "engine_only"
    assert len(saved.clips) == 1 and saved.clips[0].id != clip.id
    assert (saved.clips[0].start, saved.clips[0].end, saved.clips[0].hook_text) == (12, 18, "Keep this approved text")
    assert saved.clips[0].output_name is None and not saved.clips[0].provenance
    assert db.get_job(old_job.id).clips[0].output_name == "01-cut.mp4"
    assert old_output.read_bytes() == b"old contaminated output"
    assert (tmp_path / "jobs" / saved.id / "source" / "source.mp4").exists() is False
    assert db.get_job_private(saved.id)["source_path"] == str(source)
