"""Contract tests for the optional ``editing_presentation`` setting.

No FFmpeg needed: catalog IDs, strict/mode validation (before any source is
read or a job exists), persisted Job/private JSON, and render dispatch through
creation, retry, caption rerender, source-only versions and the Fast switch.
"""
from __future__ import annotations

import json
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, get_args

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import engine.jobs as jobs
import engine.media as media_module
from engine.app import app
from engine.config import Settings
from engine.database import Database
from engine.editing_presets import (
    CAPTION_PRESET_IDS, CAPTION_PRESET_LABELS, EMOJI_MODE_IDS, HEADING_STYLE_IDS, SPEECH_PRESETS, VIDEO_FILTER_IDS,
    manifest_summary, normalize_editing_presentation, sanitize_for_uncaptioned_path,
)
from engine.jobs import JobManager, _editing_render_kwargs
from engine.library import LibraryRules
from engine.media import _editing_picture_chain, _filters, _music_treatment_for_filter
from engine.models import (
    Clip, EditingCaptionPreset, EditingEmojiMode, EditingHeadingStyle, EditingPresentationConfig, EditingVideoFilter,
    Job, MusicPresentationConfig, MusicSubtitleTheme, Project,
)
from engine.providers import ProfileService
from engine.security import SecretVault

client = TestClient(app)
SETTINGS = Settings.from_env()


# --- catalog / models ---------------------------------------------------------------


def test_catalog_ids_are_the_shared_contract() -> None:
    assert CAPTION_PRESET_IDS == (
        "editorial_default", "clean_sentence", "bold_outline", "yellow_focus", "word_pop", "active_word_box",
        "dark_caption_plate", "light_caption_plate", "word_build", "cinematic_serif", "condensed_stack", "karaoke_line",
    )
    assert "dark_caption_plate" in CAPTION_PRESET_IDS and "light_caption_plate" in CAPTION_PRESET_IDS
    assert VIDEO_FILTER_IDS == ("existing", "original", "warm", "cool", "vibrant", "black_white", "vintage")
    assert HEADING_STYLE_IDS == ("plain", "dark_box", "white_banner") and EMOJI_MODE_IDS == ("existing", "off", "sparse")
    # Pydantic Literals and the engine catalog never drift apart.
    assert get_args(EditingCaptionPreset) == CAPTION_PRESET_IDS and get_args(EditingVideoFilter) == VIDEO_FILTER_IDS
    assert get_args(EditingHeadingStyle) == HEADING_STYLE_IDS and get_args(EditingEmojiMode) == EMOJI_MODE_IDS
    assert set(SPEECH_PRESETS) == set(CAPTION_PRESET_IDS) - {"editorial_default"} and set(CAPTION_PRESET_LABELS) == set(CAPTION_PRESET_IDS)


def test_music_theme_enum_keeps_the_nine_originals_and_adds_three() -> None:
    themes = get_args(MusicSubtitleTheme)
    assert themes[:9] == ("clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif", "condensed_black", "condensed_white", "handwritten_stack")
    assert themes[9:] == ("karaoke_focus", "soft_glow", "lyric_plate")


def test_config_defaults_round_trip_camel_case_and_reject_unknowns() -> None:
    config = EditingPresentationConfig()
    assert config.model_dump() == {"version": 1}
    assert config.model_dump(by_alias=True) == {"version": 1}
    assert normalize_editing_presentation(config.model_dump()) == {
        "version": 1, "caption_preset": "editorial_default", "video_filter": "existing", "heading_style": "plain", "emoji_mode": "existing",
    }
    parsed = EditingPresentationConfig.model_validate({"version": 1, "captionPreset": "karaoke_line", "videoFilter": "vintage", "headingStyle": "white_banner", "emojiMode": "sparse"})
    assert EditingPresentationConfig.model_validate_json(parsed.model_dump_json(by_alias=True)) == parsed
    for bad in ({"version": 2}, {"captionPreset": "nope"}, {"videoFilter": "sepia"}, {"extra": 1}):
        with pytest.raises(ValidationError):
            EditingPresentationConfig.model_validate(bad)


def test_music_filter_snapshot_omits_unselected_speech_defaults() -> None:
    config = EditingPresentationConfig.model_validate({"version": 1, "video_filter": "warm"})
    assert config.model_dump() == {"version": 1, "video_filter": "warm"}
    assert config.model_dump(by_alias=True) == {"version": 1, "videoFilter": "warm"}
    assert normalize_editing_presentation(config.model_dump()) == {
        "version": 1, "caption_preset": "editorial_default", "video_filter": "warm", "heading_style": "plain", "emoji_mode": "existing",
    }


