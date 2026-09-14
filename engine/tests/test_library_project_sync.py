from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.app import app, settings as app_settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Asset, Clip, Job, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def project(project_id: str, name: str | None = None) -> Project:
    return Project(
        id=project_id,
        name=name or project_id,
        mode="clip",
        style="educational",
        state="complete",
        source_name="source.mp4",
        source_kind="upload",
        requested_count=1,
    )


def asset(asset_id: str, project_id: str, *, protected: bool = False) -> Asset:
    return Asset(
        id=asset_id,
        title=asset_id,
        media_type="video/mp4",
        filename=f"{asset_id}.mp4",
        content_hash=f"hash-{asset_id}",
        blob_id=f"blob-{asset_id}",
        origin="generated-clip",
        source_project_id=project_id,
        source_job_id=f"job-{project_id}",
        source_clip_id=f"clip-{asset_id}",
        protected=protected,
    )


def save_project_assets(database: Database, item: Project, assets: list[Asset]) -> None:
    database.save_project(item)
    for item in assets:
        database.save_asset(item)


def test_legacy_orphan_projects_are_reconciled_on_database_startup(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    item = project("legacy-project", "Legacy orphan")
    database.save_project(item)
    with database._connect() as connection:
        connection.execute("UPDATE projects SET library_deleted=0 WHERE id=?", (item.id,))
        connection.execute("DELETE FROM schema_migrations WHERE version=7")

    restarted = Database(database.path)
    assert restarted.list_projects() == []
    with restarted._connect() as connection:
        assert connection.execute("SELECT library_deleted FROM projects WHERE id=?", (item.id,)).fetchone()[0] == 1


def test_last_library_asset_hides_project_from_persisted_recent_listing(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    item = project("project-a", "Project A")
    first, second = asset("asset-a1", item.id), asset("asset-a2", item.id)
    save_project_assets(database, item, [first, second])

    database.delete_asset(first.id)
    assert [value.id for value in database.list_projects()] == [item.id]

    database.delete_asset(second.id)
    assert database.list_projects() == []
    assert database.get_project(item.id) is not None

    restarted = Database(database.path)
    assert restarted.list_projects() == []
    assert restarted.get_asset(first.id) is None
    assert restarted.get_asset(second.id) is None


def test_project_with_any_remaining_associated_asset_stays_visible(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    first = project("project-a", "Project A")
    second = project("project-b", "Project B")
    first_assets = [asset("asset-a1", first.id), asset("asset-a2", first.id)]
    save_project_assets(database, first, first_assets)
    save_project_assets(database, second, [asset("asset-b1", second.id)])

    database.delete_asset(first_assets[0].id)
    assert {value.id for value in database.list_projects()} == {first.id, second.id}
    database.delete_asset(first_assets[1].id)
    assert [value.id for value in database.list_projects()] == [second.id]


def test_library_asset_deletion_is_idempotent_and_protected_failures_preserve_project(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    item = project("project-a")
    removable, pinned = asset("asset-a1", item.id), asset("asset-a2", item.id, protected=True)
    save_project_assets(database, item, [removable, pinned])

    database.delete_asset(removable.id)
    with pytest.raises(KeyError):
        database.delete_asset(removable.id)
    with pytest.raises(ValueError, match="Protected assets"):
        database.delete_asset(pinned.id)
    assert [value.id for value in database.list_projects()] == [item.id]
    assert database.get_asset(pinned.id) is not None

    database.save_asset(pinned.model_copy(update={"protected": False}))
    database.delete_asset(pinned.id)
    assert database.list_projects() == []


def test_deleting_a_project_source_cascades_project_outputs_and_job_workspace(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    settings = replace(app_settings, data_path=tmp_path)
    rules = LibraryRules(database, tmp_path / "library")
    manager = JobManager(database, rules, ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key")), settings)
    project_id, job_id = "project-a", "job-a"
    source_path = tmp_path / "jobs" / job_id / "source.mp4"
    output_path = tmp_path / "jobs" / job_id / "clips" / "01-cut.mp4"
    source_path.parent.mkdir(parents=True)
    output_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"source")
    output_path.write_bytes(b"output")
    source = rules.register_managed_video(source_path, title="Source", origin="project-source", project_id=project_id, job_id=job_id, clip_id="source", metadata={"duration": 20, "width": 1920, "height": 1080})
    output = rules.register_managed_video(output_path, title="Output", origin="generated-clip", project_id=project_id, job_id=job_id, clip_id="clip-a", metadata={"duration": 8, "width": 1080, "height": 1920})
    database.save_project(project(project_id, "Project A").model_copy(update={"latest_job_id": job_id, "source_blob_id": source.blob_id}))
    database.save_job(Job(id=job_id, project_id=project_id, mode="clip", processing_mode="fast", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=[Clip(id="clip-a", index=1, state="complete", start=0, end=8, duration=8, opening_line="Output", output_name="01-cut.mp4", blob_id=output.blob_id, library_asset_id=output.id)]))

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = database, manager, settings
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/library/assets/bulk-delete", json={"assetIds": [source.id]})
    finally:
        app_module.db, app_module.manager, app_module.settings = original

    assert response.status_code == 200
    assert response.json() == {"deleted": [source.id], "failed": {}}
    assert database.get_project(project_id) is None
    assert database.get_job(job_id) is None
    assert database.get_asset(source.id) is None
    assert database.get_asset(output.id) is None
    assert not source_path.exists()
    assert not output_path.exists()


def test_bulk_delete_reports_partial_failure_without_hiding_project(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    item = project("project-a")
    removable, pinned = asset("asset-a1", item.id), asset("asset-a2", item.id, protected=True)
    save_project_assets(database, item, [removable, pinned])

    import engine.app as app_module
    original = app_module.db
    app_module.db = database
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/library/assets/bulk-delete", json={"assetIds": [removable.id, pinned.id]})
    finally:
        app_module.db = original

    assert response.status_code == 200
    assert response.json() == {"deleted": [removable.id], "failed": {pinned.id: "Protected assets cannot be removed"}}
    assert database.get_asset(removable.id) is None
    assert database.get_asset(pinned.id) is not None
    assert [value.id for value in database.list_projects()] == [item.id]


def test_new_published_asset_restores_a_project_hidden_by_library_deletion(tmp_path: Path) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    item = project("project-a")
    original = asset("asset-a1", item.id)
    save_project_assets(database, item, [original])
    database.delete_asset(original.id)
    assert database.list_projects() == []

    replacement = asset("asset-a2", item.id)
    database.register_blob_asset(replacement, "blobs/sha256/bl/blob-a2.mp4", 12)
    assert [value.id for value in database.list_projects()] == [item.id]
