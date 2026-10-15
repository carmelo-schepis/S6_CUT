from __future__ import annotations

import asyncio
import json
import tempfile
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from engine import app as app_module
from engine import media as media_module
from engine.app import settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import Asset, Clip, Job, OpenRouterModel, ProfileInput, Project
from engine.providers import ProfileService
from engine.security import SecretVault
from engine.seo_titles import (
    clip_title_replaceable, fallback_clip_title, legacy_title_is_auto, normalize_seo_title,
    opening_phrase, project_name_is_auto, source_context_title,
)
from engine.title_backfill import TitleApplyRequest, TitleBackfill, TitleSuggestionRequest

client = TestClient(app_module.app)
MODEL = OpenRouterModel(
    id="google/gemini-2.5-flash-lite", name="Gemini Flash Lite", context_length=1_000_000,
    pricing={"prompt": "0.0000001", "completion": "0.0000004"}, supported_parameters=["response_format"],
)


async def _resolved(value):
    return value


def _clip(index: int, opening: str = "a useful opening", **extra: Any) -> Clip:
    return Clip(id=f"clip-{index}-{uuid.uuid4().hex[:6]}", index=index, state="queued", start=0, end=10, duration=10, opening_line=opening, **extra)


# ---------------------------------------------------------------------------
# Rule-based titles
# ---------------------------------------------------------------------------

def test_fallback_title_drops_placeholder_and_cut_number():
    title = fallback_clip_title(_clip(5, "Next restaurant. We may have got lucky at hungry jacks, but stick around for more"), "I Tried Australia's LEAST Ordered Fast Food Items")
    assert "YouTube import" not in title
    assert "Cut" not in title
    assert len(title) <= 70
    assert title.startswith("Next restaurant")
    assert " – " in title


def test_fallback_title_strips_filler_and_capitalises():
    assert opening_phrase("so, um, all right guys we made it to Grill'd") == "Guys we made it to Grill'd"
    assert opening_phrase("okay.") == ""


def test_fallback_title_without_phrase_uses_source_and_clip_number():
    assert fallback_clip_title(_clip(3, ""), "Why People Paid to Rewatch Endgame") == "Why People Paid to Rewatch Endgame – Clip 3"
    assert fallback_clip_title(_clip(2, ""), "") == "Clip 2"
    assert fallback_clip_title(_clip(2, "uh"), "YouTube import") == "Clip 2"


def test_fallback_title_is_bounded_for_long_and_unicode_text():
    title = fallback_clip_title(_clip(1, "word " * 80), "A " * 120)
    assert len(title) <= 70
    unicode_title = fallback_clip_title(_clip(1, "自然科学の短い要約です。とても面白い内容が続きます"), "科学チャンネル")
    assert unicode_title.startswith("自然科学")
    assert len(unicode_title) <= 70


def test_fallback_titles_are_unique_within_a_job():
    used: set[str] = set()
    first = fallback_clip_title(_clip(1, "Same opening line"), "Source", used)
    second = fallback_clip_title(_clip(2, "Same opening line"), "Source", used)
    third = fallback_clip_title(_clip(3, "Same opening line"), "Source", used)
    assert first == "Same opening line – Source"
    assert second == "Same opening line – Source (2)"
    assert third == "Same opening line – Source (3)"


def test_source_context_never_returns_the_placeholder():
    youtube = Project(id="p", name="YouTube import", mode="clip", style="funny", state="complete", source_name="YouTube import", source_kind="youtube", requested_count=1)
    assert source_context_title(youtube, {}) == ""
    assert source_context_title(youtube, {"youtube_title": "YouTube source"}) == ""
    assert source_context_title(youtube, {"youtube_title": "Real Video Title"}) == "Real Video Title"
    youtube.source_title = "Stored Title"
    assert source_context_title(youtube, {"youtube_title": "Other"}) == "Stored Title"
    upload = Project(id="u", name="clip", mode="clip", style="funny", state="complete", source_name="youtube-video-3-.mp4", source_kind="upload", requested_count=1)
    assert source_context_title(upload, {}) == ""
    upload.source_name = "Robot arm build log.mp4"
    assert source_context_title(upload, {}) == "Robot arm build log"


