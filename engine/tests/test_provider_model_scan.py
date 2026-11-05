from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient
import httpx
import pytest

from engine import app as app_module, providers
from engine.app import db, profiles
from engine.models import ProfileInput, ProviderModelScan

OLLAMA_URL = "http://ollama.test:11434"


class FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code, self._payload = status_code, payload

    def json(self):
        return self._payload


class Recorder:
    calls: list[tuple[str, str, dict[str, object]]] = []
    responder = None


def responder(method: str, url: str, kwargs: dict[str, object]) -> FakeResponse:
    if method == "GET" and url.endswith("/api/tags"):
        return FakeResponse(200, {"models": [
            {"name": "llama3.2:latest", "capabilities": ["completion"]},
            {"name": "embeddinggemma:latest", "capabilities": ["embedding"]},
            {"name": "gemma3:1b", "capabilities": ["completion"], "details": {"parameter_size": "999.89M"}},
        ]})
    if method == "GET" and url.endswith("/models"):
        return FakeResponse(200, {"data": [
            {"id": "openai/gpt-4.1-mini", "name": "GPT-4.1 mini", "architecture": {"output_modalities": ["text"]},
             "supported_parameters": ["response_format"], "pricing": {"prompt": "0.0000004", "completion": "0.0000016"}},
            {"id": "vendor/no-schema", "name": "No schema", "architecture": {"output_modalities": ["text"]},
             "supported_parameters": ["temperature"], "pricing": {"prompt": "0.0000001", "completion": "0.0000004"}},
        ]})
    raise AssertionError(f"unexpected request {method} {url}")


class FakeAsyncClient:
    def __init__(self, **_: object):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object):
        return None

    async def get(self, url: str, **kwargs: object):
        Recorder.calls.append(("GET", url, kwargs))
        return Recorder.responder("GET", url, kwargs)


@pytest.fixture(autouse=True)
def fake_http(monkeypatch: pytest.MonkeyPatch):
    Recorder.calls = []
    Recorder.responder = responder
    monkeypatch.setattr(providers.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)


def _save(**overrides) -> str:
    fields = {"name": "Scan test", "selected": False}
    fields.update(overrides)
    return profiles.save(ProfileInput(**fields)).id


def _scan(**fields):
    return asyncio.run(profiles.scan_models(ProviderModelScan(**fields)))


def _authorization_headers() -> list[str]:
    return [kwargs["headers"]["Authorization"] for _, url, kwargs in Recorder.calls if url.endswith("/models")]


def test_ollama_scan_uses_a_typed_endpoint_without_any_profile():
    models = _scan(provider="ollama", ollama_url=OLLAMA_URL)
    assert [model.id for model in models] == ["gemma3:1b", "llama3.2"]
    assert Recorder.calls[0][1] == f"{OLLAMA_URL}/api/tags"


def test_ollama_scan_falls_back_to_the_saved_endpoint_and_normalises_typed_ones():
    profile_id = _save(ollama_url=OLLAMA_URL)
    _scan(provider="ollama", profile_id=profile_id)
    assert Recorder.calls[0][1] == f"{OLLAMA_URL}/api/tags"
    Recorder.calls = []
    _scan(provider="ollama", profile_id=profile_id, ollama_url="http://typed.test:11434/api/")
    assert Recorder.calls[0][1] == "http://typed.test:11434/api/tags"


def test_openrouter_scan_works_for_a_non_selected_profile_that_is_not_connected():
    profile_id = _save(openrouter_key="sk-or-saved-secret")
    assert profiles.db.get_profile(profile_id)[0].text_status != "connected"
    models = _scan(provider="openrouter", profile_id=profile_id)
    assert [model.id for model in models] == ["openai/gpt-4.1-mini", "vendor/no-schema"]
    assert _authorization_headers() == ["Bearer sk-or-saved-secret"]


