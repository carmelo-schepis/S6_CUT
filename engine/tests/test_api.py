from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from engine.app import _project_name, app, db, settings, signer


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_creation_rate_limit() -> None:
    from engine import app as app_module

    app_module.creation_times.clear()


@pytest.mark.parametrize(
    ("batch_mode", "count"),
    [("standard", "31"), ("standard", "0"), ("high_volume", "0"), ("high_volume", "501"), ("high_volume", "1.5"), ("high_volume", "not-an-integer")],
)
def test_clip_api_rejects_count_outside_opted_in_integer_limits(batch_mode, count) -> None:
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "batch_mode": batch_mode, "count": count,
    })
    assert response.status_code == 422


def test_hook_text_is_opt_in_and_adds_only_an_enabled_job_step(monkeypatch) -> None:
    from engine import app as app_module

    saved: dict[str, object] = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: True)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))
    provider_calls = 0

    async def hook_provider(*_args, **_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise AssertionError("disabled hooks must never call the provider")

    monkeypatch.setattr(app_module.profiles, "openrouter_json", hook_provider)

    async def enqueue(_: str) -> None:
        job = saved["job"]
        if not job.hook_text_enabled:
            app_module.manager._generate_hook_text(job, saved.get("private") or {}, [])

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    base = {"url": "https://www.youtube.com/watch?v=fixture", "processing_mode": "smart", "count": "2"}
    response = client.post("/api/v1/jobs/clip", data=base)
    assert response.status_code == 202, response.text
    assert response.json()["job"]["hookTextEnabled"] is False
    assert "hook_text" not in [step["id"] for step in response.json()["job"]["steps"]]
    assert provider_calls == 0

    response = client.post("/api/v1/jobs/clip", data={**base, "hook_text": "true", "burn_subtitles": "false"})
    assert response.status_code == 202, response.text
    assert response.json()["job"]["hookTextEnabled"] is True
    assert response.json()["job"]["burnSubtitles"] is False
    assert [step["id"] for step in response.json()["job"]["steps"]].index("hook_text") < [step["id"] for step in response.json()["job"]["steps"]].index("render")
    assert saved["private"]["hook_text"]["enabled"] is True


@pytest.mark.parametrize(("overrides", "reason"), [
    ({"content_format": "long"}, "Long form"),
    ({"batch_mode": "high_volume"}, "High-volume"),
    ({"processing_mode": "fast"}, "Fast mode"),
    ({"source_profile": "music"}, "Music"),
])
def test_hook_text_rejects_ineligible_jobs_with_specific_reason(monkeypatch, overrides, reason) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: True)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "hook_text": "true", **overrides,
    })
    assert response.status_code == 422
    assert reason in response.json()["detail"]


def test_hook_text_requires_connected_provider(monkeypatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "hook_text": "true", "processing_mode": "smart",
    })
    assert response.status_code == 422
    assert "connected OpenRouter provider" in response.json()["detail"]


@pytest.mark.parametrize(
    "aspect_ratio",
    ["9:16", "16:9", "4:5"],
)
def test_short_smart_speech_api_persists_durable_presentation_choice(monkeypatch, aspect_ratio) -> None:
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
        "url": "https://www.youtube.com/watch?v=fixture", "processing_mode": "smart",
        "content_format": "short", "aspect_ratio": aspect_ratio, "batch_mode": "standard",
        "count": "2", "burn_subtitles": "false",
    })
    assert response.status_code == 202, response.text
    assert saved["private"]["presentation"] == {"version": 1, "caption": "smart_speech_v1"}
    assert saved["private"]["reaction_policy"] is None
    assert saved["private"]["burn_subtitles"] is False
    assert response.json()["job"]["burnSubtitles"] is False


@pytest.mark.parametrize("fields", [
    {"processing_mode": "fast", "content_format": "short"},
    {"processing_mode": "smart", "content_format": "long"},
    {"processing_mode": "smart", "content_format": "short", "source_profile": "music"},
])
def test_ineligible_jobs_persist_legacy_presentation(monkeypatch, fields) -> None:
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
        "url": "https://www.youtube.com/watch?v=fixture", "count": "2", **fields,
    })
    assert response.status_code == 202, response.text
    assert saved["private"]["presentation"] == {"version": 1, "caption": "legacy"}
    expected_policy = None if fields.get("source_profile") == "music" else {"version": 1, "name": "ironic_v1"}
    assert saved["private"]["reaction_policy"] == expected_policy


