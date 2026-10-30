"""Bounded, local Spleeter voice separation for music tracks.

The model runs on short overlapping windows. Only a window plus its context is
resident in Python at a time; the source and final WAV are streamed through
FFmpeg/raw PCM. There is intentionally no non-model fallback here.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import threading
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any, Callable

import numpy as np


MODEL_ID = "sherpa-onnx-spleeter-2stems-fp16"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2"
)
MODEL_ARCHIVE_SHA256 = "d54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2"
MODEL_FILE_SHA256 = {
    "vocals.fp16.onnx": "24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668",
    "accompaniment.fp16.onnx": "d14cea55793cc531a5875f5f4da08207d1c5ab9292e8e0099a104eecb014fcc0",
}
MODEL_DIRNAME = MODEL_ID
MODEL_SAMPLE_RATE = 44_100
CHUNK_SECONDS = 12
CONTEXT_SECONDS = 1
_READ_FRAMES = 65_536
_CACHE_LOCK = threading.Lock()
_MODEL_LOCK = threading.Lock()
_MODEL: Any | None = None
_MODEL_CACHE: Path | None = None


class VoiceSeparationError(RuntimeError):
    """Raised when a valid isolated voice stem cannot be produced."""


class VoiceSeparationCancelled(VoiceSeparationError):
    """Raised when a caller cooperatively cancels separation."""


def _cancelled(callback: Callable[[], bool] | None) -> bool:
    if callback is not None and callback():
        raise VoiceSeparationCancelled("Voice separation was cancelled")
    return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _download_model_locked(cache_dir: Path, cancellation_callback: Callable[[], bool] | None) -> Path:
    model_dir = cache_dir / MODEL_DIRNAME
    expected = set(MODEL_FILE_SHA256)
    if model_dir.is_dir() and all(
        (model_dir / name).is_file() and _sha256(model_dir / name) == digest
        for name, digest in MODEL_FILE_SHA256.items()
    ):
        return model_dir

    cache_dir.mkdir(parents=True, exist_ok=True)
    fd, archive_name = tempfile.mkstemp(prefix=f".{MODEL_ID}.", suffix=".part", dir=cache_dir)
    archive = Path(archive_name)
    staging = cache_dir / f".{MODEL_DIRNAME}.{os.getpid()}.staging"
    try:
        _cancelled(cancellation_callback)
        try:
            request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "S6-CUT/voice-separation"})
            with os.fdopen(fd, "wb") as output, urllib.request.urlopen(request, timeout=60) as response:
                while True:
                    _cancelled(cancellation_callback)
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
        except (OSError, urllib.error.URLError) as exc:
            raise VoiceSeparationError(
                "Could not download the pinned Spleeter model. Check network access, "
                f"then retry; model URL: {MODEL_URL} ({exc})"
            ) from exc
        if _sha256(archive) != MODEL_ARCHIVE_SHA256:
            raise VoiceSeparationError(
                "Downloaded Spleeter model archive failed SHA-256 verification; refusing to load it"
            )

        if staging.exists():
            for child in staging.iterdir():
                child.unlink()
            staging.rmdir()
        staging.mkdir()
        extracted: set[str] = set()
        with tarfile.open(archive, mode="r:bz2") as bundle:
            for member in bundle.getmembers():
                base_name = Path(member.name).name
                if member.isdir() and member.name.rstrip("/") == MODEL_DIRNAME:
                    continue
                if not member.isfile() or base_name not in expected or member.name != f"{MODEL_DIRNAME}/{base_name}":
                    raise VoiceSeparationError(f"Unexpected file in pinned Spleeter model archive: {member.name}")
                if base_name in extracted:
                    raise VoiceSeparationError(f"Duplicate file in pinned Spleeter model archive: {base_name}")
                source = bundle.extractfile(member)
                if source is None:
                    raise VoiceSeparationError(f"Could not read model file {base_name} from archive")
                target = staging / base_name
                with source, target.open("wb") as output:
                    while True:
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        output.write(block)
                if _sha256(target) != MODEL_FILE_SHA256[base_name]:
                    raise VoiceSeparationError(f"Pinned Spleeter model file failed SHA-256 verification: {base_name}")
                extracted.add(base_name)
        if extracted != expected:
            raise VoiceSeparationError("Pinned Spleeter model archive is missing an expected ONNX file")
        if model_dir.exists():
            for child in model_dir.iterdir():
                if child.is_file():
                    child.unlink()
            model_dir.rmdir()
        os.replace(staging, model_dir)
        return model_dir
    except (tarfile.TarError, OSError) as exc:
        if isinstance(exc, VoiceSeparationError):
            raise
        raise VoiceSeparationError(f"Could not prepare the pinned Spleeter model cache: {exc}") from exc
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        archive.unlink(missing_ok=True)
        if staging.exists():
            for child in staging.iterdir():
                child.unlink(missing_ok=True)
            staging.rmdir()


def _download_model(cache_dir: Path, cancellation_callback: Callable[[], bool] | None) -> Path:
    # Jobs can request separation concurrently. Serialize download/extraction
    # so they share a single validated cache and never race the staging dir.
    with _CACHE_LOCK:
        return _download_model_locked(cache_dir, cancellation_callback)


def _create_model(model_dir: Path) -> Any:
    try:
        import sherpa_onnx

        config = sherpa_onnx.OfflineSourceSeparationConfig(
            model=sherpa_onnx.OfflineSourceSeparationModelConfig(
                spleeter=sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(
                    vocals=str(model_dir / "vocals.fp16.onnx"),
                    accompaniment=str(model_dir / "accompaniment.fp16.onnx"),
                ),
                num_threads=1,
                debug=False,
                provider="cpu",
            )
        )
        if not config.validate():
            raise VoiceSeparationError("sherpa-onnx rejected the pinned Spleeter model configuration")
        return sherpa_onnx.OfflineSourceSeparation(config)
    except VoiceSeparationError:
        raise
    except Exception as exc:
        raise VoiceSeparationError(
            "Could not initialize sherpa-onnx Spleeter CPU inference; verify the pinned "
            f"runtime and model cache ({exc})"
        ) from exc


def _get_model(model_dir: Path) -> Any:
    global _MODEL, _MODEL_CACHE
    with _MODEL_LOCK:
        if _MODEL is None or _MODEL_CACHE != model_dir:
            try:
                _MODEL = _create_model(model_dir)
            except VoiceSeparationError:
                raise
            except Exception as exc:
                raise VoiceSeparationError(
                    "Could not initialize sherpa-onnx Spleeter CPU inference; verify the pinned "
                    f"runtime and model cache ({exc})"
                ) from exc
            _MODEL_CACHE = model_dir
        return _MODEL


def _probe_audio(source: Path, ffprobe: str) -> tuple[float, int]:
    command = [
        ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=duration,channels,sample_rate", "-of", "json", str(source),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        streams = json.loads(result.stdout).get("streams", [])
        if not streams:
            raise VoiceSeparationError("Source has no decodable audio stream")
        stream = streams[0]
        channels = int(stream["channels"])
        duration = float(stream.get("duration") or 0)
        if duration <= 0:
            duration_cmd = [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)]
            duration = float(subprocess.run(duration_cmd, check=True, capture_output=True, text=True, timeout=30).stdout.strip())
        if not np.isfinite(duration) or duration <= 0 or channels not in (1, 2):
            raise VoiceSeparationError("Source audio must have a positive duration and one or two channels")
        return duration, channels
    except VoiceSeparationError:
        raise
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise VoiceSeparationError(f"Could not inspect source audio with ffprobe: {exc}") from exc


def _read_exact(stream: Any, count: int) -> bytes:
    parts: list[bytes] = []
    remaining = count
    while remaining:
        block = stream.read(remaining)
        if not block:
            break
        parts.append(block)
        remaining -= len(block)
    return b"".join(parts)


def _infer(model: Any, chunk: np.ndarray, *, required_frames: int | None = None) -> np.ndarray:
    result = model.process(sample_rate=MODEL_SAMPLE_RATE, samples=np.ascontiguousarray(chunk.T, dtype=np.float32))
    stems = result.stems
    if len(stems) != 2:
        raise VoiceSeparationError(f"Spleeter returned {len(stems)} stems; expected two")
    data = np.asarray(stems[0].data, dtype=np.float32)
    if data.ndim != 2:
        raise VoiceSeparationError("Spleeter returned an invalid vocals tensor")
    if data.shape[0] == 2:
        vocals = data.T
    elif data.shape[1] == 2:
        vocals = data
    else:
        raise VoiceSeparationError(f"Spleeter returned an unexpected vocals shape: {data.shape}")
    # Spleeter may trim its transform tail (the length depends on input size).
    # Validate that the entire requested core is present; context after the
    # core absorbs the model's trailing trim without shifting written samples.
    required = chunk.shape[0] if required_frames is None else required_frames
    if vocals.shape[0] > chunk.shape[0] or vocals.shape[0] < required or not np.isfinite(vocals).all():
        raise VoiceSeparationError("Spleeter returned non-finite or misaligned vocals audio")
    return vocals


def _write_pcm16(output: wave.Wave_write, stereo: np.ndarray, channels: int) -> None:
    samples = stereo if channels == 2 else stereo.mean(axis=1, keepdims=True)
    if not np.isfinite(samples).all():
        raise VoiceSeparationError("Spleeter produced non-finite samples")
    pcm = np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    output.writeframesraw(pcm.tobytes())


def _validate_output(path: Path, expected_frames: int, channels: int, ffprobe: str) -> None:
    if expected_frames <= 0:
        raise VoiceSeparationError("Generated voice stem must contain audio samples")
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getframerate() != MODEL_SAMPLE_RATE or wav.getnchannels() != channels or wav.getsampwidth() != 2:
                raise VoiceSeparationError("Generated voice stem has an unexpected WAV format")
            if wav.getnframes() != expected_frames:
                raise VoiceSeparationError(
                    f"Generated voice stem sample count mismatch: expected {expected_frames}, got {wav.getnframes()}"
                )
            while block := wav.readframes(_READ_FRAMES):
                values = np.frombuffer(block, dtype="<i2")
                if values.size == 0:
                    raise VoiceSeparationError("Generated voice stem contains an empty/corrupt PCM block")
    except (wave.Error, EOFError, OSError) as exc:
        raise VoiceSeparationError(f"Generated voice stem is not a valid WAV: {exc}") from exc
    command = [ffprobe, "-v", "error", "-show_entries", "stream=codec_name,duration,sample_rate,channels", "-of", "json", str(path)]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        streams = json.loads(result.stdout).get("streams", [])
        if len(streams) != 1 or streams[0].get("codec_name") != "pcm_s16le":
            raise VoiceSeparationError("Generated voice stem failed FFprobe PCM validation")
    except VoiceSeparationError:
        raise
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise VoiceSeparationError(f"Generated voice stem could not be decoded by FFprobe: {exc}") from exc


def validate_voice_stem(path: Path | str, duration: float, settings: Any) -> bool:
    """Return whether a cached stem is a valid, duration-aligned PCM WAV."""
    try:
        with wave.open(str(path), "rb") as wav:
            frames, channels = wav.getnframes(), wav.getnchannels()
        if channels not in (1, 2) or abs(frames / MODEL_SAMPLE_RATE - duration) > max(0.1, duration * 0.005):
            return False
        _validate_output(Path(path), frames, channels, settings.ffprobe)
        return True
    except (OSError, wave.Error, VoiceSeparationError):
        return False


def separate_voice(
    source: Path | str,
    target: Path | str,
    settings: Any,
    cancellation_callback: Callable[[], bool] | None = None,
    progress_callback: Callable[[float], None] | None = None,
) -> Path:
    """Write an isolated Spleeter vocals WAV atomically and return its path."""
    source_path, target_path = Path(source), Path(target)
    if not source_path.is_file() or source_path.stat().st_size <= 0:
        raise VoiceSeparationError(f"Source audio is missing or empty: {source_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)
    duration, channels = _probe_audio(source_path, settings.ffprobe)
    model_dir = _download_model(Path(settings.data_path) / "models", cancellation_callback)
    model = _get_model(model_dir)

    fd, partial_name = tempfile.mkstemp(
        prefix=f".{target_path.name}.", suffix=".partial.wav", dir=target_path.parent
    )
    os.close(fd)
    partial = Path(partial_name)
    process: subprocess.Popen[bytes] | None = None
    expected_frames = 0
    chunk_frames = CHUNK_SECONDS * MODEL_SAMPLE_RATE
    context_frames = CONTEXT_SECONDS * MODEL_SAMPLE_RATE
    bytes_per_frame = 2 * 4
    try:
        command = [
            settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode",
            "-nostdin", "-i", str(source_path),
            "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", str(MODEL_SAMPLE_RATE),
            "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1",
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.stdout is None:
            raise VoiceSeparationError("FFmpeg did not provide a source audio stream")
        with wave.open(str(partial), "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(2)
            wav.setframerate(MODEL_SAMPLE_RATE)
            carry = np.empty((0, 2), dtype=np.float32)
            eof = False
            while True:
                _cancelled(cancellation_callback)
                while carry.shape[0] < chunk_frames + context_frames and not eof:
                    raw = _read_exact(process.stdout, _READ_FRAMES * bytes_per_frame)
                    if not raw:
                        eof = True
                        break
                    if len(raw) % bytes_per_frame:
                        raise VoiceSeparationError("FFmpeg returned a truncated PCM sample frame")
                    decoded = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
                    if not np.isfinite(decoded).all():
                        raise VoiceSeparationError("Source audio decoded to non-finite samples")
                    carry = np.concatenate((carry, decoded), axis=0)
                if carry.shape[0] == 0:
                    break
                core_count = min(chunk_frames, carry.shape[0])
                future_count = min(context_frames, max(0, carry.shape[0] - core_count))
                if not eof and core_count == chunk_frames and future_count < context_frames:
                    continue
                left_context = (
                    np.repeat(carry[:1], context_frames, axis=0)
                    if expected_frames == 0 else previous_context
                )
                right = carry[core_count:core_count + context_frames]
                right_pad_count = context_frames - right.shape[0]
                window = np.concatenate(
                    (
                        left_context,
                        carry[:core_count + right.shape[0]],
                        np.zeros((right_pad_count, 2), dtype=np.float32),
                    ), axis=0,
                )
                # Every window starts with one second of context. The first
                # chunk repeats its first sample; later chunks prepend the real
                # preceding audio saved from the previous core. In both cases
                # the current core begins after that context.
                start = context_frames
                vocals = _infer(model, window, required_frames=start + core_count)
                _write_pcm16(wav, vocals[start:start + core_count], channels)
                expected_frames += core_count
                if progress_callback is not None:
                    progress_callback(min(0.99, expected_frames / (duration * MODEL_SAMPLE_RATE)))
                if eof and core_count == carry.shape[0]:
                    carry = np.empty((0, 2), dtype=np.float32)
                    break
                previous_context = carry[max(0, core_count - context_frames):core_count]
                carry = carry[core_count:]

        if process.stdout:
            process.stdout.close()
        stderr = process.stderr.read() if process.stderr else b""
        return_code = process.wait(timeout=60)
        if return_code != 0:
            raise VoiceSeparationError(f"FFmpeg could not decode source audio: {stderr.decode(errors='replace')[-1000:]}")
        if expected_frames == 0:
            raise VoiceSeparationError("Source audio decoded to no samples")
        output_duration = expected_frames / MODEL_SAMPLE_RATE
        duration_tolerance = max(0.1, duration * 0.005)
        if abs(output_duration - duration) > duration_tolerance:
            raise VoiceSeparationError(
                "Decoded source length does not match its audio duration metadata "
                f"({output_duration:.3f}s decoded, {duration:.3f}s reported)"
            )
        _cancelled(cancellation_callback)
        _validate_output(partial, expected_frames, channels, settings.ffprobe)
        os.replace(partial, target_path)
        if progress_callback is not None:
            progress_callback(1.0)
        return target_path
    except VoiceSeparationError:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise
    except Exception as exc:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise VoiceSeparationError(f"Voice separation failed: {exc}") from exc
    finally:
        if process is not None:
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()
        partial.unlink(missing_ok=True)
