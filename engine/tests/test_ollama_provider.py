from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import httpx
import pytest

from engine import app as app_module, providers
from engine.app import db, profiles
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Clip, Job, ProfileInput, Project, ProviderProfile, normalise_ollama_url
from engine.providers import ProfileService
from engine.security import SecretVault
from test_youtube_metadata import _completed_job, _persist_job

OLLAMA_URL = "http://ollama.test:11434"
SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}


class FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code, self._payload = status_code, payload

    def json(self):
        return self._payload


class Recorder:
    calls: list[tuple[str, str, dict[str, object]]] = []
    responder = None


def default_responder(method: str, url: str, kwargs: dict[str, object]) -> FakeResponse:
    if method == "GET" and url.endswith("/api/tags"):
        return FakeResponse(200, {"models": [{"name": "llama3.2:latest"}, {"name": "qwen2.5:0.5b"}]})
    if method == "POST" and url.endswith("/api/chat"):
        return FakeResponse(200, {"message": {"content": json.dumps({"ok": True})}, "prompt_eval_count": 12, "eval_count": 7})
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

    async def post(self, url: str, **kwargs: object):
        Recorder.calls.append(("POST", url, kwargs))
        return Recorder.responder("POST", url, kwargs)


@pytest.fixture(autouse=True)
def fake_http(monkeypatch: pytest.MonkeyPatch):
    Recorder.calls = []
    Recorder.responder = default_responder
    monkeypatch.setattr(providers.httpx, "AsyncClient", FakeAsyncClient)


def save_profile(**overrides) -> str:
    value = ProfileInput(name="Ollama test", selected=True, **overrides)
    return profiles.save(value).id


@pytest.mark.parametrize("raw, expected", [
    ("localhost:11434", "http://localhost:11434"),
    ("http://host.docker.internal:11434/", "http://host.docker.internal:11434"),
    ("https://gpu.example.test/api", "https://gpu.example.test"),
    ("http://h/v1/", "http://h"),
    ("https://host.test/api/v1", "https://host.test"),
    ("   ", ""),
])
def test_endpoint_is_normalised(raw: str, expected: str):
    assert normalise_ollama_url(raw) == expected


@pytest.mark.parametrize("raw", ["ftp://x", "http://user:pw@host", "http://h/?a=1", "http://h:99999", "http://"])
def test_unsafe_endpoints_are_rejected(raw: str):
    with pytest.raises(ValueError):
        normalise_ollama_url(raw)


def test_saving_other_settings_keeps_the_endpoint_and_clearing_removes_it():
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2")
    kept = profiles.save(ProfileInput(name="Ollama test", selected=True, auto_seo_titles=False), profile_id)
    assert kept.ollama_url == OLLAMA_URL and kept.ollama_model == "llama3.2"
    cleared = profiles.save(ProfileInput(name="Ollama test", selected=True, ollama_url=""), profile_id)
    assert cleared.ollama_url is None and cleared.ollama_model is None
    assert cleared.status == "local only"


def test_duplicate_copies_the_endpoint():
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="qwen2.5:0.5b")
    copy = profiles.duplicate(profile_id)
    assert copy.ollama_url == OLLAMA_URL and copy.ollama_model == "qwen2.5:0.5b"


def test_missing_model_name_is_auto_detected_and_latest_suffix_is_removed():
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="")
    assert profiles.db.get_profile(profile_id)[0].ollama_model is None
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2:latest")
    assert profiles.db.get_profile(profile_id)[0].ollama_model == "llama3.2"


