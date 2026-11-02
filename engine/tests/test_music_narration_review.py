from __future__ import annotations

import shutil
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from engine import voice_separation as separation
from engine.selection import select_candidates


def _sentence_words(prefix: str, count: int, start: float, seconds_per_word: float = 1.0) -> list[dict[str, object]]:
    words: list[dict[str, object]] = []
    for index in range(count):
        text = f"{prefix}{index}"
        if index == count - 1:
            text += "."
        words.append({
            "text": text,
            "start": start + index * seconds_per_word,
            "end": start + (index + 1) * seconds_per_word,
            "confidence": .95,
        })
    return words


def _assert_strict_clips(chosen, minimum: float, maximum: float) -> None:
    for item in chosen:
        assert minimum - 1e-6 <= item.end - item.start <= maximum + 1e-6
    ordered = sorted(chosen, key=lambda item: item.start)
    for left, right in zip(ordered, ordered[1:]):
        assert right.start >= left.end - 1e-6, (left.start, left.end, right.start, right.end)


def test_overlong_sentence_leftover_joins_the_following_sentence() -> None:
    # A 25 s sentence followed by a 5 s sentence: the valid 20-30 s window
    # is made of the leftover of the first sentence and the second sentence.
    words = _sentence_words("a", 25, 0.0) + _sentence_words("b", 5, 25.0)
    chosen = select_candidates(words, "educational", 3, 10.0, 20.0, strict_bounds=True)
    _assert_strict_clips(chosen, 10.0, 20.0)
    assert len(chosen) == 3
    assert any(item.start == pytest.approx(20.0) and item.end == pytest.approx(30.0) for item in chosen)


def test_many_short_sentences_still_produce_bounded_strict_clips() -> None:
    # Ninety one-second sentences (90 s of speech) with 20-30 s bounds must
    # yield three non-overlapping clips, not be starved by the sentence-count
    # limit that only applies to the permissive path.
    words: list[dict[str, object]] = []
    for index in range(90):
        words.extend(_sentence_words(f"s{index}_", 1, float(index)))
    chosen = select_candidates(words, "funny", 3, 20.0, 30.0, strict_bounds=True)
    _assert_strict_clips(chosen, 20.0, 30.0)
    assert len(chosen) == 3


def test_strict_selection_respects_reserved_windows_and_bounds() -> None:
    words = _sentence_words("c", 60, 0.0)
    chosen = select_candidates(
        words, "serious", 3, 10.0, 20.0, strict_bounds=True, reserved_windows=((10.0, 20.0),),
    )
    _assert_strict_clips(chosen, 10.0, 20.0)
    for item in chosen:
        assert min(item.end, 20.0) - max(item.start, 10.0) <= 1e-6


def _write_wav(path: Path, seconds: float, channels: int = 2) -> Path:
    frames = round(seconds * separation.MODEL_SAMPLE_RATE)
    pcm = np.random.default_rng(7).integers(-8000, 8000, size=(frames, channels), dtype=np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(separation.MODEL_SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return path


class _IdentityModel:
    def process(self, *, sample_rate: int, samples: np.ndarray):
        return SimpleNamespace(stems=[SimpleNamespace(data=samples.copy()), SimpleNamespace(data=samples.copy())])


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="requires FFmpeg and FFprobe")
def test_short_source_audio_is_padded_to_the_video_timeline(tmp_path, monkeypatch) -> None:
    # A 60 s video whose audio stream is 58 s must still yield a stem that
    # covers the whole video timeline, instead of failing validation.
    monkeypatch.setattr(separation, "_download_model", lambda *_args, **_kwargs: Path("/model-cache"))
    monkeypatch.setattr(separation, "_get_model", lambda _path: _IdentityModel())
    source = _write_wav(tmp_path / "short.wav", 2.0)
    target = tmp_path / "voice.wav"
    settings = SimpleNamespace(data_path=tmp_path, ffmpeg=shutil.which("ffmpeg"), ffprobe=shutil.which("ffprobe"))
    result = separation.separate_voice(source, target, settings, timeline_duration=3.0)
    assert separation.validate_voice_stem(result, 3.0, settings)
    with wave.open(str(result), "rb") as wav:
        assert wav.getnframes() == round(3.0 * separation.MODEL_SAMPLE_RATE)


def test_youtube_403_on_primary_client_falls_back_to_android_web(tmp_path, monkeypatch) -> None:
    from engine import media
    from types import SimpleNamespace as NS

    calls: list[list[str]] = []

    def fake_run(command, target_dir, settings, **_kwargs):
        calls.append(list(command))
        if len(calls) == 1:
            raise media.MediaError("ERROR: unable to download video data: HTTP Error 403: Forbidden")
        output = target_dir / "source-abc.mp4"
        output.write_bytes(b"fake")
        return [output]

    monkeypatch.setattr(media, "_run_ytdlp_download", fake_run)
    monkeypatch.setattr(media, "probe", lambda *_args, **_kwargs: None)
    settings = NS(ytdlp="yt-dlp", ytdlp_connect_timeout=5, max_upload_bytes=10**9, ytdlp_setup_timeout=60, ytdlp_inactivity_timeout=60)
    result = media.download_youtube("https://www.youtube.com/watch?v=nHvqFw8hXh8", tmp_path / "job", settings)
    assert result.name == "source-abc.mp4"
    assert len(calls) == 2
    assert "youtube:player_client=mweb" in calls[0]
    assert calls[1][-3:-1] == ["--extractor-args", "youtube:player_client=android,web,web_music"]


def test_song_audio_403_on_primary_client_falls_back_to_android_web(tmp_path, monkeypatch) -> None:
    from engine import media
    from types import SimpleNamespace as NS

    calls: list[list[str]] = []

    def fake_run(command, target_dir, settings, **_kwargs):
        calls.append(list(command))
        if len(calls) == 1:
            raise media.MediaError("ERROR: unable to download video data: HTTP Error 403: Forbidden")
        (target_dir / "song.mp3").write_bytes(b"fake-mp3")
        return []

    monkeypatch.setattr(media, "_run_ytdlp_download", fake_run)
    monkeypatch.setattr(media, "validate_audio_track", lambda *_a, **_k: None)
    settings = NS(ytdlp="yt-dlp", ytdlp_connect_timeout=5, max_upload_bytes=10**9)
    target = tmp_path / "music" / "song.mp3"
    result = media.download_youtube_audio("https://www.youtube.com/watch?v=WzucsC_ZUjE", target, settings)
    assert result == target and target.is_file()
    assert len(calls) == 2
    assert "youtube:player_client=mweb" in calls[0]
    assert calls[1][-3:-1] == ["--extractor-args", "youtube:player_client=android"]
