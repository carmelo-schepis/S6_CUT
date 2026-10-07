from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from engine.database import Database
from engine.models import Job, ProcessingStep, ProfileInput
from engine.providers import ProfileService, ProviderError
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
    text_response: FakeResponse
    completion_response: FakeResponse
    get_error: Exception | None = None
    completion_calls = 0

    def __init__(self, **_: object):
        pass

    async def __aenter__(self): return self
    async def __aexit__(self, *_: object): return None

    async def get(self, url: str, **kwargs: object):
        if self.get_error: raise self.get_error
        return self.text_response

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


def configure_fake(monkeypatch: pytest.MonkeyPatch, *, text_status=200, text_payload=None):
    FakeClient.text_response = FakeResponse(text_status, text_payload if text_payload is not None else {"data": [{"id": "openai/test"}]})
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
    assert result.tts_status == "not_configured"


@pytest.mark.parametrize("status_code", [401, 403])
def test_invalid_openrouter_key_is_precise(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status_code: int):
    service, profile_id = make_service(tmp_path)
    configure_fake(monkeypatch, text_status=status_code, text_payload={"detail": "secret must not escape"})
    result = run_test(service, profile_id)
    assert result.text_status == "invalid_credentials"
    assert "secret must not escape" not in (result.text_message or "")


def test_profile_test_keeps_hidden_speech_configuration_but_reports_tts_retired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service, profile_id = make_service(tmp_path)
    profile = service.db.get_profile(profile_id)[0]
    profile.tts_model_id, profile.tts_voice, profile.tts_speed, profile.tts_status = "legacy/speech", "legacy-voice", 1.25, "connected"
    service.db.save_profile(profile)
    configure_fake(monkeypatch)
    result = run_test(service, profile_id)
    assert result.text_status == "connected"
    assert result.status == "connected"
    assert (result.tts_model_id, result.tts_voice, result.tts_speed, result.tts_status) == ("legacy/speech", "legacy-voice", 1.25, "not_configured")
    assert result.tts_message == "Text-to-speech is retired"
    assert result.tts_last_checked_at is None
    assert FakeClient.completion_calls == 1


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
    legacy = {"id": profile.id, "name": "Legacy", "modelId": "old/model", "voiceId": "old-voice", "selected": True, "persistence": "encrypted", "openrouterConfigured": True, "elevenlabsConfigured": True, "openrouterMasked": "••••cret", "elevenlabsMasked": "••••voice", "openrouterStatus": "connected", "elevenlabsStatus": "connected", "openrouterMessage": "Connected", "elevenlabsMessage": "Connected", "status": "connected", "capabilities": ["structured planning", "ElevenLabs narration"], "fallbacks": {}}
    old_job = Job(id="legacy-job", project_id="legacy-project", mode="script", state="complete", stage="complete", stage_label="Done", progress=100, style="educational", steps=[ProcessingStep(id="elevenlabs", label="ElevenLabs narration")])
    db.save_job(old_job, {})
    with db._connect() as connection:
        connection.execute("UPDATE profiles SET payload=? WHERE id=?", (json.dumps(legacy), profile.id))
        connection.execute("DELETE FROM schema_migrations WHERE version=5")
    db.replace_profile_secret(profile.id, vault.encrypt(b'{"openrouterKey":"openrouter-secret","elevenlabsKey":"legacy-secret"}'))
    migrated_db = Database(tmp_path / "s6-cut.sqlite3")
    migrated = ProfileService(migrated_db, vault)
    current = migrated_db.get_profile(profile.id)[0]
    assert current.text_model_id == "old/model" and current.tts_model_id is None and current.tts_voice is None
    assert "OpenRouter TTS" not in current.capabilities
    assert migrated.secrets(profile.id) == {"openrouterKey": "openrouter-secret"}
    saved_profile = migrated_db.get_profile(profile.id)
    assert saved_profile and migrated.vault.decrypt(saved_profile[1]) == b'{"openrouterKey":"openrouter-secret"}'
    migrated_job = migrated_db.get_job("legacy-job")
    assert migrated_job and migrated_job.mode == "script"
    assert migrated_job.steps[0].id == "tts" and migrated_job.steps[0].label == "Generated narration"


def test_remaining_profile_edits_preserve_all_stored_credentials_and_hidden_fields(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    service = ProfileService(db, vault)
    profile = service.save(ProfileInput(name="Legacy", text_model_id="openai/test", openrouter_key="openrouter-secret", selected=True))
    hidden = db.get_profile(profile.id)[0].model_copy(update={
        "tts_model_id": "legacy/speech", "tts_voice": "legacy-voice", "tts_speed": 1.25,
        "tts_status": "connected", "tts_message": "Connected", "tts_last_checked_at": "2026-01-01T00:00:00+00:00",
    })
    db.save_profile(hidden, vault.encrypt(b'{"openrouterKey":"openrouter-secret","elevenlabsKey":"legacy-secret"}'))
    edited = service.save(ProfileInput(name="Updated", text_model_id="openai/updated", openrouter_key="", selected=True), profile.id)
    assert (edited.tts_model_id, edited.tts_voice, edited.tts_speed) == ("legacy/speech", "legacy-voice", 1.25)
    assert edited.tts_status == "not_configured"
    assert edited.tts_message == "Text-to-speech is retired"
    assert edited.tts_last_checked_at is None
    assert service.secrets(profile.id) == {"openrouterKey": "openrouter-secret"}
    record = db.get_profile(profile.id)
    assert record and vault.decrypt(record[1]) == b'{"openrouterKey":"openrouter-secret"}'
    assert b"legacy-secret" not in (record[1] or b"")


def test_existing_tts_status_is_retired_at_startup(tmp_path: Path):
    db = Database(tmp_path / "s6-cut.sqlite3")
    vault = SecretVault(tmp_path / "secrets" / "instance.key")
    service = ProfileService(db, vault)
    profile = service.save(ProfileInput(name="Legacy", text_model_id="openai/test", selected=True))
    stale = db.get_profile(profile.id)[0].model_copy(update={
        "tts_status": "connected", "tts_message": "Connected", "tts_last_checked_at": "2026-01-01T00:00:00+00:00",
    })
    db.save_profile(stale)

    restarted = ProfileService(db, vault)
    current = db.get_profile(profile.id)[0]
    assert current.tts_status == "not_configured"
    assert current.tts_message == "Text-to-speech is retired"
    assert current.tts_last_checked_at is None
    assert restarted.secrets(profile.id) == {}
