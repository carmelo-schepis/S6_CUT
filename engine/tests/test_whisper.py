from __future__ import annotations

import inspect
import json
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from typing import Any, ClassVar

import pytest

from engine.config import Settings
from engine.media import (
    MediaError,
    TranscriptionCancelled,
    _media_duration,
    _whisper_model_cache_path,
    extract_audio_16k,
    is_whisper_model_cached,
    transcribe,
)

# ---------------------------------------------------------------------------
#  Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def settings() -> Settings:
    return Settings.from_env()


@pytest.fixture()
def tmp_path() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-whisper-test-"))


def _make_audio_source(settings: Settings, path: Path, *, duration: float = 2.0) -> Path:
    """Create a tiny WAV test source with a sine tone."""
    src = path / "source.wav"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(src),
    ], check=True, capture_output=True, text=True)
    return src


def _make_video_with_audio(settings: Settings, path: Path, *, duration: float = 3.0) -> Path:
    """Create a tiny MP4 test source with video + audio."""
    src = path / "source.mp4"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=15:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(src),
    ], check=True, capture_output=True, text=True)
    return src


# ---------------------------------------------------------------------------
#  Mock helpers for transcribe tests
# ---------------------------------------------------------------------------


class MockWord:
    """Matches the faster-whisper Segment.word interface."""
    def __init__(self, word: str, start: float, end: float, probability: float = 0.95):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class MockSegment:
    """Matches the faster-whisper Segment interface (subset)."""
    def __init__(
        self,
        start: float,
        end: float,
        text: str,
        words: list[MockWord] | None = None,
    ):
        self.id = 0
        self.seek = start
        self.start = start
        self.end = end
        self.text = text
        self.tokens = []
        self.temperature = 0.0
        self.avg_logprob = -0.3
        self.compression_ratio = 1.0
        self.no_speech_prob = 0.05
        self.words = words


class MockWhisperModel:
    """Drop-in replacement for faster_whisper.WhisperModel for testing."""

    LOG: ClassVar[list[tuple[str, Any]]] = []

    def __init__(self, model_size_or_path: str, **kwargs: Any) -> None:
        self.LOG.clear()
        self.LOG.append(("init", {"model": model_size_or_path, **kwargs}))

    def transcribe(  # type: ignore[no-untyped-def]
        self, audio: str, **kwargs: Any
    ) -> tuple[list[MockSegment], Any]:
        self.LOG.append(("transcribe", {"audio": audio, **kwargs}))
        info = types.SimpleNamespace(language="en", duration=30.0)
        segments = [
            MockSegment(
                start=0.0, end=3.0, text="Hello world",
                words=[MockWord("Hello", 0.0, 0.5), MockWord("world", 0.6, 1.0)],
            ),
            MockSegment(
                start=3.0, end=6.0, text="This is a test",
                words=[MockWord("This", 3.0, 3.3), MockWord("is", 3.4, 3.5), MockWord("a", 3.6, 3.7), MockWord("test", 3.8, 4.0)],
            ),
            MockSegment(
                start=6.0, end=9.0, text="Final segment here",
                words=[MockWord("Final", 6.0, 6.3), MockWord("segment", 6.4, 6.7), MockWord("here", 6.8, 7.0)],
            ),
        ]
        return segments, info