def test_normalize_degrades_unknown_ids_and_ignores_unversioned_values() -> None:
    assert normalize_editing_presentation(None) is None and normalize_editing_presentation({"caption_preset": "word_pop"}) is None
    value = normalize_editing_presentation({"version": 1, "caption_preset": "from-the-future", "video_filter": "warm"})
    assert value == {"version": 1, "caption_preset": "editorial_default", "video_filter": "warm", "heading_style": "plain", "emoji_mode": "existing"}


def test_manifest_summary_has_ids_and_labels_only_when_chosen() -> None:
    assert manifest_summary(None) is None
    summary = manifest_summary({"version": 1, "caption_preset": "dark_caption_plate", "video_filter": "black_white", "heading_style": "dark_box", "emoji_mode": "off"})
    assert summary["caption_preset"] == {"id": "dark_caption_plate", "label": "Dark caption plate"}
    assert summary["video_filter"] == {"id": "black_white", "label": "Black & white"}


# --- API validation / persistence ----------------------------------------------------


@pytest.fixture()
def api(monkeypatch):
    from engine import app as app_module

    calls = {"validated": 0}

    def fake_validate(*_args, **_kwargs):
        calls["validated"] += 1
        return {"duration": 40.0, "width": 640, "height": 360, "audio": True}

    monkeypatch.setattr(app_module, "_rate_limit", lambda request: None)
    monkeypatch.setattr(app_module, "validate_video_upload", fake_validate)
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)

    async def enqueue(_job_id: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)

    def post(editing: Any = None, **fields: str):
        data = {"count": "1", "min_duration": "8", "max_duration": "20", "library_folder_id": app_module.db.list_folders()[0].id, **fields}
        if editing is not None:
            data["editing_presentation"] = editing if isinstance(editing, str) else json.dumps(editing)
        before = len(app_module.db.list_jobs())
        response = client.post("/api/v1/jobs/clip", data=data, files={"file": ("clip.mp4", b"fixture", "video/mp4")})
        return response, len(app_module.db.list_jobs()) - before

    return SimpleNamespace(post=post, app=app_module, calls=calls)


def test_omitted_or_empty_selection_changes_nothing(api) -> None:
    for editing in (None, "", "{}"):
        response, created = api.post(editing)
        assert response.status_code == 202 and created == 1, response.text
        job = response.json()["job"]
        assert job["editingPresentation"] is None
        assert "editing_presentation" not in api.app.db.get_job_private(job["id"])


def test_saved_choice_is_snapshotted_on_job_and_private_settings(api) -> None:
    choice = {"version": 1, "captionPreset": "yellow_focus", "videoFilter": "warm", "headingStyle": "dark_box", "emojiMode": "sparse"}
    response, created = api.post(choice, hook_text="true", manual_hook_text="Read this first")
    assert response.status_code == 202 and created == 1, response.text
    job = response.json()["job"]
    assert job["editingPresentation"] == choice
    stored = api.app.db.get_job(job["id"])
    assert stored.editing_presentation == EditingPresentationConfig.model_validate(choice)
    assert api.app.db.get_job_private(job["id"])["editing_presentation"] == {"version": 1, "caption_preset": "yellow_focus", "video_filter": "warm", "heading_style": "dark_box", "emoji_mode": "sparse"}
    # Editorial intent is untouched by the visual preset.
    assert job["style"] == "educational"


def test_every_filter_alone_is_accepted_in_every_speech_path(api) -> None:
    for fields in ({"processing_mode": "fast"}, {"processing_mode": "smart"}, {"content_format": "long"}, {"burn_subtitles": "false"}):
        response, created = api.post({"version": 1, "videoFilter": "vintage"}, **fields)
        assert response.status_code == 202 and created == 1, (fields, response.text)


def test_smart_long_form_accepts_subtitle_styles(api) -> None:
    response, created = api.post({"version": 1, "captionPreset": "dark_caption_plate", "emojiMode": "sparse"}, content_format="long", processing_mode="smart")
    assert response.status_code == 202 and created == 1, response.text
    assert response.json()["job"]["editingPresentation"]["captionPreset"] == "dark_caption_plate"