def test_legacy_auto_title_detection():
    assert legacy_title_is_auto("YouTube import — Next restaurant. We may · Cut 05")
    assert legacy_title_is_auto("youtube-video-3- — Cut 01")
    assert not legacy_title_is_auto("My hand-written title")
    assert not legacy_title_is_auto("Something — with a dash")


def test_replaceable_rules_protect_user_titles():
    legacy = Asset(id="a", title="YouTube import — Hi there · Cut 01", media_type="video/mp4", filename="f.mp4", content_hash="h", origin="generated-clip")
    clip = _clip(1, title="YouTube import — Hi there · Cut 01")
    assert clip_title_replaceable(legacy, clip, allow_ai=False) == (True, None)
    # Older builds edited only the asset; a mismatch means the user edited it.
    edited = legacy.model_copy(update={"title": "YouTube import — Hand edited · Cut 01"})
    assert clip_title_replaceable(edited, clip, allow_ai=False)[0] is False
    user = legacy.model_copy(update={"title": "Mine", "title_source": "user"})
    assert clip_title_replaceable(user, clip, allow_ai=True)[0] is False
    ai = legacy.model_copy(update={"title": "AI", "title_source": "ai"})
    assert clip_title_replaceable(ai, clip, allow_ai=False)[0] is False
    assert clip_title_replaceable(ai, clip, allow_ai=True)[0] is True


def test_seo_title_normalisation_rejects_hashtags_cuts_and_placeholder():
    assert normalize_seo_title('  "Hungry Jack\'s Taste Test."  ') == "Hungry Jack's Taste Test"
    assert normalize_seo_title("Great clip #shorts") is None
    assert normalize_seo_title("Best moment Cut 05") is None
    assert normalize_seo_title("YouTube import highlights") is None
    assert normalize_seo_title("x" * 101) is None


def test_project_name_is_auto_treats_legacy_placeholder_as_auto():
    legacy = Project(id="l", name="YouTube import", mode="clip", style="funny", state="complete", source_name="YouTube import", source_kind="youtube", requested_count=1)
    assert project_name_is_auto(legacy)
    assert not project_name_is_auto(legacy.model_copy(update={"name": "Typed"}))


# ---------------------------------------------------------------------------
# Pipeline: project rename + rule-based publication titles
# ---------------------------------------------------------------------------

def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    test_settings = replace(settings, data_path=tmp_path)
    test_db = Database(tmp_path / "s6-cut.sqlite3")
    profiles = ProfileService(test_db, SecretVault(tmp_path / "secrets" / "instance.key"))
    return test_db, JobManager(test_db, LibraryRules(test_db, tmp_path / "library"), profiles, test_settings)


def _fake_render(*args: Any, **kwargs: Any) -> None:
    output = args[1] if len(args) > 1 else kwargs["output"]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"rendered-" + uuid.uuid4().hex.encode())


