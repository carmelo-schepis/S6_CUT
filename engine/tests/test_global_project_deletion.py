from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.app import app, settings as app_settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Clip, Job, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def cluster(tmp_path: Path) -> tuple[Database, JobManager, LibraryRules, Settings]:
    settings = replace(app_settings, data_path=tmp_path)
    database = Database(tmp_path / "s6-cut.sqlite3")
    rules = LibraryRules(database, tmp_path / "library")
    manager = JobManager(database, rules, ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key")), settings)
    return database, manager, rules, settings


def fixture_project(tmp_path: Path, project_id: str = "global-project", job_id: str = "global-job"):
    database, manager, rules, settings = cluster(tmp_path)
    source = tmp_path / "jobs" / job_id / "source.mp4"
    output = tmp_path / "jobs" / job_id / "clips" / "01-cut.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"global-project-source")
    output.write_bytes(b"global-project-output")
    source_asset = rules.register_managed_video(source, title="Global source", origin="project-source", project_id=project_id, job_id=job_id, clip_id="source", metadata={"duration": 20.0, "width": 1920, "height": 1080})
    output_asset = rules.register_managed_video(output, title="Global output", origin="generated-clip", project_id=project_id, job_id=job_id, clip_id="global-clip", metadata={"duration": 8.0, "width": 1080, "height": 1920})
    project = Project(id=project_id, name="Global deletion", mode="clip", style="educational", state="complete", source_name="source.mp4", source_kind="upload", requested_count=1, latest_job_id=job_id, source_blob_id=source_asset.blob_id)
    clip = Clip(id="global-clip", index=1, state="complete", start=0, end=8, duration=8, opening_line="Global cut", output_name="01-cut.mp4", blob_id=output_asset.blob_id, library_asset_id=output_asset.id)
    job = Job(id=job_id, project_id=project_id, mode="clip", processing_mode="fast", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=[clip])
    database.save_project(project)
    database.save_job(job, {"aspect_ratio": "9:16"})
    return database, manager, rules, settings, project, job, source_asset, output_asset


def test_global_project_deletion_removes_records_assets_and_unreferenced_blob_files(tmp_path: Path) -> None:
    database, manager, _, _, project, job, source_asset, output_asset = fixture_project(tmp_path)
    paths = [database.blob_relative_path(asset.blob_id) for asset in (source_asset, output_asset)]

    asyncio.run(manager.delete_project(project.id, delete_assets=True))

    assert database.get_project(project.id) is None
    assert database.get_job(job.id) is None
    assert database.get_asset(source_asset.id) is None
    assert database.get_asset(output_asset.id) is None
    assert all(path and not (tmp_path / path).exists() for path in paths)
    assert not (tmp_path / "jobs" / job.id).exists()
    with pytest.raises(KeyError):
        asyncio.run(manager.delete_project(project.id, delete_assets=True))


def test_ordinary_project_deletion_remains_non_cascading(tmp_path: Path) -> None:
    database, manager, _, settings, project, job, source_asset, output_asset = fixture_project(tmp_path)

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = database, manager, settings
    try:
        with TestClient(app) as client:
            response = client.delete(f"/api/v1/projects/{project.id}")
        assert response.status_code == 204
    finally:
        app_module.db, app_module.manager, app_module.settings = original
    assert database.get_project(project.id) is None
    assert database.get_job(job.id) is None
    assert database.get_asset(source_asset.id) is not None
    assert database.get_asset(output_asset.id) is not None


def test_global_project_deletion_rejects_protected_media_without_partial_deletion(tmp_path: Path) -> None:
    database, manager, _, settings, project, job, source_asset, output_asset = fixture_project(tmp_path)
    database.save_asset(output_asset.model_copy(update={"protected": True}))

    import engine.app as app_module
    original = (app_module.db, app_module.manager, app_module.settings)
    app_module.db, app_module.manager, app_module.settings = database, manager, settings
    try:
        with TestClient(app) as client:
            response = client.delete(f"/api/v1/projects/{project.id}?delete_assets=true")
        assert response.status_code == 409
        assert "Unprotect associated media" in response.json()["detail"]
    finally:
        app_module.db, app_module.manager, app_module.settings = original
    assert database.get_project(project.id) is not None
    assert database.get_job(job.id) is not None
    assert database.get_asset(source_asset.id) is not None
    assert database.get_asset(output_asset.id) is not None


def test_global_project_deletion_preserves_shared_blob_and_unaffected_publication(tmp_path: Path) -> None:
    database, manager, rules, _, project, _, _, output_asset = fixture_project(tmp_path)
    other_output = tmp_path / "jobs" / "other-job" / "clips" / "01-cut.mp4"
    other_output.parent.mkdir(parents=True, exist_ok=True)
    other_output.write_bytes(b"global-project-output")
    other_asset = rules.register_managed_video(other_output, title="Other output", origin="generated-clip", project_id="other-project", job_id="other-job", clip_id="other-clip", metadata={"duration": 8.0, "width": 1080, "height": 1920})
    other_project = Project(id="other-project", name="Other", mode="clip", style="educational", state="complete", source_name="other.mp4", source_kind="upload", requested_count=1, latest_job_id="other-job")
    other_clip = Clip(id="other-clip", index=1, state="complete", start=0, end=8, duration=8, opening_line="Other", output_name="01-cut.mp4", blob_id=other_asset.blob_id, library_asset_id=other_asset.id)
    other_job = Job(id="other-job", project_id="other-project", mode="clip", processing_mode="fast", state="complete", stage="complete", stage_label="Ready", progress=100, style="educational", clips=[other_clip])
    database.save_project(other_project)
    database.save_job(other_job, {"aspect_ratio": "9:16"})

    asyncio.run(manager.delete_project(project.id, delete_assets=True))

    relative = database.blob_relative_path(other_asset.blob_id)
    assert output_asset.blob_id == other_asset.blob_id
    assert relative and (tmp_path / relative).is_file()
    assert database.get_asset(other_asset.id) is not None
    assert database.validate_clip_asset_relationship(other_clip, other_asset) is None


def test_global_project_deletion_waits_for_worker_lock_and_marks_project(tmp_path: Path) -> None:
    database, manager, _, _, project, job, _, _ = fixture_project(tmp_path)

    async def delete_while_locked() -> None:
        lock = manager.job_locks[job.id]
        lock.acquire()
        deletion = asyncio.create_task(manager.delete_project(project.id, delete_assets=True))
        await asyncio.sleep(0)
        assert project.id in manager._deleting_projects
        assert database.get_project(project.id) is not None
        lock.release()
        await deletion

    asyncio.run(delete_while_locked())
    assert database.get_project(project.id) is None