def test_endpoint_only_profile_selects_and_tests_smallest_chat_model():
    profile_id = save_profile(ollama_url=OLLAMA_URL)

    def server(method, url, kwargs):
        if method == "GET":
            return FakeResponse(200, {"models": [
                {"name": "embeddinggemma:latest", "capabilities": ["embedding"], "details": {"parameter_size": "300M"}},
                {"name": "qwen3:8b", "capabilities": ["completion", "thinking"], "details": {"parameter_size": "8.2B"}},
                {"name": "qwen3:1.7b", "capabilities": ["completion", "thinking"], "details": {"parameter_size": "1.7B"}},
            ]})
        Recorder.calls.append((method, url, kwargs))
        return FakeResponse(200, {"message": {"content": json.dumps({"ok": True})}})

    Recorder.responder = server
    tested = asyncio.run(profiles.test(profile_id))
    assert tested.ollama_status == "connected"
    assert tested.ollama_model == "qwen3:1.7b"
    chat = next(kwargs["json"] for method, _, kwargs in Recorder.calls if method == "POST")
    assert chat["model"] == "qwen3:1.7b" and chat["think"] is False


def test_ollama_json_uses_native_chat_and_never_reaches_openrouter():
    save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2", openrouter_key="sk-or-test-secret")
    result, usage = asyncio.run(profiles.openrouter_json(
        [{"role": "user", "content": "hi"}], SCHEMA, max_tokens=500, include_usage=True,
        provider={"require_parameters": True}, reasoning={"enabled": False}, ollama=True,
    ))
    assert result == {"ok": True}
    assert usage["prompt_tokens"] == 12 and usage["completion_tokens"] == 7 and usage["cost"] == 0
    assert Recorder.calls, "expected the Ollama server to be called"
    assert all(url.startswith(OLLAMA_URL) for _, url, _ in Recorder.calls)
    method, url, kwargs = Recorder.calls[-1]
    assert (method, url) == ("POST", f"{OLLAMA_URL}/api/chat")
    body = kwargs["json"]
    assert body["model"] == "llama3.2" and body["stream"] is False and body["think"] is False
    assert body["format"] == SCHEMA
    assert body["options"]["num_ctx"] == providers.OLLAMA_NUM_CTX and body["options"]["num_predict"] == 500
    assert "provider" not in body and "reasoning" not in body


def test_ollama_model_missing_from_server_is_an_actionable_failure():
    save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2")
    Recorder.responder = lambda method, url, kwargs: FakeResponse(200, {"models": []})
    with pytest.raises(providers.ProviderError) as caught:
        asyncio.run(profiles.openrouter_json([{"role": "user", "content": "hi"}], SCHEMA, model_id="llama3.2", ollama=True))
    assert caught.value.category == "unavailable"


def test_offline_ollama_reports_the_docker_address_hint():
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2")

    def unreachable(method, url, kwargs):
        raise httpx.ConnectError("connection refused")

    Recorder.responder = unreachable
    tested = asyncio.run(profiles.test(profile_id))
    assert tested.ollama_status == "timeout_offline"
    assert "host.docker.internal" in (tested.ollama_message or "")
    assert tested.status != "connected"


def test_successful_test_marks_ollama_connected_and_lists_capability():
    profile_id = save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2")
    tested = asyncio.run(profiles.test(profile_id))
    assert tested.ollama_status == "connected"
    assert tested.status == "connected"
    assert "Ollama text generation" in tested.capabilities
    assert profiles.ollama_available() is True


def test_no_endpoint_means_no_ollama_availability():
    save_profile()
    assert profiles.ollama_available() is False


def test_oversized_prompt_is_refused_before_ollama_is_called():
    save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2")
    huge = [{"role": "user", "content": "x" * 60_000}]
    with pytest.raises(providers.ProviderError) as caught:
        asyncio.run(profiles.openrouter_json(huge, SCHEMA, ollama=True))
    assert caught.value.category == "unavailable"
    assert not any(method == "POST" for method, _, _ in Recorder.calls)


def _create_job(monkeypatch, policy: str, *, smart: bool, ollama: bool):
    saved: dict = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: smart)
    monkeypatch.setattr(app_module.profiles, "ollama_available", lambda: ollama)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_):
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    app_module.creation_times.clear()
    response = TestClient(app_module.app).post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "execution_policy": policy, "processing_mode": "auto",
    })
    return response, saved