def _youtube_fast_job(monkeypatch: pytest.MonkeyPatch, *, name: str, name_is_auto: bool) -> tuple[Database, str]:
    tmp_path = Path(tempfile.mkdtemp(prefix="s6-seo-"))
    test_db, test_manager = _cluster(tmp_path)
    source = tmp_path / "jobs" / "yt-job" / "source" / "source-video.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"youtube-video")
    source.with_suffix(".info.json").write_text(json.dumps({"title": "I Tried Australia's LEAST Ordered Fast Food Items", "channel": "Food Channel"}), encoding="utf-8")
    monkeypatch.setattr("engine.jobs.download_youtube", lambda *_args, **_kwargs: source)
    monkeypatch.setattr("engine.jobs.probe", lambda *_: {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": False, "audio_codec": None})
    monkeypatch.setattr(media_module, "plan_fast_windows", lambda *_args, **_kwargs: ([(0.0, 10.0), (12.0, 22.0)], None))
    monkeypatch.setattr(media_module, "render_fast_clip", _fake_render)
    project = Project(id="yt-project", name=name, name_is_auto=name_is_auto, mode="clip", style="educational", state="queued", source_name="YouTube import", source_kind="youtube", requested_count=2, latest_job_id="yt-job")
    job = Job(id="yt-job", project_id=project.id, mode="clip", processing_mode="fast", state="queued", stage="queued", stage_label="Queued", progress=0, style="educational")
    test_db.save_project(project)
    test_db.save_job(job, {"url": "https://www.youtube.com/watch?v=fixture", "processing_mode": "fast", "count": 2, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16"})
    test_manager._process(job.id)
    return test_db, job.id


def test_auto_named_youtube_project_takes_the_video_title(monkeypatch):
    test_db, job_id = _youtube_fast_job(monkeypatch, name="YouTube import", name_is_auto=True)
    project = test_db.get_project("yt-project")
    assert project.name == "I Tried Australia's LEAST Ordered Fast Food Items"
    job = test_db.get_job(job_id)
    assert job.state == "complete"
    titles = [clip.title for clip in job.clips]
    assert all(title and "YouTube import" not in title and "Cut" not in title and len(title) <= 70 for title in titles)
    assert len(set(titles)) == len(titles)
    assert all(clip.title_source == "auto" for clip in job.clips)
    for clip in job.clips:
        asset = test_db.get_asset(clip.library_asset_id)
        assert asset.title == clip.title and asset.title_source == "auto"
        assert asset.tags == [] and asset.triggers == [] and asset.policy == "neutral"


def test_user_typed_project_name_survives_the_video_title(monkeypatch):
    test_db, job_id = _youtube_fast_job(monkeypatch, name="My food trip", name_is_auto=False)
    project = test_db.get_project("yt-project")
    assert project.name == "My food trip"
    assert project.source_title == "I Tried Australia's LEAST Ordered Fast Food Items"
    assert all("My food trip" in clip.title for clip in test_db.get_job(job_id).clips)


def test_create_endpoint_marks_blank_names_auto(monkeypatch):
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)

    async def enqueue(job_id: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    created = client.post("/api/v1/jobs/clip", data={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "processing_mode": "fast"})
    assert created.status_code == 202, created.text
    project = created.json()["project"]
    try:
        assert project["name"] == "YouTube import"
        assert project["nameIsAuto"] is True
        assert created.json()["job"]["youtubeMetadataEnabled"] is False  # Fast never auto-enables
    finally:
        app_module.db.delete_project(project["id"])
    named = client.post("/api/v1/jobs/clip", data={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "processing_mode": "fast", "name": "Typed"})
    assert named.status_code == 202, named.text
    try:
        assert named.json()["project"]["nameIsAuto"] is False
    finally:
        app_module.db.delete_project(named.json()["project"]["id"])


# ---------------------------------------------------------------------------
# Bulk suggest → apply
# ---------------------------------------------------------------------------

def _library(tmp_path: Path):
    db, manager = _cluster(tmp_path)
    profiles = manager.profiles
    profile = profiles.save(ProfileInput(name="Titles", openrouter_key="sk-or-v1-" + "a" * 40, selected=True))
    stored, secret = db.get_profile(profile.id)
    db.save_profile(stored.model_copy(update={"text_status": "connected"}), secret)
    project = Project(id="legacy-project", name="YouTube import", mode="clip", style="funny", state="complete", source_name="YouTube import", source_kind="youtube", source_title="Why People Paid $126,274,509 to Rewatch Endgame", source_creator="Movie Channel", requested_count=3, latest_job_id="legacy-job")
    db.save_project(project)
    clips = []
    for index, (title, opening) in enumerate([
        ("YouTube import — Avengers Endgame just made 86 million dollars again · Cut 01", "Avengers Endgame just made 86 million dollars again"),
        ("YouTube import — Going to the movies is a social ritual · Cut 02", "Going to the movies is a social ritual"),
        ("My own edited title", "Your phone is the enemy of true escapism"),
    ], start=1):
        clip = Clip(id=f"legacy-clip-{index}", index=index, state="complete", start=index * 20, end=index * 20 + 15, duration=15,
                    opening_line=opening, transcript_excerpt=f"{opening}. More grounded transcript words follow here.",
                    output_name=f"{index:02d}.mp4", library_asset_id=f"legacy-asset-{index}", title=title if index < 3 else "YouTube import — Your phone · Cut 03")
        clips.append(clip)
        db.save_asset(Asset(id=f"legacy-asset-{index}", title=title, media_type="video/mp4", filename=f"{index:02d}.mp4", content_hash=f"hash-{index}",
                            origin="generated-clip", source_project_id=project.id, source_job_id="legacy-job", source_clip_id=clip.id,
                            tags=["cinema"] if index == 1 else [], triggers=["endgame"] if index == 1 else [], policy="neutral"))
    db.save_job(Job(id="legacy-job", project_id=project.id, mode="clip", state="complete", stage="complete", stage_label="Complete", progress=100, style="funny", processing_mode="smart", clips=clips), {"transcript": {"language": "en"}})
    return db, manager, TitleBackfill(db, profiles, lambda job, private: manager._save(job, private))


def _fake_provider(monkeypatch, profiles, requests: list[dict]):
    async def generate(messages, schema, **kwargs):
        payload = json.loads(messages[1]["content"])
        requests.append({"payload": payload, "kwargs": kwargs, "system": messages[0]["content"]})
        clips = [{"clip_id": item["clip_id"], "title": f"Avengers Endgame Rerelease Box Office Angle {index}", "description": "Why fans returned to cinemas for Avengers Endgame.\n#Shorts #Avengers"} for index, item in enumerate(payload["clips"], start=1)]
        return {"clips": clips}, {"prompt_tokens": 500, "completion_tokens": 200, "cost": 0.00012}

    monkeypatch.setattr(profiles, "openrouter_models", lambda *a, **k: _resolved([MODEL]))
    monkeypatch.setattr(profiles, "openrouter_json", generate)


def test_suggestions_write_nothing_and_skip_user_titles(monkeypatch):
    db, manager, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))
    requests: list[dict] = []
    _fake_provider(monkeypatch, manager.profiles, requests)
    before = {asset.id: asset.model_dump() for asset in db.list_assets(include_archived=True)}
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    assert {asset.id: asset.model_dump() for asset in db.list_assets(include_archived=True)} == before
    assert db.get_project("legacy-project").name == "YouTube import"
    kinds = sorted((item.kind, item.asset_id or item.project_id) for item in result.suggestions)
    assert kinds == [("clip", "legacy-asset-1"), ("clip", "legacy-asset-2"), ("project", "legacy-project")]
    project_row = next(item for item in result.suggestions if item.kind == "project")
    assert project_row.suggested_title == "Why People Paid $126,274,509 to Rewatch Endgame"
    assert [item.asset_id for item in result.skipped] == ["legacy-asset-3"]
    assert result.skipped[0].reason == "Title was edited by hand"
    assert result.requests == 1 and result.cost_usd == pytest.approx(0.00012) and result.cost_kind == "actual"
    sent = requests[0]["payload"]
    assert sent["clips"][0]["source_title"] == "Why People Paid $126,274,509 to Rewatch Endgame"
    assert sent["clips"][0]["channel_name"] == "Movie Channel"
    assert "My own edited title" in sent["avoid_titles"]
    assert "YouTube import" not in json.dumps(sent["clips"])
    assert "#Shorts" in requests[0]["system"]


def _explain_signature(manager: JobManager, texts: tuple[str, ...]) -> list[dict]:
    rows = [manager.rules.explain(text) for text in texts]
    return [{"score": row.score, "selected": row.selected.id if row.selected else None, "rejected": sorted(item["assetId"] for item in row.rejected)} for row in rows]


def test_apply_syncs_clip_and_asset_and_is_idempotent(monkeypatch):
    db, manager, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))
    _fake_provider(monkeypatch, manager.profiles, [])
    texts = ("endgame box office", "cinema ritual", "your phone")
    rules_before = _explain_signature(manager, texts)
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    items = []
    for row in result.suggestions:
        edited = row.asset_id == "legacy-asset-2"
        items.append({"kind": row.kind, "assetId": row.asset_id, "projectId": row.project_id, "currentTitle": row.current_title,
                      "title": "Movie Night Is a Social Ritual Worth Keeping" if edited else row.suggested_title,
                      "description": row.suggested_description, "revision": row.revision, "edited": edited})
    applied = backfill.apply(TitleApplyRequest.model_validate({"items": items}))
    assert len(applied.applied) == 3 and applied.conflicts == []
    job = db.get_job("legacy-job")
    for index in (1, 2):
        asset = db.get_asset(f"legacy-asset-{index}")
        clip = job.clips[index - 1]
        assert asset.title == clip.title
        assert asset.description == clip.youtube_description
        assert asset.title_source == clip.title_source
        assert "Cut" not in asset.title
    assert db.get_asset("legacy-asset-1").title_source == "ai"
    assert db.get_asset("legacy-asset-2").title_source == "user"
    assert db.get_asset("legacy-asset-2").title == "Movie Night Is a Social Ritual Worth Keeping"
    assert db.get_asset("legacy-asset-3").title == "My own edited title"
    one = db.get_asset("legacy-asset-1")
    assert one.tags == ["cinema"] and one.triggers == ["endgame"] and one.policy == "neutral" and one.filename == "01.mp4"
    assert db.get_project("legacy-project").name == "Why People Paid $126,274,509 to Rewatch Endgame"
    # Overlay matching is unchanged: same selection, scores and rejected set.
    # (The rejected list's display order follows updated_at, as for any edit.)
    assert _explain_signature(manager, texts) == rules_before
    # A second run offers nothing; replaying the same rows conflicts instead of writing twice.
    again = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    assert again.suggestions == []
    replay = backfill.apply(TitleApplyRequest.model_validate({"items": items}))
    assert replay.applied == [] and len(replay.conflicts) == 3


