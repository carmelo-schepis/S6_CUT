from __future__ import annotations

from fastapi.testclient import TestClient

from engine.app import _project_name, app, db


client = TestClient(app)


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


def test_script_job_preserves_exact_source_and_returns_durable_records() -> None:
    script = "The Beatles changed popular music. This second sentence explains why."
    response = client.post("/api/v1/jobs/script", json={"script": script, "style": "educational", "aspectRatio": "9:16", "narration": "silent"})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["project"]["mode"] == "script"
    assert body["job"]["state"] == "queued"
    assert db.get_job_private(body["job"]["id"])["script"] == script
    assert client.get(f"/api/v1/projects/{body['project']['id']}").status_code == 200


def test_provider_secrets_are_masked_and_never_returned() -> None:
    key = "sk-or-v1-a-very-private-test-key"
    response = client.post("/api/v1/profiles", json={
        "name": "Only OpenRouter", "modelId": "openai/test", "openrouterKey": key,
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
        "name": "Independent providers", "modelId": "openai/test", "voiceId": "voice-ok",
        "openrouterKey": "openrouter-secret", "elevenlabsKey": "elevenlabs-secret",
        "persistence": "encrypted", "selected": True,
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
            if "openrouter" in url:
                return Response(401, {})
            return Response(200, {"voices": [{"voice_id": "voice-ok"}]})

    monkeypatch.setattr("engine.providers.httpx.AsyncClient", lambda **_: Client())
    response = client.post(f"/api/v1/profiles/{created['id']}/test")
    assert response.status_code == 200
    assert response.json()["openrouterStatus"] == "invalid_credentials"
    assert response.json()["elevenlabsStatus"] == "connected"
    assert "openrouter-secret" not in response.text
    assert "elevenlabs-secret" not in response.text


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
