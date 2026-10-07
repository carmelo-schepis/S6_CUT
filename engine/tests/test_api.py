from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from engine.app import _project_name, app, db, settings, signer


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_creation_rate_limit() -> None:
    from engine import app as app_module

    app_module.creation_times.clear()


def test_openrouter_text_model_discovery_remains_compatible_without_speech_discovery(monkeypatch) -> None:
    from engine import app as app_module
    from engine.models import OpenRouterModel

    async def fake_models():
        return [
            OpenRouterModel(id="text/model", name="Text Model", output_modalities=["text"]),
            OpenRouterModel(id="speech/model", name="Speech Model", output_modalities=["speech"], voices=["alloy"]),
        ]

    monkeypatch.setattr(app_module.profiles, "openrouter_models", fake_models)
    all_models = client.get("/api/v1/openrouter/models")
    text_models = client.get("/api/v1/openrouter/models?outputModalities=text")
    retired_speech = client.get("/api/v1/openrouter/models?outputModalities=speech")

    assert all_models.status_code == text_models.status_code == 200
    assert [model["id"] for model in all_models.json()] == ["text/model", "speech/model"]
    assert [model["id"] for model in text_models.json()] == ["text/model"]
    assert retired_speech.status_code == 410
    assert "/api/v1/openrouter/models" in app.openapi()["paths"]
    assert "/api/v1/ai/topic-plan" not in app.openapi()["paths"]


def test_retired_creation_routes_are_absent_and_have_no_side_effects(monkeypatch) -> None:
    from engine import app as app_module

    projects_before = {project.id for project in db.list_projects()}
    jobs_before = {job.id for job in db.list_jobs()}
    queue_size = app_module.manager.queue.qsize()
    side_effects: list[str] = []

    def fail(*_: object, **__: object) -> None:
        side_effects.append("called")
        raise AssertionError("a retired endpoint must have no side effects")

    monkeypatch.setattr(app_module.manager, "enqueue", fail)
    monkeypatch.setattr(app_module.db, "save_project", fail)
    monkeypatch.setattr(app_module.db, "save_job", fail)
    monkeypatch.setattr(app_module.profiles, "openrouter_json", fail)
    responses = [
        client.post("/api/v1/jobs/script", json={"script": "A valid legacy script body", "style": "serious", "aspectRatio": "9:16"}),
        client.post("/api/v1/ai/topic-plan", json={"topic": "Retired", "customScript": "A valid custom script"}),
    ]
    assert [response.status_code for response in responses] == [405, 404]
    assert "/api/v1/jobs/script" not in app.openapi()["paths"]
    assert "/api/v1/ai/topic-plan" not in app.openapi()["paths"]
    assert {project.id for project in db.list_projects()} == projects_before
    assert {job.id for job in db.list_jobs()} == jobs_before
    assert app_module.manager.queue.qsize() == queue_size
    assert side_effects == []


def test_legacy_script_controls_reject_without_queue_or_record_mutation(monkeypatch) -> None:
    import uuid

    from engine import app as app_module
    from engine.models import Clip, Job, Project

    project_id, job_id, clip_id = (str(uuid.uuid4()) for _ in range(3))
    project = Project(id=project_id, name="Old Script", mode="script", style="educational", state="failed", source_name="legacy", source_kind="script", requested_count=1, latest_job_id=job_id)
    job = Job(id=job_id, project_id=project_id, mode="script", state="failed", stage="failed", stage_label="Legacy render retired", progress=100, style="educational", clips=[Clip(id=clip_id, index=1, state="failed", start=0, end=10, duration=10, opening_line="Legacy output")])
    db.save_project(project)
    db.save_job(job, {"caption_overrides": {clip_id: {"revision": 1, "cues": []}}})
    before = db.get_job(job_id).model_dump(mode="json")
    private_before = db.get_job_private(job_id)
    queue_size = app_module.manager.queue.qsize()
    monkeypatch.setattr(app_module.manager, "enqueue", lambda *_args, **_kwargs: pytest.fail("legacy script work must not be enqueued"))

    responses = [
        client.post(f"/api/v1/jobs/{job_id}/control/resume"),
        client.post(f"/api/v1/jobs/{job_id}/control/retry-failed"),
        client.post(f"/api/v1/jobs/{job_id}/clips/{clip_id}/retry"),
        client.post(f"/api/v1/jobs/{job_id}/clips/{clip_id}/captions/rerender?revision=1"),
    ]
    assert all(response.status_code == 409 and "Legacy Script" in response.text for response in responses)
    assert db.get_job(job_id).model_dump(mode="json") == before
    assert db.get_job_private(job_id) == private_before
    assert app_module.manager.queue.qsize() == queue_size


