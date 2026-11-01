from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

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
from engine import selection


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


def _keep_voice_job(job, private, *, count, completed):
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    private.update({"count": count, "min_duration": 20.0, "max_duration": 120.0, "effective_target": count})
    job.clips = completed


def test_keep_voice_retry_repairs_invalid_saved_plan_without_completed_outputs(tmp_path):
    db, manager, job, private = cluster(tmp_path)
    completed = []
    _keep_voice_job(job, private, count=5, completed=completed)
    job.clips = [
        Clip(id="c1", index=1, state="queued", start=41.02, end=83.44, duration=42.42, opening_line="A"),
        Clip(id="c2", index=2, state="queued", start=68.70, end=125.26, duration=56.56, opening_line="B"),
    ]
    words = [{"text": "plain narration", "start": 0.0, "end": 5.0, "confidence": 0.9}]

    manager._repair_saved_music_plan(job, private, words, 621.32)
    db.save_job(job, private)

    assert job.clips == []
    assert job.total_items == 0
    assert job.planned_count == 0
    assert any("regenerated from the cached transcript" in warning for warning in job.warnings)
    saved_job = db.get_job("j")
    assert saved_job.clips == []


def test_keep_voice_retry_regenerates_only_invalid_clips_and_avoids_completed_windows(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    completed = [Clip(id="c-done", index=1, state="complete", start=0.0, end=30.0, duration=30.0, opening_line="kept", output_name="01-final.mp4")]
    _keep_voice_job(job, private, count=2, completed=completed)
    invalid = Clip(id="c-bad", index=2, state="queued", start=20.0, end=50.0, duration=30.0, opening_line="overlaps the completed clip")
    job.clips = completed + [invalid]
    words = [{"text": "plain narration", "start": 0.0, "end": 5.0, "confidence": 0.9}]

    def candidate(_words, _style, count, *_bounds, strict_bounds=False, reserved_windows=()):
        assert strict_bounds
        assert reserved_windows == ((0.0, 30.0),)
        return [selection.Candidate(60.0, 90.0, words, SimpleNamespace(total=10.0))]

    monkeypatch.setattr("engine.jobs.select_candidates", candidate)
    monkeypatch.setattr("engine.jobs.visual_concept", lambda _excerpt: "illustration")

    def fake_candidate_clip(_candidate, index):
        return Clip(id=f"rebuilt-{index}", index=index, state="queued", start=60.0, end=90.0, duration=30.0, opening_line="regenerated")

    monkeypatch.setattr("engine.jobs.clip_from_candidate", fake_candidate_clip)
    manager._repair_saved_music_plan(job, private, words, 621.32)

    assert [item for item in job.clips if item.state == "complete"] == completed
    rebuilt = [item for item in job.clips if item.state == "queued"]
    assert len(rebuilt) == 1
    assert rebuilt[0].id != invalid.id
    assert (rebuilt[0].start, rebuilt[0].end) == (60.0, 90.0)
    assert rebuilt[0].index == 2
    assert rebuilt[0].music_track == job.music_track
    assert rebuilt[0].music_audio_mode == job.music_audio_mode
    assert job.total_items == 2 and job.planned_count == 2
    assert any("regenerated from the cached transcript; completed outputs were kept" in warning for warning in job.warnings)


def test_keep_voice_partial_plan_that_cannot_regenerate_keeps_completed_outputs(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    completed = [Clip(id="c-done", index=1, state="complete", start=0.0, end=30.0, duration=30.0, opening_line="kept", output_name="01-final.mp4")]
    _keep_voice_job(job, private, count=2, completed=completed)
    invalid = Clip(id="c-bad", index=2, state="queued", start=20.0, end=50.0, duration=30.0, opening_line="overlaps")
    job.clips = completed + [invalid]
    words = [{"text": "plain narration", "start": 0.0, "end": 5.0, "confidence": 0.9}]

    monkeypatch.setattr("engine.jobs.select_candidates", lambda *_args, **_kwargs: [])
    with pytest.raises(Exception) as raised:
        manager._repair_saved_music_plan(job, private, words, 621.32)
    assert "completed output" in str(raised.value)
    assert job.clips == completed + [invalid]
    assert completed[0].output_name == "01-final.mp4"


def test_keep_voice_retry_keeps_valid_completed_and_queued_windows(tmp_path):
    _, manager, job, private = cluster(tmp_path)
    completed = [Clip(id="c-done", index=1, state="complete", start=0.0, end=30.0, duration=30.0, opening_line="kept", output_name="01-final.mp4")]
    _keep_voice_job(job, private, count=2, completed=completed)
    valid_queued = Clip(id="c-q", index=2, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="fine")
    job.clips = completed + [valid_queued]
    words = [{"text": "plain narration", "start": 0.0, "end": 5.0, "confidence": 0.9}]

    manager._repair_saved_music_plan(job, private, words, 621.32)

    assert job.clips == completed + [valid_queued]


@pytest.mark.parametrize("mode", [MusicAudioMode.SONG_ONLY, MusicAudioMode.MIX_ORIGINAL])
def test_legacy_music_modes_keep_ordinary_planning(monkeypatch, tmp_path, mode):
    _, manager, job, private = cluster(tmp_path)
    job.source_profile = "music"
    job.music_audio_mode = mode
    private.update({"count": 2, "min_duration": 8, "max_duration": 12})
    requested = []

    def candidates(_words, _style, count, *_bounds, strict_bounds=False):
        requested.append((count, strict_bounds))
        return []

    monkeypatch.setattr("engine.jobs.select_candidates", candidates)
    manager._plan_smart_candidates(job, private, [], local_only=True)

    assert requested == [(6, False)]


def test_keep_voice_retry_preserves_cached_transcript_and_complete_publication(monkeypatch, tmp_path):
    db, manager, job, private = cluster(tmp_path)
    completed = Clip(
        id="c-done", index=1, state="complete", start=0.0, end=30.0,
        duration=30.0, opening_line="kept", output_name="01-final.mp4",
        library_asset_id="asset-1", blob_id="blob-1",
    )
    _keep_voice_job(job, private, count=2, completed=[completed])
    invalid = Clip(id="c-bad", index=2, state="queued", start=20.0, end=50.0, duration=30.0, opening_line="overlap")
    job.clips = [completed, invalid]
    cached_transcript = {"language": "en", "words": [{"text": "cached"}], "diagnostics": {"invalid_timing_count": 1}}
    private["transcript"] = cached_transcript
    private["music_voice_stem"] = {"stem_hash": "stem-id"}
    words = [{"text": "plain narration", "start": 0.0, "end": 5.0}]

    def candidate(_words, _style, count, *_bounds, strict_bounds=False, reserved_windows=()):
        assert strict_bounds
        assert reserved_windows == ((0.0, 30.0),)
        return [selection.Candidate(60.0, 90.0, words, SimpleNamespace(total=10.0))]

    monkeypatch.setattr("engine.jobs.select_candidates", candidate)
    monkeypatch.setattr("engine.jobs.visual_concept", lambda _excerpt: "illustration")
    monkeypatch.setattr("engine.jobs.clip_from_candidate", lambda _candidate, index: Clip(
        id=f"rebuilt-{index}", index=index, state="queued", start=60.0, end=90.0,
        duration=30.0, opening_line="regenerated",
    ))

    manager._repair_saved_music_plan(job, private, words, 621.32)
    db.save_job(job, private)
    saved = db.get_job("j")
    saved_private = db.get_job_private("j")

    assert saved is not None
    saved_done = next(item for item in saved.clips if item.state == "complete")
    assert (saved_done.id, saved_done.output_name, saved_done.library_asset_id, saved_done.blob_id) == (
        "c-done", "01-final.mp4", "asset-1", "blob-1",
    )
    assert saved_private["transcript"] == cached_transcript
    assert saved_private["music_voice_stem"] == {"stem_hash": "stem-id"}


@pytest.mark.parametrize("bad_window", [(float("nan"), 90.0), (60.0, float("inf"))])
def test_keep_voice_repair_discards_nonfinite_unpublished_windows(monkeypatch, tmp_path, bad_window):
    _, manager, job, private = cluster(tmp_path)
    _keep_voice_job(job, private, count=1, completed=[])
    start, end = bad_window
    clip = Clip(id="bad", index=1, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="bad")
    object.__setattr__(clip, "start", start)
    object.__setattr__(clip, "end", end)
    job.clips = [clip]

    monkeypatch.setattr("engine.jobs.select_candidates", lambda *_args, **_kwargs: [])

    manager._repair_saved_music_plan(job, private, [], 621.32)

    assert job.clips == []
    assert job.total_items == 0


@pytest.mark.parametrize("bad_window", [(float("nan"), 90.0), (60.0, float("inf"))])
def test_keep_voice_boundary_validation_fails_nonfinite_saved_windows(monkeypatch, tmp_path, bad_window):
    _, manager, job, private = cluster(tmp_path)
    _keep_voice_job(job, private, count=1, completed=[])
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    start, end = bad_window
    clip = Clip(id="bad", index=1, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="bad")
    object.__setattr__(clip, "start", start)
    object.__setattr__(clip, "end", end)
    object.__setattr__(job, "clips", [clip])
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(manager, "_save", lambda *_args, **_kwargs: None)
    try:
        with pytest.raises(Exception, match="non-finite saved boundary"):
            manager._verify_music_boundaries(job, private, 621.32)
    finally:
        monkeypatch.undo()

    boundary = next(step for step in job.steps if step.id == "boundaries")
    assert boundary.status == "failed"
    assert next(step for step in job.steps if step.id == "render").status == "pending"


def test_keep_voice_recovery_reopens_boundary_validation_step(tmp_path):
    _, manager, job, private = cluster(tmp_path)
    _keep_voice_job(job, private, count=1, completed=[])
    job.state = "recovered"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    job.clips = [Clip(id="q", index=1, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="saved")]
    for step_id in ("boundaries", "render", "verify", "ready"):
        step = next(item for item in job.steps if item.id == step_id)
        step.status = "complete"
        step.completed_at = step.started_at = job.updated_at

    manager._reconcile_steps(job, private)

    assert next(step for step in job.steps if step.id == "boundaries").status == "pending"
    assert next(step for step in job.steps if step.id == "render").status == "pending"


def test_keep_voice_cached_transcript_and_stem_resume_without_retranscription(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    source = tmp_path / "cached-source.mp4"
    from engine.voice_separation import MODEL_ID, SEPARATION_SETTINGS_ID

    stem = tmp_path / "jobs" / "j" / "transcription" / f"voice-source-hash-{SEPARATION_SETTINGS_ID[:12]}.wav"
    source.write_bytes(b"source")
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(b"stem")
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.clips = []
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    private.update({
        "source_path": str(source), "source_hash": "source-hash",
        "source_metadata": {"duration": 60.0, "audio": True, "width": 1080, "height": 1920},
        "count": 1, "effective_target": 1, "min_duration": 8.0, "max_duration": 20.0,
        "transcript_cache_key": "cached-key",
        "transcript": {"language": "en", "words": [{"text": "cached", "start": 1.0, "end": 2.0}], "diagnostics": {}},
        "music_voice_stem": {
            "path": str(stem), "source_hash": "source-hash", "model_identity": MODEL_ID,
            "settings_identity": SEPARATION_SETTINGS_ID, "stem_hash": "stem-hash",
        },
    })
    monkeypatch.setattr(manager, "_source", lambda *_args: source)
    monkeypatch.setattr(manager, "_music_track_source", lambda *_args: None)
    stem_calls = []
    monkeypatch.setattr("engine.jobs.sha256_file", lambda _path: "stem-hash")
    monkeypatch.setattr("engine.voice_separation.validate_voice_stem", lambda *_args: True)
    monkeypatch.setattr("engine.voice_separation.separate_voice", lambda *_args, **_kwargs: stem_calls.append("separated"))
    monkeypatch.setattr("engine.jobs.transcription_cache_key", lambda *_args, **_kwargs: "cached-key")
    monkeypatch.setattr("engine.media.extract_audio_16k", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("audio must reuse cache")))
    monkeypatch.setattr(manager, "_transcribe_with_stages", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transcript must reuse cache")))

    class PlanningReached(Exception):
        pass

    def stop_after_cache(_job, _private, words, **_kwargs):
        assert words[0]["text"] == "cached"
        assert _private["transcript"]["words"][0]["text"] == "cached"
        raise PlanningReached

    monkeypatch.setattr(manager, "_plan_smart_candidates", stop_after_cache)
    monkeypatch.setattr(manager, "_resolve_batch_target", lambda *_args: 1)

    with pytest.raises(PlanningReached):
        manager._process_clip_smart(job, private)

    assert stem_calls == []
    assert private["transcript_cache_key"] == "cached-key"


def test_keep_voice_boundary_validation_completes_active_step_for_valid_saved_plan(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    _keep_voice_job(job, private, count=1, completed=[])
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    job.clips = [Clip(id="q", index=1, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="saved")]
    monkeypatch.setattr(manager, "_save", lambda *_args, **_kwargs: None)

    manager._verify_music_boundaries(job, private, 621.32)

    assert next(step for step in job.steps if step.id == "boundaries").status == "complete"


def test_keep_voice_repair_refuses_nonfinite_completed_window_without_changing_output(tmp_path):
    _, manager, job, private = cluster(tmp_path)
    completed = Clip(id="done", index=1, state="complete", start=40.0, end=70.0, duration=30.0, opening_line="published", output_name="final.mp4")
    object.__setattr__(completed, "start", float("nan"))
    _keep_voice_job(job, private, count=1, completed=[completed])

    with pytest.raises(Exception, match="non-finite saved boundary"):
        manager._repair_saved_music_plan(job, private, [], 621.32)

    assert job.clips[0] is completed
    assert completed.output_name == "final.mp4"


def test_keep_voice_retry_failed_reopens_boundary_step(monkeypatch, tmp_path):
    db, manager, job, private = cluster(tmp_path)
    _keep_voice_job(job, private, count=1, completed=[])
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.state = "partial"
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    job.clips = [Clip(id="failed", index=1, state="failed", start=40.0, end=70.0, duration=30.0, opening_line="retry")]
    boundary = next(step for step in job.steps if step.id == "boundaries")
    boundary.status = "complete"
    boundary.started_at = boundary.completed_at = job.updated_at
    db.save_job(job, private)

    async def no_enqueue(_job_id):
        return None

    monkeypatch.setattr(manager, "enqueue", no_enqueue)
    import asyncio
    retried = asyncio.run(manager.control(job.id, "retry-failed"))

    assert next(step for step in retried.steps if step.id == "boundaries").status == "pending"
    assert next(step for step in retried.steps if step.id == "render").status == "pending"
    assert retried.clips[0].state == "queued"


def test_keep_voice_duplicate_completed_windows_raise_and_preserve_publications(tmp_path):
    _, manager, job, private = cluster(tmp_path)
    first = Clip(
        id="done-1", index=1, state="complete", start=40.0, end=70.0,
        duration=30.0, opening_line="published one", output_name="01.mp4",
        library_asset_id="asset-1", blob_id="blob-1",
    )
    second = Clip(
        id="done-2", index=2, state="complete", start=40.0, end=70.0,
        duration=30.0, opening_line="published two", output_name="02.mp4",
        library_asset_id="asset-2", blob_id="blob-2",
    )
    _keep_voice_job(job, private, count=2, completed=[first, second])

    with pytest.raises(Exception, match="repeat the same narration window"):
        manager._repair_saved_music_plan(job, private, [], 621.32)

    assert job.clips == [first, second]
    assert [(clip.output_name, clip.library_asset_id, clip.blob_id) for clip in job.clips] == [
        ("01.mp4", "asset-1", "blob-1"), ("02.mp4", "asset-2", "blob-2"),
    ]


def test_legacy_song_only_boundary_validation_allows_identical_windows(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.SONG_ONLY
    private.update({"min_duration": 20.0, "max_duration": 120.0})
    job.steps = manager._smart_steps(False, "music")
    window = (Clip(id="a", index=1, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="same"),
              Clip(id="b", index=2, state="queued", start=40.0, end=70.0, duration=30.0, opening_line="same"))
    job.clips = list(window)
    monkeypatch.setattr(manager, "_save", lambda *_args, **_kwargs: None)

    manager._verify_music_boundaries(job, private, 621.32, allow_identical=True)

    assert next(step for step in job.steps if step.id == "boundaries").status == "complete"


def test_keep_voice_high_volume_shortfall_does_not_spread_or_repeat_windows(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    source = tmp_path / "cached-source.mp4"
    stem = tmp_path / "cached-stem.wav"
    source.write_bytes(b"source")
    stem.write_bytes(b"stem")
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.batch_mode = "high_volume"
    job.clips = []
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    private.update({
        "source_path": str(source), "source_hash": "source-hash",
        "source_metadata": {"duration": 60.0, "audio": True, "width": 1080, "height": 1920},
        "count": 5, "effective_target": 5, "batch_mode": "high_volume",
        "min_duration": 8.0, "max_duration": 20.0, "transcript_cache_key": "cached-key",
        "transcript": {"language": "en", "words": [{"text": "cached", "start": 1.0, "end": 2.0}], "diagnostics": {}},
        "music_voice_stem": {"source_hash": "source-hash", "model_identity": "model", "stem_hash": "stem-hash"},
    })
    monkeypatch.setattr(manager, "_source", lambda *_args: source)
    monkeypatch.setattr(manager, "_music_track_source", lambda *_args: None)
    monkeypatch.setattr(manager, "_music_voice_stem", lambda *_args: stem)
    monkeypatch.setattr("engine.jobs.transcription_cache_key", lambda *_args, **_kwargs: "cached-key")
    monkeypatch.setattr(manager, "_resolve_batch_target", lambda *_args: 5)
    words = [{"text": "spoken words.", "start": 10.0, "end": 19.0}]
    candidates = [
        selection.Candidate(10.0, 19.0, words, SimpleNamespace(total=10.0)),
        selection.Candidate(30.0, 39.0, words, SimpleNamespace(total=9.0)),
    ]
    monkeypatch.setattr(manager, "_plan_smart_candidates", lambda *_args, **_kwargs: candidates)
    monkeypatch.setattr("engine.jobs.clip_from_candidate", lambda candidate, index: Clip(
        id=f"clip-{index}", index=index, state="queued", start=candidate.start, end=candidate.end,
        duration=candidate.end - candidate.start, opening_line="shortfall",
    ))
    monkeypatch.setattr("engine.jobs.visual_concept", lambda _text: "illustration")
    spread_calls = []
    monkeypatch.setattr("engine.jobs._spread_temporal_items", lambda items, count: spread_calls.append(count) or items)
    class PlanningComplete(Exception):
        pass
    monkeypatch.setattr(manager, "_generate_youtube_metadata", lambda *_args: (_ for _ in ()).throw(PlanningComplete()))

    with pytest.raises(PlanningComplete):
        manager._process_clip_smart(job, private)

    assert spread_calls == []
    assert len(job.clips) == 2
    assert len({(clip.start, clip.end) for clip in job.clips}) == 2
    assert any("Found 2 valid non-overlapping narration windows instead of 5" in warning for warning in job.warnings)


def test_keep_voice_high_volume_empty_strict_plan_fails_actionably(monkeypatch, tmp_path):
    _, manager, job, private = cluster(tmp_path)
    source = tmp_path / "high-volume-empty-source.mp4"
    stem = tmp_path / "high-volume-empty-stem.wav"
    source.write_bytes(b"source")
    stem.write_bytes(b"stem")
    job.source_profile = "music"
    job.music_audio_mode = MusicAudioMode.REPLACE_MUSIC_KEEP_VOICE
    job.batch_mode = "high_volume"
    job.clips = []
    job.steps = manager._smart_steps(False, "music", preserve_voice=True)
    private.update({
        "source_path": str(source), "source_hash": "source-hash",
        "source_metadata": {"duration": 60.0, "audio": True, "width": 1080, "height": 1920},
        "count": 5, "effective_target": 5, "batch_mode": "high_volume",
        "min_duration": 8.0, "max_duration": 20.0, "transcript_cache_key": "cached-key",
        "transcript": {"language": "en", "words": [{"text": "short", "start": 1.0, "end": 2.0}], "diagnostics": {}},
        "music_voice_stem": {"source_hash": "source-hash", "model_identity": "model", "stem_hash": "stem-hash"},
    })
    monkeypatch.setattr(manager, "_source", lambda *_args: source)
    monkeypatch.setattr(manager, "_music_track_source", lambda *_args: None)
    monkeypatch.setattr(manager, "_music_voice_stem", lambda *_args: stem)
    monkeypatch.setattr("engine.jobs.transcription_cache_key", lambda *_args, **_kwargs: "cached-key")
    monkeypatch.setattr(manager, "_resolve_batch_target", lambda *_args: 5)
    monkeypatch.setattr(manager, "_plan_smart_candidates", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(manager, "_generate_youtube_metadata", lambda *_args: (_ for _ in ()).throw(AssertionError("empty narration must fail before metadata or rendering")))

    with pytest.raises(Exception, match="Isolated narration did not contain enough timed speech"):
        manager._process_clip_smart(job, private)

    assert job.clips == []
