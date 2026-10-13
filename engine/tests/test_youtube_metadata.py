from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from engine import app as app_module
from engine.database import MetadataGenerationClaimError
from engine.models import Asset, Clip, Job, OpenRouterModel, Project, YouTubeMetadataUpdate
from engine.providers import ProfileService

client = TestClient(app_module.app)


def test_openrouter_model_pricing_is_sanitized_for_the_cost_picker():
    model = ProfileService._model_from_entry({
        "id": "vendor/economy", "name": "Economy",
        "pricing": {"prompt": "0.000001", "completion": "0.000002", "input": "malformed"},
    })
    assert model is not None
    assert model.pricing == {"prompt": "0.000001", "completion": "0.000002"}


def test_metadata_schema_accepts_unicode_and_rejects_controls_and_angle_brackets():
    value = YouTubeMetadataUpdate(revision=0, title="科学で学ぶ自然 — A short title", description="自然科学の短い要約です。")
    assert value.title.startswith("科学")
    with pytest.raises(ValueError):
        YouTubeMetadataUpdate(revision=0, title="bad<title", description="")
    with pytest.raises(ValueError):
        YouTubeMetadataUpdate(revision=0, title="bad\x00title", description="")


def _completed_job(processing_mode: str = "smart") -> Job:
    suffix = uuid.uuid4().hex
    clip = Clip(
        id=f"clip-{suffix}", index=1, state="complete", start=0, end=20, duration=20,
        opening_line="A useful opening", transcript_excerpt="A grounded transcript excerpt.",
        output_name="clip.mp4", library_asset_id="published-asset", title="Deterministic fallback title",
    )
    return Job(
        id=f"metadata-{suffix}", project_id=f"project-{suffix}", mode="clip", state="complete",
        stage="complete", stage_label="Complete", progress=100, style="educational",
        processing_mode=processing_mode, clips=[clip],
    )


def _persist_job(job: Job, private: dict | None = None) -> None:
    app_module.db.save_project(Project(
        id=job.project_id, name="Metadata fixture", mode="clip", style="educational", state="complete",
        source_name="fixture.mp4", source_kind="upload", requested_count=1,
    ))
    clip = job.clips[0]
    app_module.db.save_asset(Asset(
        id=clip.library_asset_id or "published-asset", title=clip.title or "Deterministic fallback title",
        description=clip.youtube_description or "", media_type="video/mp4", filename="clip.mp4",
        content_hash=f"hash-{job.id}", origin="generated-clip", source_project_id=job.project_id,
        source_job_id=job.id, source_clip_id=clip.id,
    ))
    app_module.db.save_job(job, private or {})


def test_metadata_updates_are_revision_checked_and_persisted():
    job = _completed_job()
    _persist_job(job)
    try:
        path = f"/api/v1/jobs/{job.id}/clips/{job.clips[0].id}/youtube-metadata"
        updated = client.put(path, json={
            "revision": 0, "title": "  A title  ", "description": "A useful description",
        })
        assert updated.status_code == 200, updated.text
        clip = updated.json()["clips"][0]
        assert clip["title"] == "A title"
        assert clip["youtubeDescription"] == "A useful description"
        assert clip["youtubeMetadataRevision"] == 1
        stale = client.put(path, json={"revision": 0, "title": "stale", "description": ""})
        assert stale.status_code == 409
        saved = app_module.db.get_job(job.id)
        assert saved.clips[0].title == "A title"
        assert saved.clips[0].youtube_metadata_revision == 1
        linked_asset = app_module.db.get_asset("published-asset")
        assert linked_asset.title == "A title"
        assert linked_asset.description == "A useful description"
    finally:
        app_module.db.delete_project(job.project_id)


def test_metadata_generation_is_bounded_and_never_runs_for_fast_jobs(monkeypatch):
    job = _completed_job(processing_mode="fast")
    _persist_job(job)
    called = False

    async def should_not_call(*args, **kwargs):
        nonlocal called
        called = True
        return {"title": "x", "description": "", "tags": []}

    monkeypatch.setattr(app_module.profiles, "openrouter_json", should_not_call)
    try:
        path = f"/api/v1/jobs/{job.id}/clips/{job.clips[0].id}/youtube-metadata"
        response = client.post(path)
        assert response.status_code == 409
        assert called is False
        assert app_module.db.get_job_private(job.id).get("youtube_metadata_generation_calls", 0) == 0
    finally:
        app_module.db.delete_project(job.project_id)