@pytest.mark.parametrize(
    ("batch_mode", "count"),
    [("standard", "31"), ("standard", "0"), ("high_volume", "0"), ("high_volume", "501"), ("high_volume", "1.5"), ("high_volume", "not-an-integer")],
)
def test_clip_api_rejects_count_outside_opted_in_integer_limits(batch_mode, count) -> None:
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "batch_mode": batch_mode, "count": count,
    })
    assert response.status_code == 422


def test_high_volume_clip_api_persists_requested_count_separately(monkeypatch) -> None:
    from engine import app as app_module

    saved: dict[str, object] = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: True)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "batch_mode": "high_volume", "count": "500",
        "processing_mode": "smart",
    })
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["project"]["requestedCount"] == 500
    assert body["project"]["batchMode"] == "high_volume"
    assert body["project"]["effectiveTarget"] is None
    assert body["job"]["requestedCount"] == 500
    assert body["job"]["batchMode"] == "high_volume"
    assert body["job"]["processingMode"] == "smart"
    assert body["job"]["plannedCount"] == body["job"]["successfulCount"] == 0
    assert saved["private"]["count"] == 500
    assert saved["private"]["batch_mode"] == "high_volume"
    assert saved["private"]["use_openrouter"] is False


def test_api_persists_a_500_clip_selection() -> None:
    import uuid

    from engine.models import Clip, Job, Project

    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    project = Project(
        id=project_id, name="500 selection", mode="clip", style="serious", state="complete",
        source_name="YouTube import", source_kind="youtube", requested_count=500,
        batch_mode="high_volume", effective_target=500, latest_job_id=job_id,
    )
    clips = [Clip(
        id=f"clip-{index}", index=index, state="complete", start=index / 10, end=index / 10 + 8,
        duration=8, opening_line=f"Window {index}", library_asset_id=f"asset-{index}", selected=False,
    ) for index in range(1, 501)]
    job = Job(
        id=job_id, project_id=project_id, mode="clip", state="complete", stage="complete",
        stage_label="Complete", progress=100, style="serious", requested_count=500,
        batch_mode="high_volume", effective_target=500, planned_count=500, clips=clips,
    )
    db.save_project(project)
    db.save_job(job, {})

    response = client.put(f"/api/v1/jobs/{job_id}/selection", json={"clipIds": [clip.id for clip in clips]})
    assert response.status_code == 200, response.text
    assert len(response.json()["clips"]) == 500
    assert all(clip["selected"] for clip in response.json()["clips"])
    assert db.get_job(job_id).clips[0].selected is True


def test_high_volume_smart_landscape_uses_transcript_pipeline_and_skips_provider_ordering(monkeypatch) -> None:
    from engine import app as app_module

    saved: dict[str, object] = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: True)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "batch_mode": "high_volume", "count": "500",
        "processing_mode": "smart", "content_format": "long",
    })
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["project"]["contentFormat"] == body["job"]["contentFormat"] == "long"
    assert saved["private"]["aspect_ratio"] == "16:9"
    assert body["job"]["processingMode"] == "smart"
    assert [step["id"] for step in body["job"]["steps"]][:6] == [
        "source", "probe", "audio", "transcribe", "openrouter", "local_planning",
    ]
    assert saved["private"]["use_openrouter"] is False


def test_high_volume_music_request_is_rejected_without_changing_music_planning(monkeypatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "batch_mode": "high_volume", "source_profile": "music",
    })
    assert response.status_code == 422
    assert "Music keeps its existing non-overlapping planner" in response.json()["detail"]


