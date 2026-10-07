from __future__ import annotations

import asyncio
from dataclasses import replace

from fastapi.testclient import TestClient

from engine.config import settings as app_settings
from engine.database import Database
from engine.library import LibraryRules
from engine.jobs import JobManager
from engine.models import Clip, Job, ProcessingStep, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def _isolated_client(monkeypatch, tmp_path):
    import engine.app as app_module

    async def no_lifecycle_work():
        pass

    isolated_db = Database(tmp_path / "s6-cut.sqlite3")
    runtime = replace(app_settings, data_path=tmp_path)
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    profiles = ProfileService(isolated_db, vault)
    manager = JobManager(isolated_db, LibraryRules(isolated_db, tmp_path / "library"), profiles, runtime)
    monkeypatch.setattr(manager, "start", no_lifecycle_work)
    monkeypatch.setattr(manager, "stop", no_lifecycle_work)
    monkeypatch.setattr(app_module, "db", isolated_db)
    monkeypatch.setattr(app_module, "settings", runtime)
    monkeypatch.setattr(app_module, "profiles", profiles)
    monkeypatch.setattr(app_module, "manager", manager)
    return TestClient(app_module.app), isolated_db


def test_retired_script_creation_route_is_absent_from_openapi_and_has_no_side_effects(monkeypatch, tmp_path):
    client, isolated_db = _isolated_client(monkeypatch, tmp_path)
    before_projects = isolated_db.list_projects()
    before_jobs = isolated_db.list_jobs()

    paths = client.get("/api/openapi.json").json()["paths"]
    assert "/api/v1/jobs/script" not in paths
    assert "/api/v1/ai/topic-plan" not in paths
    import engine.app as app_module

    provider_calls = []
    async def observe_provider_call(*_args, **_kwargs):
        provider_calls.append(True)
    monkeypatch.setattr(app_module.profiles, "openrouter_json", observe_provider_call)

    response = client.post("/api/v1/jobs/script", json={"script": "An old script request."})
    topic_plan = client.post("/api/v1/ai/topic-plan", json={"topic": "An old topic request."})

    assert response.status_code == 405
    assert topic_plan.status_code == 404
    assert isolated_db.list_projects() == before_projects
    assert isolated_db.list_jobs() == before_jobs
    assert not list(tmp_path.glob("jobs/*"))
    assert provider_calls == []


def test_legacy_script_project_and_job_survive_database_restart_and_remain_readable(monkeypatch, tmp_path):
    database_path = tmp_path / "s6-cut.sqlite3"
    original = Database(database_path)
    project = Project(
        id="11111111-1111-4111-8111-111111111111", name="Historical narration", mode="script", style="serious",
        state="complete", source_name="37 character script", source_kind="script", requested_count=1,
        latest_job_id="22222222-2222-4222-8222-222222222222",
    )
    job = Job(
        id="22222222-2222-4222-8222-222222222222", project_id=project.id, mode="script", state="complete", stage="complete",
        stage_label="Complete", progress=100, style="serious",
    )
    original.save_project(project)
    original.save_job(job, {"script": "Historical narration remains available."})

    restarted = Database(database_path)

    assert restarted.get_project(project.id) == project
    assert restarted.get_job(job.id) == job
    assert restarted.get_job_private(job.id)["script"] == "Historical narration remains available."
    client, _ = _isolated_client(monkeypatch, tmp_path)
    import engine.app as app_module
    monkeypatch.setattr(app_module, "db", restarted)
    assert client.get(f"/api/v1/projects/{project.id}").json()["mode"] == "script"
    assert client.get(f"/api/v1/jobs/{job.id}").json()["mode"] == "script"


def test_legacy_resume_retry_and_caption_rerender_are_rejected_without_side_effects(monkeypatch, tmp_path):
    client, database = _isolated_client(monkeypatch, tmp_path)
    import engine.app as app_module

    project = Project(
        id="legacy-action-project", name="Legacy action", mode="script", style="serious",
        state="paused", source_name="legacy source", source_kind="script", requested_count=1,
        latest_job_id="legacy-action-job",
    )
    job = Job(
        id="legacy-action-job", project_id=project.id, mode="script", state="paused", stage="queued",
        stage_label="Paused", progress=0, style="serious",
        clips=[Clip(id="legacy-action-clip", index=1, state="failed", start=0, end=3, duration=3, opening_line="old output")],
    )
    database.save_project(project)
    database.save_job(job, {"script": "historical text"})
    before_job = database.get_job(job.id)
    before_private = database.get_job_private(job.id)
    enqueue_calls = []
    provider_calls = []

    async def observe_enqueue(*_args, **_kwargs):
        enqueue_calls.append(True)

    async def observe_provider(*_args, **_kwargs):
        provider_calls.append(True)

    monkeypatch.setattr(app_module.manager, "enqueue", observe_enqueue)
    monkeypatch.setattr(app_module.profiles, "openrouter_json", observe_provider)

    paths = [
        f"/api/v1/jobs/{job.id}/control/resume",
        f"/api/v1/jobs/{job.id}/control/retry-failed",
        f"/api/v1/jobs/{job.id}/clips/legacy-action-clip/retry",
        f"/api/v1/jobs/{job.id}/clips/legacy-action-clip/captions/rerender?revision=1",
    ]
    responses = [client.post(path) for path in paths]

    assert [response.status_code for response in responses] == [410, 410, 410, 410]
    assert database.get_job(job.id) == before_job
    assert database.get_job_private(job.id) == before_private
    assert enqueue_calls == []
    assert provider_calls == []
    assert not list((tmp_path / "jobs").glob("*"))


def test_restart_terminalizes_queued_legacy_script_job_without_resuming_it(tmp_path):
    database = Database(tmp_path / "restart.sqlite3")
    project = Project(
        id="queued-legacy-project", name="Legacy queued", mode="script", style="serious",
        state="queued", source_name="37 character script", source_kind="script", requested_count=1,
        latest_job_id="queued-legacy-job",
    )
    job = Job(
        id="queued-legacy-job", project_id=project.id, mode="script", state="queued", stage="queued",
        stage_label="Queued", progress=0, style="serious",
        steps=[ProcessingStep(id="render", label="Render")],
    )
    database.save_project(project)
    database.save_job(job, {"script": "Historical narration remains available."})
    runtime = replace(app_settings, data_path=tmp_path, job_workers=1)
    manager = JobManager(database, LibraryRules(database, tmp_path / "library"), ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key")), runtime)

    async def restart_and_stop():
        await manager.start()
        await manager.stop()

    asyncio.run(restart_and_stop())

    terminal = Database(database.path).get_job(job.id)
    assert terminal is not None
    assert terminal.state == "failed"
    assert "legacy" in terminal.stage_label.lower()
    assert terminal.clips == []
    assert Database(database.path).get_job_private(job.id)["script"] == "Historical narration remains available."
