import math

import pytest
from pydantic import ValidationError

from engine.models import (
    ApiModel, AssetDelete, AssetMove, Beat, CaptionDownload, CaptionReviewInput,
    DownloadProgress, FolderCreate, FolderMove, FolderUpdate, Health, MobileClip,
    MobileDownload, MobileJob, MobileOverview, PenaltyItem, ProjectFolderUpdate,
    ProviderProfile, ShortsTextOverlay, to_camel,
)


def invalid(model, payload):
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_to_camel_and_api_model_contract():
    assert [to_camel(s) for s in ("word", "snake_case", "", "api_id_value")] == ["word", "snakeCase", "", "apiIdValue"]
    class Sample(ApiModel):
        some_value: int
    invalid(Sample, {"some_value": 1, "extra": 2})
    assert Sample.model_validate({"someValue": 1}).model_dump() == {"some_value": 1}
    assert Sample.model_validate({"some_value": 1}).model_dump(by_alias=True) == {"someValue": 1}


def test_download_progress_boundaries_aliases_and_defaults():
    base = DownloadProgress()
    assert (base.phase, base.downloaded_bytes, base.resumable) == ("queued", 0, True)
    assert base.total_bytes is base.percent is base.speed_bytes_per_second is base.eta_seconds is None
    payload = {"downloadedBytes": 4, "totalBytes": 4, "percent": 100, "lastProgressAt": "2025-01-01T00:00:00Z"}
    value = DownloadProgress.model_validate(payload)
    assert value.downloaded_bytes == 4 and value.last_progress_at == payload["lastProgressAt"]
    assert DownloadProgress.model_validate_json(value.model_dump_json()).downloaded_bytes == 4
    for change in ({"downloaded_bytes": -1}, {"total_bytes": -1}, {"percent": 100.1}, {"speed_bytes_per_second": -1}, {"eta_seconds": -1}, {"phase": "unknown"}, {"message": "x" * 501}):
        invalid(DownloadProgress, change)


@pytest.mark.parametrize("kind", ["filler_words", "length_off_target"])
def test_penalty_item_kinds_and_aliases(kind):
    item = PenaltyItem.model_validate({"kind": kind, "points": 0, "fillerWordCounts": {"um": 2}, "pointsPerWord": 1})
    assert item.filler_word_counts == {"um": 2} and item.points_per_word == 1
    for payload in ({"kind": kind, "points": -1}, {"kind": kind, "points": 0, "points_per_word": -1}, {"kind": "bad", "points": 0}):
        invalid(PenaltyItem, payload)


@pytest.mark.parametrize("fmt", ["ass", "srt", "vtt"])
def test_caption_download_formats(fmt):
    assert CaptionDownload(format=fmt, filename="x", url="/x").format == fmt
    invalid(CaptionDownload, {"format": "txt", "filename": "x", "url": "/x"})


def test_beat_required_aliases_and_limits():
    payload = dict(id="b", start=0, end=0.1, charStart=0, charEnd=1, text="x", concept="c", source="s", confidence=0, matchReason="why", assetId="a")
    beat = Beat.model_validate(payload)
    assert beat.char_start == 0 and beat.match_reason == "why" and beat.asset_id == "a"
    assert beat.model_dump(by_alias=True)["matchReason"] == "why"
    for change in ({"start": -1}, {"char_start": -1}, {"end": 0}, {"char_end": 0}, {"confidence": 1.1}, {"confidence": -0.1}):
        invalid(Beat, payload | change)


def test_health_contract():
    data = dict(status="ready", version="1", database=True, ffmpeg=True, ffprobe=True, whisper=True, ytdlp=True, data_path="provided", free_bytes=0, configured_workers=1, active_workers=0, queued_jobs=0, fallbacks={})
    assert Health.model_validate(data).build_revision == "unknown"
    assert Health.model_validate(data).model_dump(by_alias=True)["buildRevision"] == "unknown"
    for status in ("ready", "degraded", "starting"):
        assert Health.model_validate(data | {"status": status}).status == status
    invalid(Health, data | {"status": "bad"})
    invalid(Health, data | {"configured_workers": 0})


