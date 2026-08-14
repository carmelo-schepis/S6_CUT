from __future__ import annotations

import sqlite3
import uuid

import pytest

from engine.database import Database, UNSORTED_FOLDER_ID
from engine.models import Asset, Job, LibraryFolder, Project


def folder(name: str, parent_id: str | None = None) -> LibraryFolder:
    return LibraryFolder(id=str(uuid.uuid4()), name=name, parent_id=parent_id)


def test_migration_is_restart_safe_and_assigns_existing_assets(tmp_path):
    path = tmp_path / "old.sqlite3"
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE assets(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE projects(id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL,private_payload TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE profiles(id TEXT PRIMARY KEY,selected INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,payload TEXT NOT NULL,secret_payload BLOB);
            CREATE TABLE analysis_cache(cache_key TEXT PRIMARY KEY,created_at TEXT NOT NULL,payload TEXT NOT NULL);
        """)
        asset = Asset(id="a", title="Old", media_type="image/png", filename="a.png", content_hash="hash")
        db.execute("INSERT INTO assets VALUES(?,?,?,?)", (asset.id, asset.content_hash, asset.created_at, asset.model_dump_json(by_alias=True)))
    legacy_file = tmp_path / "library" / "a" / "a.png"
    legacy_file.parent.mkdir(parents=True)
    legacy_file.write_bytes(b"legacy")
    first = Database(path)
    second = Database(path)
    assert first.get_asset("a").folder_id == UNSORTED_FOLDER_ID
    assert second.get_folder(UNSORTED_FOLDER_ID).system
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=2").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=3").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=4").fetchone()[0] == 1
    assert legacy_file.read_bytes() == b"legacy"
    assert not (tmp_path / "blobs").exists()


def test_folder_constraints_move_and_safe_removal(tmp_path):
    db = Database(tmp_path / "db.sqlite3")
    root = db.save_folder(folder("Client"))
    with pytest.raises(ValueError, match="already exists"):
        db.save_folder(folder("CLIENT"))
    child = db.save_folder(folder("Campaign", root.id))
    grandchild = db.save_folder(folder("Social", child.id))
    with pytest.raises(ValueError, match="3 levels"):
        db.save_folder(folder("Too deep", grandchild.id))
    with pytest.raises(ValueError, match="cycle"):
        db.move_folder(root.id, grandchild.id)
    with pytest.raises(ValueError, match="inside"):
        db.remove_folder(root.id, grandchild.id)

    asset = Asset(id="asset", title="Logo", media_type="image/png", filename="logo.png", content_hash="blob", folder_id=root.id)
    db.save_asset(asset)
    project = Project(id="active-project", name="Active", mode="clip", style="educational", state="active", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="active-job", library_folder_id=root.id)
    job = Job(id="active-job", project_id=project.id, library_folder_id=root.id, mode="clip", state="active", stage="render", stage_label="Rendering", progress=50, style="educational")
    db.save_project(project)
    db.save_job(job)
    db.remove_folder(root.id, UNSORTED_FOLDER_ID)
    assert db.get_asset(asset.id).folder_id == UNSORTED_FOLDER_ID
    assert db.get_folder(child.id).parent_id == UNSORTED_FOLDER_ID
    assert db.get_folder(root.id) is None
    assert db.get_project(project.id).library_folder_id == UNSORTED_FOLDER_ID
    assert db.get_job(job.id).library_folder_id == root.id  # immutable running-job snapshot
    later = Asset(id="later", title="Later cut", media_type="video/mp4", filename="later.mp4", content_hash="later-hash", blob_id="later-hash", folder_id=root.id, origin="generated-clip", source_project_id=project.id, source_job_id=job.id, source_clip_id="later-clip")
    registered = db.register_blob_asset(later, "blobs/sha256/la/later-hash.mp4", 10)
    assert registered.folder_id == UNSORTED_FOLDER_ID


def test_project_folder_change_can_move_existing_or_future_only(tmp_path):
    db = Database(tmp_path / "db.sqlite3")
    original = db.save_folder(folder("Original"))
    destination = db.save_folder(folder("Destination"))
    project = Project(id="project", name="Client", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id="job", library_folder_id=original.id)
    job = Job(id="job", project_id="project", library_folder_id=original.id, mode="clip", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational")
    asset = Asset(id="automatic", title="Client — Cut 01", media_type="video/mp4", filename="cut.mp4", content_hash="auto", origin="generated-clip", source_project_id="project", source_job_id="job", source_clip_id="clip", folder_id=original.id)
    db.save_project(project)
    db.save_job(job)
    db.save_asset(asset)

    changed = db.update_project_folder("project", destination.id, False)
    assert changed.library_folder_id == destination.id
    assert db.get_asset(asset.id).folder_id == original.id
    assert db.get_job("job").library_folder_id == original.id  # immutable snapshot
    db.update_project_folder("project", destination.id, True)
    assert db.get_asset(asset.id).folder_id == destination.id


def test_asset_combined_filters_and_bulk_move(tmp_path):
    db = Database(tmp_path / "db.sqlite3")
    target = db.save_folder(folder("Acme"))
    image = Asset(id="i", title="Acme Logo", media_type="image/png", filename="brand.png", tags=["blue"], brands=["Northwind"], people=["Ada"], content_hash="one")
    video = Asset(id="v", title="Other", media_type="video/mp4", filename="cut.mp4", content_hash="two", origin="generated-clip")
    db.save_asset(image)
    db.save_asset(video)
    assert [item.id for item in db.list_assets(media_type="image", search="blue")] == ["i"]
    assert [item.id for item in db.list_assets(search="Northwind")] == ["i"]
    assert [item.id for item in db.list_assets(search="Ada")] == ["i"]
    assert [item.id for item in db.list_assets(origin="generated-clip")] == ["v"]
    assert db.move_assets(["i", "v"], target.id) == 2
    assert {item.id for item in db.list_assets(folder_id=target.id)} == {"i", "v"}
    db.save_folder(target.model_copy(update={"archived": True}))
    assert db.list_assets(folder_id=target.id) == []
    assert {item.id for item in db.list_assets(folder_id=target.id, include_archived=True)} == {"i", "v"}
