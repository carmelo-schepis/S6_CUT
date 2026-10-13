from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from engine import media as media_module
from engine.app import settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Job, ProfileInput
from engine.providers import ProfileService, ProviderError, test_openrouter_failure
from engine.security import SecretVault
from engine.tests.test_atomic_publication import (
    _clip_job,
    _fake_extract,
    _fake_probe,
    _fake_render_clip,
    _fake_select,
    _fake_transcribe,
)


@pytest.fixture()
def smart_cluster(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Database, JobManager, str]:
    runtime = replace(settings, data_path=tmp_path)
    database = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    manager = JobManager(database, LibraryRules(database, tmp_path / "library"), profiles, runtime)
    monkeypatch.setattr("engine.jobs.probe", _fake_probe)
    monkeypatch.setattr(media_module, "extract_audio_16k", _fake_extract)
    monkeypatch.setattr(media_module, "is_whisper_model_cached", lambda _: True)
    monkeypatch.setattr(media_module, "transcribe", _fake_transcribe)
    monkeypatch.setattr("engine.jobs.select_candidates", _fake_select)
    monkeypatch.setattr("engine.jobs.render_clip", _fake_render_clip)
    job_id = "openrouter-fallback"
    _clip_job(database, job_id, "openrouter-fallback-project", tmp_path=tmp_path, mode="smart", count=3)
    private = database.get_job_private(job_id)
    private["use_openrouter"] = True
    database.save_job(database.get_job(job_id), private)
    return database, manager, job_id


def _configure_provider_failure(manager: JobManager, category: str, message: str) -> None:
    async def fail(*_: Any, **__: Any) -> dict[str, Any]:
        raise ProviderError(category, message)

    manager.profiles.openrouter_json = fail


def _run(database: Database, manager: JobManager, job_id: str) -> Job:
    manager._process(job_id)
    job = database.get_job(job_id)
    assert job is not None
    return job


@pytest.mark.parametrize(
    ("category", "message", "expected"),
    [
        ("timeout_offline", "OpenRouter could not be reached", "could not be reached"),
        ("invalid_credentials", "OpenRouter rejected the saved credentials", "credentials"),
        ("rate_limited", "OpenRouter rate limit reached. Wait and retry.", "rate limit"),
        ("timeout_offline", "OpenRouter is temporarily unavailable", "temporarily unavailable"),
        ("unavailable_model", "The selected OpenRouter model is unavailable. Choose another model in Settings.", "model"),
        ("malformed_response", "OpenRouter returned a plan that could not be validated.", "could not be validated"),
    ],
)
def test_provider_failures_complete_through_local_smart_fallback(
    smart_cluster: tuple[Database, JobManager, str], category: str, message: str, expected: str,
) -> None:
    database, manager, job_id = smart_cluster
    database_path = database.path.parent
    _configure_provider_failure(manager, category, message)

    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert job.error is None
    assert len(job.clips) == 3
    assert all(clip.state == "complete" and clip.library_asset_id and clip.output_name for clip in job.clips)
    assert all((database_path / "jobs" / job_id / "clips" / clip.output_name).is_file() for clip in job.clips if clip.output_name)
    warning = "OpenRouter API failed: "
    assert sum(item.startswith(warning) for item in job.warnings) == 1
    provider_warning = next(item for item in job.warnings if item.startswith(warning))
    assert expected in provider_warning
    assert "Continuing with deterministic local planning." in provider_warning
    steps = {step.id: step for step in job.steps}
    assert steps["openrouter"].status == "failed"
    assert steps["local_planning"].status == "complete"
    assert steps["select"].status == "complete"
    assert steps["boundaries"].status == "complete"
    assert steps["render"].status == "complete"
    assert steps["verify"].status == "complete"
    assert steps["ready"].status == "complete"
    assert len(database.list_assets()) == 4


def test_provider_exception_is_sanitized_and_does_not_escape(smart_cluster: tuple[Database, JobManager, str]) -> None:
    database, manager, job_id = smart_cluster

    async def fail(*_: Any, **__: Any) -> dict[str, Any]:
        raise RuntimeError("provider exception with secret-redaction-marker")

    manager.profiles.openrouter_json = fail
    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert "secret-redaction-marker" not in " ".join(job.warnings)
    assert any(item.startswith("OpenRouter API failed:") for item in job.warnings)