def test_stale_revision_is_a_conflict(monkeypatch):
    db, manager, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))
    _fake_provider(monkeypatch, manager.profiles, [])
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(asset_ids=["legacy-asset-1"])))
    row = next(item for item in result.suggestions if item.kind == "clip")
    db.update_generated_clip_metadata("legacy-asset-1", row.current_title, "", row.revision)  # concurrent change bumps revision
    applied = backfill.apply(TitleApplyRequest.model_validate({"items": [{"kind": "clip", "assetId": row.asset_id, "currentTitle": row.current_title, "title": row.suggested_title, "description": "", "revision": row.revision, "edited": False}]}))
    assert applied.applied == [] and applied.conflicts[0].reason == "Title changed since the suggestion"


def test_without_a_profile_only_rule_based_project_renames_are_offered():
    db, _, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))
    for profile in db.list_profiles():
        db.delete_profile(profile.id)
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    assert result.ai_available is False
    assert [item.kind for item in result.suggestions] == ["project"]
    assert "Connect an OpenRouter profile in Settings to write AI titles" in {item.reason for item in result.skipped}


def test_provider_failure_keeps_titles_and_reports_warning(monkeypatch):
    db, manager, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))

    async def fail(*_args, **_kwargs):
        raise TimeoutError("socket timed out with key sk-or-v1-secret")

    monkeypatch.setattr(manager.profiles, "openrouter_models", lambda *a, **k: _resolved([MODEL]))
    monkeypatch.setattr(manager.profiles, "openrouter_json", fail)
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    assert result.warning and "sk-or-v1-secret" not in result.warning
    assert [item.kind for item in result.suggestions] == ["project"]
    assert db.get_asset("legacy-asset-1").title.startswith("YouTube import")


