from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.config import Settings
from engine import media
from engine.media import MediaError, TranscriptionCancelled


@pytest.fixture
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("S6_DATA_PATH", str(tmp_path / "data"))
    value = Settings.from_env()
    return Settings(**{**value.__dict__, "ffmpeg": "sentinel-ffmpeg", "ffprobe": "sentinel-ffprobe", "ytdlp": "sentinel-ytdlp"})


def test_validate_audio_track_decodes_full_file_and_forwards_cancellation(settings, tmp_path, monkeypatch):
    path = tmp_path / "song.mp3"
    path.write_bytes(b"fixture")
    metadata = {"duration": 90.5, "audio_codec": "mp3"}
    monkeypatch.setattr(media, "probe_audio", lambda *_: metadata)
    seen = []
    callback = lambda: False
    def run(command, **kwargs):
        seen.append((command, kwargs))
    monkeypatch.setattr(media, "run", run)
    assert media.validate_audio_track(path, settings, cancellation_callback=callback) == metadata
    command, kwargs = seen[0]
    assert command[0] == settings.ffmpeg
    assert command[command.index("-i") + 1] == str(path)
    assert not {"-ss", "-sseof", "-t", "-to", "-frames:a", "-aframes", "-shortest"}.intersection(command)
    assert "-xerror" in command
    assert command[command.index("-err_detect") + 1] == "explode"
    assert command[command.index("-map") + 1] == "0:a:0"
    assert command[-3:] == ["-f", "null", "-"]
    assert kwargs == {"timeout": 241, "cancellation_callback": callback}


@pytest.mark.parametrize(("duration", "limit", "expected"), [(1, 1, 120), (0.1, None, 120), (4000, None, 7200)])
def test_validate_audio_timeout_clamps(settings, tmp_path, monkeypatch, duration, limit, expected):
    monkeypatch.setattr(media, "probe_audio", lambda *_: {"duration": duration, "audio_codec": "mp3"})
    calls = []
    monkeypatch.setattr(media, "run", lambda command, **kw: calls.append(kw))
    media.validate_audio_track(tmp_path / "x.mp3", settings, max_seconds=limit)
    assert calls[0]["timeout"] == expected