@pytest.mark.parametrize(
    ("result", "provider_succeeds"),
    [
        ({"indexes": [2, 2, 1]}, True),
        ({"indexes": [True]}, False),
        ({"indexes": [-1]}, False),
        ({"indexes": [999]}, False),
    ],
)
def test_duplicate_or_invalid_indexes_never_duplicate_clips_and_use_safe_fallback(
    smart_cluster: tuple[Database, JobManager, str], result: dict[str, Any], provider_succeeds: bool,
) -> None:
    database, manager, job_id = smart_cluster

    async def malformed(*_: Any, **__: Any) -> dict[str, Any]:
        return result

    manager.profiles.openrouter_json = malformed
    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert len(job.clips) == 3
    assert len({clip.start for clip in job.clips}) == 3
    openrouter = next(step for step in job.steps if step.id == "openrouter")
    local_planning = next(step for step in job.steps if step.id == "local_planning")
    assert openrouter.status == ("complete" if provider_succeeds else "failed")
    assert local_planning.status == ("skipped" if provider_succeeds else "complete")
    if provider_succeeds:
        assert [clip.start for clip in job.clips] == [6.0, 3.0, 0.0]


def test_malformed_or_empty_indexes_use_local_pool_and_preserve_requested_count(
    smart_cluster: tuple[Database, JobManager, str],
) -> None:
    database, manager, job_id = smart_cluster

    async def malformed(*_: Any, **__: Any) -> dict[str, Any]:
        return {"indexes": []}

    manager.profiles.openrouter_json = malformed
    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert len(job.clips) == 3
    assert next(step for step in job.steps if step.id == "openrouter").status == "failed"
    assert next(step for step in job.steps if step.id == "local_planning").status == "complete"


def test_successful_provider_order_is_kept_and_pool_fills_requested_count(
    smart_cluster: tuple[Database, JobManager, str],
) -> None:
    database, manager, job_id = smart_cluster

    async def choose_one(*_: Any, **__: Any) -> dict[str, Any]:
        return {"indexes": [2]}

    manager.profiles.openrouter_json = choose_one
    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert len(job.clips) == 3
    assert job.clips[0].start == 6.0
    assert next(step for step in job.steps if step.id == "openrouter").status == "complete"
    assert next(step for step in job.steps if step.id == "local_planning").status == "skipped"
    assert not any("API failed" in warning for warning in job.warnings)


def test_no_provider_skips_api_step_without_failure_warning(smart_cluster: tuple[Database, JobManager, str]) -> None:
    database, manager, job_id = smart_cluster
    private = database.get_job_private(job_id)
    private["use_openrouter"] = False
    database.save_job(database.get_job(job_id), private)

    job = _run(database, manager, job_id)

    assert job.state == "complete"
    assert not any("API failed" in warning for warning in job.warnings)
    steps = {step.id: step for step in job.steps}
    assert steps["openrouter"].status == "skipped"
    assert steps["local_planning"].status == "complete"


def test_required_local_transcription_failure_remains_terminal(smart_cluster: tuple[Database, JobManager, str], monkeypatch: pytest.MonkeyPatch) -> None:
    database, manager, job_id = smart_cluster

    def fail_transcription(*_: Any, **__: Any) -> dict[str, Any]:
        raise RuntimeError("local transcription unavailable")

    monkeypatch.setattr(media_module, "transcribe", fail_transcription)
    job = _run(database, manager, job_id)

    assert job.state == "failed"
    assert job.error == "local transcription unavailable"
    assert not any("API failed" in warning for warning in job.warnings)
    assert next(step for step in job.steps if step.id == "transcribe").status == "failed"


