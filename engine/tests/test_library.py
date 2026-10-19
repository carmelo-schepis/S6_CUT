from __future__ import annotations

from datetime import date

import pytest

from engine.database import Database
from engine.library import LibraryRules, visual_concept
from engine.models import Asset, Clip, Job, Project


def asset(asset_id: str, title: str, policy: str, triggers: list[str], *, negative: list[str] | None = None, active_until: str | None = None) -> Asset:
    return Asset(id=asset_id, title=title, media_type="image/png", filename="asset.png", tags=[], triggers=triggers, negative_triggers=negative or [], policy=policy, active_until=active_until, licence="User supplied", content_hash=asset_id * 8)


def test_required_prefer_never_and_negative_rules_are_explainable(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.save_asset(asset("a", "Beatles poster", "prefer", ["The Beatles"]))
    db.save_asset(asset("b", "Blocked image", "never", ["Beatles"]))
    db.save_asset(asset("c", "Required campaign", "required", ["campaign"], negative=["competitor"]))
    rules = LibraryRules(db, tmp_path / "library")

    result = rules.explain("The Beatles changed popular music")
    assert result.selected and result.selected.id == "a"
    assert "The Beatles" in result.matched_triggers
    assert any(item["assetId"] == "b" and "Never" in item["reason"] for item in result.rejected)

    blocked = rules.explain("Our campaign compares a competitor")
    assert blocked.selected is None
    assert any(item["assetId"] == "c" and "Negative" in item["reason"] for item in blocked.rejected)


def test_expired_required_asset_is_excluded_before_ranking(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.save_asset(asset("d", "Old campaign", "required", ["launch"], active_until="2024-01-01"))
    result = LibraryRules(db, tmp_path / "library").explain("launch", on_date=date(2026, 8, 13))
    assert result.selected is None
    assert result.rejected[0]["reason"] == "Active date range has ended"


@pytest.mark.parametrize("media_type", ["audio/mpeg", "audio/mp4", "audio/wav"])
def test_soundtrack_cannot_match_as_a_visual_even_when_required(tmp_path, media_type):
    db = Database(tmp_path / "db.sqlite3")
    song = asset("song", "song", "required", ["song"])
    song.media_type = media_type
    db.save_asset(song)
    rules = LibraryRules(db, tmp_path / "library")
    query = "Follow the selected background song through this whole video"
    explanation = rules.explain(query)
    assert explanation.selected is None
    assert explanation.rejected == [{"assetId": song.id, "title": song.title, "reason": "This asset has no visual media for an overlay"}]
    assert rules.resolve(query).asset is None
    picture = asset("picture", "Song picture", "neutral", ["song"])
    db.save_asset(picture)
    assert rules.explain(query).selected.id == picture.id


def test_managed_video_registration_is_idempotent_and_independently_durable(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    source = tmp_path / "jobs" / "job-1" / "clips" / "cut.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"validated-video")
    metadata = {"duration": 12.5, "width": 1080, "height": 1920}

    first = rules.register_managed_video(
        source, title="Campaign — Cut 01", origin="generated-clip",
        project_id="project-1", job_id="job-1", clip_id="clip-1", metadata=metadata,
    )
    second = rules.register_managed_video(
        source, title="Campaign — Cut 01", origin="generated-clip",
        project_id="project-1", job_id="job-1", clip_id="clip-1", metadata=metadata,
    )

    assert first.id == second.id
    assert len(db.list_assets()) == 1
    assert first.origin == "generated-clip"
    assert first.source_clip_id == "clip-1"
    assert first.duration_seconds == 12.5
    relative = db.blob_relative_path(first.blob_id)
    assert relative and relative.startswith("blobs/sha256/")
    managed = tmp_path / relative
    source.unlink()
    assert managed.read_bytes() == b"validated-video"
    assert db.blob_reference_count(first.blob_id) == 2  # asset + clip

    # The same bytes in another project get their own relationship record, not another blob.
    other = rules.register_managed_video(
        managed, title="Other — Cut 01", origin="generated-clip",
        project_id="project-2", job_id="job-2", clip_id="clip-2", metadata=metadata,
    )
    assert other.id != first.id
    assert other.blob_id == first.blob_id
    assert len(db.list_assets()) == 2


def test_library_and_project_record_deletion_keep_shared_media_safe(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    output = tmp_path / "jobs" / "job" / "clips" / "cut.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"shared-output")
    metadata = {"duration": 8, "width": 1080, "height": 1920}
    asset = rules.register_managed_video(
        output, title="Client — Cut 01", origin="generated-clip",
        project_id="project", job_id="job", clip_id="clip", metadata=metadata,
    )
    project = Project(id="project", name="Client", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="job")
    clip = Clip(id="clip", index=1, state="complete", start=0, end=8, duration=8, opening_line="Cut", output_name="cut.mp4", blob_id=asset.blob_id)
    job = Job(id="job", project_id="project", mode="clip", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=[clip])
    db.save_project(project)
    db.save_job(job)
    db.delete_asset(asset.id)
    assert output.read_bytes() == b"shared-output"
    assert db.blob_reference_count(asset.blob_id) == 1

    # Re-register, then delete the project records: the Library reference remains usable.
    asset = rules.register_managed_video(
        output, title="Client — Cut 01", origin="generated-clip",
        project_id="project", job_id="job", clip_id="clip", metadata=metadata,
    )
    db.delete_project("project")
    relative = db.blob_relative_path(asset.blob_id)
    assert relative and (tmp_path / relative).is_file()
    assert db.get_asset(asset.id) is not None


def test_temporary_or_missing_media_cannot_be_registered(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    partial = tmp_path / "render.mp4.partial"
    partial.write_bytes(b"unfinished")
    with pytest.raises(ValueError, match="published"):
        rules.register_file(partial, title="Bad", media_type="video/mp4", origin="manual-import", folder_id="00000000-0000-0000-0000-000000000001")
    assert db.list_assets() == []


def test_visual_concept_skips_pronoun_contractions_for_named_entities() -> None:
    assert visual_concept("It's the natural progression, you know, GW, CIA.") == "CIA"
    assert visual_concept("The Beatles changed popular music.") == "The Beatles"