def test_price_ceiling_blocks_expensive_models(monkeypatch):
    _, manager, backfill = _library(Path(tempfile.mkdtemp(prefix="s6-seo-lib-")))
    expensive = MODEL.model_copy(update={"pricing": {"prompt": "0.00001", "completion": "0.00004"}})
    monkeypatch.setattr(manager.profiles, "openrouter_models", lambda *a, **k: _resolved([expensive]))

    async def never(*_args, **_kwargs):
        raise AssertionError("must not call an over-budget model")

    monkeypatch.setattr(manager.profiles, "openrouter_json", never)
    result = asyncio.run(backfill.suggest(TitleSuggestionRequest(scope="auto-titled")))
    assert "price ceiling" in (result.warning or "")
    assert result.requests == 0


def test_rule_inspector_blur_without_change_keeps_title_source():
    job_id = f"inspector-{uuid.uuid4().hex}"
    project = Project(id=f"p-{job_id}", name="Inspector", mode="clip", style="funny", state="complete", source_name="x.mp4", source_kind="upload", requested_count=1)
    clip = Clip(id=f"c-{job_id}", index=1, state="complete", start=0, end=10, duration=10, opening_line="Opening", output_name="c.mp4", library_asset_id=f"a-{job_id}", title="Auto title", title_source="auto")
    app_module.db.save_project(project)
    app_module.db.save_asset(Asset(id=f"a-{job_id}", title="Auto title", title_source="auto", media_type="video/mp4", filename="c.mp4", content_hash=f"h-{job_id}", origin="generated-clip", source_project_id=project.id, source_job_id=job_id, source_clip_id=clip.id))
    app_module.db.save_job(Job(id=job_id, project_id=project.id, mode="clip", state="complete", stage="complete", stage_label="Complete", progress=100, style="funny", clips=[clip]), {})
    try:
        same = client.put(f"/api/v1/library/assets/a-{job_id}", json={"title": "Auto title"})
        assert same.status_code == 200 and same.json()["titleSource"] == "auto"
        changed = client.put(f"/api/v1/library/assets/a-{job_id}", json={"title": "Hand written"})
        assert changed.json()["titleSource"] == "user"
        saved = app_module.db.get_job(job_id).clips[0]
        assert saved.title == "Hand written" and saved.title_source == "user"
    finally:
        app_module.db.delete_project(project.id)


