from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient

from engine.app import _project_name, app, db, profiles, settings, signer


client = TestClient(app)


def test_topic_plan_reports_storage_pressure_without_internal_error(monkeypatch) -> None:
    async def unavailable(*_: object, **__: object):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(profiles, "openrouter_json", unavailable)
    response = client.post("/api/v1/ai/topic-plan", json={
        "topic": "Why bees matter", "audience": "General audience", "tone": "Friendly",
        "language": "English", "callToAction": "", "instructions": "", "durationSeconds": 30,
        "aspectRatio": "9:16", "variants": 1, "customScript": "", "modelId": "openai/test",
    })
    assert response.status_code == 503
    assert response.json()["detail"] == "Local project storage is temporarily unavailable. Free disk space and try again."


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
    })
    assert response.status_code == 202
    body = response.json()
    assert body["project"]["sourceProfile"] == "music"
    assert body["job"]["sourceProfile"] == "music"
    assert body["job"]["processingMode"] == "smart"
    assert saved["private"]["use_openrouter"] is False


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
    }, files={"file": ("source.mp4", b"fixture", "video/mp4")})
    assert response.status_code == 202
    body = response.json()
    assert body["job"]["processingMode"] == "smart"
    assert [step["id"] for step in body["job"]["steps"]][:4] == ["source", "probe", "audio", "transcribe"]
    assert saved["private"]["processing_mode"] == "smart"


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


def test_script_job_preserves_exact_source_and_returns_durable_records() -> None:
    script = "The Beatles changed popular music. This second sentence explains why."
    response = client.post("/api/v1/jobs/script", json={"script": script, "style": "educational", "aspectRatio": "9:16", "narration": "silent"})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["project"]["mode"] == "script"
    assert body["job"]["state"] == "queued"
    assert db.get_job_private(body["job"]["id"])["script"] == script
    assert client.get(f"/api/v1/projects/{body['project']['id']}").status_code == 200


def test_tts_speed_accepts_documented_minimum_and_rejects_below() -> None:
    accepted = client.post("/api/v1/profiles", json={"name": "Minimum TTS speed", "ttsSpeed": 0.25})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["ttsSpeed"] == 0.25

    rejected = client.post("/api/v1/profiles", json={"name": "Below minimum TTS speed", "ttsSpeed": 0.249})
    assert rejected.status_code == 422


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


def test_provider_tests_report_each_optional_service_independently(monkeypatch) -> None:
    created = client.post("/api/v1/profiles", json={
        "name": "Independent provider capabilities", "textModelId": "openai/test", "ttsModelId": "free/speech", "ttsVoice": "alloy",
        "openrouterKey": "openrouter-secret", "persistence": "encrypted", "selected": True,
    }).json()

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
    assert response.json()["ttsStatus"] == "invalid_credentials"
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


def test_specific_job_routes_are_not_shadowed_by_control_actions(monkeypatch, tmp_path) -> None:
    script = "A complete script sentence creates one durable video project."
    created = client.post("/api/v1/jobs/script", json={"script": script, "style": "serious", "aspectRatio": "9:16", "narration": "silent"}).json()
    job_id = created["job"]["id"]
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