def test_validate_audio_rejects_codec_and_duration_before_decode(settings, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(media, "run", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(media, "probe_audio", lambda *_: {"duration": 4, "audio_codec": "aac"})
    with pytest.raises(MediaError):
        media.validate_audio_track(tmp_path / "x.mp3", settings)
    monkeypatch.setattr(media, "probe_audio", lambda *_: {"duration": 5, "audio_codec": "mp3"})
    with pytest.raises(MediaError):
        media.validate_audio_track(tmp_path / "x.mp3", settings, max_seconds=4)
    assert not calls


@pytest.mark.parametrize("error", [MediaError("bad decode"), TranscriptionCancelled("cancelled")])
def test_validate_audio_propagates_decoder_errors(settings, tmp_path, monkeypatch, error):
    monkeypatch.setattr(media, "probe_audio", lambda *_: {"duration": 2, "audio_codec": "mp3"})
    monkeypatch.setattr(media, "run", lambda *a, **k: (_ for _ in ()).throw(error))
    with pytest.raises(type(error)):
        media.validate_audio_track(tmp_path / "x.mp3", settings)


def test_music_transcription_hash_normalizes_and_separates_inputs(monkeypatch):
    base = media.music_transcription_source_hash("a" * 64, 1.23441, 12.3456784)
    assert base == media.music_transcription_source_hash("a" * 64, 1.23442, 12.34567849)
    assert media.music_transcription_source_hash("a" * 64, 8, -2) == media.music_transcription_source_hash("a" * 64, 1.5, 0)
    assert len(base) == 64 and set(base) <= set("0123456789abcdef")
    assert base != media.music_transcription_source_hash("b" * 64, 1.23441, 12.3456784)
    assert base != media.music_transcription_source_hash("a" * 64, 1.235, 12.3456784)
    assert base != media.music_transcription_source_hash("a" * 64, 1.23441, 12.345679)
    monkeypatch.setattr(media, "_MUSIC_AUDIO_PREPROCESSING_VERSION", "changed-test-version")
    assert base != media.music_transcription_source_hash("a" * 64, 1.23441, 12.3456784)


def test_download_audio_success_wiring_and_complete_progress(settings, tmp_path, monkeypatch):
    target = tmp_path / "audio.mp3"
    target.write_bytes(b"old")
    events = []
    seen = {}
    cancellation_callback = lambda: False
    monkeypatch.setattr(media, "validate_youtube_url", lambda url: seen.setdefault("url", "validated:" + url))
    def download(command, directory, actual_settings, **kwargs):
        seen.update(command=command, kwargs=kwargs, old_exists=target.exists())
        target.write_bytes(b"new audio")
    monkeypatch.setattr(media, "_run_ytdlp_download", download)
    monkeypatch.setattr(media, "validate_audio_track", lambda path, st, **kwargs: seen.update(validation=(path, st, kwargs)))
    result = media.download_youtube_audio("https://youtube.com/watch?v=x", target, settings,
        progress_callback=events.append, cancellation_callback=cancellation_callback, max_seconds=15)
    assert result == target and not seen["old_exists"]
    command = seen["command"]
    for flag in ("--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--output", "--max-filesize", "--write-info-json"):
        assert flag in command
    assert "validated:https://youtube.com/watch?v=x" in command
    assert seen["kwargs"]["progress_callback"].__self__ is events
    assert seen["kwargs"]["progress_callback"].__name__ == "append"
    assert seen["kwargs"]["cancellation_callback"] is cancellation_callback
    assert seen["validation"] == (target, settings, {"max_seconds": 15, "cancellation_callback": cancellation_callback})
    assert events[-1]["phase"] == "complete" and events[-1]["downloaded_bytes"] == 9


def test_download_audio_fallback_and_bad_outputs(settings, tmp_path, monkeypatch):
    target = tmp_path / "audio.mp3"
    events = []
    monkeypatch.setattr(media, "validate_youtube_url", lambda value: value)
    def fallback(*args, **kwargs):
        (tmp_path / "audio.variant.mp3").write_bytes(b"variant")
    monkeypatch.setattr(media, "_run_ytdlp_download", fallback)
    monkeypatch.setattr(media, "validate_audio_track", lambda *a, **k: None)
    assert media.download_youtube_audio("url", target, Settings.from_env(), progress_callback=events.append) == target
    assert events[-1]["downloaded_bytes"] == 7
    for empty in (None, b""):
        target.unlink(missing_ok=True)
        (tmp_path / "audio.variant.mp3").unlink(missing_ok=True)
        event_count = len(events)
        monkeypatch.setattr(media, "_run_ytdlp_download", lambda *a, **k: target.write_bytes(empty) if empty is not None else None)
        with pytest.raises(MediaError):
            media.download_youtube_audio("url", target, Settings.from_env(), progress_callback=events.append)
        assert not any(event.get("phase") == "complete" for event in events[event_count:])


def test_download_audio_validation_error_cleans_target_and_url_error_preserves(settings, tmp_path, monkeypatch):
    target = tmp_path / "audio.mp3"
    target.write_bytes(b"old")
    events = []
    starts = []
    monkeypatch.setattr(media, "validate_youtube_url", lambda value: (_ for _ in ()).throw(MediaError("invalid")))
    monkeypatch.setattr(media, "_run_ytdlp_download", lambda *a, **k: starts.append(True))
    with pytest.raises(MediaError):
        media.download_youtube_audio("bad", target, settings, progress_callback=events.append)
    assert target.read_bytes() == b"old" and not starts
    monkeypatch.setattr(media, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(media, "_run_ytdlp_download", lambda *a, **k: target.write_bytes(b"new"))
    monkeypatch.setattr(media, "validate_audio_track", lambda *a, **k: (_ for _ in ()).throw(MediaError("invalid audio")))
    with pytest.raises(MediaError):
        media.download_youtube_audio("url", target, settings, progress_callback=events.append)
    assert not target.exists() and not any(event.get("phase") == "complete" for event in events)


@pytest.mark.parametrize("payload", [{"title": "  Cafe\u0301\n\u0001music "+"x"*210}, [], {"title": 4}, {}])
def test_downloaded_audio_title_is_normalized_non_consuming(tmp_path, payload):
    source = tmp_path / "audio.mp3"
    sidecar = source.with_suffix(".info.json")
    sidecar.write_text(json.dumps(payload), encoding="utf8")
    result = media.downloaded_audio_title(source)
    if isinstance(payload, dict) and isinstance(payload.get("title"), str):
        assert result.startswith("Café music") and len(result) <= 200
    else:
        assert result is None
    assert sidecar.exists()


@pytest.mark.parametrize(("wrapper", "payload", "expected"), [
    (media.youtube_import_title, {"title": "Track"}, "Track"),
    (media.youtube_import_creator, {"channel": "Artist"}, "Artist"),
    (media.youtube_import_title, {"title": "\n"}, None),
    (media.youtube_import_creator, {}, None),
])
def test_import_wrappers_consume_sidecar(tmp_path, wrapper, payload, expected):
    source = tmp_path / "audio.mp3"
    sidecar = source.with_suffix(".info.json")
    sidecar.write_text(json.dumps(payload), encoding="utf8")
    assert wrapper(source) == expected
    assert not sidecar.exists()


def test_title_handles_missing_and_malformed_sidecars(tmp_path):
    source = tmp_path / "audio.mp3"
    assert media.downloaded_audio_title(source) is None
    source.with_suffix(".info.json").write_text("{", encoding="utf8")
    assert media.downloaded_audio_title(source) is None