def _mock_whisper(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace the lazy ``faster_whisper.WhisperModel`` import with a mock.

    Also isolates the in-memory model cache so every test starts cold.
    """
    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = MockWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    monkeypatch.setattr("engine.media._whisper_models", {})


def _dummy_source(tmp_path: Path) -> Path:
    source = tmp_path / "source.wav"
    source.write_bytes(b"dummy")
    return source


# ---------------------------------------------------------------------------
#  Settings / config defaults
# ---------------------------------------------------------------------------


class TestWhisperConfig:
    def test_defaults(self) -> None:
        s = Settings.from_env()
        assert s.whisper_model == "base"
        assert s.whisper_device == "cpu"
        assert s.whisper_compute_type == "int8"
        assert s.whisper_beam_size == 1
        assert s.whisper_word_timestamps is True

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("S6_WHISPER_DEVICE", "cuda")
        monkeypatch.setenv("S6_WHISPER_COMPUTE_TYPE", "float16")
        monkeypatch.setenv("S6_WHISPER_BEAM_SIZE", "5")
        monkeypatch.setenv("S6_WHISPER_WORD_TIMESTAMPS", "false")
        s = Settings.from_env()
        assert s.whisper_device == "cuda"
        assert s.whisper_compute_type == "float16"
        assert s.whisper_beam_size == 5
        assert s.whisper_word_timestamps is False

    def test_device_choices(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("S6_WHISPER_DEVICE", "INVALID")
        assert Settings.from_env().whisper_device == "cpu"  # falls back to default

    def test_compute_type_choices(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("S6_WHISPER_COMPUTE_TYPE", "INVALID")
        assert Settings.from_env().whisper_compute_type == "int8"  # falls back

    def test_beam_size_bounds(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("S6_WHISPER_BEAM_SIZE", "0")
        assert Settings.from_env().whisper_beam_size == 1  # minimum 1
        monkeypatch.setenv("S6_WHISPER_BEAM_SIZE", "99")
        assert Settings.from_env().whisper_beam_size == 8  # maximum 8

    def test_word_timestamps_bool(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("S6_WHISPER_WORD_TIMESTAMPS", "0")
        assert Settings.from_env().whisper_word_timestamps is False
        monkeypatch.setenv("S6_WHISPER_WORD_TIMESTAMPS", "true")
        assert Settings.from_env().whisper_word_timestamps is True
        monkeypatch.setenv("S6_WHISPER_WORD_TIMESTAMPS", "yes")
        assert Settings.from_env().whisper_word_timestamps is True


# ---------------------------------------------------------------------------
#  extract_audio_16k
# ---------------------------------------------------------------------------


class TestExtractAudio16k:
    def test_extract_to_temp(self, settings: Settings, tmp_path: Path) -> None:
        source = _make_audio_source(settings, tmp_path)
        out = extract_audio_16k(source, settings)
        assert out.exists()
        assert out.suffix == ".wav"
        assert out.stat().st_size > 44
        # Verify via ffprobe
        meta = subprocess.run(
            [settings.ffprobe, "-v", "error", "-show_streams", "-of", "json", str(out)],
            capture_output=True, text=True, check=True,
        )
        streams = json.loads(meta.stdout).get("streams", [])
        assert len(streams) == 1
        assert streams[0]["codec_name"] == "pcm_s16le"
        assert streams[0]["channels"] == 1
        assert streams[0]["sample_rate"] == "16000"

    def test_extract_to_explicit_path(self, settings: Settings, tmp_path: Path) -> None:
        source = _make_audio_source(settings, tmp_path)
        explicit = tmp_path / "custom.wav"
        result = extract_audio_16k(source, settings, output=explicit)
        assert result == explicit
        assert explicit.exists()

    def test_extract_from_video(self, settings: Settings, tmp_path: Path) -> None:
        source = _make_video_with_audio(settings, tmp_path)
        out = extract_audio_16k(source, settings)
        assert out.exists()
        assert out.stat().st_size > 44

    def test_extract_raises_on_missing_source(self, settings: Settings, tmp_path: Path) -> None:
        missing = tmp_path / "does-not-exist.mp4"
        with pytest.raises(MediaError):
            extract_audio_16k(missing, settings)

    def test_extract_raises_on_silent_source(self, settings: Settings, tmp_path: Path) -> None:
        # Video without audio
        src = tmp_path / "silent.mp4"
        subprocess.run([
            settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", str(src),
        ], check=True, capture_output=True, text=True)
        with pytest.raises(MediaError):
            extract_audio_16k(src, settings)


# ---------------------------------------------------------------------------
#  _media_duration
# ---------------------------------------------------------------------------


class TestMediaDuration:
    def test_duration_from_audio(self, settings: Settings, tmp_path: Path) -> None:
        source = _make_audio_source(settings, tmp_path, duration=1.5)
        d = _media_duration(source, settings)
        assert abs(d - 1.5) < 0.1

    def test_duration_from_video(self, settings: Settings, tmp_path: Path) -> None:
        source = _make_video_with_audio(settings, tmp_path, duration=2.0)
        d = _media_duration(source, settings)
        assert abs(d - 2.0) < 0.1

    def test_duration_fallback_to_probe(self, settings: Settings, tmp_path: Path) -> None:
        """probe_audio fails on silent video → falls back to probe."""
        src = tmp_path / "silent.mp4"
        subprocess.run([
            settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1.5",
            "-c:v", "libx264", "-preset", "ultrafast", str(src),
        ], check=True, capture_output=True, text=True)
        d = _media_duration(src, settings)
        assert abs(d - 1.5) < 0.1


# ---------------------------------------------------------------------------
#  is_whisper_model_cached / _whisper_model_cache_path
# ---------------------------------------------------------------------------


class TestWhisperModelCached:
    def test_not_cached_when_no_model_dir(self, settings: Settings, tmp_path: Path) -> None:
        # Point to a clean temp dir so no models are cached
        s = Settings(
            data_path=tmp_path,
            whisper_model="small",
            whisper_device="cpu",
            whisper_compute_type="int8",
            whisper_beam_size=1,
            whisper_word_timestamps=True,
            job_workers=1,
            max_queued_jobs=4,
            max_upload_bytes=1_000_000_000,
            max_source_seconds=3600,
            max_output_count=10,
            retention_days=30,
            max_retained_jobs=100,
            media_url_ttl=900,
            fast_guard_seconds=1.0,
            allowed_origins=("http://localhost:5173",),
            ffmpeg="ffmpeg",
            ffprobe="ffprobe",
            ytdlp="yt-dlp",
            local_tts="espeak-ng",
        )
        assert is_whisper_model_cached(s) is False
        assert _whisper_model_cache_path(s) is None

    def test_cached_with_local_path(self, settings: Settings, tmp_path: Path) -> None:
        model_dir = tmp_path / "my-model"
        model_dir.mkdir(parents=True)
        (model_dir / "model.bin").write_bytes(b"fake-model")
        (model_dir / "config.json").write_bytes(b"{}")
        s = _settings_with(settings, tmp_path, whisper_model=str(model_dir))
        assert is_whisper_model_cached(s) is True
        assert _whisper_model_cache_path(s) == model_dir

    def test_not_cached_with_local_path_missing_model_bin(self, settings: Settings, tmp_path: Path) -> None:
        model_dir = tmp_path / "my-model"
        model_dir.mkdir(parents=True)
        (model_dir / "config.json").write_bytes(b"{}")
        s = _settings_with(settings, tmp_path, whisper_model=str(model_dir))
        assert is_whisper_model_cached(s) is False

    def test_cached_with_hf_structure(self, settings: Settings, tmp_path: Path) -> None:
        """Simulate the Hugging Face cache layout for a known model."""
        models_dir = tmp_path / "models"
        snapshots = models_dir / "models--Systran--faster-whisper-small" / "snapshots" / "abc123"
        snapshots.mkdir(parents=True)
        (snapshots / "model.bin").write_bytes(b"fake-model")
        (snapshots / "config.json").write_bytes(b"{}")
        s = _settings_with(settings, tmp_path, whisper_model="small")
        assert is_whisper_model_cached(s) is True
        assert _whisper_model_cache_path(s) == snapshots

    def test_not_cached_with_empty_snapshots(self, settings: Settings, tmp_path: Path) -> None:
        models_dir = tmp_path / "models"
        snapshots = models_dir / "models--Systran--faster-whisper-base" / "snapshots"
        snapshots.mkdir(parents=True)
        # Empty snapshots dir → not cached
        s = _settings_with(settings, tmp_path, whisper_model="base")
        assert is_whisper_model_cached(s) is False

    def test_cached_with_repo_id_model(self, settings: Settings, tmp_path: Path) -> None:
        """Repo ID style models (e.g. distil-large-v3.5) resolve correctly."""
        models_dir = tmp_path / "models"
        snapshots = models_dir / "models--distil-whisper--distil-large-v3.5-ct2" / "snapshots" / "rev1"
        snapshots.mkdir(parents=True)
        (snapshots / "model.bin").write_bytes(b"fake")
        s = _settings_with(settings, tmp_path, whisper_model="distil-large-v3.5")
        assert is_whisper_model_cached(s) is True

    def test_cached_with_unknown_model_name(self, settings: Settings, tmp_path: Path) -> None:
        """Unknown model name (not in _WHISPER_MODEL_REPOS) returns False."""
        s = _settings_with(settings, tmp_path, whisper_model="does-not-exist")
        assert is_whisper_model_cached(s) is False


# ---------------------------------------------------------------------------
#  transcribe — progress callback
# ---------------------------------------------------------------------------


class TestTranscribeProgress:
    def test_progress_callback_invoked_per_segment(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        calls: list[tuple[float, str]] = []

        def cb(fraction: float, message: str) -> None:
            calls.append((fraction, message))

        result = transcribe(source, Settings.from_env(), progress_callback=cb)

        assert len(calls) == 3
        # segment 0: end=3.0 / 30.0 = 0.1
        assert abs(calls[0][0] - 0.1) < 0.001
        assert "Hello" in calls[0][1]
        # segment 1: end=6.0 / 30.0 = 0.2
        assert abs(calls[1][0] - 0.2) < 0.001
        assert "This" in calls[1][1]
        # segment 2: end=9.0 / 30.0 = 0.3
        assert abs(calls[2][0] - 0.3) < 0.001
        assert "Final" in calls[2][1]

        # Verify final transcript shape
        assert result["language"] == "en"
        assert len(result["segments"]) == 3
        assert len(result["words"]) == 9
        assert result["words"][0]["text"] == "Hello"
        assert result["words"][0]["confidence"] == 0.95
        assert result["words"][-1]["text"] == "here"

    def test_progress_not_called_when_no_callback(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)
        # Should not raise
        result = transcribe(source, Settings.from_env())
        assert result["language"] == "en"


# ---------------------------------------------------------------------------
#  transcribe — cancellation
# ---------------------------------------------------------------------------


class TestTranscribeCancellation:
    def test_cancellation_before_model_load(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        def cancel() -> bool:
            return True  # cancelled from the very first poll

        with pytest.raises(TranscriptionCancelled, match="cancelled before model load"):
            transcribe(source, Settings.from_env(), progress_callback=lambda f, m: None, cancellation_callback=cancel)

    def test_cancellation_during_decoding(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Cancel after model load + transcribe start: must abort in the segment loop."""
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        call_count = 0

        def cancel() -> bool:
            nonlocal call_count
            call_count += 1
            # Checks happen: before model load, inside lock, before decode,
            # then once per segment. Cancel on the 4th poll (first segment).
            return call_count >= 4

        with pytest.raises(TranscriptionCancelled, match="cancelled during decoding"):
            transcribe(source, Settings.from_env(), progress_callback=lambda f, m: None, cancellation_callback=cancel)
        assert call_count >= 4

    def test_no_cancellation_when_not_requested(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        result = transcribe(source, Settings.from_env())
        assert result["language"] == "en"


# ---------------------------------------------------------------------------
#  transcribe — S6_TEST_TRANSCRIPT_JSON fixture
# ---------------------------------------------------------------------------


class TestTranscribeFixture:
    def test_fixture_returns_early(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fixture = json.dumps({"language": "fi", "words": [{"text": "test", "start": 0.0, "end": 1.0, "confidence": 0.9}], "segments": []})
        monkeypatch.setenv("S6_TEST_TRANSCRIPT_JSON", fixture)
        # Even with no faster-whisper installed, the fixture path should work
        # because the import is inside transcribe and we never reach it.
        result = transcribe(Path("/dev/null"), Settings.from_env())
        assert result["language"] == "fi"
        assert result["words"][0]["text"] == "test"


# ---------------------------------------------------------------------------
#  transcribe — signature contains progress_callback (parent's check)
# ---------------------------------------------------------------------------


class TestTranscribeSignature:
    def test_signature_contains_progress_callback(self) -> None:
        sig = inspect.signature(transcribe)
        assert "progress_callback" in sig.parameters
        param = sig.parameters["progress_callback"]
        assert param.default is None
        assert param.kind == inspect.Parameter.KEYWORD_ONLY

    def test_signature_contains_cancellation_callback(self) -> None:
        sig = inspect.signature(transcribe)
        assert "cancellation_callback" in sig.parameters
        assert sig.parameters["cancellation_callback"].default is None

    def test_signature_contains_device_override(self) -> None:
        sig = inspect.signature(transcribe)
        assert "device" in sig.parameters
        assert sig.parameters["device"].default is None

    def test_signature_contains_beam_size_override(self) -> None:
        sig = inspect.signature(transcribe)
        assert "beam_size" in sig.parameters
        assert sig.parameters["beam_size"].default is None

    def test_parent_style_check_works(self) -> None:
        """Mirrors the parent's check: ``if 'progress_callback' in inspect.signature(...).parameters``."""
        sig = inspect.signature(transcribe)
        assert "progress_callback" in sig.parameters


# ---------------------------------------------------------------------------
#  transcribe — model init passes configured device/compute_type
# ---------------------------------------------------------------------------


class TestTranscribeModelInit:
    def test_model_init_uses_settings_defaults(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        MockWhisperModel.LOG.clear()
        transcribe(source, Settings.from_env())

        init_calls = [entry for entry in MockWhisperModel.LOG if entry[0] == "init"]
        assert len(init_calls) == 1
        kwargs = init_calls[0][1]
        assert kwargs["device"] == "cpu"
        assert kwargs["compute_type"] == "int8"

    def test_model_init_accepts_overrides(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        MockWhisperModel.LOG.clear()
        transcribe(source, Settings.from_env(), device="cuda", compute_type="float16", beam_size=3)

        init_calls = [entry for entry in MockWhisperModel.LOG if entry[0] == "init"]
        assert len(init_calls) == 1
        kwargs = init_calls[0][1]
        assert kwargs["device"] == "cuda"
        assert kwargs["compute_type"] == "float16"

    def test_transcribe_passes_beam_and_word_timestamps(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _mock_whisper(monkeypatch)
        monkeypatch.setattr("engine.media._media_duration", lambda *a, **kw: 30.0)
        source = _dummy_source(tmp_path)

        MockWhisperModel.LOG.clear()
        transcribe(source, Settings.from_env(), beam_size=2, word_timestamps=False)

        tx_calls = [entry for entry in MockWhisperModel.LOG if entry[0] == "transcribe"]
        assert len(tx_calls) == 1
        kwargs = tx_calls[0][1]
        assert kwargs["beam_size"] == 2
        assert kwargs["word_timestamps"] is False


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


def _settings_with(existing: Settings, data_path: Path, **overrides: Any) -> Settings:
    """Create a Settings copy with a custom data_path and optional overrides."""
    return Settings(
        data_path=data_path,
        whisper_model=overrides.get("whisper_model", existing.whisper_model),
        whisper_device=overrides.get("whisper_device", existing.whisper_device),
        whisper_compute_type=overrides.get("whisper_compute_type", existing.whisper_compute_type),
        whisper_beam_size=overrides.get("whisper_beam_size", existing.whisper_beam_size),
        whisper_word_timestamps=overrides.get("whisper_word_timestamps", existing.whisper_word_timestamps),
        job_workers=existing.job_workers,
        max_queued_jobs=existing.max_queued_jobs,
        max_upload_bytes=existing.max_upload_bytes,
        max_source_seconds=existing.max_source_seconds,
        max_output_count=existing.max_output_count,
        retention_days=existing.retention_days,
        max_retained_jobs=existing.max_retained_jobs,
        media_url_ttl=existing.media_url_ttl,
        fast_guard_seconds=existing.fast_guard_seconds,
        allowed_origins=existing.allowed_origins,
        ffmpeg=existing.ffmpeg,
        ffprobe=existing.ffprobe,
        ytdlp=existing.ytdlp,
        local_tts=existing.local_tts,
    )