def test_generation_request_claim_is_atomic_and_enforces_per_job_budget():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    job = _completed_job()
    _persist_job(job)
    barrier = Barrier(2)

    def claim():
        barrier.wait()
        try:
            app_module.db.claim_youtube_metadata_generation(job.id, job.clips[0].id, 0, "cheap/model", 0.001)
            return "claimed"
        except MetadataGenerationClaimError as exc:
            return exc.category

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: claim(), range(2)))
        assert outcomes.count("claimed") == 1
        assert "in_flight" in outcomes
        private = app_module.db.get_job_private(job.id)
        assert private["youtube_metadata_generation_calls"] == 1
        assert private["youtube_metadata_spend_estimate_usd"] == pytest.approx(0.001)
    finally:
        app_module.db.delete_project(job.project_id)


def test_metadata_generation_preserves_concurrent_manual_edit(monkeypatch):
    job = _completed_job()
    job.youtube_metadata_enabled = True
    job.youtube_metadata_model_id = "cheap/model"
    _persist_job(job, {"youtube_metadata": {"enabled": True, "model_id": "cheap/model"}})

    async def models():
        return [OpenRouterModel(
            id="cheap/model", name="Cheap", pricing={"prompt": "0.0000001", "completion": "0.0000004"},
            supported_parameters=["response_format"],
        )]

    async def generate(*_args, **_kwargs):
        app_module.db.update_generated_clip_metadata("published-asset", "User's newer title", "User's preserved description", 0)
        return ({"clip_id": job.clips[0].id, "title": "Provider's stale title", "description": "Provider's stale description"}, {"prompt_tokens": 80, "completion_tokens": 40, "cost": 0.00001})

    monkeypatch.setattr(app_module.profiles, "openrouter_models", models)
    monkeypatch.setattr(app_module.profiles, "openrouter_json", generate)
    try:
        path = f"/api/v1/jobs/{job.id}/clips/{job.clips[0].id}/youtube-metadata"
        response = client.post(path)
        assert response.status_code == 409
        saved = app_module.db.get_job(job.id).clips[0]
        asset = app_module.db.get_asset("published-asset")
        assert saved.title == "User's newer title"
        assert saved.youtube_description == "User's preserved description"
        assert saved.youtube_metadata_revision == 1
        assert asset.title == saved.title
        assert asset.description == saved.youtube_description
    finally:
        app_module.db.delete_project(job.project_id)


def test_metadata_generation_uses_small_output_budget_and_caps_paid_calls(monkeypatch):
    job = _completed_job()
    job.youtube_metadata_enabled = True
    job.youtube_metadata_model_id = "cheap/model"
    _persist_job(job, {"youtube_metadata": {"enabled": True, "model_id": "cheap/model"}})
    calls = []

    async def generate(messages, schema, **kwargs):
        calls.append((messages, schema, kwargs))
        return ({"clip_id": job.clips[0].id, "title": "Grounded title", "description": "Grounded description"}, {"prompt_tokens": 80, "completion_tokens": 40, "cost": 0.00001})

    async def models():
        return [OpenRouterModel(
            id="cheap/model", name="Cheap", pricing={"prompt": "0.0000001", "completion": "0.0000004"},
            supported_parameters=["response_format"],
        )]

    monkeypatch.setattr(app_module.profiles, "openrouter_json", generate)
    monkeypatch.setattr(app_module.profiles, "openrouter_models", models)
    try:
        path = f"/api/v1/jobs/{job.id}/clips/{job.clips[0].id}/youtube-metadata"
        response = client.post(path)
        assert response.status_code == 200, response.text
        assert calls[0][2]["max_tokens"] == 200
        assert calls[0][2]["model_id"] == "cheap/model"
        assert calls[0][2]["require_saved_profile"] is True
        assert calls[0][2]["provider"]["max_price"] == {"prompt": 0.10, "completion": 0.40}
        assert calls[0][2]["reasoning"] == {"enabled": False}
        assert response.json()["clips"][0]["youtubeMetadataRevision"] == 1
        assert app_module.db.get_asset("published-asset").title == "Grounded title"
        private = app_module.db.get_job_private(job.id)
        private["youtube_metadata_generation_calls"] = 5
        app_module.db.save_job(app_module.db.get_job(job.id), private)
        limited = client.post(path, json={"regenerate": True})
        assert limited.status_code == 429
        assert len(calls) == 1
    finally:
        app_module.db.delete_project(job.project_id)
