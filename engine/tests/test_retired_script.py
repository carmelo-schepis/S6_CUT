from __future__ import annotations

import asyncio
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest

from engine.config import Settings
from engine.database import Database, UNSORTED_FOLDER_ID
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Asset, Beat, Clip, Job, ProcessingStep, Project
from engine.providers import ProfileService
from engine.security import SecretVault


@pytest.mark.parametrize("state", ["queued", "active", "recovered", "paused"])
def test_legacy_script_jobs_settle_without_recovery_or_render(tmp_path: Path, state: str) -> None:
    settings = replace(Settings.from_env(), data_path=tmp_path, job_workers=1)
    database = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    rules = LibraryRules(database, tmp_path / "library")
    project = Project(
        id="legacy-project", name="Historic Script", mode="script", style="educational",
        state=state, source_name="legacy script", source_kind="script", requested_count=1,
        latest_job_id="legacy-job",
    )
    job = Job(
        id="legacy-job", project_id=project.id, mode="script", state=state,
        stage="render", stage_label="Interrupted legacy render", progress=50,
        style="educational",
        beats=[Beat(
            id="legacy-beat", start=0, end=2, char_start=0, char_end=18,
            text="Historic narration", concept="Historic narration", source="script",
            confidence=1, match_reason="Legacy saved beat",
        )],
        clips=[Clip(id="legacy-clip", index=1, state="rendering", start=0, end=2, duration=2, opening_line="Legacy render")],
        steps=[
            ProcessingStep(id="render", label="Rendering", status="active", started_at="2026-01-01T00:00:00+00:00"),
            ProcessingStep(id="publish", label="Publishing"),
        ],
    )
    database.save_project(project)
    database.save_job(job, {"script": "Historic narration", "narration": "auto", "tts": {"model": "legacy/tts"}})

    render_calls: list[str] = []

    async def start_once():
        manager = JobManager(database, rules, profiles, settings)
        manager._process = lambda job_id: render_calls.append(job_id)
        await manager.start()
        await asyncio.sleep(0)
        assert manager.queue.qsize() == 0
        await manager.stop()
        return manager

    asyncio.run(start_once())
    settled = database.get_job("legacy-job")
    assert settled is not None
    assert settled.state == "failed"
    assert settled.stage == "failed"
    assert settled.stage_label == "Legacy Script jobs are no longer processed"
    assert [step.status for step in settled.steps] == ["failed", "skipped"]
    assert all(step.completed_at for step in settled.steps)
    assert settled.clips[0].state == "failed"
    assert "retired" in (settled.error or "").lower()
    assert database.get_job_private("legacy-job")["script"] == "Historic narration"
    assert database.get_job_private("legacy-job")["tts"]["model"] == "legacy/tts"
    assert database.get_project(project.id).state == "failed"

    # A second fresh manager must leave the terminal record unchanged and must
    # not enqueue or execute a legacy renderer on repeated engine startup.
    settled_at = settled.updated_at
    asyncio.run(start_once())
    repeated = database.get_job("legacy-job")
    assert repeated is not None and repeated.state == "failed"
    assert repeated.updated_at == settled_at
    assert render_calls == []
    assert database.get_job_private("legacy-job")["script"] == "Historic narration"


def test_completed_script_media_and_library_identity_survive_startup(tmp_path: Path) -> None:
    settings = replace(Settings.from_env(), data_path=tmp_path, job_workers=1)
    database = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    rules = LibraryRules(database, tmp_path / "library")
    content = b"historic published Script video"
    digest = sha256(content).hexdigest()
    relative = f"blobs/sha256/{digest[:2]}/{digest}.mp4"
    blob = tmp_path / relative
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(content)
    output = tmp_path / "jobs" / "legacy-complete-job" / "clips" / "historic.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)

    project = Project(
        id="legacy-complete-project", name="Historic Script", mode="script", style="educational",
        state="complete", source_name="legacy script", source_kind="script", requested_count=1,
        latest_job_id="legacy-complete-job",
    )
    asset = Asset(
        id="legacy-script-asset", title="Historic Script — Script video", filename="historic.mp4",
        media_type="video/mp4", content_hash=digest, blob_id=digest, origin="script-output",
        folder_id=UNSORTED_FOLDER_ID, source_project_id=project.id,
        source_job_id="legacy-complete-job", source_clip_id="legacy-complete-clip",
    )
    clip = Clip(
        id="legacy-complete-clip", index=1, state="complete", start=0, end=1, duration=1,
        opening_line="Historic output", output_name="historic.mp4", blob_id=digest,
        library_asset_id=asset.id,
    )
    job = Job(
        id="legacy-complete-job", project_id=project.id, mode="script", state="complete",
        stage="complete", stage_label="Project ready", progress=100, style="educational", clips=[clip],
    )
    database.save_project(project)
    database.save_job(job)
    database.register_blob_asset(asset, relative, len(content))

    async def restart():
        manager = JobManager(database, rules, profiles, settings)
        await manager.start()
        await manager.stop()

    asyncio.run(restart())
    asyncio.run(restart())

    retained = database.get_job(job.id)
    assert retained is not None and retained.state == "complete"
    assert database.get_project(project.id).state == "complete"
    assert retained.clips[0].library_asset_id == asset.id
    assert database.get_generated_asset("script-output", project.id, job.id, clip.id).id == asset.id
    assert output.read_bytes() == content
    assert blob.read_bytes() == content