def test_provider_profile_defaults_and_validation():
    p = ProviderProfile(id="i", name="n", text_model_id="m", selected=False, persistence="session", openrouter_configured=False, status="ok", capabilities=[], fallbacks={})
    assert p.youtube_metadata_model_id == "google/gemini-2.5-flash-lite" and p.auto_seo_titles
    out = p.model_dump(by_alias=True)
    assert out["textModelId"] == "m" and out["youtubeMetadataModelId"] == p.youtube_metadata_model_id and not out["openrouterConfigured"]
    for status in ("not_configured", "connected", "timeout_offline"):
        assert ProviderProfile.model_validate(p.model_dump() | {"text_status": status}).text_status == status
    invalid(ProviderProfile, p.model_dump() | {"text_status": "bad"})
    invalid(ProviderProfile, p.model_dump() | {"persistence": "bad"})


def mobile_job():
    return dict(id="j", projectId="p", projectName="Project", mode="clip", state="active", stage="render", stageLabel="Rendering", progress=100, style="funny", createdAt="now", updatedAt="now", downloadProgress={"downloadedBytes": 5}, clips=[dict(id="c", index=1, title="Clip", duration=0, thumbnailUrl="/thumb")])


def test_mobile_overview_nested_aliases_round_trip_and_defaults():
    payload = dict(running=[mobile_job()], recent=[], recentTotal=1, downloads=[dict(id="d", state="complete", phase="done", createdAt="now", updatedAt="now", downloadedBytes=5, percent=100)])
    overview = MobileOverview.model_validate(payload)
    job = overview.running[0]
    assert isinstance(job, MobileJob) and isinstance(job.download_progress, DownloadProgress) and isinstance(job.clips[0], MobileClip)
    assert isinstance(overview.downloads[0], MobileDownload)
    dumped = overview.model_dump(by_alias=True)
    assert dumped["running"][0]["projectId"] == "p" and dumped["running"][0]["stageLabel"] == "Rendering"
    assert dumped["running"][0]["downloadProgress"]["downloadedBytes"] == 5
    assert dumped["running"][0]["clips"][0]["thumbnailUrl"] == "/thumb" and dumped["downloads"][0]["downloadedBytes"] == 5
    assert MobileOverview.model_validate_json(overview.model_dump_json()).running[0].clips[0].id == "c"
    a, b = MobileOverview(), MobileOverview()
    a.running.append(MobileJob.model_validate(mobile_job()))
    a.running[0].warnings.append("x"); a.running[0].clips.append(a.running[0].clips[0])
    assert b.running == [] and MobileJob.model_validate(mobile_job()).warnings == [] and len(MobileJob.model_validate(mobile_job()).clips) == 1


@pytest.mark.parametrize("model,payload,changes", [
    (MobileClip, dict(id="c", index=1, title="t", duration=0), ({"index": 0}, {"duration": -1})),
    (MobileJob, mobile_job(), ({"progress": -1}, {"progress": 101}, {"current_item": -1}, {"total_items": -1}, {"queue_position": 0}, {"active_elapsed_seconds": -1}, {"mode": "bad"}, {"state": "bad"}, {"style": "bad"})),
    (MobileDownload, dict(id="d", state="queued", phase="x", created_at="n", updated_at="n"), ({"downloaded_bytes": -1}, {"total_bytes": -1}, {"percent": 101}, {"state": "bad"})),
    (MobileOverview, {}, ({"recent_total": -1}, {"clips_last_day": -1}, {"failed_last_day": -1})),
])
def test_mobile_invalid_boundaries(model, payload, changes):
    for change in changes:
        invalid(model, payload | change)


def test_caption_review_input_boundaries():
    cue = dict(id="c", start=0, end=1, text="hello", confidence=1)
    assert len(CaptionReviewInput(revision=0, cues=[cue] * 500).cues) == 500
    assert CaptionReviewInput(revision=0, cues=[]).cues == []
    invalid(CaptionReviewInput, {"revision": -1, "cues": []})
    invalid(CaptionReviewInput, {"revision": 0, "cues": [cue] * 501})
    invalid(CaptionReviewInput, {"revision": 0, "cues": [{"id": "x", "start": -1, "end": 1, "text": "x"}]})


