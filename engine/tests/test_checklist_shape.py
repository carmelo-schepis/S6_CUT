"""Long-form clip jobs must hold the checklist the pipeline they run actually asks for.

Long form always renders through the fast path, whatever processing mode was
chosen. A job written before that decision was unified kept the eleven-step
smart checklist and was then handed to the fast renderer, which asks for a
'plan' step the smart checklist lacks — so it failed on creation and again on
every retry, because nothing reshaped a checklist once persisted.
"""
from __future__ import annotations

import json
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest

from engine.app import settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import ChecklistShapeError, JobManager, job_uses_fast_pipeline, uses_fast_pipeline
from engine.library import LibraryRules
from engine.models import Job, Project
from engine.providers import ProfileService
from engine.security import SecretVault

FAST_IDS = {"source", "probe", "plan", "render", "verify", "ready"}


@pytest.fixture
def tmp_path_local() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-checklist-test-"))


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    test_settings: Settings = replace(settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    profiles = ProfileService(test_db, vault)
    rules = LibraryRules(test_db, tmp_path / "library")
    return test_db, JobManager(test_db, rules, profiles, test_settings)


def _long_smart_job(db: Database, manager: JobManager, *, state: str = "failed") -> Job:
    """A long-form Smart job carrying the wrong (smart) checklist, as shipped before the fix."""
    db.save_project(Project(
        id="p-long", name="Long form", mode="clip", style="funny", state=state,
        source_name="source.mp4", source_kind="youtube", requested_count=2, content_format="long",
    ))
    job = Job(
        id="j-long", project_id="p-long", mode="clip", state=state, stage="failed",
        stage_label="Project failed", progress=0, style="funny", processing_mode="smart",
        content_format="long", steps=manager._smart_steps(False), clips=[], beats=[], warnings=[],
    )
    db.save_job(job, {"content_format": "long", "processing_mode": "smart", "count": 2})
    return job


def test_long_form_smart_job_is_routed_to_the_fast_pipeline() -> None:
    assert uses_fast_pipeline("smart", "long") is True
    assert uses_fast_pipeline("smart", "short") is False


def test_high_volume_long_form_smart_job_uses_transcript_planning_checklist(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    smart_ids = {step.id for step in manager._smart_steps(False)}
    job = Job(
        id="j-high-volume-long-smart", project_id="p", mode="clip", state="queued", stage="queued",
        stage_label="Queued", progress=0, style="funny", processing_mode="smart", content_format="long",
        batch_mode="high_volume", requested_count=500, steps=manager._smart_steps(False),
    )
    private = {
        "batch_mode": "high_volume", "content_format": "long", "processing_mode": "smart", "count": 500,
    }
    assert job_uses_fast_pipeline(job, private) is False
    assert manager._required_step_ids(job, private) == smart_ids


def test_persisted_smart_checklist_on_a_long_form_job_is_rebuilt_before_processing(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    job = _long_smart_job(db, manager)
    private = db.get_job_private(job.id)
    assert {step.id for step in job.steps} != FAST_IDS, "fixture must start mis-shaped"

    manager._reconcile_steps(job, private)

    assert {step.id for step in job.steps} == FAST_IDS
    # The step the fast renderer asks for now resolves instead of raising.
    assert manager._step_by_id(job, "plan").id == "plan"
    assert {step.id for step in db.get_job(job.id).steps} == FAST_IDS, "repair is persisted"


def test_repair_preserves_proven_render_counters_and_leaves_complete_jobs_alone(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    job = _long_smart_job(db, manager, state="complete")
    private = db.get_job_private(job.id)

    manager._reconcile_steps(job, private)

    # A finished job keeps the history it was rendered with; only live work is reshaped.
    assert {step.id for step in job.steps} != FAST_IDS


def test_every_pipeline_gets_the_checklist_its_processor_asks_for(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    smart_ids = {step.id for step in manager._smart_steps(False)}
    script_ids = {step.id for step in manager._script_steps()}
    for content_format in ("short", "long"):
        for processing_mode in ("fast", "smart"):
            job = Job(
                id=f"j-{content_format}-{processing_mode}", project_id="p", mode="clip", state="queued",
                stage="queued", stage_label="Queued", progress=0, style="funny",
                processing_mode=processing_mode, content_format=content_format,
                steps=[], clips=[], beats=[], warnings=[],
            )
            private = {"content_format": content_format, "processing_mode": processing_mode}
            expected = FAST_IDS if uses_fast_pipeline(processing_mode, content_format) else smart_ids
            assert manager._required_step_ids(job, private) == expected, (content_format, processing_mode)

    script = Job(
        id="j-script", project_id="p", mode="script", state="queued", stage="queued",
        stage_label="Queued", progress=0, style="funny", steps=[], clips=[], beats=[], warnings=[],
    )
    assert manager._required_step_ids(script, {}) == script_ids


def test_missing_step_reports_a_customer_safe_message(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    job = _long_smart_job(db, manager)

    with pytest.raises(ChecklistShapeError) as raised:
        manager._step_by_id(job, "plan")

    message = str(raised.value)
    assert job.id not in message and "plan" not in message, "no internals reach the banner"
    assert "checklist" in message.lower()
    # The identifiers stay available for the log line raised alongside it.
    assert raised.value.job_id == job.id and raised.value.step_id == "plan"


def test_migration_reshapes_a_mismatched_row_and_spares_complete_jobs(tmp_path_local: Path) -> None:
    db, manager = _cluster(tmp_path_local)
    smart_steps = manager._smart_steps(False)
    smart_ids = {step.id for step in smart_steps}
    db.save_project(Project(
        id="p-long", name="Long form", mode="clip", style="funny", state="failed",
        source_name="source.mp4", source_kind="youtube", requested_count=2, content_format="long",
    ))

    def _row(job_id: str, state: str) -> None:
        db.save_job(Job(
            id=job_id, project_id="p-long", mode="clip", state=state, stage="failed",
            stage_label="Project failed", progress=0, style="funny", processing_mode="smart",
            content_format="long", steps=manager._smart_steps(False), clips=[], beats=[], warnings=[],
        ), {"content_format": "long", "processing_mode": "smart"})

    _row("j-broken", "failed")
    _row("j-done", "complete")
    # The rows were written by code that predates migration 8; re-open the
    # database so the migration runs over them exactly as it would on upgrade.
    with db._connect() as connection:
        connection.execute("DELETE FROM schema_migrations WHERE version=8")

    repaired = Database(db.path)

    assert {step.id for step in repaired.get_job("j-broken").steps} == FAST_IDS
    assert {step.id for step in repaired.get_job("j-done").steps} == smart_ids, "a finished job keeps its history"