def test_music_clip_request_forces_smart_and_persists_source_profile(monkeypatch) -> None:
    from engine import app as app_module

    saved: dict[str, object] = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    folder = app_module.db.list_folders()[0]
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "source_profile": "music",
        "processing_mode": "fast", "count": "1", "min_duration": "8", "max_duration": "20",
        "library_folder_id": folder.id,
        "subscribe_animation": '{"enabled":true,"version":1,"shortFormLeadSeconds":10}',
    })
    assert response.status_code == 202
    body = response.json()
    assert body["project"]["sourceProfile"] == "music"
    assert body["job"]["sourceProfile"] == "music"
    assert body["job"]["processingMode"] == "smart"
    assert saved["private"]["use_openrouter"] is False
    assert saved["private"]["subscribe_animation"] == {"version": 1, "enabled": True, "short_form_lead_seconds": 10}


def test_shorts_editor_caption_request_uses_smart_pipeline(monkeypatch) -> None:
    from engine import app as app_module

    saved: dict[str, object] = {}
    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {
        "duration": 20.0, "width": 1920, "height": 1080, "audio": True,
    })
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    folder = app_module.db.list_folders()[0]
    response = client.post("/api/v1/jobs/shorts/source", data={
        "start": "2", "end": "8", "aspect_ratio": "4:5", "library_folder_id": folder.id,
        "burn_subtitles": "true",
        "subscribe_animation": '{"enabled":true,"version":1,"shortFormLeadSeconds":10}',
    }, files={"file": ("source.mp4", b"fixture", "video/mp4")})
    assert response.status_code == 202
    body = response.json()
    assert body["job"]["processingMode"] == "smart"
    assert [step["id"] for step in body["job"]["steps"]][:4] == ["source", "probe", "audio", "transcribe"]
    assert saved["private"]["processing_mode"] == "smart"
    assert saved["private"]["subscribe_animation"] == {"version": 1, "enabled": True, "short_form_lead_seconds": 10}


def test_shorts_library_request_persists_animation_configuration(monkeypatch, tmp_path: Path) -> None:
    from engine import app as app_module
    from engine.models import Asset

    saved: dict[str, object] = {}
    source = tmp_path / "library-source.mp4"
    asset = Asset(id="animation-source", title="Source", filename="source.mp4", media_type="video/mp4", content_hash="a" * 64)
    monkeypatch.setattr(app_module.db, "get_asset", lambda asset_id: asset if asset_id == asset.id else None)
    monkeypatch.setattr(app_module.db, "blob_relative_path", lambda _: "blobs/sha256/aa/source.mp4")
    monkeypatch.setattr(app_module, "confined", lambda *_: source)
    monkeypatch.setattr(app_module, "probe", lambda *_: {"duration": 20.0, "width": 1920, "height": 1080, "audio": True})
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    folder = app_module.db.list_folders()[0]
    response = client.post("/api/v1/jobs/shorts", json={
        "assetId": asset.id, "start": 2, "end": 12, "aspectRatio": "1:1", "libraryFolderId": folder.id,
        "subscribeAnimation": {"enabled": True, "version": 1, "shortFormLeadSeconds": 5},
    })
    assert response.status_code == 202, response.text
    assert saved["private"]["trim_start"] == 2
    assert saved["private"]["trim_end"] == 12
    assert saved["private"]["subscribe_animation"] == {"version": 1, "enabled": True, "short_form_lead_seconds": 5}


