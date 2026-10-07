from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from engine.database import Database
from engine.models import Job, ProcessingStep, ProfileInput
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
    models_response: FakeResponse
    completion_response: FakeResponse
    get_error: Exception | None = None
    completion_calls = 0

    def __init__(self, **_: object):
        pass

    async def __aenter__(self): return self
    async def __aexit__(self, *_: object): return None

    async def get(self, *_: object, **__: object):
        if self.get_error: raise self.get_error
        return self.models_response

    async def post(self, *_: object, **__: object):
        type(self).completion_calls += 1
        return self.completion_response


def make_service(tmp_path: Path) -> tuple[ProfileService, str]:
    db = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(
        name="Verification test", text_model_id="openai/test",
        openrouter_key="test-key", selected=True,
    ))
    return service, profile.id


def run_test(service: ProfileService, profile_id: str):
    return asyncio.run(service.test(profile_id))


def configure_fake(monkeypatch: pytest.MonkeyPatch, *, status_code=200, payload=None):
    FakeClient.models_response = FakeResponse(status_code, payload if payload is not None else {"data": [{"id": "openai/test", "architecture": {"output_modalities": ["text"]}}]})
    FakeClient.completion_response = FakeResponse(200, {"choices": [{"message": {"content": '{"ok":true}'}}]})
    FakeClient.get_error = None
    FakeClient.completion_calls = 0
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", FakeClient)


def test_missing_key_is_not_verified(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Missing key", text_model_id="openai/test", selected=True))
    result = run_test(service, profile.id)
    assert result.text_status == "not_configured"
    assert result.status == "local only"


@pytest.mark.parametrize("status_code", [401, 403])
def test_invalid_openrouter_key_is_precise(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status_code: int):
    service, profile_id = make_service(tmp_path)
    configure_fake(monkeypatch, status_code=status_code, payload={"detail": "secret must not escape"})
    result = run_test(service, profile_id)
    assert result.text_status == "invalid_credentials"
    assert "secret must not escape" not in (result.text_message or "")


def test_text_profile_verification_checks_model_and_completion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service, profile_id = make_service(tmp_path)
    configure_fake(monkeypatch)
    result = run_test(service, profile_id)
    assert result.text_status == "connected"
    assert result.status == "connected"
    assert FakeClient.completion_calls == 1

    configure_fake(monkeypatch, payload={"data": [{"id": "another/model", "architecture": {"output_modalities": ["text"]}}]})
    unavailable = run_test(service, profile_id)
    assert unavailable.text_status == "unavailable"
    assert FakeClient.completion_calls == 0


def test_text_model_discovery_filters_text_models_deterministically(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service, profile_id = make_service(tmp_path)
    configure_fake(monkeypatch, payload={"data": [
        {"id": "speech/only", "architecture": {"output_modalities": ["audio"]}},
        {"id": "z/text", "name": "Z text", "architecture": {"output_modalities": ["text"]}},
        {"id": "a/text", "name": "A text", "architecture": {"output_modalities": ["text"]}},
    ]})
    profile = service.db.get_profile(profile_id)[0]
    profile.text_status = "connected"
    service.db.save_profile(profile)
    models = asyncio.run(service.openrouter_models("text"))
    assert [model.id for model in models] == ["a/text", "z/text"]


def test_masked_or_blank_key_retains_encrypted_openrouter_secret(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    original = service.save(ProfileInput(name="Original", text_model_id="openai/test", openrouter_key=" fixture-secret ", selected=True))
    service.save(ProfileInput(name="Blank", text_model_id="openai/test", openrouter_key="", selected=True), original.id)
    service.save(ProfileInput(name="Masked", text_model_id="openai/test", openrouter_key="••••cret", selected=True), original.id)
    assert service.secrets(original.id)["openrouterKey"] == "fixture-secret"
    record = db.get_profile(original.id)
    assert record and b"fixture-secret" not in (record[1] or b"")


def test_openrouter_network_failure_is_redacted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service, profile_id = make_service(tmp_path)
    configure_fake(monkeypatch)
    FakeClient.get_error = httpx.ConnectError("private network detail")
    result = run_test(service, profile_id)
    assert result.text_status == "timeout_offline"
    assert "private network detail" not in (result.text_message or "")


def test_old_profile_payload_is_migrated_idempotently(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    service = ProfileService(db, vault)
    profile = service.save(ProfileInput(name="Legacy", text_model_id="old/model", openrouter_key="openrouter-secret", selected=True))
    legacy = {"id": profile.id, "name": "Legacy", "modelId": "old/model", "voiceId": "old-voice", "selected": True, "persistence": "encrypted", "openrouterConfigured": True, "elevenlabsConfigured": True, "openrouterMasked": "••••cret", "elevenlabsMasked": "••••voice", "openrouterStatus": "unsupported_model_or_voice", "elevenlabsStatus": "connected", "openrouterMessage": "Connected", "elevenlabsMessage": "Connected", "status": "connected", "capabilities": ["structured planning", "ElevenLabs narration"], "fallbacks": {}}
    old_job = Job(id="legacy-job", project_id="legacy-project", mode="script", state="complete", stage="complete", stage_label="Done", progress=100, style="educational", steps=[ProcessingStep(id="elevenlabs", label="ElevenLabs narration")])
    db.save_job(old_job, {})
    with db._connect() as connection:
        connection.execute("UPDATE profiles SET payload=? WHERE id=?", (json.dumps(legacy), profile.id))
        connection.execute("DELETE FROM schema_migrations WHERE version IN (5, 10)")
    db.replace_profile_secret(profile.id, vault.encrypt(b'{"openrouterKey":"openrouter-secret","elevenlabsKey":"legacy-secret"}'))
    migrated_db = Database(tmp_path / "s6-cut.sqlite3")
    migrated = ProfileService(migrated_db, vault)
    current = migrated_db.get_profile(profile.id)[0]
    assert current.text_model_id == "old/model" and current.text_status == "unavailable"
    assert "ttsModelId" not in current.model_dump(by_alias=True)
    assert "OpenRouter TTS" not in current.capabilities
    assert migrated.secrets(profile.id) == {"openrouterKey": "openrouter-secret"}
    migrated_job = migrated_db.get_job("legacy-job")
    assert migrated_job and migrated_job.steps[0].id == "legacy-media" and migrated_job.steps[0].label == "Legacy media step"


def test_legacy_secret_is_removed_without_removing_openrouter(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    service = ProfileService(db, vault)
    profile = service.save(ProfileInput(name="Legacy", text_model_id="openai/test", openrouter_key="openrouter-secret", selected=True))
    db.replace_profile_secret(profile.id, vault.encrypt(b'{"openrouterKey":"openrouter-secret","elevenlabsKey":"legacy-secret"}'))
    migrated = ProfileService(db, vault)
    assert migrated.secrets(profile.id) == {"openrouterKey": "openrouter-secret"}
    record = db.get_profile(profile.id)
    assert record and b"legacy-secret" not in (record[1] or b"")