def test_provider_warning_is_not_duplicated_when_planning_is_reentered(
    smart_cluster: tuple[Database, JobManager, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, manager, job_id = smart_cluster
    transcription_calls = 0
    original_transcribe = _fake_transcribe

    def count_transcription(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal transcription_calls
        transcription_calls += 1
        return original_transcribe(*args, **kwargs)

    monkeypatch.setattr(media_module, "transcribe", count_transcription)
    _configure_provider_failure(manager, "timeout_offline", "OpenRouter could not be reached")
    first = _run(database, manager, job_id)
    private = database.get_job_private(job_id)
    warning = next(item for item in first.warnings if item.startswith("OpenRouter API failed:"))

    # A recovery/retry can revisit planning with the same transcript. Re-enter
    # only this boundary to verify the durable warning remains one row.
    first.clips = []
    first.state = "queued"
    first.stage = "queued"
    first.stage_label = "Queued"
    first.progress = 0
    ready = next(step for step in first.steps if step.id == "ready")
    ready.status = "pending"
    ready.detail = None
    ready.started_at = None
    ready.completed_at = None
    database.save_job(first, private)
    manager._plan_smart_candidates(first, private, _fake_transcribe(None, None)["words"])
    second = database.get_job(job_id)

    assert second is not None
    assert second.warnings.count(warning) == 1
    assert transcription_calls == 1


class _ProviderResponse:
    def __init__(self, status_code: int, payload: object | None = None):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        if isinstance(self.payload, BaseException):
            raise self.payload
        return self.payload


class _ProviderClient:
    response: _ProviderResponse
    post_error: BaseException | None = None
    post_calls = 0

    def __init__(self, **_: Any):
        type(self).post_calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: Any):
        return None

    async def post(self, *_: Any, **__: Any):
        type(self).post_calls += 1
        if type(self).post_error:
            raise type(self).post_error
        return type(self).response


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "rejected the saved credentials"),
        (403, "rejected the saved credentials"),
        (404, "selected OpenRouter text model is unavailable"),
        (422, "selected OpenRouter text model is unavailable"),
        (408, "temporarily unavailable"),
        (429, "rate limit reached"),
        (500, "temporarily unavailable"),
        (502, "temporarily unavailable"),
        (503, "temporarily unavailable"),
        (504, "temporarily unavailable"),
    ],
)
def test_openrouter_http_failures_are_mapped_without_response_body_leaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status_code: int, expected: str,
) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="HTTP failure", openrouter_key="test-key", selected=True))
    profile.text_status = "connected"
    database.save_profile(profile)
    _ProviderClient.response = _ProviderResponse(status_code, {"error": "private response body must not escape"})
    _ProviderClient.post_error = None
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", _ProviderClient)

    with pytest.raises(ProviderError, match=expected) as error:
        asyncio.run(service.openrouter_json([], {"type": "object"}))
    assert "private response body" not in str(error.value)
    assert _ProviderClient.post_calls == (2 if status_code in {408, 500, 502, 503, 504} else 1)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": [{"message": {}}]},
        {"choices": [{"message": {"content": 123}}]},
        {"choices": [{"message": {"content": "not-json"}}]},
    ],
)
def test_malformed_provider_responses_are_rejected_without_body_leaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, payload: object,
) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Malformed response", openrouter_key="test-key", selected=True))
    profile.text_status = "connected"
    database.save_profile(profile)
    _ProviderClient.response = _ProviderResponse(200, payload)
    _ProviderClient.post_error = None
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", _ProviderClient)

    with pytest.raises(ProviderError, match="could not be validated"):
        asyncio.run(service.openrouter_json([], {"type": "object"}))


@pytest.mark.parametrize("error", [httpx.ReadTimeout("private timeout detail"), httpx.ConnectError("private connection detail")])
def test_provider_connection_failures_are_retried_and_mapped_safely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: httpx.RequestError,
) -> None:
    database = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Connection failure", openrouter_key="test-key", selected=True))
    profile.text_status = "connected"
    database.save_profile(profile)
    _ProviderClient.post_error = error
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", _ProviderClient)

    with pytest.raises(ProviderError, match="could not be reached") as provider_error:
        asyncio.run(service.openrouter_json([], {"type": "object"}))
    assert "private" not in str(provider_error.value)
    assert _ProviderClient.post_calls == 2


