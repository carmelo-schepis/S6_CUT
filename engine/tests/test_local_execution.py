from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from engine import app as app_module
from engine.database import Database
from engine.hook_text import local_hook_text
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Clip, Job, MusicAudioMode, Project
from engine.providers import ProfileService
from engine.security import SecretVault


@pytest.mark.parametrize("connected", [False, True])
def test_clip_api_snapshots_engine_only_without_disabling_requested_features(monkeypatch, connected):
    saved = {}
    monkeypatch.setattr(app_module, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: connected)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    monkeypatch.setattr(app_module.db, "save_project", lambda project: saved.update(project=project))
    monkeypatch.setattr(app_module.db, "save_job", lambda job, private=None: saved.update(job=job, private=private))

    async def enqueue(_):
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    app_module.creation_times.clear()
    response = TestClient(app_module.app).post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "execution_policy": "engine_only",
        "processing_mode": "auto", "hook_text": "true", "youtube_metadata": "true",
    })
    assert response.status_code == 202, response.text
    job = response.json()["job"]
    assert job["executionPolicy"] == "engine_only"
    assert job["processingMode"] == "smart"
    assert job["burnSubtitles"] and job["hookTextEnabled"] and job["youtubeMetadataEnabled"]
    assert saved["private"]["execution_policy"] == "engine_only"
    assert saved["private"]["use_openrouter"] is False
    assert saved["private"]["provider_available"] is False


def cluster(tmp_path, *, public_policy="engine_only", private_policy="auto"):
    runtime = replace(app_module.settings, data_path=tmp_path)
    db = Database(tmp_path / "test.sqlite3")
    profiles = ProfileService(db, SecretVault(tmp_path / "secrets" / "key"))
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), profiles, runtime)
    project = Project(id="p", name="Local speech", mode="clip", style="educational",
                      state="active", source_name="speech.mp4", source_kind="upload", requested_count=1)
    job = Job(id="j", project_id="p", mode="clip", style="educational", execution_policy=public_policy,
              state="active", stage="planning", stage_label="Planning", progress=30,
              hook_text_enabled=True, youtube_metadata_enabled=True,
              clips=[Clip(id="c", index=1, state="queued", start=0, end=12, duration=12,
                          opening_line="We can grow vegetables in a small garden.")],
              steps=manager._smart_steps(True, include_hook_text=True))
    private = {"execution_policy": private_policy, "use_openrouter": True, "provider_available": True,
               "count": 1, "min_duration": 8, "max_duration": 12, "transcript": {"language": "en"},
               "hook_text": {"enabled": True, "status": "pending"}}
    db.save_project(project)
    db.save_job(job, private)
    return db, manager, job, private


@pytest.mark.parametrize(("public_policy", "private_policy"), [("engine_only", "auto"), ("auto", "engine_only")])
def test_either_persisted_policy_vetoes_every_worker_provider_call(monkeypatch, tmp_path, public_policy, private_policy):
    db, manager, job, private = cluster(tmp_path, public_policy=public_policy, private_policy=private_policy)
    calls = []

    async def forbidden(*args, **kwargs):
        calls.append("provider")
        raise AssertionError("Engine only must make zero provider requests")

    monkeypatch.setattr(manager.profiles, "openrouter_json", forbidden)
    monkeypatch.setattr(manager.profiles, "openrouter_models", forbidden)
    candidate = object()
    monkeypatch.setattr("engine.jobs.select_candidates", lambda *args, **kwargs: [candidate])
    # Reload both snapshots to exercise the same policy after restart.
    job, private = db.get_job("j"), db.get_job_private("j")
    words = [{"text": "We can grow vegetables in a small garden.", "start": 1, "end": 5}]
    assert manager._plan_smart_candidates(job, private, words) == [candidate]
    manager._generate_hook_text(job, private, words)
    manager._generate_youtube_metadata(job, private, words)
    assert calls == []
    reloaded = db.get_job("j")
    assert reloaded.clips[0].hook_text == words[0]["text"]
    assert reloaded.clips[0].youtube_description == words[0]["text"]
    assert reloaded.clips[0].youtube_metadata_status == "fallback"


def test_partial_api_hooks_preserve_valid_result_and_count_only_local_replacements(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path, public_policy="auto", private_policy="auto")
    job.clips.append(Clip(id="c2", index=2, state="queued", start=12, end=24, duration=12,
                          opening_line="Water the plants each morning."))
    async def partial(*args, **kwargs):
        return {"hooks": [{"index": 1, "text": "A small garden can feed a family."}]}

    monkeypatch.setattr(manager.profiles, "openrouter_json", partial)
    words = [{"text": "We can grow vegetables in a small garden.", "start": 1, "end": 5},
             {"text": "Water the plants each morning.", "start": 13, "end": 17}]
    manager._generate_hook_text(job, private, words)
    assert job.clips[0].hook_text == "A small garden can feed a family."
    assert job.clips[1].hook_text == "Water the plants each morning."
    assert private["hook_text"]["local_fallback_count"] == 1
    assert all("rendered without hook text" not in warning for warning in job.warnings)


def test_interrupted_hook_generation_recovers_locally_without_replaying_paid_request(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path, public_policy="auto", private_policy="auto")
    private["hook_text"]["status"] = "generating"
    calls = []
    async def forbidden(*args, **kwargs):
        calls.append("provider")
        return None
    monkeypatch.setattr(manager.profiles, "openrouter_json", forbidden)
    manager._generate_hook_text(job, private, [{"text": "We can grow vegetables in a small garden.", "start": 1, "end": 5}])
    assert calls == []
    assert job.clips[0].hook_text
    assert private["hook_text"]["status"] == "complete"


@pytest.mark.parametrize("text", ["", "short", "Visit https://example.com for the full story"])
def test_local_hook_does_not_invent_text_for_missing_or_unsuitable_context(text):
    assert local_hook_text(text) is None

def test_local_only_music_narration_planning_never_calls_provider(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path, public_policy="auto", private_policy="auto")
    calls = []

    async def forbidden(*args, **kwargs):
        calls.append("provider")
        raise AssertionError("narration planning must stay local")

    candidate = object()
    monkeypatch.setattr(manager.profiles, "openrouter_json", forbidden)
    monkeypatch.setattr("engine.jobs.select_candidates", lambda *args, **kwargs: [candidate])
    result = manager._plan_smart_candidates(job, private, [{"text": "a complete spoken sentence", "start": 1, "end": 6}], local_only=True)
    assert result == [candidate]
    assert calls == []
    assert next(step for step in job.steps if step.id == "local_planning").status == "complete"


def test_keep_voice_planning_uses_strict_narration_selection(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    private.update({"count": 2, "min_duration": 8, "max_duration": 12})
    candidate = object()
    requested = []

    def candidates(_words, _style, count, *_bounds, strict_bounds=False):
        requested.append((count, strict_bounds))
        return [candidate]

    monkeypatch.setattr("engine.jobs.select_candidates", candidates)
    result = manager._plan_smart_candidates(job, private, [], local_only=True)

    assert requested == [(2, True)]
    assert result == [candidate]
