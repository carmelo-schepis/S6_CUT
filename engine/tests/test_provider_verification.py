from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from engine.database import Database
from engine.models import ProfileInput
from engine.providers import ProfileService
from engine.security import SecretVault


class FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


class FakeClient:
    model_response: FakeResponse
    completion_response: FakeResponse
    get_error: Exception | None = None
    completion_calls = 0

    def __init__(self, **_: object):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object):
        return None

    async def get(self, *_: object, **__: object):
        if self.get_error:
            raise self.get_error
        return self.model_response

    async def post(self, *_: object, **__: object):
        type(self).completion_calls += 1
        return self.completion_response


def make_service(tmp_path: Path) -> tuple[ProfileService, str]:
    db = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Verification test", model_id="openai/test", openrouter_key="test-key", selected=True))
    return service, profile.id


def run_test(service: ProfileService, profile_id: str) -> object:
    return asyncio.run(service.test(profile_id))


def test_missing_key_is_not_verified(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Missing key", model_id="openai/test", selected=True))

    result = run_test(service, profile.id)

    assert result.openrouter_status == "not_configured"
    assert result.openrouter_last_checked_at is None


@pytest.mark.parametrize(
    ("status_code", "status"),
    [(401, "invalid_credentials"), (403, "invalid_credentials"), (429, "rate_limited")],
)
def test_http_verification_failures_are_precise(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status_code: int, status: str) -> None:
    service, profile_id = make_service(tmp_path)
    FakeClient.model_response = FakeResponse(status_code, {"secret": "never returned"})
    FakeClient.get_error = None
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeClient)

    result = run_test(service, profile_id)

    assert result.openrouter_status == status
    assert result.openrouter_last_checked_at is not None
    assert "never returned" not in result.openrouter_message


def test_timeout_and_malformed_responses_are_not_connected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, profile_id = make_service(tmp_path)
    FakeClient.get_error = httpx.ReadTimeout("private upstream detail")
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeClient)

    timed_out = run_test(service, profile_id)
    assert timed_out.openrouter_status == "timeout_offline"
    assert "private upstream detail" not in timed_out.openrouter_message

    FakeClient.get_error = None
    FakeClient.model_response = FakeResponse(200, {"wrong": []})
    malformed = run_test(service, profile_id)
    assert malformed.openrouter_status == "malformed_response"


def test_success_requires_exact_model_and_valid_structured_response(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, profile_id = make_service(tmp_path)
    FakeClient.get_error = None
    FakeClient.model_response = FakeResponse(200, {"data": [{"id": "openai/test"}]})
    FakeClient.completion_response = FakeResponse(200, {"choices": [{"message": {"content": '{"ok":true}'}}]})
    FakeClient.completion_calls = 0
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeClient)

    result = run_test(service, profile_id)

    assert result.openrouter_status == "connected"
    assert result.openrouter_last_checked_at is not None
    assert FakeClient.completion_calls == 1

    FakeClient.completion_response = FakeResponse(200, {"choices": [{"message": {"content": "{}"}}]})
    failed = run_test(service, profile_id)
    assert failed.openrouter_status == "malformed_response"
    assert failed.openrouter_last_checked_at is not None


def test_later_failure_clears_previous_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, profile_id = make_service(tmp_path)
    FakeClient.get_error = None
    FakeClient.model_response = FakeResponse(200, {"data": [{"id": "openai/test"}]})
    FakeClient.completion_response = FakeResponse(200, {"choices": [{"message": {"content": '{"ok":true}'}}]})
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeClient)

    connected = run_test(service, profile_id)
    assert connected.openrouter_status == "connected"
    previous_check = connected.openrouter_last_checked_at

    FakeClient.model_response = FakeResponse(401, {})
    rejected = run_test(service, profile_id)

    assert rejected.openrouter_status == "invalid_credentials"
    assert rejected.openrouter_last_checked_at is not None
    assert rejected.openrouter_last_checked_at != previous_check
    assert service.smart_available() is False