def test_suggest_endpoint_requires_scope_or_ids():
    assert client.post("/api/v1/library/title-suggestions", json={}).status_code == 422


# ---------------------------------------------------------------------------
# Verify-review regressions: hand-edited titles survive every write path
# ---------------------------------------------------------------------------

def _published_pair(db: Database, *, job_id: str, title: str, title_source: str | None, clip_count: int = 2):
    project = Project(id=f"p-{job_id}", name="Typed name", mode="clip", style="funny", state="active", source_name="x.mp4", source_kind="upload", requested_count=clip_count)
    db.save_project(project)
    clips = [Clip(id=f"{job_id}-c{index}", index=index, state="complete" if index == 1 else "rendering", start=0, end=10, duration=10, opening_line="Opening words here",
                  output_name=f"{index:02d}.mp4", library_asset_id=f"{job_id}-a1" if index == 1 else None, title=title if index == 1 else None,
                  title_source=title_source if index == 1 else None) for index in range(1, clip_count + 1)]
    db.save_asset(Asset(id=f"{job_id}-a1", title=title, title_source=title_source, media_type="video/mp4", filename="01.mp4", content_hash=f"h-{job_id}-1",
                        origin="generated-clip", source_project_id=project.id, source_job_id=job_id, source_clip_id=clips[0].id))
    job = Job(id=job_id, project_id=project.id, mode="clip", state="active", stage="render", stage_label="Rendering", progress=50, style="funny", processing_mode="smart", clips=clips)
    db.save_job(job, {})
    return project, job


def test_republication_keeps_a_user_title_source():
    db, _ = _cluster(Path(tempfile.mkdtemp(prefix="s6-seo-pub-")))
    project, job = _published_pair(db, job_id="repub", title="My hand title", title_source="user", clip_count=1)
    clip = job.clips[0]
    incoming = Asset(id="new-id", title="Rule title – Typed name", title_source="auto", media_type="video/mp4", filename="01.mp4", content_hash="h-repub-2",
                     origin="generated-clip", source_project_id=project.id, source_job_id=job.id, source_clip_id=clip.id)
    _, published_clip, asset = db.publish_clip_output(job, clip.model_copy(update={"title": "Rule title – Typed name", "title_source": "auto"}), incoming, "blobs/x.mp4", 10, private={})
    assert asset.title == "My hand title" and asset.title_source == "user"
    assert published_clip.title == "My hand title" and published_clip.title_source == "user"
    assert clip_title_replaceable(asset, published_clip, allow_ai=True)[0] is False