def test_shorts_text_overlay_contract():
    overlay = ShortsTextOverlay(id="x", text="", start=0, duration=0.1)
    assert (overlay.color, overlay.size, overlay.x, overlay.y) == ("#ffffff", 48, .5, .5)
    assert ShortsTextOverlay(id="x" * 80, text="t" * 500, size=8, x=0, y=1, start=0, duration=1).duration == 1
    for change in ({"size": 7.9}, {"size": 240.1}, {"x": -0.1}, {"y": 1.1}, {"color": "red"}, {"id": ""}, {"id": "x" * 81}):
        invalid(ShortsTextOverlay, {"id": "x", "text": "t"} | change)
    for key in ("start", "duration"):
        for number in (math.nan, math.inf, -math.inf):
            invalid(ShortsTextOverlay, {"id": "x", "text": "t", key: number})
    invalid(ShortsTextOverlay, {"id": "x", "text": "t", "duration": 0})


def test_folder_models_patch_and_alias_semantics():
    assert ProjectFolderUpdate.model_validate({"folderId": "f"}).move_existing_assets is False
    assert ProjectFolderUpdate.model_validate({"folder_id": "f", "move_existing_assets": True}).folder_id == "f"
    assert FolderCreate(name="n", parentId="p").model_dump(by_alias=True)["parentId"] == "p"
    assert FolderMove().parent_id is None
    omitted = FolderUpdate.model_validate({}).model_dump(by_alias=True, exclude_unset=True)
    explicit_null = FolderUpdate.model_validate({"name": None}).model_dump(by_alias=True, exclude_unset=True)
    assert omitted == {} and explicit_null == {"name": None}
    assert FolderUpdate(name="x", description="d", color="#abcdef").name == "x"
    for payload in ({"name": ""}, {"name": "x" * 101}, {"description": "x" * 501}, {"color": "bad"}):
        invalid(FolderCreate, {"name": "n"} | payload)
    for payload in ({"name": ""}, {"name": "x" * 101}, {"description": "x" * 501}, {"color": "bad"}):
        invalid(FolderUpdate, payload)


def test_asset_move_and_delete_cardinality_aliases():
    for count in (1, 500):
        ids = [str(i) for i in range(count)]
        assert len(AssetMove.model_validate({"assetIds": ids, "folderId": "f"}).asset_ids) == count
        assert len(AssetDelete.model_validate({"assetIds": ids}).asset_ids) == count
    for count in (0, 501):
        ids = [str(i) for i in range(count)]
        invalid(AssetMove, {"asset_ids": ids, "folder_id": "f"})
        invalid(AssetDelete, {"asset_ids": ids})
    invalid(AssetMove, {"asset_ids": ["a"]})


def test_named_models_forbid_extra_fields():
    cases = [
        (DownloadProgress, {}), (PenaltyItem, {"kind": "filler_words", "points": 0}),
        (CaptionDownload, {"format": "ass", "filename": "x", "url": "x"}),
        (Beat, dict(id="b", start=0, end=1, char_start=0, char_end=1, text="x", concept="x", source="x", confidence=0, match_reason="x")),
        (Health, dict(status="ready", version="1", database=True, ffmpeg=True, ffprobe=True, whisper=True, ytdlp=True, data_path="x", free_bytes=0, configured_workers=1, active_workers=0, queued_jobs=0, fallbacks={})),
        (MobileClip, {"id": "c", "index": 1, "title": "t", "duration": 0}),
        (MobileJob, mobile_job()),
        (MobileDownload, {"id": "d", "state": "queued", "phase": "x", "created_at": "x", "updated_at": "x"}),
        (MobileOverview, {}), (CaptionReviewInput, {"revision": 0, "cues": []}),
        (ShortsTextOverlay, {"id": "x", "text": "x"}), (ProjectFolderUpdate, {"folder_id": "x"}),
        (ProviderProfile, dict(id="i", name="n", text_model_id="m", selected=False, persistence="session", openrouter_configured=False, status="ok", capabilities=[], fallbacks={})),
        (FolderCreate, {"name": "n"}), (FolderUpdate, {}), (FolderMove, {}),
        (AssetMove, {"asset_ids": ["a"], "folder_id": "f"}), (AssetDelete, {"asset_ids": ["a"]}),
    ]
    for model, payload in cases:
        invalid(model, payload | {"unexpected": True})