def test_music_upload_rejects_impossible_non_overlapping_count(monkeypatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {
        "duration": 284.0, "width": 1920, "height": 1080, "audio": True,
    })
    folder = app_module.db.list_folders()[0]
    response = client.post("/api/v1/jobs/clip", data={
        "source_profile": "music", "count": "21", "min_duration": "20", "max_duration": "60",
        "library_folder_id": folder.id,
    }, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert response.status_code == 422
    assert "at most 14" in response.json()["detail"]


def test_project_name_normalization_has_safe_fallbacks() -> None:
    assert _project_name("  QA Browser Test  ", "Fallback") == "QA Browser Test"
    assert _project_name("\t\n", "Generated source") == "Generated source"
    assert len(_project_name("x" * 200, "Fallback")) == 160


def test_health_is_honest_and_hides_host_path() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ready", "degraded", "starting"}
    assert body["dataPath"] in {"Container data directory", "Local mounted data directory"}
    assert "/app/" not in body["dataPath"]
    assert "planning" in body["fallbacks"]


def test_health_aliases_stay_available_when_mounted_data_does_not_support_statvfs(monkeypatch) -> None:
    def unsupported_disk_usage(_: Path) -> object:
        raise OSError(95, "Operation not supported")

    monkeypatch.setattr("engine.app.shutil.disk_usage", unsupported_disk_usage)

    client_without_disk_usage = TestClient(app, raise_server_exceptions=False)
    for path in ("/api/health", "/api/v1/health"):
        response = client_without_disk_usage.get(path)
        assert response.status_code == 200
        assert response.json()["freeBytes"] == 0


def test_storage_diagnostics_stay_available_without_statvfs(monkeypatch, tmp_path: Path) -> None:
    (tmp_path / "jobs").mkdir()
    (tmp_path / "jobs" / "retained.json").write_text("{}")
    configured_settings = replace(settings, data_path=tmp_path, retention_days=17, max_retained_jobs=23)
    monkeypatch.setattr("engine.app.settings", configured_settings)

    def unsupported_disk_usage(_: Path) -> None:
        raise OSError(95, "Operation not supported")

    monkeypatch.setattr("engine.app.shutil.disk_usage", unsupported_disk_usage)

    response = client.get("/api/v1/storage")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["freeBytes"] == 0
    assert body["totalBytes"] == 0
    assert body["files"] == {"jobs": 1, "blobs": 0, "library": 0, "cache": 0, "exports": 0}
    assert body["retentionDays"] == configured_settings.retention_days
    assert body["maxRetainedJobs"] == configured_settings.max_retained_jobs


def test_retired_tts_profile_controls_are_rejected() -> None:
    response = client.post("/api/v1/profiles", json={
        "name": "Retired speech settings", "ttsModelId": "openai/gpt-4o-mini-tts",
        "ttsVoice": "alloy", "ttsSpeed": 1.2,
    })
    assert response.status_code == 422


def test_provider_secrets_are_masked_and_never_returned() -> None:
    key = "sk-or-v1-a-very-private-test-key"
    response = client.post("/api/v1/profiles", json={
        "name": "Only OpenRouter", "textModelId": "openai/test", "openrouterKey": key,
        "persistence": "encrypted", "selected": True,
    })
    assert response.status_code == 200, response.text
    serialized = response.text
    assert key not in serialized
    assert response.json()["openrouterMasked"].endswith("-key")
    listed = client.get("/api/v1/profiles").text
    assert key not in listed


def test_provider_test_checks_text_only_and_keeps_legacy_speech_fields(monkeypatch) -> None:
    created = client.post("/api/v1/profiles", json={
        "name": "Legacy provider capabilities", "textModelId": "openai/test",
        "openrouterKey": "openrouter-secret", "persistence": "encrypted", "selected": True,
    }).json()
    stored = db.get_profile(created["id"])
    assert stored is not None
    legacy = stored[0].model_copy(update={"tts_model_id": "free/speech", "tts_voice": "alloy"})
    db.save_profile(legacy, stored[1])

    class Response:
        def __init__(self, status_code: int, payload: dict[str, object]):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_: object):
            return None

        async def get(self, url: str, **_: object):
            return Response(401, {})

        async def post(self, url: str, **_: object):
            return Response(200, {"choices": [{"message": {"content": '{"ok":true}'}}]})

    monkeypatch.setattr("engine.providers.httpx.AsyncClient", lambda **_: Client())
    response = client.post(f"/api/v1/profiles/{created['id']}/test")
    assert response.status_code == 200
    assert response.json()["textStatus"] == "invalid_credentials"
    assert response.json()["ttsStatus"] == "not_configured"
    assert response.json()["ttsModelId"] == "free/speech" and response.json()["ttsVoice"] == "alloy"
    assert "openrouter-secret" not in response.text


def test_openrouter_test_requires_a_structured_generation(monkeypatch) -> None:
    created = client.post("/api/v1/profiles", json={
        "name": "Generation verification", "textModelId": "openai/test", "openrouterKey": "verification-secret",
        "persistence": "encrypted", "selected": True,
    }).json()

    class Response:
        status_code = 200

        def __init__(self, payload: dict[str, object]):
            self.payload = payload

        def json(self):
            return self.payload

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_: object):
            return None

        async def get(self, *_: object, **__: object):
            return Response({"data": [{"id": "openai/test"}]})

        async def post(self, *_: object, **__: object):
            return Response({"choices": [{"message": {"content": '{"ok":true}'}}]})

    monkeypatch.setattr("engine.providers.httpx.AsyncClient", lambda **_: Client())
    response = client.post(f"/api/v1/profiles/{created['id']}/test")
    assert response.status_code == 200
    assert response.json()["textStatus"] == "connected"
    assert "text generation succeeded" in response.json()["textMessage"]


