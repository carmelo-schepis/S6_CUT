from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.database import Database
from engine.app import app
from engine.models import Asset, Project


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
