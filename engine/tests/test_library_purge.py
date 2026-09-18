from __future__ import annotations

from pathlib import Path
from dataclasses import replace

from fastapi.testclient import TestClient

from engine.app import app, settings as app_settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Job
from engine.providers import ProfileService
from engine.security import SecretVault
from engine.tests.test_global_project_deletion import fixture_project


def cluster(tmp_path: Path):
    settings = replace(app_settings, data_path=tmp_path)
    database = Database(tmp_path / "s6-cut.sqlite3")
    rules = LibraryRules(database, tmp_path / "library")
    manager = JobManager(database, rules, ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key")), settings)
    return database, manager, rules, settings


def use_cluster(database, manager, settings):
    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = database, manager, settings
    return app_module, original


def test_library_purge_removes_protected_media_and_linked_projects_but_keeps_folders(tmp_path: Path) -> None:
    database, manager, rules, settings, project, job, source_asset, output_asset = fixture_project(tmp_path)
    standalone_path = tmp_path / "standalone.mp4"
    standalone_path.write_bytes(b"protected standalone")
    standalone = rules.register_managed_video(standalone_path, title="Pinned", origin="manual-import", project_id=None, job_id=None, metadata={"duration": 1.0, "width": 16, "height": 9})
    database.save_asset(standalone.model_copy(update={"protected": True}))
    standalone_relative = database.blob_relative_path(standalone.blob_id)
    folders_before = {folder.id for folder in database.list_folders()}
    app_module, original = use_cluster(database, manager, settings)
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/library/purge", json={"confirmation": "DELETE ALL CONTENT"})
        assert response.status_code == 200
        body = response.json()
        assert body["assetsDeleted"] == 3
        assert body["projectsDeleted"] == 1
        assert body["blobsDeleted"] == 3
        assert body["bytesReclaimed"] > 0
    finally:
        app_module.db, app_module.manager, app_module.settings = original

    assert database.list_assets(include_archived=True) == []
    assert database.get_project(project.id) is None
    assert database.get_job(job.id) is None
    assert {folder.id for folder in database.list_folders()} == folders_before
    assert standalone_relative and not (tmp_path / standalone_relative).exists()
    assert not (tmp_path / "jobs" / job.id).exists()


def test_library_purge_requires_exact_phrase_and_is_repeatable(tmp_path: Path) -> None:
    database, manager, rules, settings = cluster(tmp_path)
    media = tmp_path / "media.mp4"
    media.write_bytes(b"media")
    rules.register_managed_video(media, title="Media", origin="manual-import", project_id=None, job_id=None, metadata={"duration": 1.0, "width": 16, "height": 9})
    app_module, original = use_cluster(database, manager, settings)
    try:
        with TestClient(app) as client:
            rejected = client.post("/api/v1/library/purge", json={"confirmation": "delete all content"})
            assert rejected.status_code == 409
            assert database.list_assets(include_archived=True)
            first = client.post("/api/v1/library/purge", json={"confirmation": "DELETE ALL CONTENT"})
            second = client.post("/api/v1/library/purge", json={"confirmation": "DELETE ALL CONTENT"})
        assert first.status_code == 200
        assert first.json()["assetsDeleted"] == 1
        assert second.status_code == 200
        assert second.json()["assetsDeleted"] == 0
    finally:
        app_module.db, app_module.manager, app_module.settings = original


def test_library_purge_rejects_queued_jobs_without_mutation(tmp_path: Path) -> None:
    database, manager, rules, settings = cluster(tmp_path)
    media = tmp_path / "media.mp4"
    media.write_bytes(b"media")
    rules.register_managed_video(media, title="Media", origin="manual-import", project_id=None, job_id=None, metadata={"duration": 1.0, "width": 16, "height": 9})
    database.save_job(Job(id="queued-job", project_id="missing-project", mode="clip", processing_mode="fast", state="queued", stage="queued", stage_label="Queued", progress=0, style="educational"), {})
    app_module, original = use_cluster(database, manager, settings)
    try:
        # Deliberately no lifespan here: entering TestClient as a context manager
        # starts the job worker, which is free to claim this queued job and fail
        # it (its project and source do not exist) before the request lands. The
        # job would then no longer be queued and the purge would be allowed —
        # the assertion below would fail for a reason that has nothing to do with
        # the guard it is testing. The endpoint reads the database directly, so
        # it needs no running worker.
        response = TestClient(app).post("/api/v1/library/purge", json={"confirmation": "DELETE ALL CONTENT"})
        assert response.status_code == 409
        assert "queued or running" in response.json()["detail"]
    finally:
        app_module.db, app_module.manager, app_module.settings = original
    assert database.list_assets(include_archived=True)