def test_invalid_profile_input_never_echoes_a_raw_key() -> None:
    raw_key = "sensitive-" + "x" * 600
    response = client.post("/api/v1/profiles", json={"name": "Too long", "openrouterKey": raw_key})
    assert response.status_code == 422
    assert raw_key not in response.text


def test_library_dedup_and_match_explanation() -> None:
    upload = {"file": ("poster.png", b"small-fixture-image-bytes", "image/png")}
    data = {"title": "Beatles poster", "tags": "music, band", "triggers": "The Beatles", "policy": "prefer", "licence": "User supplied"}
    first = client.post("/api/v1/library/assets", files=upload, data=data)
    second = client.post("/api/v1/library/assets", files=upload, data=data)
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert "previewUrl" in first.json()
    assert "AppData" not in first.json()["previewUrl"] and "\\" not in first.json()["previewUrl"]
    preview = client.get(first.json()["previewUrl"])
    assert preview.status_code == 200
    assert preview.content == b"small-fixture-image-bytes"
    assert client.get(first.json()["previewUrl"].replace("signature=", "signature=tampered")).status_code == 403
    match = client.get("/api/v1/library/match", params={"text": "The Beatles changed music"})
    assert match.status_code == 200
    assert match.json()["selected"]["title"] == "Beatles poster"


def test_zip_download_uses_unicode_archive_filename(monkeypatch, tmp_path: Path) -> None:
    relative = "exports/job/Café - Launch.zip"
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(b"zip bytes")
    monkeypatch.setattr("engine.app.settings", replace(settings, data_path=tmp_path))
    expires, signature = signer.sign(relative)
    response = client.get(f"/api/v1/files/{relative}", params={"expires": expires, "signature": signature})
    assert response.status_code == 200
    assert "filename*=utf-8''Caf%C3%A9%20-%20Launch.zip" in response.headers["content-disposition"]


def test_download_traversal_and_bad_signature_fail_safely() -> None:
    response = client.get("/api/v1/files/jobs/../../secrets/instance.key", params={"expires": 9999999999, "signature": "wrong"})
    assert response.status_code in {403, 404}


def test_invalid_url_import_does_not_create_a_project() -> None:
    response = client.post("/api/v1/jobs/clip", data={"url": "http://127.0.0.1/internal", "style": "hype", "count": 2, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16"})
    assert response.status_code == 422


def test_specific_job_routes_are_not_shadowed_by_control_actions(monkeypatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {
        "duration": 20.0, "width": 1920, "height": 1080, "audio": True,
    })

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    folder = app_module.db.list_folders()[0]
    created = client.post("/api/v1/jobs/clip", data={
        "name": "Route smoke", "count": "1", "min_duration": "8", "max_duration": "20",
        "aspect_ratio": "9:16", "library_folder_id": folder.id,
    }, files={"file": ("fixture.mp4", b"fixture mp4 bytes", "video/mp4")})
    assert created.status_code == 202, created.text
    job_id = created.json()["job"]["id"]
    selection = client.put(f"/api/v1/jobs/{job_id}/selection", json={"clipIds": []})
    assert selection.status_code == 200
    export = client.post(f"/api/v1/jobs/{job_id}/export", json={"clipIds": []})
    assert export.status_code == 422
    paused = client.post(f"/api/v1/jobs/{job_id}/control/pause")
    assert paused.status_code == 200


def test_long_form_always_resolves_to_the_fast_pipeline() -> None:
    """Long form renders through the fast pipeline whatever mode was asked for,
    so every caller that builds a checklist must agree on that. When the creation
    route decided on processing mode alone, a long-form Auto/Smart job was given
    the smart checklist and then died in the fast renderer on a missing 'plan'
    step. engine/app.py builds the creation checklist from this predicate."""
    from engine.jobs import uses_fast_pipeline

    assert uses_fast_pipeline("smart", "long") is True
    assert uses_fast_pipeline("fast", "long") is True
    assert uses_fast_pipeline("fast", "short") is True
    assert uses_fast_pipeline("smart", "short") is False
    assert uses_fast_pipeline(None, None) is False