@pytest.mark.parametrize("fields", [
    {"processing_mode": "smart", "content_format": "short", "batch_mode": "standard"},
    {"processing_mode": "smart", "content_format": "long", "batch_mode": "standard"},
    {"processing_mode": "fast", "content_format": "short", "batch_mode": "standard"},
    {"processing_mode": "smart", "content_format": "short", "batch_mode": "high_volume"},
])
def test_speech_reaction_policy_snapshot_is_independent_of_presentation_eligibility(monkeypatch, fields) -> None:
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
        "url": "https://www.youtube.com/watch?v=fixture", "count": "2", "burn_subtitles": "true", **fields,
    })
    assert response.status_code == 202, response.text
    assert saved["private"]["reaction_policy"] == {"version": 1, "name": "ironic_v1"}


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
    assert saved["job"].source_profile == "music"
    assert saved["private"]["presentation"] == {"version": 1, "caption": "legacy"}
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
    assert saved["private"]["source_path"] == str(source)
    assert saved["private"]["source_hash"] == asset.content_hash
    assert response.json()["project"]["sourceName"] == asset.filename
    assert response.json()["job"]["clips"][0]["start"] == 2
    assert response.json()["job"]["clips"][0]["end"] == 12
    assert response.json()["job"]["clips"][0]["duration"] == 10
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


def test_provider_test_validates_text_and_never_returns_secret(monkeypatch) -> None:
    created = client.post("/api/v1/profiles", json={
        "name": "Text provider verification", "textModelId": "openai/test",
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


def test_library_thumbnail_route_enforces_signed_blob_scope_expiry_and_confinement(monkeypatch, tmp_path: Path) -> None:
    from engine import app as app_module
    from engine.models import Asset

    asset = Asset(id="thumbnail-test", title="Thumbnail", filename="source.mp4", media_type="video/mp4", content_hash="a" * 64, blob_id="blob-safe")
    source = tmp_path / "blobs" / "safe.mp4"
    source.parent.mkdir()
    source.write_bytes(b"source bytes")
    thumbnail = tmp_path / "thumbnail.jpg"
    thumbnail.write_bytes(b"\xff\xd8" + b"x" * 1100)
    monkeypatch.setattr(app_module, "settings", replace(settings, data_path=tmp_path))
    monkeypatch.setattr(app_module.db, "get_asset", lambda asset_id: asset if asset_id == asset.id else None)
    monkeypatch.setattr(app_module.db, "blob_relative_path", lambda blob_id: "blobs/safe.mp4" if blob_id == "blob-safe" else "blobs/other.mp4")
    from engine.security import confined as confined_path
    monkeypatch.setattr(app_module, "confined", confined_path)

    async def extracted(*_args, **_kwargs):
        return thumbnail

    monkeypatch.setattr(app_module, "get_thumbnail", extracted)
    expires, signature = signer.sign("library-thumbnail:blob-safe:v1")
    response = client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": expires, "signature": signature})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content == thumbnail.read_bytes()

    assert client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": expires, "signature": signature + "x"}).status_code == 403
    video_expires, video_signature = signer.sign(f"library-asset:{asset.id}:{asset.blob_id}")
    assert client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": video_expires, "signature": video_signature}).status_code == 403
    renewed = client.get(f"/api/v1/library/assets/{asset.id}/thumbnail-url")
    assert renewed.status_code == 200
    fresh_url = renewed.json()["thumbnailUrl"]
    assert fresh_url.startswith(f"/api/v1/library/assets/{asset.id}/thumbnail?")

    async def corrupt_source(*_args, **_kwargs):
        raise RuntimeError("Could not decode a video frame")

    monkeypatch.setattr(app_module, "get_thumbnail", corrupt_source)
    failed = client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": expires, "signature": signature})
    assert failed.status_code == 503
    assert failed.json()["detail"] == "Thumbnail is temporarily unavailable"
    other_expires, other_signature = signer.sign("library-thumbnail:blob-other:v1")
    assert client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": other_expires, "signature": other_signature}).status_code == 403
    assert client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": 1, "signature": signature}).status_code == 403

    monkeypatch.setattr(app_module.db, "blob_relative_path", lambda _: "../../outside.mp4")
    invalid_path = client.get(f"/api/v1/library/assets/{asset.id}/thumbnail", params={"expires": expires, "signature": signature})
    assert invalid_path.status_code == 400
    assert invalid_path.json()["detail"] == "Invalid media reference"


def test_orphaned_thumbnail_cache_is_pruned_against_live_video_assets(monkeypatch, tmp_path: Path) -> None:
    from engine import app as app_module, thumbnails

    monkeypatch.setattr(app_module, "settings", replace(settings, data_path=tmp_path))
    live_blob_id = "a" * 64
    monkeypatch.setattr(
        app_module.db,
        "list_assets",
        lambda **_kwargs: [SimpleNamespace(blob_id=live_blob_id, media_type="video/mp4")],
    )
    retained = tmp_path / thumbnails.thumbnail_relative(live_blob_id)
    orphaned = tmp_path / thumbnails.thumbnail_relative("b" * 64)
    retained.parent.mkdir(parents=True)
    orphaned.parent.mkdir(parents=True)
    retained.write_bytes(b"retained")
    orphaned.write_bytes(b"orphaned")

    app_module._prune_orphaned_thumbnails()

    assert retained.is_file()
    assert not orphaned.exists()


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