def test_high_volume_smart_short_accepts_one_saved_choice(api) -> None:
    response, _ = api.post({"version": 1, "captionPreset": "word_pop"}, batch_mode="high_volume", count="40", processing_mode="smart")
    assert response.status_code == 202, response.text


@pytest.mark.parametrize(("editing", "fields"), [
    ({"version": 1, "captionPreset": "word_pop"}, {"processing_mode": "fast"}),
    ({"version": 1, "emojiMode": "off"}, {"processing_mode": "fast"}),
    ({"version": 1, "captionPreset": "word_pop"}, {"burn_subtitles": "false"}),
    ({"version": 1, "emojiMode": "sparse"}, {"burn_subtitles": "false"}),
    ({"version": 1, "captionPreset": "nope"}, {}),
    ({"version": 1, "videoFilter": "sepia"}, {}),
    ({"version": 2}, {}),
    ({"version": 1, "surprise": True}, {}),
    ("{not json", {}),
    ("[]", {}),
    ({"version": 1, "captionPreset": "word_pop"}, {"source_profile": "music"}),
    ({"version": 1, "headingStyle": "dark_box"}, {"source_profile": "music"}),
    ({"version": 1, "emojiMode": "off"}, {"source_profile": "music"}),
    ({"version": 1, "captionPreset": "editorial_default"}, {"source_profile": "music"}),
])
def test_invalid_or_irrelevant_selection_fails_before_media_or_job(api, editing, fields) -> None:
    response, created = api.post(editing, **fields)
    assert response.status_code == 422, response.text
    assert created == 0 and api.calls["validated"] == 0, "must fail before the upload is validated or a job is saved"


def test_music_may_choose_the_common_filter_and_new_themes(api) -> None:
    response, created = api.post(
        {"version": 1, "videoFilter": "black_white"}, source_profile="music",
        music_presentation=json.dumps({"version": 1, "subtitle_theme": "lyric_plate", "lyric_animation": "word_build"}),
    )
    assert response.status_code == 202 and created == 1, response.text
    job = response.json()["job"]
    assert job["musicPresentation"]["subtitleTheme"] == "lyric_plate" and job["editingPresentation"]["videoFilter"] == "black_white"
    for theme in ("karaoke_focus", "soft_glow", "lyric_plate"):
        assert MusicPresentationConfig.model_validate({"version": 1, "subtitle_theme": theme}).subtitle_theme == theme


def test_speech_hidden_music_options_still_rejected_with_editing_choice(api) -> None:
    response, created = api.post({"version": 1, "videoFilter": "warm"}, music_presentation=json.dumps({"version": 1, "subtitle_theme": "soft_glow"}))
    assert response.status_code == 422 and created == 0


# --- render dispatch -----------------------------------------------------------------

EDITING = {"version": 1, "caption_preset": "karaoke_line", "video_filter": "cool", "heading_style": "white_banner", "emoji_mode": "off"}


def test_render_kwargs_only_for_compatible_renderers_and_music_keeps_filter_only() -> None:
    def accepts(*, editing_presentation=None): ...
    def legacy(*, words): ...
    def anything(**kwargs): ...

    assert _editing_render_kwargs(accepts, {"editing_presentation": EDITING}) == {"editing_presentation": EDITING}
    assert _editing_render_kwargs(anything, {"editing_presentation": EDITING}) == {"editing_presentation": EDITING}
    assert _editing_render_kwargs(legacy, {"editing_presentation": EDITING}) == {}
    assert _editing_render_kwargs(accepts, {}) == {}
    assert _editing_render_kwargs(accepts, {"editing_presentation": EDITING}, "music") == {"editing_presentation": {"version": 1, "video_filter": "cool"}}


def test_fast_switch_keeps_the_filter_and_drops_caption_only_choices() -> None:
    assert sanitize_for_uncaptioned_path(EDITING) == {"version": 1, "caption_preset": "editorial_default", "video_filter": "cool", "heading_style": "plain", "emoji_mode": "existing"}
    assert sanitize_for_uncaptioned_path(None) is None


def _cluster(tmp_path: Path) -> tuple[Database, JobManager]:
    settings = replace(SETTINGS, data_path=tmp_path)
    db = Database(tmp_path / "s6-cut.sqlite3")
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key")), settings)
    return db, manager