def test_publishing_the_next_clip_does_not_revert_an_edit_made_mid_job():
    db, _ = _cluster(Path(tempfile.mkdtemp(prefix="s6-seo-race-")))
    project, job = _published_pair(db, job_id="race", title="Auto title – Typed name", title_source="auto")
    stale = Job.model_validate_json(job.model_dump_json(by_alias=True))  # the worker's in-memory copy
    db.update_generated_clip_metadata("race-a1", "Edited while rendering", "", 0, title_source="user")
    second = stale.clips[1]
    incoming = Asset(id="race-a2", title="Second – Typed name", title_source="auto", media_type="video/mp4", filename="02.mp4", content_hash="h-race-2",
                     origin="generated-clip", source_project_id=project.id, source_job_id=job.id, source_clip_id=second.id)
    db.publish_clip_output(stale, second.model_copy(update={"title": "Second – Typed name", "title_source": "auto", "output_name": "02.mp4"}), incoming, "blobs/y.mp4", 10, private={"youtube_metadata_generation_calls": 0})
    saved = db.get_job("race")
    first = next(clip for clip in saved.clips if clip.id == "race-c1")
    assert first.title == "Edited while rendering" and first.title_source == "user"
    assert first.youtube_metadata_revision == 1
    assert db.get_asset("race-a1").title == first.title


def test_apply_api_refuses_to_overwrite_a_user_title():
    job_id = f"apply-user-{uuid.uuid4().hex[:8]}"
    project, job = _published_pair(app_module.db, job_id=job_id, title="Hand written", title_source="user", clip_count=1)
    try:
        response = client.post("/api/v1/library/title-suggestions/apply", json={"items": [{"kind": "clip", "assetId": f"{job_id}-a1", "currentTitle": "Hand written", "title": "AI replacement title", "description": "", "revision": 0, "edited": False}]})
        assert response.status_code == 200, response.text
        assert response.json()["applied"] == [] and response.json()["conflicts"][0]["reason"] == "Title was edited by hand"
        assert app_module.db.get_asset(f"{job_id}-a1").title == "Hand written"
    finally:
        app_module.db.delete_project(project.id)


def test_failed_generation_keeps_the_library_title_and_description():
    job_id = f"fail-keep-{uuid.uuid4().hex[:8]}"
    project, job = _published_pair(app_module.db, job_id=job_id, title="YouTube import — Old words · Cut 01", title_source=None, clip_count=1)
    asset = app_module.db.get_asset(f"{job_id}-a1")
    app_module.db.save_asset(asset.model_copy(update={"title": "Library-only hand title", "description": "My own description"}))
    try:
        app_module._record_youtube_metadata_failure(job_id, f"{job_id}-c1", 0, "Provider timed out", "a long enough transcript excerpt for a fallback description")
        after = app_module.db.get_asset(f"{job_id}-a1")
        assert after.title == "Library-only hand title"
        assert after.description == "My own description"
        clip = app_module.db.get_job(job_id).clips[0]
        assert clip.title == after.title and clip.youtube_metadata_status == "fallback"
    finally:
        app_module.db.delete_project(project.id)


def test_workspace_save_with_a_stale_seeded_title_keeps_the_library_title():
    job_id = f"stale-draft-{uuid.uuid4().hex[:8]}"
    project, job = _published_pair(app_module.db, job_id=job_id, title="YouTube import — Old words · Cut 01", title_source=None, clip_count=1)
    asset = app_module.db.get_asset(f"{job_id}-a1")
    app_module.db.save_asset(asset.model_copy(update={"title": "Library-only hand title"}))
    try:
        response = client.put(f"/api/v1/jobs/{job_id}/clips/{job_id}-c1/youtube-metadata", json={"revision": 0, "title": "YouTube import — Old words · Cut 01", "description": "New description only"})
        assert response.status_code == 200, response.text
        after = app_module.db.get_asset(f"{job_id}-a1")
        assert after.title == "Library-only hand title" and after.description == "New description only"
    finally:
        app_module.db.delete_project(project.id)


def test_default_on_seo_toggle_never_blocks_an_auto_job_that_resolved_to_fast(monkeypatch):
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)

    async def enqueue(job_id: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    created = client.post("/api/v1/jobs/clip", data={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "processing_mode": "auto", "youtube_metadata": "true"})
    assert created.status_code == 202, created.text
    try:
        assert created.json()["job"]["processingMode"] == "fast"
        assert created.json()["job"]["youtubeMetadataEnabled"] is False
    finally:
        app_module.db.delete_project(created.json()["project"]["id"])
