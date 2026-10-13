from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from engine.app import settings as app_settings
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Clip, Job, OpenRouterModel, Project
from engine.providers import ProfileService
from engine.security import SecretVault


def _runtime(tmp_path: Path):
    runtime: Settings = replace(app_settings, data_path=tmp_path)
    db = Database(tmp_path / "metadata.sqlite3")
    profiles = ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key"))
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), profiles, runtime)
    clips = [
        Clip(id=f"00000000-0000-4000-8000-{index:012d}", index=index, state="queued", start=(index - 1) * 20, end=index * 20,
             duration=20, opening_line=f"opening {index}")
        for index in range(1, 9)
    ]
    project = Project(id="project-metadata", name="Grounded science", mode="clip", style="educational",
                      state="active", source_name="science.mp4", source_kind="upload", requested_count=len(clips))
    job = Job(id="job-metadata", project_id=project.id, mode="clip", state="active", stage="planning",
              stage_label="Planning", progress=40, style="educational", processing_mode="smart",
              content_format="short", youtube_metadata_enabled=True,
              youtube_metadata_model_id="google/gemini-2.5-flash-lite", clips=clips)
    db.save_project(project)
    private = {"source_title": "A secondary source title", "transcription_language": "en",
               "transcript": {"language": "en"}, "youtube_metadata": {"enabled": True}}
    db.save_job(job, private)
    return db, manager, job, private


@pytest.mark.parametrize("bad_items", [
    lambda ids: [{"clip_id": ids[0], "title": "A grounded title", "description": "A grounded description."},
                 {"clip_id": ids[0], "title": "A repeated id", "description": "A repeated item."}],
    lambda ids: [{"clip_id": "unknown", "title": "A grounded title", "description": "A grounded description."}],
    lambda ids: [{"clip_id": ids[0], "title": "A grounded title", "description": "A grounded description."}],
    lambda ids: [{"clip_id": ids[0], "title": "Same title", "description": "A grounded description."},
                 {"clip_id": ids[1], "title": "same title", "description": "Another grounded description."}],
])
def test_auto_generation_requires_exact_distinct_ids_and_preserves_fallback(monkeypatch, tmp_path, bad_items):
    db, manager, job, private = _runtime(tmp_path)
    batch = job.clips[:2]
    job.clips = batch
    db.save_job(job, private)
    monkeypatch.setattr(manager.profiles, "openrouter_models", lambda: _resolved([
        OpenRouterModel(id="google/gemini-2.5-flash-lite", name="Gemini Flash Lite", context_length=4096,
                       pricing={"prompt": "0.0000001", "completion": "0.0000004"},
                       supported_parameters=["response_format"])
    ]))
    monkeypatch.setattr(manager.profiles, "openrouter_json", lambda *args, **kwargs: _resolved((
        {"clips": bad_items([clip.id for clip in batch])}, {"prompt_tokens": 50, "completion_tokens": 50}
    )))
    words = [{"text": "A transcript sentence describing the exact clip content.", "start": clip.start + 1, "end": clip.start + 3} for clip in batch]
    words.append({"text": "out of bounds", "start": 200, "end": 201})
    manager._generate_youtube_metadata(job, private, words)
    assert all(clip.youtube_metadata_status == "fallback" for clip in job.clips)
    assert all("out of bounds" not in (clip.youtube_description or "") for clip in job.clips)
    assert all(clip.title is None for clip in job.clips)  # deterministic publication title remains available
    assert any("YouTube metadata unavailable" in warning for warning in job.warnings)
    assert db.get_job(job.id).clips[0].youtube_metadata_status == "fallback"


def test_auto_generation_batches_stable_ids_persists_and_reuses_successes(monkeypatch, tmp_path):
    db, manager, job, private = _runtime(tmp_path)
    request_batches = []
    monkeypatch.setattr(manager.profiles, "openrouter_models", lambda: _resolved([
        OpenRouterModel(id="google/gemini-2.5-flash-lite", name="Gemini Flash Lite", context_length=4096,
                       pricing={"prompt": "0.0000001", "completion": "0.0000004"},
                       supported_parameters=["response_format"])
    ]))

    async def generate(messages, schema, **kwargs):
        request = json.loads(messages[1]["content"])
        request_batches.append((request, schema, kwargs))
        return ({"clips": [{"clip_id": item["clip_id"], "title": f"Clip {item['clip_id']} explains the science", "description": (f"A concise transcript-grounded explanation of {item['clip_id']} and its specific science topic, including the concrete context and supporting detail from the timed excerpt.").ljust(240, ".")} for item in request["clips"]]}, {"prompt_tokens": 200, "completion_tokens": 120, "cost": 0.00002})

    monkeypatch.setattr(manager.profiles, "openrouter_json", generate)
    words = []
    for index, clip in enumerate(job.clips, 1):
        words.append({"text": f"Clip {index} transcript explains a specific science topic accurately.", "start": clip.start + 1, "end": clip.start + 4})
    manager._generate_youtube_metadata(job, private, words)
    assert [len(batch[0]["clips"]) for batch in request_batches] == [2, 2, 2, 2]
    assert all(batch[2]["max_tokens"] == 400 for batch in request_batches)
    assert all(batch[2]["provider"]["max_price"] == {"prompt": 0.10, "completion": 0.40} for batch in request_batches)
    assert all(batch[2]["reasoning"] == {"enabled": False} for batch in request_batches)
    assert all(batch[2]["temperature"] <= 0.2 for batch in request_batches)
    assert all(120 <= len(clip.youtube_description or "") <= 300 for clip in job.clips)
    assert all(clip.youtube_metadata_status == "generated" for clip in job.clips)
    assert all(clip.youtube_metadata_revision == 1 for clip in job.clips)
    assert all(clip.youtube_metadata_cost_kind == "actual" for clip in job.clips)
    assert db.get_job(job.id).clips[3].title == job.clips[3].title
    assert private["youtube_metadata_generation_calls"] == 4
    manager._generate_youtube_metadata(job, private, words)
    assert len(request_batches) == 4
    assert private["youtube_metadata_generation_calls"] == 4


def test_auto_generation_skips_when_budget_is_exhausted_and_requires_priced_supported_model(monkeypatch, tmp_path):
    db, manager, job, private = _runtime(tmp_path)
    private["youtube_metadata_spend_estimate_usd"] = 0.05
    db.save_job(job, private)
    called = False

    async def should_not_call(*_args, **_kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(manager.profiles, "openrouter_models", lambda: _resolved([
        OpenRouterModel(id="google/gemini-2.5-flash-lite", name="Gemini Flash Lite", context_length=4096,
                       pricing={"prompt": "0.0000001", "completion": "0.0000004"},
                       supported_parameters=["response_format"])
    ]))
    monkeypatch.setattr(manager.profiles, "openrouter_json", should_not_call)
    words = [{"text": "A transcript sentence describing this specific clip content.", "start": clip.start + 1, "end": clip.start + 4} for clip in job.clips]
    manager._generate_youtube_metadata(job, private, words)
    assert not called
    assert all(clip.youtube_metadata_status == "fallback" for clip in job.clips)
    assert all("budget" in (clip.youtube_metadata_reason or "").lower() for clip in job.clips)
    assert private["youtube_metadata_generation_calls"] == 0


def _resolved(value):
    async def result():
        return value
    return result()