def _fast_job(db: Database, tmp_path: Path, job_id: str, private_extra: dict[str, Any], *, count: int = 1, processing_mode: str = "fast", **job_fields: Any) -> Path:
    source = tmp_path / f"{job_id}.mp4"
    source.write_bytes(b"fake")
    db.save_project(Project(id=f"{job_id}-p", name=job_id, mode="clip", style="educational", state="queued", source_name="s.mp4", source_kind="upload", requested_count=count))
    private = {"source_path": str(source), "count": count, "min_duration": 10, "max_duration": 30, "aspect_ratio": "9:16", "processing_mode": "fast", **private_extra}
    db.save_job(Job(id=job_id, project_id=f"{job_id}-p", mode="clip", processing_mode=processing_mode, state="queued", stage="queued", stage_label="Queued", progress=0, style="educational", **job_fields), private)
    return source


def _patch_media(monkeypatch, renders: list[dict[str, Any]], *, fail: bool = False) -> None:
    def render(source: Path, output: Path, **kwargs: Any) -> None:
        renders.append(kwargs)
        if fail:
            raise media_module.MediaError("forced failure")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"rendered")

    monkeypatch.setattr("engine.jobs.probe", lambda *_: {"duration": 100.0, "width": 1080, "height": 1920, "video_codec": "h264", "audio": True, "audio_codec": "aac"})
    monkeypatch.setattr(media_module, "plan_fast_windows", lambda *_a, **_k: ([(0.0, 10.0)], ""))
    monkeypatch.setattr(media_module, "render_fast_clip", render)
    monkeypatch.setattr("engine.jobs.render_clip", render)


def test_initial_render_retry_and_source_only_all_receive_the_saved_snapshot(monkeypatch, tmp_path: Path) -> None:
    db, manager = _cluster(tmp_path)
    renders: list[dict[str, Any]] = []
    _fast_job(db, tmp_path, "edit-job", {"editing_presentation": EDITING}, editing_presentation=EditingPresentationConfig.model_validate(EDITING))

    # Initial render fails; the saved snapshot was still handed to the renderer.
    _patch_media(monkeypatch, renders, fail=True)
    manager._process("edit-job")
    failed = db.get_job("edit-job")
    assert renders[-1]["editing_presentation"] == EDITING
    assert failed.clips and failed.clips[0].state == "failed"

    # Retry re-runs the same job from the persisted private settings.
    clip = failed.clips[0]
    clip.state, clip.error, failed.state = "queued", None, "queued"
    manager._reset_steps_for_retry(failed)
    manager._save(failed)
    renders.clear()
    _patch_media(monkeypatch, renders)
    manager._process("edit-job")
    done = db.get_job("edit-job")
    assert renders and all(call["editing_presentation"] == EDITING for call in renders)
    assert done.clips[0].state == "complete"
    assert db.get_job_private("edit-job")["editing_presentation"] == EDITING  # survives saves and restart-style reloads

    # A source-only version copies the Job snapshot and private settings, then renders with them.
    regenerated = manager.create_source_only_rerender(done, [done.clips[0].id])
    assert db.get_job(regenerated.id).editing_presentation == EditingPresentationConfig.model_validate(EDITING)
    assert db.get_job_private(regenerated.id)["editing_presentation"] == EDITING
    renders.clear()
    manager._process(regenerated.id)
    assert renders and renders[-1]["editing_presentation"] == EDITING


def test_reviewed_caption_rerender_forwards_the_snapshot(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}
    monkeypatch.setattr(media_module, "render_fast_clip", lambda *args, **kwargs: captured.update(kwargs))
    monkeypatch.setattr(jobs, "probe", lambda *_a, **_k: {"audio": True})
    manager = object.__new__(JobManager)
    manager.settings = SimpleNamespace(data_path=tmp_path)
    manager._source = lambda *_a: tmp_path / "source.mp4"
    manager._save = lambda *_a: None
    manager._publish_output = lambda job, clip, *_a: (job, clip, None)
    clip = Clip(id="rc", index=1, state="complete", start=2, end=4, duration=2, opening_line="words")
    job = Job(id="rj", project_id="rp", mode="clip", state="active", stage="render", stage_label="Rendering", progress=50, style="educational", clips=[clip])
    request = {"clip_id": clip.id, "revision": 1, "run_id": "edit"}
    private = {
        "aspect_ratio": "9:16", "presentation": {"version": 2, "caption": "smart_speech_v2"}, "burn_subtitles": True,
        "editing_presentation": EDITING, "caption_rerender": request,
        "caption_overrides": {clip.id: {"revision": 1, "cues": [{"id": "w", "start": .2, "end": .8, "text": "edited"}]}},
    }
    manager._process_caption_rerender(job, private, request)
    assert captured["editing_presentation"] == EDITING and captured["words"] == [{"text": "edited", "start": .2, "end": .8}]