def test_a_typed_key_is_used_and_a_masked_value_is_ignored():
    profile_id = _save(openrouter_key="sk-or-saved-secret")
    _scan(provider="openrouter", profile_id=profile_id, openrouter_key="sk-or-typed-secret")
    _scan(provider="openrouter", profile_id=profile_id, openrouter_key="sk-or-••••cret")
    assert _authorization_headers() == ["Bearer sk-or-typed-secret", "Bearer sk-or-saved-secret"]


def test_the_environment_key_is_never_used_for_a_scan(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-environment")
    with pytest.raises(providers.ProviderError) as no_profile:
        _scan(provider="openrouter")
    assert no_profile.value.safe_message == "Add your OpenRouter API key to scan its models."
    profile_id = _save()
    with pytest.raises(providers.ProviderError):
        _scan(provider="openrouter", profile_id=profile_id)
    assert Recorder.calls == []


def test_switched_off_providers_make_no_calls():
    openrouter_off = _save(openrouter_key="sk-or-saved-secret", openrouter_enabled=False)
    with pytest.raises(providers.ProviderError) as openrouter:
        _scan(provider="openrouter", profile_id=openrouter_off)
    assert openrouter.value.safe_message == providers.OPENROUTER_OFF_MESSAGE
    ollama_off = _save(ollama_url=OLLAMA_URL, ollama_enabled=False)
    with pytest.raises(providers.ProviderError) as ollama:
        _scan(provider="ollama", profile_id=ollama_off)
    assert ollama.value.safe_message == providers.OLLAMA_OFF_MESSAGE
    assert Recorder.calls == []


def test_missing_endpoint_gives_an_actionable_message():
    with pytest.raises(providers.ProviderError) as caught:
        _scan(provider="ollama")
    assert caught.value.safe_message == "Add your Ollama endpoint to scan its models."
    assert Recorder.calls == []


def test_unknown_profile_raises_key_error():
    with pytest.raises(KeyError):
        _scan(provider="ollama", profile_id="does-not-exist", ollama_url=OLLAMA_URL)


def test_a_scan_writes_nothing_and_the_response_never_contains_the_key():
    profile_id = _save(openrouter_key="sk-or-saved-secret")
    before = profiles.db.get_profile(profile_id)[0].model_dump()
    secrets_before = profiles.secrets(profile_id)
    client = TestClient(app_module.app)
    response = client.post("/api/v1/provider-models/scan", json={"provider": "openrouter", "profileId": profile_id, "openrouterKey": "sk-or-typed-secret"})
    assert response.status_code == 200
    assert "sk-or-typed-secret" not in response.text and "sk-or-saved-secret" not in response.text
    assert profiles.db.get_profile(profile_id)[0].model_dump() == before
    assert profiles.secrets(profile_id) == secrets_before


def test_route_status_codes_for_the_scan():
    client = TestClient(app_module.app)
    ok = client.post("/api/v1/provider-models/scan", json={"provider": "ollama", "ollamaUrl": OLLAMA_URL})
    assert ok.status_code == 200 and [item["id"] for item in ok.json()] == ["gemma3:1b", "llama3.2"]
    assert client.post("/api/v1/provider-models/scan", json={"provider": "ollama", "profileId": "missing"}).status_code == 404
    bad = client.post("/api/v1/provider-models/scan", json={"provider": "ollama", "ollamaUrl": "ftp://x"})
    assert bad.status_code == 422 and "http or https" in bad.json()["detail"]
    assert client.post("/api/v1/provider-models/scan", json={"provider": "ollama"}).status_code == 503
    assert client.post("/api/v1/provider-models/scan", json={"provider": "other", "ollamaUrl": OLLAMA_URL}).status_code == 422


def test_an_offline_ollama_server_is_a_503_with_the_docker_hint():
    def unreachable(method, url, kwargs):
        raise httpx.ConnectError("connection refused")

    Recorder.responder = unreachable
    response = TestClient(app_module.app).post("/api/v1/provider-models/scan", json={"provider": "ollama", "ollamaUrl": OLLAMA_URL})
    assert response.status_code == 503
    assert "host.docker.internal" in response.json()["detail"]