def test_ollama_job_is_refused_without_an_endpoint(monkeypatch):
    response, saved = _create_job(monkeypatch, "ollama", smart=True, ollama=False)
    assert response.status_code == 422
    assert "Ollama endpoint" in response.json()["detail"]
    assert saved == {}


@pytest.mark.parametrize(("policy", "smart", "ollama", "expected"), [
    ("auto", True, False, True),
    ("auto", False, True, False),  # a saved endpoint never turns Auto into an Ollama job
    ("engine_only", True, True, False),
    ("ollama", False, True, True),  # no OpenRouter needed; Auto processing resolves to Smart
])
def test_provider_flags_follow_the_chosen_policy(monkeypatch, policy, smart, ollama, expected):
    response, saved = _create_job(monkeypatch, policy, smart=smart, ollama=ollama)
    assert response.status_code == 202, response.text
    assert saved["private"]["provider_available"] is expected
    assert saved["private"]["use_openrouter"] is expected
    assert saved["job"].processing_mode == "smart"
    label = next(step.label for step in saved["job"].steps if step.id == "openrouter") if expected else None
    assert label in (None, "Ollama planning" if policy == "ollama" else "OpenRouter planning")


def _ollama_job(tmp_path, *, private_extra=None):
    runtime = replace(app_module.settings, data_path=tmp_path)
    db = Database(tmp_path / "test.sqlite3")
    service = ProfileService(db, SecretVault(tmp_path / "secrets" / "key"))
    service.save(ProfileInput(name="Both", selected=True, openrouter_key="sk-or-test-secret", ollama_url=OLLAMA_URL, ollama_model="llama3.2"))
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), service, runtime)
    project = Project(id="p", name="Speech", mode="clip", style="educational", state="active", source_name="s.mp4", source_kind="upload", requested_count=1)
    job = Job(id="j", project_id="p", mode="clip", style="educational", execution_policy="ollama", state="active", stage="planning",
              stage_label="Planning", progress=30, hook_text_enabled=True, youtube_metadata_enabled=True, youtube_metadata_model_id="llama3.2",
              clips=[Clip(id="c", index=1, state="queued", start=0, end=12, duration=12, opening_line="We can grow vegetables in a small garden.", title="Cut 1")],
              steps=manager._smart_steps(True, include_hook_text=True, provider_name="Ollama"))
    private = {"execution_policy": "ollama", "use_openrouter": True, "provider_available": True, "count": 1, "min_duration": 8, "max_duration": 12,
               "transcript": {"language": "en"}, "hook_text": {"enabled": True, "status": "pending"},
               "youtube_metadata": {"enabled": True, "model_id": "llama3.2", "status": "pending"}, **(private_extra or {})}
    db.save_project(project)
    db.save_job(job, private)
    return db, manager


def _schema_reply(method: str, url: str, kwargs: dict[str, object]) -> FakeResponse:
    if method == "GET":
        return default_responder(method, url, kwargs)
    required = kwargs["json"]["format"]["required"]
    content = {"indexes": [0]} if "indexes" in required else (
        {"hooks": [{"index": 1, "text": "A small garden can feed a family."}]} if "hooks" in required else
        {"clips": [{"clip_id": "c", "title": "How a small garden feeds a whole family", "description": ("A grounded look at growing vegetables in a small garden and what it takes to do it well.").ljust(130, ".")}]})
    return FakeResponse(200, {"message": {"content": json.dumps(content)}, "prompt_eval_count": 10, "eval_count": 5})


def test_every_worker_step_of_an_ollama_job_stays_on_ollama(monkeypatch, tmp_path):
    db, manager = _ollama_job(tmp_path)
    Recorder.responder = _schema_reply
    words = [{"text": "We can grow vegetables in a small garden.", "start": 1, "end": 5}]
    candidate = SimpleNamespace(start=0.0, end=12.0, words=words)
    monkeypatch.setattr("engine.jobs.select_candidates", lambda *args, **kwargs: [candidate])
    job, private = db.get_job("j"), db.get_job_private("j")
    assert manager._plan_smart_candidates(job, private, words) == [candidate]
    manager._generate_hook_text(job, private, words)
    manager._generate_youtube_metadata(job, private, words)
    chats = [kwargs["json"]["format"]["required"] for method, _, kwargs in Recorder.calls if method == "POST"]
    assert chats == [["indexes"], ["hooks"], ["clips"]]
    assert {url.split("/api/")[0] for _, url, _ in Recorder.calls} == {OLLAMA_URL}
    saved = db.get_job("j")
    assert saved.clips[0].hook_text == "A small garden can feed a family."
    assert saved.clips[0].title_source == "ai"


