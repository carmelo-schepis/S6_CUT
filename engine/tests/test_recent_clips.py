from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from engine.config import settings as app_settings
from engine.database import Database, UNSORTED_FOLDER_ID
from engine.models import Asset, Clip, Job, Project


def _publish(db: Database, root: Path, name: str, *, origin: str = "generated-clip", media_type: str = "video/mp4", published_at: str = "2025-01-01T00:00:00+00:00", title: str | None = None) -> Asset:
    content = f"media-{name}".encode()
    digest = hashlib.sha256(content).hexdigest()
    relative = f"blobs/sha256/{digest[:2]}/{digest}.mp4"
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    asset = Asset(
        id=f"asset-{name}", title=title or name, filename=f"{name}.mp4", media_type=media_type,
        content_hash=digest, blob_id=digest, origin=origin,
        folder_id=UNSORTED_FOLDER_ID, source_project_id=f"project-{name}",
        source_job_id=f"job-{name}", source_clip_id=f"clip-{name}",
        published_at=published_at,
    )
    return db.register_blob_asset(asset, relative, len(content))


def _client(monkeypatch, tmp_path, db):
    import engine.app as app_module

    # These read-only endpoint tests must not start the real worker and replay
    # unrelated queued jobs from the shared test data directory.
    async def no_lifecycle_work():
        pass

    monkeypatch.setattr(app_module.manager, "start", no_lifecycle_work)
    monkeypatch.setattr(app_module.manager, "stop", no_lifecycle_work)
    monkeypatch.setattr(app_module, "db", db)
    monkeypatch.setattr(app_module, "settings", replace(app_settings, data_path=tmp_path))
    return TestClient(app_module.app)


def test_recent_clips_filters_sources_manual_images_and_missing_metadata_file(monkeypatch, tmp_path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    good = _publish(db, tmp_path, "good", title="A searchable launch", published_at="2025-02-01T00:00:00+00:00")
    _publish(db, tmp_path, "script", origin="script-output")
    _publish(db, tmp_path, "manual", origin="manual-import")
    _publish(db, tmp_path, "source", origin="project-source")
    _publish(db, tmp_path, "image", media_type="image/png")
    missing_file = _publish(db, tmp_path, "gone-file")
    (tmp_path / db.blob_relative_path(missing_file.blob_id)).unlink()

    missing_blob = _publish(db, tmp_path, "gone-blob")
    with db._connect() as connection:
        connection.execute("DELETE FROM media_blob_refs WHERE blob_id=?", (missing_blob.blob_id,))
        connection.execute("DELETE FROM media_blobs WHERE id=?", (missing_blob.blob_id,))

    missing_ref = _publish(db, tmp_path, "gone-ref")
    with db._connect() as connection:
        connection.execute("DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id=?", (missing_ref.id,))

    with _client(monkeypatch, tmp_path, db) as client:
        response = client.get("/api/v1/library/recent-clips")
    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["items"]] == [good.id, "asset-script"]
    assert body["total"] == 2
    historical = next(item for item in body["items"] if item["id"] == "asset-script")
    assert historical["origin"] == "script-output"
    with _client(monkeypatch, tmp_path, db) as client:
        preview = client.get(historical["previewUrl"])
    assert preview.status_code == 200
    assert preview.content == b"media-script"


def test_recent_clips_search_count_pagination_and_newest_tie_break(monkeypatch, tmp_path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    stamp = "2025-02-01T00:00:00+00:00"
    _publish(db, tmp_path, "a", published_at=stamp, title="Launch alpha")
    _publish(db, tmp_path, "b", published_at=stamp, title="Launch beta")
    _publish(db, tmp_path, "c", published_at="2025-03-01T00:00:00+00:00", title="Other campaign")
    with _client(monkeypatch, tmp_path, db) as client:
        first = client.get("/api/v1/library/recent-clips", params={"search": "launch", "page": 1, "page_size": 1}).json()
        second = client.get("/api/v1/library/recent-clips", params={"search": "launch", "page": 2, "page_size": 1}).json()
    assert first["total"] == second["total"] == 2
    assert first["items"][0]["id"] == "asset-b"
    assert second["items"][0]["id"] == "asset-a"
    assert first["hasMore"] is True and second["hasMore"] is False
    assert first["pageSize"] == 1


def test_deleted_output_is_not_backfilled_after_restart(tmp_path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    asset = _publish(db, tmp_path, "deleted")
    project = Project(id="project-deleted", name="Deleted", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1)
    clip = Clip(id="clip-deleted", index=1, state="complete", start=0, end=1, duration=1, opening_line="Deleted clip", output_name="deleted.mp4", blob_id=asset.blob_id, library_asset_id=asset.id)
    job = Job(id="job-deleted", project_id=project.id, mode="clip", processing_mode="fast", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=[clip])
    db.save_project(project)
    db.save_job(job)
    db.delete_asset(asset.id)
    legacy_job = job.model_copy(update={"clips": [clip.model_copy(update={"library_asset_id": None})]})

    restarted = Database(db.path)
    repaired, count, ids = restarted.backfill_missing_assets(legacy_job)
    assert count == 0 and ids == []
    assert repaired.clips[0].library_asset_id is None
    assert restarted.get_generated_asset("generated-clip", project.id, job.id, clip.id) is None