@pytest.mark.parametrize("failure", ["timeout", "offline", "401", "403", "404", "422", "408", "429", "500", "502", "503", "504", "malformed"])
def test_test_failure_seam_allowlist_is_deterministic(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    monkeypatch.setenv("S6_TEST_MODE", "1")
    monkeypatch.setenv("S6_TEST_OPENROUTER_FAILURE", failure)
    result = test_openrouter_failure()
    assert result is not None
    assert isinstance(result[0], str) and isinstance(result[1], str)


def test_test_failure_seam_requires_explicit_test_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S6_TEST_OPENROUTER_FAILURE", "timeout")
    monkeypatch.delenv("S6_TEST_MODE", raising=False)
    assert test_openrouter_failure() is None
    monkeypatch.setenv("S6_TEST_MODE", "1")
    assert test_openrouter_failure() == ("timeout_offline", "OpenRouter could not be reached")
    monkeypatch.setenv("S6_TEST_OPENROUTER_FAILURE", "arbitrary-code")
    assert test_openrouter_failure() is None


def test_openrouter_metadata_controls_are_opt_in_and_return_usage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    database = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Metadata request", openrouter_key="test-key", selected=True))
    profile.text_status = "connected"
    database.save_profile(profile)

    class CaptureClient:
        request: dict[str, Any] = {}

        def __init__(self, **_: Any): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_: Any): return None
        async def post(self, _url: str, *, json: dict[str, Any], **_: Any):
            type(self).request = json
            return _ProviderResponse(200, {"choices": [{"message": {"content": '{"clips": []}'}}], "usage": {"prompt_tokens": 41, "completion_tokens": 17, "cost": 0.00001}})

    monkeypatch.setattr("engine.providers.httpx.AsyncClient", CaptureClient)
    result = asyncio.run(service.openrouter_json(
        [], {"type": "object"}, max_tokens=900, temperature=0.2,
        provider={"require_parameters": True, "max_price": {"prompt": 0.10, "completion": 0.40}},
        reasoning={"enabled": False}, include_usage=True,
    ))
    assert result == ({"clips": []}, {"prompt_tokens": 41, "completion_tokens": 17, "cost": 0.00001})
    request = CaptureClient.request
    assert request["max_tokens"] == 400
    assert request["temperature"] == 0.2
    assert request["provider"]["require_parameters"] is True
    assert request["provider"]["max_price"] == {"prompt": 0.10, "completion": 0.40}
    assert request["reasoning"] == {"enabled": False}
    assert "tools" not in request


def test_test_failure_seam_is_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("S6_TEST_MODE", raising=False)
    monkeypatch.delenv("S6_TEST_OPENROUTER_FAILURE", raising=False)
    assert test_openrouter_failure() is None


@pytest.mark.parametrize(
    ("test_mode", "failure"),
    [(None, None), (None, "timeout"), ("1", None)],
)
def test_provider_call_is_unchanged_without_explicit_allowlisted_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, test_mode: str | None, failure: str | None,
):
    if test_mode is None:
        monkeypatch.delenv("S6_TEST_MODE", raising=False)
    else:
        monkeypatch.setenv("S6_TEST_MODE", test_mode)
    if failure is None:
        monkeypatch.delenv("S6_TEST_OPENROUTER_FAILURE", raising=False)
    else:
        monkeypatch.setenv("S6_TEST_OPENROUTER_FAILURE", failure)
    database = Database(tmp_path / "s6-cut.sqlite3")
    service = ProfileService(database, SecretVault(tmp_path / "secrets" / "instance.key"))
    profile = service.save(ProfileInput(name="Normal provider", openrouter_key="test-key", selected=True))
    profile.text_status = "connected"
    database.save_profile(profile)
    _ProviderClient.response = _ProviderResponse(200, {"choices": [{"message": {"content": '{"ok": true}'}}]})
    _ProviderClient.post_error = None
    monkeypatch.setattr("engine.providers.httpx.AsyncClient", _ProviderClient)

    result = asyncio.run(service.openrouter_json([], {"type": "object"}))

    assert result == {"ok": True}
    assert _ProviderClient.post_calls == 1
