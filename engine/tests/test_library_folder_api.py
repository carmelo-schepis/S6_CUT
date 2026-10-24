from __future__ import annotations

import dataclasses
import sqlite3
import pytest
from fastapi.testclient import TestClient

from engine import app as app_module
from engine.database import Database, UNSORTED_FOLDER_ID
from engine.models import Asset, Job, LibraryFolder, Project


@pytest.fixture
def api(tmp_path, monkeypatch):
    database = Database(tmp_path / "s6-cut.sqlite3")
    monkeypatch.setattr(app_module, "db", database)
    monkeypatch.setattr(app_module, "settings", dataclasses.replace(app_module.settings, data_path=tmp_path))
    client = TestClient(app_module.app)
    try:
        yield client, database
    finally:
        client.close()


def create(client, name, parent_id=None):
    body = {"name": name, "description": "initial", "color": "#123456"}
    if parent_id is not None:
        body["parentId"] = parent_id
    response = client.post("/api/v1/library/folders", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_list_update_and_guards(api):
    client, db = api
    root = create(client, "Client")
    assert root["parentId"] is None
    assert root["id"] in {f["id"] for f in client.get("/api/v1/library/folders").json()}
    updated = client.put(f"/api/v1/library/folders/{root['id']}", json={"name": "Renamed"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["description"] == "initial"
    assert db.get_folder(root["id"]).color == "#123456"
    assert client.post("/api/v1/library/folders", json={"name": "renamed"}).status_code == 409
    assert client.post("/api/v1/library/folders", json={"name": "Orphan", "parentId": "missing"}).status_code == 404
    assert client.put("/api/v1/library/folders/missing", json={"name": "x"}).status_code == 404
    assert client.put(f"/api/v1/library/folders/{UNSORTED_FOLDER_ID}", json={"name": "x"}).status_code == 409
    second = create(client, "Child", root["id"])
    third = create(client, "Grandchild", second["id"])
    assert client.post("/api/v1/library/folders", json={"name": "Too deep", "parentId": third["id"]}).status_code == 409


def test_move_archive_query_binding_and_protections(api):
    client, db = api
    first, second = create(client, "First"), create(client, "Second")
    child = create(client, "Child", first["id"])
    response = client.post(f"/api/v1/library/folders/{child['id']}/move", json={"parentId": second["id"]})
    assert response.status_code == 200 and response.json()["parentId"] == second["id"]
    assert db.get_folder(child["id"]).parent_id == second["id"]
    assert client.post(f"/api/v1/library/folders/{second['id']}/move", json={"parentId": child["id"]}).status_code == 409
    assert client.post(f"/api/v1/library/folders/{child['id']}/move", json={"parentId": "missing"}).status_code == 409
    assert db.get_folder(child["id"]).parent_id == second["id"]
    archived = client.post(f"/api/v1/library/folders/{first['id']}/archive")
    assert archived.status_code == 200 and archived.json()["archived"] is True
    assert first["id"] not in {f["id"] for f in client.get("/api/v1/library/folders").json()}
    assert first["id"] in {f["id"] for f in client.get("/api/v1/library/folders?include_archived=true").json()}
    assert client.post(f"/api/v1/library/folders/{first['id']}/archive?archived=false").json()["archived"] is False
    assert client.post("/api/v1/library/folders/missing/archive").status_code == 404
    assert client.post(f"/api/v1/library/folders/{UNSORTED_FOLDER_ID}/archive").status_code == 409


def test_remove_confirmation_soft_delete_redirect_and_relocation(api, tmp_path):
    client, db = api
    target, destination = create(client, "Remove"), create(client, "Destination")
    child = create(client, "Child", target["id"])
    project = Project(id="p", name="Project", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="j", library_folder_id=target["id"])
    job = Job(id="j", project_id="p", library_folder_id=target["id"], mode="clip", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational")
    asset = Asset(id="a", title="Asset", media_type="image/png", filename="a.png", content_hash="hash", folder_id=target["id"])
    db.save_project(project); db.save_job(job); db.save_asset(asset)
    url = f"/api/v1/library/folders/{target['id']}"
    assert client.delete(url).status_code == 409
    assert client.delete(url, params={"confirmed": "true", "destination_folder_id": "missing"}).status_code == 409
    assert db.get_folder(target["id"]) is not None
    response = client.delete(url, params={"confirmed": "true", "destination_folder_id": destination["id"]})
    assert response.status_code == 204 and not response.content
    assert db.get_asset("a").folder_id == destination["id"]
    assert db.get_folder(child["id"]).parent_id == destination["id"]
    assert db.get_project("p").library_folder_id == destination["id"]
    assert db.get_job("j").library_folder_id == target["id"]
    assert db.resolve_folder_id(target["id"]) == destination["id"]
    assert target["id"] not in {f["id"] for f in client.get("/api/v1/library/folders?include_archived=true").json()}
    with sqlite3.connect(tmp_path / "s6-cut.sqlite3") as conn:
        assert conn.execute("SELECT deleted FROM library_folders WHERE id=?", (target["id"],)).fetchone()[0] == 1


def test_project_folder_and_asset_move_http(api):
    client, db = api
    old, new = create(client, "Old"), create(client, "New")
    project_destination = create(client, "Project destination")
    project = Project(id="p", name="Project", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="j", library_folder_id=old["id"])
    job = Job(id="j", project_id="p", library_folder_id=old["id"], mode="clip", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational")
    db.save_project(project); db.save_job(job)
    for ident in ("one", "two", "other"):
        db.save_asset(Asset(id=ident, title=ident, media_type="image/png", filename=f"{ident}.png", content_hash=ident, folder_id=old["id"], source_project_id="p" if ident != "other" else None))
    response = client.put("/api/v1/projects/p/folder", json={"folderId": new["id"]})
    assert response.status_code == 200
    assert response.json()["libraryFolderId"] == new["id"]
    assert db.get_project("p").library_folder_id == new["id"]
    assert all(db.get_asset(ident).folder_id == old["id"] for ident in ("one", "two", "other"))
    assert db.get_job("j").library_folder_id == old["id"]
    response = client.put("/api/v1/projects/p/folder", json={"folderId": project_destination["id"], "moveExistingAssets": True})
    assert response.status_code == 200
    assert response.json()["libraryFolderId"] == project_destination["id"]
    assert db.get_project("p").library_folder_id == project_destination["id"]
    assert all(db.get_asset(ident).folder_id == project_destination["id"] for ident in ("one", "two"))
    assert db.get_asset("other").folder_id == old["id"]
    assert db.get_job("j").library_folder_id == old["id"]
    assert client.put("/api/v1/projects/missing/folder", json={"folderId": new["id"]}).status_code == 404
    before = db.get_project("p").library_folder_id
    assert client.put("/api/v1/projects/p/folder", json={"folderId": "missing"}).status_code == 409
    archived = create(client, "Archived")
    client.post(f"/api/v1/library/folders/{archived['id']}/archive")
    assert client.put("/api/v1/projects/p/folder", json={"folderId": archived["id"]}).status_code == 409
    assert db.get_project("p").library_folder_id == before
    moved = client.post("/api/v1/library/assets/move", json={"assetIds": ["one", "two"], "folderId": new["id"]})
    assert moved.status_code == 200 and moved.json() == {"moved": 2}
    assert all(db.get_asset(ident).folder_id == new["id"] for ident in ("one", "two"))
    assert db.get_asset("other").folder_id == old["id"]
    for payload in ({"assetIds": ["one", "absent"], "folderId": old["id"]}, {"assetIds": ["one"], "folderId": "missing"}, {"assetIds": [], "folderId": old["id"]}):
        snapshot = {item: db.get_asset(item).folder_id for item in ("one", "two", "other")}
        assert client.post("/api/v1/library/assets/move", json=payload).status_code == 422
        assert {item: db.get_asset(item).folder_id for item in snapshot} == snapshot
    assert client.post("/api/v1/library/assets/move", json={"assetIds": ["one"], "folderId": archived["id"]}).status_code == 422
