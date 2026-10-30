from __future__ import annotations

import os
import shutil
import subprocess
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from engine import voice_separation as separation


pytestmark = pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="voice separation tests require FFmpeg and FFprobe",
)


class IdentityModel:
    def __init__(self):
        self.input_shapes: list[tuple[int, int]] = []

    def process(self, *, sample_rate: int, samples: np.ndarray):
        assert sample_rate == separation.MODEL_SAMPLE_RATE
        self.input_shapes.append(samples.shape)
        return SimpleNamespace(stems=[SimpleNamespace(data=samples.copy()), SimpleNamespace(data=samples.copy())])


def _settings(root: Path) -> SimpleNamespace:
    return SimpleNamespace(data_path=root, ffmpeg=shutil.which("ffmpeg"), ffprobe=shutil.which("ffprobe"))


def _make_source(path: Path, seconds: float, channels: int = 2) -> Path:
    frames = round(seconds * separation.MODEL_SAMPLE_RATE)
    pcm = np.random.default_rng(523).integers(-10000, 10000, size=(frames, channels), dtype=np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(separation.MODEL_SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return path


def _patch_pipeline(monkeypatch, model: IdentityModel):
    monkeypatch.setattr(separation, "_download_model", lambda *_args, **_kwargs: Path("/model-cache"))
    monkeypatch.setattr(separation, "_get_model", lambda _path: model)


@pytest.mark.parametrize("channels,seconds", [(1, 0.27), (2, 0.27), (1, 2.35), (2, 2.35)])
def test_streams_short_partial_and_multichunk_windows_with_exact_sample_count(
    tmp_path, monkeypatch, channels, seconds
):
    if seconds > 1:
        monkeypatch.setattr(separation, "CHUNK_SECONDS", 1)
    source = _make_source(tmp_path / "source.wav", seconds, channels)
    target = tmp_path / "voice.wav"
    model = IdentityModel()
    _patch_pipeline(monkeypatch, model)
    progress: list[float] = []

    result = separation.separate_voice(source, target, _settings(tmp_path), progress_callback=progress.append)

    assert result == target
    assert target.is_file()
    with wave.open(str(target), "rb") as wav:
        assert wav.getframerate() == separation.MODEL_SAMPLE_RATE
        assert wav.getnchannels() == channels
        assert wav.getnframes() == round(seconds * separation.MODEL_SAMPLE_RATE)
        assert wav.getsampwidth() == 2
    assert model.input_shapes
    assert all(shape[0] == 2 for shape in model.input_shapes)
    assert progress[-1] == 1.0
    assert progress == sorted(progress)
    if seconds > 1:
        assert len(model.input_shapes) >= 3
        reference = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source), "-map", "0:a:0",
             "-ac", "2", "-ar", str(separation.MODEL_SAMPLE_RATE), "-f", "f32le", "pipe:1"],
            check=True, capture_output=True,
        ).stdout
        expected = np.frombuffer(reference, dtype="<f4").reshape(-1, 2)
        expected_samples = expected if channels == 2 else expected.mean(axis=1, keepdims=True)
        expected_pcm = np.rint(np.clip(expected_samples, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(str(target), "rb") as wav:
            actual_pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, channels)
        np.testing.assert_array_equal(actual_pcm, expected_pcm)


def test_cancellation_removes_partial_and_preserves_existing_target(tmp_path, monkeypatch):
    source = _make_source(tmp_path / "long.wav", 2.35)
    target = tmp_path / "voice.wav"
    target.write_bytes(b"previous complete result")
    model = IdentityModel()
    _patch_pipeline(monkeypatch, model)
    monkeypatch.setattr(separation, "CHUNK_SECONDS", 1)
    progress: list[float] = []

    with pytest.raises(separation.VoiceSeparationError, match="cancelled"):
        separation.separate_voice(
            source, target, _settings(tmp_path),
            cancellation_callback=lambda: bool(progress and progress[-1] > 0),
            progress_callback=progress.append,
        )

    assert len(model.input_shapes) == 1
    assert target.read_bytes() == b"previous complete result"
    assert not list(tmp_path.glob("*.partial.wav"))
    assert not list(tmp_path.glob(".*.partial.wav"))


def test_repeated_missing_stem_recovery_replaces_atomically(tmp_path, monkeypatch):
    source = _make_source(tmp_path / "source.wav", 0.4)
    target = tmp_path / "voice.wav"
    model = IdentityModel()
    _patch_pipeline(monkeypatch, model)

    first = separation.separate_voice(source, target, _settings(tmp_path))
    first_bytes = target.read_bytes()
    second = separation.separate_voice(source, target, _settings(tmp_path))

    assert first == second == target
    assert len(model.input_shapes) == 2
    assert target.is_file() and target.read_bytes()
    with wave.open(str(target), "rb") as wav:
        assert wav.getnframes() == round(0.4 * separation.MODEL_SAMPLE_RATE)
    assert target.read_bytes() == first_bytes


@pytest.mark.parametrize("kind", ["empty", "corrupt", "missing"])
def test_invalid_source_is_rejected_without_output(tmp_path, monkeypatch, kind):
    if kind == "empty":
        source = tmp_path / "empty.wav"
        source.touch()
    elif kind == "corrupt":
        source = tmp_path / "corrupt.wav"
        source.write_bytes(b"not media")
    else:
        source = tmp_path / "missing.wav"
    target = tmp_path / "voice.wav"
    _patch_pipeline(monkeypatch, IdentityModel())

    with pytest.raises(separation.VoiceSeparationError):
        separation.separate_voice(source, target, _settings(tmp_path))

    assert not target.exists()


class ShortTailModel:
    def process(self, *, sample_rate: int, samples: np.ndarray):
        assert sample_rate == separation.MODEL_SAMPLE_RATE
        vocals = samples[:, :-128]
        return SimpleNamespace(stems=[SimpleNamespace(data=vocals), SimpleNamespace(data=vocals)])


def test_model_transform_tail_is_tolerated_only_when_requested_core_is_present():
    source = np.ones((separation.MODEL_SAMPLE_RATE * 2, 2), dtype=np.float32)
    result = separation._infer(ShortTailModel(), source, required_frames=source.shape[0] - 128)
    assert result.shape == (source.shape[0] - 128, 2)
    with pytest.raises(separation.VoiceSeparationError, match="misaligned"):
        separation._infer(ShortTailModel(), source, required_frames=source.shape[0])


def test_corrupt_or_wrong_sample_count_outputs_are_rejected(tmp_path):
    corrupt = tmp_path / "corrupt.wav"
    corrupt.write_bytes(b"broken wave")
    with pytest.raises(separation.VoiceSeparationError, match="valid WAV"):
        separation._validate_output(corrupt, 1, 2, shutil.which("ffprobe"))

    valid = tmp_path / "valid.wav"
    with wave.open(str(valid), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(separation.MODEL_SAMPLE_RATE)
        wav.writeframes(np.zeros((4, 2), dtype="<i2").tobytes())
    with pytest.raises(separation.VoiceSeparationError, match="sample count mismatch"):
        separation._validate_output(valid, 5, 2, shutil.which("ffprobe"))


def test_settings_identity_changes_when_inference_settings_change():
    assert separation._settings_identity(chunk_seconds=separation.CHUNK_SECONDS + 1) != separation.SEPARATION_SETTINGS_ID
    assert separation._settings_identity(context_seconds=separation.CONTEXT_SECONDS + 1) != separation.SEPARATION_SETTINGS_ID
    assert separation._settings_identity(sample_rate=separation.MODEL_SAMPLE_RATE + 1) != separation.SEPARATION_SETTINGS_ID


def test_model_initialization_failure_is_actionable(tmp_path, monkeypatch):
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    monkeypatch.setattr(separation, "_create_model", lambda _path: (_ for _ in ()).throw(RuntimeError("bad runtime")))
    monkeypatch.setattr(separation, "_MODEL", None)

    with pytest.raises(separation.VoiceSeparationError, match="Could not initialize sherpa-onnx"):
        separation._get_model(model_dir)


def test_model_object_cache_is_scoped_to_model_directory(tmp_path, monkeypatch):
    created: list[Path] = []
    monkeypatch.setattr(separation, "_MODEL", None)
    monkeypatch.setattr(separation, "_MODEL_CACHE", None)

    def create(directory: Path):
        created.append(directory)
        return object()

    monkeypatch.setattr(separation, "_create_model", create)
    first_dir, second_dir = tmp_path / "first", tmp_path / "second"
    assert separation._get_model(first_dir) is separation._get_model(first_dir)
    second_model = separation._get_model(second_dir)
    assert created == [first_dir, second_dir]
    assert second_model is separation._MODEL


@pytest.mark.skipif(os.getenv("S6_RUN_REAL_VOICE_MODEL") != "1", reason="opt-in real Spleeter inference")
def test_opt_in_real_model_produces_decodable_full_length_stem(tmp_path):
    source = _make_source(tmp_path / "real-model-input.wav", 2.0)
    target = tmp_path / "real-model-voice.wav"
    result = separation.separate_voice(source, target, _settings(tmp_path))
    assert result == target
    separation._validate_output(target, round(2.0 * separation.MODEL_SAMPLE_RATE), 2, shutil.which("ffprobe"))
