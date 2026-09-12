from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from engine.app import app, db

client = TestClient(app)


class FakeResponse:
    def __init__(self, status_code: int, payload: object): self.status_code, self._payload = status_code, payload
    def json(self):
        if isinstance(self._payload, Exception): raise self._payload
        return self._payload


class FakeAsyncClient:
    response: FakeResponse
    model_requests: list[dict[str, object]] = []
    completion_requests: list[dict[str, object]] = []
    def __init__(self, **_: object): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *_: object): return None
    async def get(self, url: str, **kwargs: object):
        self.model_requests.append({"url": url, "kwargs": kwargs})
        return self.response
    async def post(self, url: str, **kwargs: object):
        self.completion_requests.append({"url": url, "kwargs": kwargs})
        return FakeResponse(200, {"choices": [{"message": {"content": json.dumps({"title": "Test plan", "hook": "A hook", "narration": "A useful narration.", "beats": [{"narration": "A useful narration.", "seconds": 10, "keywords": ["test"]}], "estimated_duration": 10, "description": "Description", "hashtags": ["test"]})}}]})


def connected_profile(name: str = "Model test profile", model_id: str = "legacy/profile") -> str:
    response = client.post("/api/v1/profiles", json={"name": name, "textModelId": model_id, "openrouterKey": "sk-secret-model-test", "persistence": "encrypted", "selected": True})
    assert response.status_code == 200, response.text
    profile_id = response.json()["id"]
    profile = db.get_profile(profile_id)[0]
    profile.text_status = "connected"
    db.save_profile(profile)
    return profile_id


def remove_profile(profile_id: str) -> None: client.delete(f"/api/v1/profiles/{profile_id}")


def test_models_are_dynamic_sanitized_deduplicated_and_authorized(monkeypatch):
    profile_id = connected_profile()
    FakeAsyncClient.response = FakeResponse(200, {"data": [{"id": "zeta/arbitrary", "name": "Zeta", "context_length": 32000}, {"id": "alpha/arbitrary", "name": "Alpha"}, {"id": "zeta/arbitrary", "name": "Duplicate"}, {"id": "", "name": "Invalid"}, {"name": "Missing ID"}, "not an object", {"id": "unnamed/model", "name": "  "}, {"id": "bad-context", "context_length": "nope"}]})
    FakeAsyncClient.model_requests = []; monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        response = client.get("/api/v1/openrouter/models")
        assert response.status_code == 200
        assert [item["id"] for item in response.json()] == ["alpha/arbitrary", "bad-context", "unnamed/model", "zeta/arbitrary"]
        assert all(item["outputModalities"] == [] and item["free"] is False and item["voices"] == [] for item in response.json())
        assert FakeAsyncClient.model_requests[0]["kwargs"]["headers"] == {"Authorization": "Bearer sk-secret-model-test"}
        assert "sk-secret-model-test" not in response.text
    finally: remove_profile(profile_id)


@pytest.mark.parametrize(("status_code", "expected"), [(401, 502), (402, 402), (403, 502), (429, 429)])
def test_model_endpoint_redacts_upstream_failures(monkeypatch, status_code: int, expected: int):
    profile_id = connected_profile(f"Failure {status_code}")
    FakeAsyncClient.response = FakeResponse(status_code, {"secret": "upstream-secret"}); monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        response = client.get("/api/v1/openrouter/models", params={"outputModalities": "speech"})
        assert response.status_code == expected
        assert "upstream-secret" not in response.text and "sk-secret-model-test" not in response.text
    finally: remove_profile(profile_id)


def test_model_endpoint_handles_timeout_and_malformed_payload(monkeypatch):
    profile_id = connected_profile("Malformed model profile"); monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        FakeAsyncClient.response = FakeResponse(200, {"wrong": []})
        response = client.get("/api/v1/openrouter/models"); assert response.status_code == 502
        class TimeoutClient(FakeAsyncClient):
            async def get(self, *_: object, **__: object): raise httpx.ReadTimeout("private upstream detail")
        monkeypatch.setattr("engine.providers.httpx.AsyncClient", TimeoutClient)
        response = client.get("/api/v1/openrouter/models"); assert response.status_code == 503 and "private upstream detail" not in response.text
    finally: remove_profile(profile_id)


def test_missing_or_unconnected_profile_is_rejected():
    response = client.get("/api/v1/openrouter/models"); assert response.status_code == 503
    profile_id = client.post("/api/v1/profiles", json={"name": "Not tested", "textModelId": "x", "openrouterKey": "sk-unconnected", "selected": True}).json()["id"]
    try:
        response = client.get("/api/v1/openrouter/models"); assert response.status_code == 503
    finally: remove_profile(profile_id)


def test_selected_model_is_sent_and_deleted_model_is_rejected(monkeypatch):
    profile_id = connected_profile("Completion model profile", "saved/model")
    FakeAsyncClient.response = FakeResponse(200, {"data": [{"id": "dynamic/chosen", "name": "Chosen"}]}); FakeAsyncClient.completion_requests = []
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeAsyncClient)
    try:
        response = client.post("/api/v1/ai/topic-plan", json={"topic": "Testing models", "modelId": "dynamic/chosen"}); assert response.status_code == 200
        assert FakeAsyncClient.completion_requests[-1]["kwargs"]["json"]["model"] == "dynamic/chosen"
        response = client.post("/api/v1/ai/topic-plan", json={"topic": "Testing models", "modelId": "deleted/model"}); assert response.status_code == 422
    finally: remove_profile(profile_id)


def test_custom_script_bypasses_openrouter_and_model_selection():
    profile_id = connected_profile("Custom script profile")
    try:
        response = client.post("/api/v1/ai/topic-plan", json={"topic": "Local", "customScript": "This local custom script does not need OpenRouter."})
        assert response.status_code == 200 and response.json()["narration"] == "This local custom script does not need OpenRouter."
    finally: remove_profile(profile_id)
