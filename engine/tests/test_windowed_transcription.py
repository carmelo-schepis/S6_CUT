"""Windowed speech transcription: long audio is decoded in overlapping windows, one slice at a time.

A fake Faster-Whisper model stands in for the real one. It emits a word every half second on a
fixed grid, so the expected output is exact and seams are easy to check.
"""
from __future__ import annotations

import json
import math
import wave
from pathlib import Path
from typing import Any

import faster_whisper
import numpy as np
import pytest

from engine import media
from engine.config import Settings

RATE = 16000
SOURCE: dict[str, float] = {"seconds": 0.0}


class FakeWord:
    def __init__(self, text: str, start: float, end: float) -> None:
        self.word, self.start, self.end, self.probability = text, start, end, 0.9


class FakeSegment:
    def __init__(self, start: float, end: float, text: str, words: list[FakeWord]) -> None:
        self.start, self.end, self.text, self.words = start, end, text, words


class FakeInfo:
    language = "en"
    language_probability = 0.99


class FakeModel:
    calls: list[dict[str, Any]] = []
    language = "en"

    def __init__(self, *_: Any, **__: Any) -> None:
        pass

    def transcribe(self, audio: Any, **kwargs: Any):
        FakeModel.calls.append({"audio": audio, "kwargs": dict(kwargs)})
        if isinstance(audio, str):
            seconds = SOURCE["seconds"]
        else:
            seconds = len(audio) / RATE
            if not np.any(audio):
                return iter([]), FakeInfo()
        words: list[FakeWord] = []
        t = 0.25
        while t + 0.1 <= seconds + 1e-9:
            words.append(FakeWord(f"w{len(words)}", t, t + 0.1))
            t += 0.5
        segments = [FakeSegment(words[0].start, words[-1].end, "spoken", words)] if words else []
        info = FakeInfo()
        info.language = FakeModel.language
        return iter(segments), info


def write_wav(path: Path, seconds: float, *, rate: int = RATE, channels: int = 1, silent: bool = False) -> Path:
    frames = int(seconds * rate)
    samples = np.zeros(frames * channels, dtype=np.int16) if silent else np.full(frames * channels, 1000, dtype=np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes())
    return path


@pytest.fixture(autouse=True)
def fake_whisper(monkeypatch: pytest.MonkeyPatch):
    FakeModel.calls = []
    FakeModel.language = "en"
    SOURCE["seconds"] = 0.0
    media._whisper_models.clear()
    monkeypatch.setattr(faster_whisper, "WhisperModel", FakeModel)
    monkeypatch.delenv("S6_TEST_TRANSCRIPT_JSON", raising=False)
    return FakeModel


@pytest.fixture()
def settings() -> Settings:
    return Settings.from_env()


