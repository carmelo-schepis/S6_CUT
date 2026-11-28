"""The Workspace must only offer Retry import where the engine would accept it.

The offer used to be inferred in the browser from the project's source kind
while the engine decided from the job's own private payload. When those
disagreed the customer was shown the one recovery control their failed project
had, and it answered 409.
"""
from __future__ import annotations

import asyncio
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest

from engine.app import settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager, QueueFullError, can_retry_import
from engine.library import LibraryRules
from engine.media import MediaError
from engine.models import Job, Project
from engine.providers import ProfileService
from engine.security import SecretVault


@pytest.fixture
def workspace() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-retry-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    test_settings: Settings = replace(settings, data_path=tmp_path)
    db = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    return db, JobManager(db, LibraryRules(db, tmp_path / "library"), profiles, test_settings)


def _job(state: str = "failed", mode: str = "clip") -> Job:
    return Job(
        id=f"j-{state}-{mode}", project_id="p", mode=mode, state=state, stage="failed",
        stage_label="Project failed", progress=0, style="funny", steps=[], clips=[], beats=[], warnings=[],
    )


def test_an_import_with_a_url_can_be_retried_only_from_a_stopped_state() -> None:
    youtube = {"url": "https://www.youtube.com/watch?v=abc"}
    for state in ("failed", "stalled", "cancelled_kept"):
        assert can_retry_import(_job(state), youtube) is True, state
    for state in ("queued", "active", "paused", "complete"):
        assert can_retry_import(_job(state), youtube) is False, state


def test_a_job_with_no_import_can_never_be_retried_as_one() -> None:
    upload = {"source_path": "/app/data/uploads/source.mp4"}
    assert can_retry_import(_job("failed"), upload) is False
    assert can_retry_import(_job("failed"), {}) is False
    # A script job has no import step whatever its payload says.
    assert can_retry_import(_job("failed", mode="script"), {"url": "https://example.com/x"}) is False


def test_control_refuses_a_retry_the_workspace_would_not_offer(workspace: Path) -> None:
    db, manager = _cluster(workspace)
    db.save_project(Project(
        id="p", name="Uploaded", mode="clip", style="funny", state="failed",
        source_name="source.mp4", source_kind="upload", requested_count=1,
    ))
    job = _job("failed").model_copy(update={"id": "j-upload", "project_id": "p"})
    db.save_job(job, {"source_path": str(workspace / "source.mp4")})

    assert can_retry_import(job, db.get_job_private(job.id)) is False
    with pytest.raises(MediaError) as raised:
        asyncio.run(manager.control(job.id, "retry-import"))
    assert "no YouTube import" in str(raised.value)


def test_retry_import_does_not_wedge_job_in_queued_when_queue_is_full(workspace: Path) -> None:
    test_settings: Settings = replace(settings, data_path=workspace, max_queued_jobs=1)
    db = Database(workspace / "s6-cut.sqlite3")
    profiles = ProfileService(db, SecretVault(workspace / "secrets" / "instance.key"))
    manager = JobManager(db, LibraryRules(db, workspace / "library"), profiles, test_settings)

    db.save_project(Project(
        id="p-stalled", name="Stalled YouTube", mode="clip", style="funny", state="stalled",
        source_name="YouTube import", source_kind="youtube", requested_count=1, latest_job_id="j-stalled",
    ))
    job = _job("stalled").model_copy(update={"id": "j-stalled", "project_id": "p-stalled", "stage": "source", "error": "Download stalled"})
    db.save_job(job, {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})

    # Fill the render queue to capacity with another job.
    db.save_job(_job("queued").model_copy(update={"id": "j-other", "project_id": "p-other"}), {})
    asyncio.run(manager.enqueue("j-other"))
    assert manager.queue.full()

    with pytest.raises(QueueFullError):
        asyncio.run(manager.control(job.id, "retry-import"))

    saved_job = db.get_job(job.id)
    saved_project = db.get_project("p-stalled")
    saved_private = db.get_job_private(job.id)
    assert saved_job is not None and saved_job.state == "stalled"
    assert saved_job.error == "Download stalled"
    assert saved_project is not None and saved_project.state == "stalled"
    assert saved_private.get("retry_import") is None
    assert can_retry_import(saved_job, saved_private) is True


def test_retry_import_rolls_back_on_enqueue_race_queue_full(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db, manager = _cluster(workspace)
    db.save_project(Project(
        id="p-stopped", name="Stopped YouTube", mode="clip", style="funny", state="cancelled_kept",
        source_name="YouTube import", source_kind="youtube", requested_count=1, latest_job_id="j-stopped",
    ))
    job = _job("cancelled_kept").model_copy(update={"id": "j-stopped", "project_id": "p-stopped", "stage": "cancelled"})
    db.save_job(job, {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})

    async def fail_enqueue(_job_id: str, **_kwargs) -> None:
        raise QueueFullError("The local render queue is full.")

    monkeypatch.setattr(manager, "enqueue", fail_enqueue)

    with pytest.raises(QueueFullError):
        asyncio.run(manager.control(job.id, "retry-import"))

    saved_job = db.get_job(job.id)
    saved_project = db.get_project("p-stopped")
    saved_private = db.get_job_private(job.id)
    assert saved_job is not None and saved_job.state == "cancelled_kept"
    assert saved_project is not None and saved_project.state == "cancelled_kept"
    assert saved_private.get("retry_import") is None
    assert can_retry_import(saved_job, saved_private) is True

