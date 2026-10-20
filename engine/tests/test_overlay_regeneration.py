from __future__ import annotations

import json
import json
from pathlib import Path

from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import CaptionCue, Clip, Job, Project


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
        hook_text="Keep this approved text", provenance=[], caption_revision=2,
        caption_cues=[CaptionCue(id="cue-reviewed", start=0.2, end=1.4, text="Reviewed wording")],
    )
    old_job = Job(
        id="old-job", project_id=project.id, mode="clip", state="complete", stage="complete",
        stage_label="Ready", progress=100, style="serious", processing_mode="fast",
        library_overlays_enabled=True, clips=[clip],
    )
    db.save_project(project)
    reviewed_cues = [{"start": 0.2, "end": 1.4, "text": "Reviewed wording"}]
    db.save_job(old_job, {"source_path": str(source), "processing_mode": "fast", "library_overlays_enabled": True,
                          "caption_overrides": {clip.id: {"revision": 2, "cues": reviewed_cues}}})

    regenerated = manager.create_source_only_rerender(old_job, [clip.id])
    saved = db.get_job(regenerated.id)
    saved_project = db.get_project(project.id)

    assert saved and saved_project
    assert saved_project.latest_job_id == regenerated.id
    assert saved.state == "queued" and saved.library_overlays_enabled is False
    assert saved.execution_policy == "engine_only"
    assert len(saved.clips) == 1 and saved.clips[0].id != clip.id
    assert (saved.clips[0].start, saved.clips[0].end, saved.clips[0].hook_text) == (12, 18, "Keep this approved text")
    assert saved.clips[0].caption_revision == 2
    assert [cue.text for cue in saved.clips[0].caption_cues] == ["Reviewed wording"]
    saved_private = db.get_job_private(regenerated.id)
    assert saved_private["caption_overrides"] == {saved.clips[0].id: {"revision": 2, "cues": reviewed_cues}}
    assert saved_private["source_only_regeneration"] is True
    assert saved.clips[0].output_name is None and not saved.clips[0].provenance
    assert db.get_job(old_job.id).clips[0].output_name == "01-cut.mp4"
    assert old_output.read_bytes() == b"old contaminated output"
    assert (tmp_path / "jobs" / saved.id / "source" / "source.mp4").exists() is False
    assert db.get_job_private(saved.id)["source_path"] == str(source)


def test_asset_eligibility_migration_defaults_old_assets_off_and_preserves_opt_ins(tmp_path: Path) -> None:
    path = tmp_path / "db.sqlite3"
    db = Database(path)
    old = rules_asset("old")
    opted_in = rules_asset("eligible", eligible=True)
    db.save_asset(old)
    db.save_asset(opted_in)
    with db._connect() as connection:
        for row in connection.execute("SELECT id,payload FROM assets").fetchall():
            payload = json.loads(row["payload"])
            if row["id"] == old.id:
                payload.pop("videoOverlayEligible", None)
            connection.execute("UPDATE assets SET payload=? WHERE id=?", (json.dumps(payload), row["id"]))
        connection.execute("DELETE FROM schema_migrations WHERE version=12")

    upgraded = Database(path)

    assert {asset.id: asset.video_overlay_eligible for asset in upgraded.list_assets()} == {old.id: False, opted_in.id: True}
    with upgraded._connect() as connection:
        assert connection.execute("SELECT 1 FROM schema_migrations WHERE version=12").fetchone()


def rules_asset(asset_id: str, *, eligible: bool = False):
    from engine.models import Asset

    return Asset(
        id=asset_id, title=asset_id, filename=f"{asset_id}.png", media_type="image/png",
        content_hash=asset_id * 16, video_overlay_eligible=eligible,
    )


def test_asset_eligibility_migration_defaults_old_assets_off_and_preserves_opt_ins(tmp_path: Path) -> None:
    path = tmp_path / "db.sqlite3"
    db = Database(path)
    old = rules_asset("old")
    opted_in = rules_asset("eligible", eligible=True)
    db.save_asset(old)
    db.save_asset(opted_in)
    with db._connect() as connection:
        for row in connection.execute("SELECT id,payload FROM assets").fetchall():
            payload = json.loads(row["payload"])
            if row["id"] == old.id:
                payload.pop("videoOverlayEligible", None)
            connection.execute("UPDATE assets SET payload=? WHERE id=?", (json.dumps(payload), row["id"]))
        connection.execute("DELETE FROM schema_migrations WHERE version=12")

    upgraded = Database(path)

    assert {asset.id: asset.video_overlay_eligible for asset in upgraded.list_assets()} == {old.id: False, opted_in.id: True}
    with upgraded._connect() as connection:
        assert connection.execute("SELECT 1 FROM schema_migrations WHERE version=12").fetchone()


def rules_asset(asset_id: str, *, eligible: bool = False):
    from engine.models import Asset

    return Asset(
        id=asset_id, title=asset_id, filename=f"{asset_id}.png", media_type="image/png",
        content_hash=asset_id * 16, video_overlay_eligible=eligible,
    )


def test_source_only_render_prefers_saved_reviewed_caption_words(tmp_path: Path) -> None:
    from engine.jobs import _render_words_for_clip, _reviewed_caption_words_for_clip

    clip = Clip(
        id="new-clip", index=1, state="queued", start=12, end=18, duration=6,
        opening_line="A saved phrase", caption_revision=3,
    )
    private = {"caption_overrides": {clip.id: {"revision": 3, "cues": [
        {"start": 0.5, "end": 1.25, "text": "Edited caption"},
    ]}}}

    words = _render_words_for_clip(private, clip, [{"text": "transcript", "start": 12.0, "end": 13.0}])

    assert words == [{"text": "Edited caption", "start": 12.5, "end": 13.25}]
    assert _reviewed_caption_words_for_clip(private, clip) == [{"text": "Edited caption", "start": 0.5, "end": 1.25}]
