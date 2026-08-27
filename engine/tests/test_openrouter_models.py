from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from engine.app import app, db


client = TestClient(app)


class FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeAsyncClient:
    response: FakeResponse
    model_requests: list[dict[str, object]] = []
    completion_requests: list[dict[str, object]] = []

    def __init__(self, **_: object):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object):
        return None

    async def get(self, url: str, **kwargs: object):
        self.model_requests.append({"url": url, "kwargs": kwargs})
        return self.response

    async def post(self, url: str, **kwargs: object):
        self.completion_requests.append({"url": url, "kwargs": kwargs})
        return FakeResponse(200, {"choices": [{"message": {"content": json.dumps({
            "title": "Test plan", "hook": "A hook", "narration": "A useful narration.",
            "beats": [{"narration": "A useful narration.", "seconds": 10, "keywords": ["test"]}],
            "estimated_duration": 10, "description": "Description", "hashtags": ["test"],
        })}}]})


def connected_profile(name: str = "Model test profile", model_id: str = "legacy/profile") -> str:
    response = client.post("/api/v1/profiles", json={
        "name": name, "modelId": model_id, "openrouterKey": "sk-secret-model-test",
        "persistence": "encrypted", "selected": True,
    })
    assert response.status_code == 200, response.text
    profile_id = response.json()["id"]
    profile = db.get_profile(profile_id)[0]
    profile.openrouter_status = "connected"
    db.save_profile(profile)
    return profile_id


def remove_profile(profile_id: str) -> None:
    client.delete(f"/api/v1/profiles/{profile_id}")


def test_models_are_dynamic_sanitized_deduplicated_and_authorized(monkeypatch) -> None:
    profile_id = connected_profile()
    FakeAsyncClient.response = FakeResponse(200, {"data": [
        {"id": "zeta/arbitrary", "name": "Zeta", "context_length": 32000},
        {"id": "alpha/arbitrary", "name": "Alpha"},
        {"id": "zeta/arbitrary", "name": "Duplicate"},
        {"id": "", "name": "Invalid"}, {"name": "Missing ID"}, "not an object",
        {"id": "unnamed/model", "name": "  "}, {"id": "bad-context", "context_length": "nope"},
    ]})
    FakeAsyncClient.model_requests = []
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == 200
        assert response.json() == [
            {"id": "alpha/arbitrary", "name": "Alpha", "contextLength": None},
            {"id": "bad-context", "name": "bad-context", "contextLength": None},
            {"id": "unnamed/model", "name": "unnamed/model", "contextLength": None},
            {"id": "zeta/arbitrary", "name": "Zeta", "contextLength": 32000},
        ]
        request = FakeAsyncClient.model_requests[0]
        assert request["kwargs"]["headers"] == {"Authorization": "Bearer sk-secret-model-test"}
        assert "sk-secret-model-test" not in response.text
    finally:
        remove_profile(profile_id)


@pytest.mark.parametrize(("status_code", "message"), [
    (401, "rejected"), (403, "rejected"), (429, "rate limit"),
])
def test_model_endpoint_redacts_upstream_failures(monkeypatch, status_code: int, message: str) -> None:
    profile_id = connected_profile(f"Failure {status_code}")
    FakeAsyncClient.response = FakeResponse(status_code, {"secret": "upstream-secret"})
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == (429 if status_code == 429 else 502)
        assert message in response.json()["detail"]
        assert "sk-secret-model-test" not in response.text
        assert "upstream-secret" not in response.text
    finally:
        remove_profile(profile_id)


def test_model_endpoint_handles_timeout_and_malformed_payload(monkeypatch) -> None:
    profile_id = connected_profile("Malformed model profile")
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        FakeAsyncClient.response = FakeResponse(200, {"wrong": []})
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == 502
        assert response.json()["detail"] == "OpenRouter returned an unreadable model list."

        class TimeoutClient(FakeAsyncClient):
            async def get(self, *_: object, **__: object):
                raise httpx.ReadTimeout("private upstream detail")

        monkeypatch.setattr("engine.providers.httpx.AsyncClient", TimeoutClient)
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == 503
        assert "private upstream detail" not in response.text
        assert "timed out" in response.json()["detail"]
    finally:
        remove_profile(profile_id)


def test_missing_or_unconnected_profile_is_rejected(monkeypatch) -> None:
    response = client.get("/api/v1/openrouter/models")
    assert response.status_code == 503
    assert "connected" in response.json()["detail"]

    profile_id = client.post("/api/v1/profiles", json={"name": "Not tested", "modelId": "x", "openrouterKey": "sk-unconnected", "selected": True}).json()["id"]
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    FakeAsyncClient.model_requests = []
    try:
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == 503
        assert "connected" in response.json()["detail"]
        assert FakeAsyncClient.model_requests == []
    finally:
        remove_profile(profile_id)


def test_selected_model_is_sent_and_deleted_model_is_rejected(monkeypatch) -> None:
    profile_id = connected_profile("Completion model profile", "saved/model")
    FakeAsyncClient.response = FakeResponse(200, {"data": [{"id": "dynamic/chosen", "name": "Chosen"}]})
    FakeAsyncClient.completion_requests = []
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    payload = {"topic": "Testing models", "modelId": "dynamic/chosen"}
    try:
        response = client.post("/api/v1/ai/topic-plan", json=payload)
        assert response.status_code == 200, response.text
        assert FakeAsyncClient.completion_requests[-1]["kwargs"]["json"]["model"] == "dynamic/chosen"

        FakeAsyncClient.completion_requests = []
        response = client.post("/api/v1/ai/topic-plan", json={"topic": "Testing models", "modelId": "deleted/model"})
        assert response.status_code == 422
        assert "no longer available" in response.json()["detail"]
        assert FakeAsyncClient.completion_requests == []
    finally:
        remove_profile(profile_id)


def test_custom_script_bypasses_openrouter_and_model_selection() -> None:
    profile_id = connected_profile("Custom script profile")
    try:
        response = client.post("/api/v1/ai/topic-plan", json={"topic": "Local", "customScript": "This local custom script does not need OpenRouter."})
        assert response.status_code == 200, response.text
        assert response.json()["narration"] == "This local custom script does not need OpenRouter."
    finally:
        remove_profile(profile_id)