def test_switch_to_fast_snapshot_keeps_only_the_picture_filter(tmp_path: Path) -> None:
    db, manager = _cluster(tmp_path)
    _fast_job(db, tmp_path, "sw", {"editing_presentation": EDITING, "processing_mode": "smart"}, editing_presentation=EditingPresentationConfig.model_validate(EDITING), processing_mode="smart")
    replacement = manager._switch_to_fast(db.get_job("sw"))
    assert replacement.editing_presentation.video_filter == "cool" and replacement.editing_presentation.caption_preset == "editorial_default"
    assert db.get_job_private(replacement.id)["editing_presentation"]["emoji_mode"] == "existing"


def test_export_manifest_reports_the_choice_only_for_jobs_that_selected_it(tmp_path: Path) -> None:
    db, manager = _cluster(tmp_path)
    for job_id, extra in (("with", {"editing_presentation": EDITING}), ("without", {})):
        _fast_job(db, tmp_path, job_id, extra)
        output = tmp_path / "jobs" / job_id / "clips" / "01-cut.mp4"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"x" * 10)
        job = db.get_job(job_id)
        job.clips = [Clip(id=f"{job_id}-c", index=1, state="complete", start=0, end=10, duration=10, opening_line="w", output_name="01-cut.mp4", width=1080, height=1920)]
        job.state = "complete"
        db.save_job(job, db.get_job_private(job_id))
        with zipfile.ZipFile(manager.build_export(job_id, [f"{job_id}-c"])) as archive:
            manifest = json.loads(archive.read(next(name for name in archive.namelist() if name.endswith("manifest.json"))))
        if job_id == "with":
            assert manifest["outputs"][0]["editing_presentation"]["caption_preset"] == {"id": "karaoke_line", "label": "Karaoke line"}
            assert manifest["job"]["editing_presentation"]["video_filter"]["id"] == "cool"
        else:
            assert "editing_presentation" not in manifest["outputs"][0] and "editing_presentation" not in manifest["job"]
        assert "credits" not in manifest and "creator_credit" in manifest["outputs"][0]  # existing fields preserved


# --- filter order / Music override ---------------------------------------------------


def test_picture_chain_is_applied_to_footage_before_overlays_captions_and_graphics() -> None:
    chain = _editing_picture_chain("warm")
    graph, mapped = _filters(1080, 1920, [(Path("o.png"), 1, 2)], 1, "captions.ass", (1280, 720), subscribe_animations=[(5, 1.0, 2.0, 300, 120)], picture_chain=chain)
    assert f",{chain}[base]" in graph and graph.startswith("[0:v]")
    assert graph.index(chain) < graph.index("[ov0]overlay=") < graph.index("[subscribe0]") < graph.index("subtitles=captions.ass")
    assert mapped == "outv"
    plain, _ = _filters(1080, 1920, [], 1, "captions.ass", (1280, 720))
    assert chain not in plain and plain.endswith("subtitles=captions.ass[outv]")


def test_music_picture_chain_precedes_the_black_pad_and_overrides_assigned_treatment() -> None:
    chain = _editing_picture_chain("vibrant")
    graph, _ = _filters(1080, 1920, [], 1, "c.ass", (1280, 720), music_treatment="color", picture_chain=chain)
    assert graph.index(chain) < graph.index(",pad=")
    assert _music_treatment_for_filter("existing", "grayscale") == "grayscale" and _music_treatment_for_filter("existing", "color") == "color"
    for explicit in ("original", "warm", "cool", "vibrant", "vintage"):
        assert _music_treatment_for_filter(explicit, "grayscale") == "color"
    assert _music_treatment_for_filter("black_white", "color") == "grayscale"
    gray, _ = _filters(1080, 1920, [], 1, "c.ass", (1280, 720), music_treatment="grayscale")
    assert "hue=s=0" in gray


def test_filter_chains_cover_all_seven_choices() -> None:
    assert _editing_picture_chain("existing") == "" and _editing_picture_chain("original") == ""
    for name in ("warm", "cool", "vibrant", "black_white", "vintage"):
        assert _editing_picture_chain(name)
    assert "noise=alls=" in _editing_picture_chain("vintage") and f"all_seed={20260918}" in _editing_picture_chain("vintage")
    assert _editing_picture_chain("vibrant").endswith("format=yuv420p")