def test_offline_ollama_during_planning_falls_back_and_names_ollama(monkeypatch, tmp_path):
    db, manager = _ollama_job(tmp_path)

    def unreachable(method, url, kwargs):
        raise httpx.ConnectError("connection refused")

    Recorder.responder = unreachable
    words = [{"text": "We can grow vegetables in a small garden.", "start": 1, "end": 5}]
    candidate = SimpleNamespace(start=0.0, end=12.0, words=words)
    monkeypatch.setattr("engine.jobs.select_candidates", lambda *args, **kwargs: [candidate])
    job, private = db.get_job("j"), db.get_job_private("j")
    assert manager._plan_smart_candidates(job, private, words) == [candidate]
    assert any(warning.startswith("Ollama API failed") for warning in job.warnings)
    assert not any("OpenRouter" in warning for warning in job.warnings)
    assert {url.split("/api/")[0] for _, url, _ in Recorder.calls} == {OLLAMA_URL}


def test_switching_to_fast_keeps_the_ollama_policy(tmp_path):
    db, manager = _ollama_job(tmp_path, private_extra={"url": "https://www.youtube.com/watch?v=fixture"})
    assert manager._switch_to_fast(db.get_job("j")).execution_policy == "ollama"


def test_profiles_saved_before_this_feature_still_load():
    old = {"id": "old", "name": "Old", "text_model_id": "m", "selected": True, "persistence": "encrypted", "openrouter_configured": False, "status": "local only", "capabilities": [], "fallbacks": {}}
    loaded = ProviderProfile.model_validate_json(json.dumps(old))
    assert loaded.ollama_url is None and loaded.ollama_status == "not_configured"


def _regenerate(reply):
    save_profile(ollama_url=OLLAMA_URL, ollama_model="llama3.2", openrouter_key="sk-or-test-secret")
    job = _completed_job()
    job.execution_policy = "ollama"
    job.clips[0].transcript_excerpt = "A sufficiently long, grounded transcript excerpt for this completed clip."
    _persist_job(job, {"execution_policy": "ollama"})
    Recorder.responder = reply
    try:
        response = TestClient(app_module.app).post(f"/api/v1/jobs/{job.id}/clips/{job.clips[0].id}/youtube-metadata")
        return response, app_module.db.get_job(job.id).clips[0]
    finally:
        app_module.db.delete_project(job.project_id)


def test_regenerating_clip_metadata_on_an_ollama_job_stays_on_ollama():
    def reply(method, url, kwargs):
        if method == "GET":
            return default_responder(method, url, kwargs)
        clip_id = kwargs["json"]["format"]["properties"]["clip_id"]["enum"][0]
        content = {"clip_id": clip_id, "title": "How a small garden feeds a whole family", "description": "A grounded look at growing vegetables in a small garden and what it takes.".ljust(130, ".")}
        return FakeResponse(200, {"message": {"content": json.dumps(content)}, "prompt_eval_count": 10, "eval_count": 5})

    response, clip = _regenerate(reply)
    assert response.status_code == 200, response.text
    assert clip.title == "How a small garden feeds a whole family"
    assert {url.split("/api/")[0] for _, url, _ in Recorder.calls} == {OLLAMA_URL}


def test_regenerating_with_a_missing_model_gives_the_pull_hint():
    response, _ = _regenerate(lambda method, url, kwargs: FakeResponse(200, {"models": []}))
    assert response.status_code == 409
    assert "ollama pull llama3.2" in response.json()["detail"]