@pytest.fixture()
def tiny_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the window constants so a 5 s file is windowed: 1 s windows, 0.2 s overlap."""
    monkeypatch.setattr(media, "_WINDOW_THRESHOLD_SECONDS", 2.0)
    monkeypatch.setattr(media, "_WINDOW_SECONDS", 1.0)
    monkeypatch.setattr(media, "_WINDOW_OVERLAP_SECONDS", 0.2)


def _starts(result: dict[str, Any]) -> list[float]:
    return [round(word["start"], 2) for word in result["words"]]


def test_short_audio_makes_one_call_with_the_path_unchanged(tmp_path: Path, settings: Settings) -> None:
    path = write_wav(tmp_path / "short.wav", 5.0)
    SOURCE["seconds"] = 5.0
    result = media.transcribe(path, settings)
    assert len(FakeModel.calls) == 1
    assert FakeModel.calls[0]["audio"] == str(path)
    assert _starts(result) == [0.25 + 0.5 * k for k in range(10)]


def test_long_speech_is_windowed_with_bounded_arrays_and_one_copy_of_each_word(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = write_wav(tmp_path / "long.wav", 5.0)
    result = media.transcribe(path, settings)
    assert len(FakeModel.calls) == 5
    assert all(isinstance(call["audio"], np.ndarray) for call in FakeModel.calls)
    assert all(len(call["audio"]) <= 1.2 * RATE + 1 for call in FakeModel.calls)
    assert _starts(result) == [0.25 + 0.5 * k for k in range(10)]
    assert len(set(_starts(result))) == len(result["words"])
    assert result["words"] == sorted(result["words"], key=lambda item: item["start"])


def test_words_keep_absolute_times_and_the_result_shape(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = write_wav(tmp_path / "shape.wav", 5.0)
    result = media.transcribe(path, settings)
    assert set(result) >= {"language", "words", "segments"}
    assert result["language"] == "en"
    assert all(set(word) == {"text", "start", "end", "confidence"} for word in result["words"])
    assert all(word["start"] < word["end"] for word in result["words"])
    assert max(word["end"] for word in result["words"]) <= 5.0 + 1e-6
    assert all(segment["start"] >= 0 for segment in result["segments"])


def test_a_silent_window_is_allowed_when_speech_exists_elsewhere(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = tmp_path / "mixed.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(np.concatenate([np.zeros(RATE * 3, dtype=np.int16), np.full(RATE * 2, 1000, dtype=np.int16)]).tobytes())
    result = media.transcribe(path, settings)
    assert len(FakeModel.calls) == 5
    assert result["words"], "speech after the silent windows must still be transcribed"


def test_all_silent_long_audio_raises_the_existing_no_speech_error(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = write_wav(tmp_path / "silent.wav", 5.0, silent=True)
    with pytest.raises(media.MediaError, match="No speech was detected"):
        media.transcribe(path, settings)


def test_music_and_non_canonical_audio_stay_single_pass(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    SOURCE["seconds"] = 5.0
    music = write_wav(tmp_path / "music.wav", 5.0)
    media.transcribe(music, settings, profile="music")
    assert len(FakeModel.calls) == 1 and FakeModel.calls[0]["audio"] == str(music)

    FakeModel.calls = []
    stereo = write_wav(tmp_path / "stereo.wav", 5.0, channels=2)
    media.transcribe(stereo, settings)
    assert len(FakeModel.calls) == 1 and FakeModel.calls[0]["audio"] == str(stereo)

    FakeModel.calls = []
    narrow = write_wav(tmp_path / "narrow.wav", 5.0, rate=8000)
    media.transcribe(narrow, settings)
    assert len(FakeModel.calls) == 1 and FakeModel.calls[0]["audio"] == str(narrow)


def test_auto_language_is_detected_once_and_pinned_for_later_windows(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    FakeModel.language = "fr"
    path = write_wav(tmp_path / "language.wav", 5.0)
    media.transcribe(path, settings, language=None)
    assert "language" not in FakeModel.calls[0]["kwargs"]
    assert all(call["kwargs"].get("language") == "fr" for call in FakeModel.calls[1:])
    assert len(FakeModel.calls) == 5


def test_progress_stays_between_zero_and_one_and_never_goes_backwards(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = write_wav(tmp_path / "progress.wav", 5.0)
    seen: list[float] = []
    media.transcribe(path, settings, progress_callback=lambda fraction, _="": seen.append(fraction))
    assert seen
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert all(later >= earlier - 1e-9 for earlier, later in zip(seen, seen[1:]))
    assert seen[-1] == pytest.approx(1.0, abs=0.05)


def test_cancellation_stops_between_and_during_windows(tmp_path: Path, settings: Settings, tiny_windows: None) -> None:
    path = write_wav(tmp_path / "cancel.wav", 5.0)
    with pytest.raises(media.TranscriptionCancelled):
        media.transcribe(path, settings, cancellation_callback=lambda: len(FakeModel.calls) >= 1)
    assert len(FakeModel.calls) == 1


def test_the_test_fixture_hook_still_short_circuits(tmp_path: Path, settings: Settings, tiny_windows: None, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = {"language": "en", "words": [{"text": "hi", "start": 0.0, "end": 0.4, "confidence": 1.0}], "segments": []}
    monkeypatch.setenv("S6_TEST_TRANSCRIPT_JSON", json.dumps(fixture))
    path = write_wav(tmp_path / "fixture.wav", 5.0)
    assert media.transcribe(path, settings) == fixture
    assert FakeModel.calls == []


def test_window_constants_are_the_measured_defaults() -> None:
    assert media._WINDOW_THRESHOLD_SECONDS == 1200.0
    assert media._WINDOW_SECONDS == 900.0
    assert media._WINDOW_OVERLAP_SECONDS == 10.0
    assert math.isfinite(media._WINDOW_SECONDS + media._WINDOW_OVERLAP_SECONDS)
