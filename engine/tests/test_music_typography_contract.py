"""Contract, persistence and dispatch tests for Music typography/motion options."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from engine.app import app
from engine.models import Clip, Job, MusicPresentationConfig, Project

client = TestClient(app)
NEW_THEMES = ("condensed_black", "condensed_white", "handwritten_stack")
ANIMATIONS = ("legacy", "slow_fade", "line_crossfade", "word_build")


def test_new_themes_and_enum_values_are_accepted_and_invalid_ones_rejected() -> None:
    for theme in NEW_THEMES:
        assert MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": theme}).subtitle_theme == theme
    for animation in ANIMATIONS:
        assert MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": "clean", "lyricAnimation": animation}).lyric_animation == animation
    for fmt in ("plain", "white_banner"):
        assert MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": "clean", "hookTextFormat": fmt}).hook_text_format == fmt
    for payload in (
        {"version": 1, "subtitleTheme": "clean", "lyricAnimation": "spin"},
        {"version": 1, "subtitleTheme": "clean", "hookTextFormat": "neon"},
        {"version": 1, "subtitleTheme": "clean", "lyric_animation": 3},
        {"version": 1, "subtitleTheme": "clean", "extra": True},
        {"version": 2, "subtitleTheme": "clean"},
    ):
        with pytest.raises(ValidationError):
            MusicPresentationConfig.model_validate(payload)


def test_omitted_options_keep_the_historical_two_field_shape() -> None:
    config = MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": "warm"})
    assert config.lyric_animation is None and config.hook_text_format is None
    assert config.model_dump(by_alias=True) == {"version": 1, "subtitleTheme": "warm"}
    assert config.model_dump() == {"version": 1, "subtitle_theme": "warm"}
    assert config.model_dump(mode="json", by_alias=True, exclude_none=True) == {"version": 1, "subtitleTheme": "warm"}
    assert MusicPresentationConfig().model_dump(by_alias=True) == {"version": 1, "subtitleTheme": "clean"}
    # A historical Job reads and re-serialises without gaining default keys.
    job = Job.model_validate({
        "id": "old", "project_id": "p", "mode": "clip", "state": "complete", "stage": "complete", "stage_label": "Done",
        "progress": 100, "style": "serious", "source_profile": "music", "music_presentation": {"version": 1, "subtitle_theme": "serif"},
    })
    assert job.model_dump(by_alias=True)["musicPresentation"] == {"version": 1, "subtitleTheme": "serif"}
    assert Job.model_validate_json(job.model_dump_json(by_alias=True)).music_presentation == job.music_presentation


def test_chosen_options_serialise_in_both_naming_styles() -> None:
    config = MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": "handwritten_stack", "lyricAnimation": "line_crossfade", "hookTextFormat": "white_banner"})
    assert config.model_dump(by_alias=True) == {"version": 1, "subtitleTheme": "handwritten_stack", "lyricAnimation": "line_crossfade", "hookTextFormat": "white_banner"}
    assert config.model_dump() == {"version": 1, "subtitle_theme": "handwritten_stack", "lyric_animation": "line_crossfade", "hook_text_format": "white_banner"}
    assert MusicPresentationConfig.model_validate(config.model_dump()) == config


def _accept_music(monkeypatch: pytest.MonkeyPatch):
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {"duration": 40.0, "width": 640, "height": 360, "audio": True})
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)

    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    return app_module, {
        "source_profile": "music", "processing_mode": "smart", "count": "1", "min_duration": "8", "max_duration": "20",
        "library_folder_id": app_module.db.list_folders()[0].id,
    }


def test_api_saves_the_full_config_on_the_job_and_private_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    app_module, fields = _accept_music(monkeypatch)
    config = '{"version":1,"subtitleTheme":"condensed_black","lyricAnimation":"word_build","hookTextFormat":"white_banner"}'
    accepted = client.post("/api/v1/jobs/clip", data={**fields, "music_presentation": config, "music_top_text": "Exact hook"}, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert accepted.status_code == 202, accepted.text
    body = accepted.json()["job"]
    assert body["musicPresentation"] == {"version": 1, "subtitleTheme": "condensed_black", "lyricAnimation": "word_build", "hookTextFormat": "white_banner"}
    assert body["musicTopText"] == "Exact hook"
    persisted = app_module.db.get_job(body["id"])
    assert persisted is not None and persisted.music_presentation is not None
    assert persisted.music_presentation.lyric_animation == "word_build"
    private = app_module.db.get_job_private(body["id"])
    assert private["music_presentation"] == {"version": 1, "subtitle_theme": "condensed_black", "lyric_animation": "word_build", "hook_text_format": "white_banner"}
    assert private["music_top_text"] == "Exact hook"


def test_api_omitted_options_stay_absent_from_the_response_and_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    app_module, fields = _accept_music(monkeypatch)
    accepted = client.post("/api/v1/jobs/clip", data={**fields, "music_presentation": '{"version":1,"subtitleTheme":"warm"}'}, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["job"]["musicPresentation"] == {"version": 1, "subtitleTheme": "warm"}
    assert app_module.db.get_job_private(accepted.json()["job"]["id"])["music_presentation"] == {"version": 1, "subtitle_theme": "warm"}


@pytest.mark.parametrize("config", [
    '{"version":1,"subtitleTheme":"clean","lyricAnimation":"spin"}',
    '{"version":1,"subtitleTheme":"clean","hookTextFormat":"loud"}',
    '{"version":1,"subtitleTheme":"unknown"}',
])
def test_api_rejects_invalid_new_enum_values(monkeypatch: pytest.MonkeyPatch, config: str) -> None:
    _app_module, fields = _accept_music(monkeypatch)
    rejected = client.post("/api/v1/jobs/clip", data={**fields, "music_presentation": config}, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert rejected.status_code == 422


@pytest.mark.parametrize("config", [
    '{"version":1,"subtitleTheme":"clean","lyricAnimation":"slow_fade"}',
    '{"version":1,"subtitleTheme":"clean","hookTextFormat":"white_banner"}',
    '{"version":1,"subtitleTheme":"handwritten_stack"}',
])
def test_api_rejects_music_only_presentation_on_speech(monkeypatch: pytest.MonkeyPatch, config: str) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    response = client.post("/api/v1/jobs/clip", data={"url": "https://www.youtube.com/watch?v=fixture", "source_profile": "speech", "music_presentation": config})
    assert response.status_code == 422


def test_options_survive_database_reload_for_job_and_private_snapshot(tmp_path: Path) -> None:
    from engine.database import Database

    database = Database(tmp_path / "typography.sqlite3")
    project = Project(id="p", name="P", mode="clip", style="educational", state="active", source_name="song.mp4", source_kind="upload", requested_count=1, source_profile="music")
    config = MusicPresentationConfig(subtitle_theme="handwritten_stack", lyric_animation="line_crossfade", hook_text_format="white_banner")
    job = Job(id="j", project_id="p", mode="clip", state="active", stage="render", stage_label="Rendering", progress=40, style="educational", source_profile="music", music_presentation=config, music_top_text="Hook")
    database.save_project(project)
    database.save_job(job, {"music_presentation": config.model_dump(), "music_top_text": "Hook"})
    reopened = Database(tmp_path / "typography.sqlite3")
    restored = reopened.get_job("j")
    assert restored is not None and restored.music_presentation == config
    assert reopened.get_job_private("j")["music_presentation"] == config.model_dump()
    # Legacy two-field config survives the same trip without new keys.
    legacy = MusicPresentationConfig(subtitle_theme="warm")
    database.save_job(job.model_copy(update={"id": "legacy", "music_presentation": legacy}), {"music_presentation": legacy.model_dump()})
    assert Database(tmp_path / "typography.sqlite3").get_job_private("legacy")["music_presentation"] == {"version": 1, "subtitle_theme": "warm"}


# --- dispatch --------------------------------------------------------------------

def test_render_kwargs_send_additive_options_only_when_non_legacy_and_accepted() -> None:
    from engine.jobs import _music_render_kwargs

    def full(*, music_theme=None, music_top_text=None, music_treatment=None, music_lyric_animation=None, music_hook_text_format=None): ...
    def older(*, music_theme=None, music_top_text=None, music_treatment=None): ...
    def anything(**kwargs): ...

    assert _music_render_kwargs(full, "clean", "T", None) == {"music_theme": "clean", "music_top_text": "T", "music_treatment": None}
    assert _music_render_kwargs(full, "clean", "T", None, "legacy", "plain") == {"music_theme": "clean", "music_top_text": "T", "music_treatment": None}
    chosen = _music_render_kwargs(full, "condensed_white", "T", "grayscale", "slow_fade", "white_banner")
    assert chosen == {"music_theme": "condensed_white", "music_top_text": "T", "music_treatment": "grayscale", "music_lyric_animation": "slow_fade", "music_hook_text_format": "white_banner"}
    assert set(_music_render_kwargs(older, "clean", "T", None, "word_build", "white_banner")) == {"music_theme", "music_top_text", "music_treatment"}
    assert "music_lyric_animation" in _music_render_kwargs(anything, "clean", None, None, "word_build", None)


def _rerender_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, presentation: dict, render_name: str):
    import engine.jobs as jobs_module
    import engine.media as media_module
    from engine.jobs import JobManager

    rendered: dict = {}
    monkeypatch.setattr(media_module, render_name, lambda *args, **kwargs: rendered.update(kwargs))
    monkeypatch.setattr(jobs_module, "probe", lambda *_args, **_kwargs: {"audio": True, "duration": 100})
    monkeypatch.setattr(media_module, "prepare_music_track", lambda *_a, **_k: tmp_path / "prepared-song.mp3")
    manager = object.__new__(JobManager)
    manager.settings = SimpleNamespace(data_path=tmp_path)
    manager._source = lambda *_args: tmp_path / "source.mp4"
    manager._music_track_source = lambda *_args: tmp_path / "saved-song.mp3"
    manager._save = lambda *_args: None
    manager._publish_output = lambda job, clip, *_args: (job, clip, None)
    manager._video_overlay_for_clip = lambda *_args: ([], [])
    clip = Clip(id="music-clip", index=1, state="complete", start=50, end=52, duration=2, opening_line="old", music_top_text="Exact title", music_treatment="color")
    job = Job(id="music-job", project_id="music-project", mode="clip", state="active", stage="render", stage_label="Rendering", progress=50, style="educational", source_profile="music", clips=[clip])
    request = {"clip_id": clip.id, "revision": 1, "run_id": "edit"}
    private = {
        "aspect_ratio": "9:16", "music_presentation": presentation, "music_top_text": "Exact title", "music_track_speed": 1.0,
        "caption_rerender": request,
        "caption_overrides": {clip.id: {"revision": 1, "cues": [{"id": "w", "start": 0.5, "end": 0.9, "text": "edited"}]}},
    }
    return manager, job, private, request, rendered


def test_caption_rerender_uses_the_saved_typography_motion_and_banner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    presentation = {"version": 1, "subtitle_theme": "condensed_black", "lyric_animation": "line_crossfade", "hook_text_format": "white_banner"}
    manager, job, private, request, rendered = _rerender_setup(tmp_path, monkeypatch, presentation, "render_fast_clip")
    manager._process_caption_rerender(job, private, request)
    assert rendered["music_theme"] == "condensed_black"
    assert rendered["music_lyric_animation"] == "line_crossfade"
    assert rendered["music_hook_text_format"] == "white_banner"
    assert rendered["music_top_text"] == "Exact title"


def test_caption_rerender_of_legacy_job_sends_no_additive_options(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, job, private, request, rendered = _rerender_setup(tmp_path, monkeypatch, {"version": 1, "subtitle_theme": "warm"}, "render_fast_clip")
    manager._process_caption_rerender(job, private, request)
    assert rendered["music_theme"] == "warm"
    assert "music_lyric_animation" not in rendered and "music_hook_text_format" not in rendered


def test_fast_adapter_forwards_the_options_to_render_clip_for_music_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import engine.media as media

    calls: list[dict] = []
    monkeypatch.setattr(media, "render_clip", lambda *args, **kwargs: calls.append(kwargs))
    settings = SimpleNamespace()
    common = dict(start=0, end=2, aspect="9:16", settings=settings, words=[], subtitles_enabled=True)
    media.render_fast_clip(tmp_path / "s.mp4", tmp_path / "o.mp4", music_theme="handwritten_stack", music_lyric_animation="word_build", music_hook_text_format="white_banner", **common)
    assert calls[-1]["music_lyric_animation"] == "word_build" and calls[-1]["music_hook_text_format"] == "white_banner"
    assert calls[-1]["music_theme"] == "handwritten_stack"


def test_music_fonts_resolve_to_their_exact_faces() -> None:
    from engine.media import MUSIC_EXACT_FACES

    assert {family for family, _, _ in MUSIC_EXACT_FACES} >= {"Oswald", "Gaegu", "Roboto Condensed", "Barlow"}
    # Roboto Condensed must keep resolving to the lone Light face.
    assert ("Roboto Condensed", "Regular", "Light") in MUSIC_EXACT_FACES
