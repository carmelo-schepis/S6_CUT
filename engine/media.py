from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import selectors
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from .config import Settings
from .security import redact, validate_youtube_url

ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_whisper_lock = threading.Lock()
_whisper_models: dict[str, Any] = {}

# Shared final-delivery profile: high quality, local, and browser compatible.
DELIVERY_VIDEO_CODEC = "libx264"
DELIVERY_PRESET = "slow"
DELIVERY_CRF = "18"
DELIVERY_AUDIO_CODEC = "aac"
DELIVERY_AUDIO_BITRATE = "192k"
DELIVERY_AUDIO_RATE = "48000"
# Prefer YouTube's separate highest-quality streams while bounding acquisition to
# the delivery ceiling. The progressive branch is only a compatibility fallback
# for videos that do not expose a mergeable video+audio pair.
YOUTUBE_FORMAT_SELECTOR = "bv*[height<=1080]+ba/b[height<=1080]"
# YouTube now binds full-length Google Video Server access to a per-video
# Proof-of-Origin token for the mweb client. The provider is an internal Compose
# service; keeping its URL here ensures every production download uses the same
# token-aware path that exposes the complete high-resolution streams.
YOUTUBE_EXTRACTOR_ARGS = (
    "youtube:player_client=mweb",
    "youtubepot-bgutilhttp:base_url=http://pot-provider:4416",
)


class MediaError(RuntimeError):
    pass


class TranscriptionCancelled(MediaError):
    """Raised when a caller-provided cancellation callback reports True."""


class DownloadStalled(MediaError):
    """Raised after a YouTube download has made no measurable progress."""


DownloadCallback = Callable[[dict[str, Any]], None]


# Stable faster-whisper model-name → Hugging Face repo ID mapping. Only used to
# locate the on-disk cache; transcription itself keeps using settings.whisper_model.
_WHISPER_MODEL_REPOS: dict[str, str] = {
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "tiny": "Systran/faster-whisper-tiny",
    "base.en": "Systran/faster-whisper-base.en",
    "base": "Systran/faster-whisper-base",
    "small.en": "Systran/faster-whisper-small.en",
    "small": "Systran/faster-whisper-small",
    "medium.en": "Systran/faster-whisper-medium.en",
    "medium": "Systran/faster-whisper-medium",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large": "Systran/faster-whisper-large-v3",
    "distil-large-v2": "Systran/faster-distil-whisper-large-v2",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
    "distil-large-v3.5": "distil-whisper/distil-large-v3.5-ct2",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}


def _whisper_repo_id(model: str) -> str:
    """Hugging Face repo ID for a faster-whisper model name or explicit repo ID."""
    if "/" in model:
        return model
    return _WHISPER_MODEL_REPOS.get(model, model)


def _whisper_model_cache_path(settings: Settings) -> Path | None:
    """Resolve the downloaded model directory, or None when it is not cached yet.

    Faster-Whisper stores models in the Hugging Face cache layout under
    ``S6_DATA_PATH/models``; a model counts as cached when one snapshot
    directory contains the CTranslate2 ``model.bin`` file. Local model paths
    (absolute or relative) are recognised directly.
    """
    candidate = Path(settings.whisper_model)
    if (candidate / "model.bin").is_file():
        return candidate
    repo_id = _whisper_repo_id(settings.whisper_model)
    snapshots = settings.data_path / "models" / f"models--{repo_id.replace('/', '--')}" / "snapshots"
    if not snapshots.is_dir():
        return None
    for revision in sorted(snapshots.iterdir()):
        if revision.is_dir() and (revision / "model.bin").is_file():
            return revision
    return None


def is_whisper_model_cached(settings: Settings) -> bool:
    """True when the configured Whisper model is already downloaded on disk.

    This is an observability helper: callers can skip the "model download"
    stage (or show it as instant) without loading the model into memory.
    """
    return _whisper_model_cache_path(settings) is not None


def _rational_to_float(value: str | None) -> float | None:
    """Parse an FFprobe rational like ``30000/1001`` into a float (29.97...)."""
    if not value:
        return None
    numerator, _, denominator = value.partition("/")
    try:
        numerator_float = float(numerator)
        denominator_float = float(denominator) if denominator else 1.0
    except ValueError:
        return None
    if denominator_float <= 0 or numerator_float <= 0 or math.isinf(numerator_float / denominator_float):
        return None
    return numerator_float / denominator_float


def _rotation_from_stream(video: dict[str, Any]) -> int:
    """Best-effort rotation in degrees (0, 90, 180, 270) from FFprobe output."""
    rotation = video.get("rotation")
    if rotation is not None and rotation != "":
        try:
            return int(rotation) % 360
        except (TypeError, ValueError):
            pass
    tags = video.get("tags") or {}
    rotate = next((value for key, value in tags.items() if str(key).casefold() == "rotate"), None)
    if rotate is not None:
        try:
            return int(float(rotate)) % 360
        except (TypeError, ValueError):
            pass
    for side_data in video.get("side_data_list") or []:
        rotate = next((value for key, value in side_data.items() if str(key).casefold() == "rotation"), None)
        if rotate is not None:
            try:
                return int(round(float(rotate))) % 360
            except (TypeError, ValueError):
                continue
    return 0


def available(command: str) -> bool:
    return shutil.which(command) is not None or Path(command).is_file()


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 3600, cancellation_callback: Callable[[], bool] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        if cancellation_callback is None:
            result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
        else:
            process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            started = time.monotonic()
            while process.poll() is None:
                if cancellation_callback():
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    raise TranscriptionCancelled("Media operation cancelled")
                if time.monotonic() - started > timeout:
                    process.kill()
                    process.wait()
                    raise MediaError(f"{Path(command[0]).name} timed out")
                time.sleep(.05)
            stdout, stderr = process.communicate()
            result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except TranscriptionCancelled:
        raise
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaError(redact(str(exc))) from exc
    if result.returncode:
        detail = result.stderr.strip().splitlines()[-8:]
        raise MediaError(redact("\n".join(detail) or f"{Path(command[0]).name} failed"))
    return result


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


# DO-NOT-CHANGE: enforces max_source_seconds via settings; rotation handling is fragile
def probe(path: Path, settings: Settings, *, max_seconds: int | None = None) -> dict[str, Any]:
    result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    try:
        payload = json.loads(result.stdout)
        streams = payload.get("streams", [])
        video = next((item for item in streams if item.get("codec_type") == "video"), None)
        audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
        duration = float(payload.get("format", {}).get("duration") or (video or {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe returned malformed media metadata") from exc
    if not video or duration <= 0:
        raise MediaError("The source does not contain a readable video stream")
    duration_limit = settings.max_source_seconds if max_seconds is None else max_seconds
    if duration > duration_limit:
        raise MediaError(f"Source duration {duration:.1f}s exceeds the configured {duration_limit}-second limit; choose Long form for sources up to {settings.max_long_source_seconds}s." if max_seconds is None else f"Source duration {duration:.1f}s exceeds the configured {duration_limit}-second limit")
    frame_rate = _rational_to_float(video.get("avg_frame_rate")) or _rational_to_float(video.get("r_frame_rate")) or 0.0
    return {
        "duration": duration,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "video_codec": video.get("codec_name"),
        "video_bitrate": int(video["bit_rate"]) if str(video.get("bit_rate", "")).isdigit() else None,
        "pixel_format": video.get("pix_fmt"),
        "color_space": video.get("color_space"),
        "color_transfer": video.get("color_transfer"),
        "color_primaries": video.get("color_primaries"),
        "audio": bool(audio),
        "audio_codec": audio.get("codec_name") if audio else None,
        "audio_bitrate": int(audio["bit_rate"]) if audio and str(audio.get("bit_rate", "")).isdigit() else None,
        "audio_sample_rate": int(audio["sample_rate"]) if audio and str(audio.get("sample_rate", "")).isdigit() else None,
        "audio_channels": int(audio["channels"]) if audio and str(audio.get("channels", "")).isdigit() else None,
        "frame_rate": round(frame_rate, 3),
        "rotation": _rotation_from_stream(video),
    }


def probe_audio(path: Path, settings: Settings) -> dict[str, Any]:
    result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    try:
        payload = json.loads(result.stdout)
        audio = next((item for item in payload.get("streams", []) if item.get("codec_type") == "audio"), None)
        duration = float(payload.get("format", {}).get("duration") or (audio or {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe returned malformed audio metadata") from exc
    if not audio or duration <= 0:
        raise MediaError("Narration does not contain a readable audio stream")
    return {"duration": duration, "audio_codec": audio.get("codec_name")}


def validate_video_upload(path: Path, original_name: str, settings: Settings, *, max_seconds: int | None = None) -> dict[str, Any]:
    if Path(original_name).suffix.casefold() not in ALLOWED_VIDEO_SUFFIXES:
        raise MediaError("Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
    return probe(path, settings, max_seconds=max_seconds)


def _cleanup_partials(target_dir: Path) -> None:
    """Remove yt-dlp temporary/partial files to avoid stale state on retry."""
    try:
        for pattern in ("*.part", "*.ytdl", "*.part-Frag*"):
            for partial in target_dir.glob(pattern):
                if partial.is_file():
                    partial.unlink(missing_ok=True)
    except OSError:
        pass


def _download_update(callback: DownloadCallback | None, **values: Any) -> None:
    if callback:
        try:
            callback(values)
        except Exception:
            # Progress is observational and must never break an otherwise valid import.
            pass


def _parse_download_line(line: str) -> dict[str, Any] | None:
    if not line.startswith("download:"):
        return None
    parts = line.removeprefix("download:").split("|", 6)
    if len(parts) != 7:
        return None
    status, downloaded, total, estimate, speed, eta, percent = parts

    def number(value: str) -> float | None:
        try:
            return float(value) if value and value not in {"NA", "N/A", "none"} else None
        except ValueError:
            return None

    downloaded_value = number(downloaded)
    # An estimate is useful for yt-dlp's own percentage, but is not presented
    # as a confirmed total to users.
    total_value = number(total)
    speed_value = number(speed)
    eta_value = number(eta)
    return {
        "status": status, "downloaded_bytes": int(downloaded_value or 0),
        "total_bytes": int(total_value) if total_value is not None else None,
        "speed_bytes_per_second": speed_value, "eta_seconds": eta_value,
        "percent": number(percent.rstrip("%")),
    }


def _run_ytdlp_download(
    command: list[str], target_dir: Path, settings: Settings, *,
    progress_callback: DownloadCallback | None = None,
    cancellation_callback: Callable[[], bool] | None = None,
) -> list[Path]:
    started = time.monotonic()
    first_progress: float | None = None
    last_byte_progress = started
    last_output = started
    lines: list[str] = []
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(command, cwd=target_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        _download_update(progress_callback, phase="connecting", downloaded_bytes=0, total_bytes=None, percent=None, message="Connecting to YouTube")
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            ready = selector.select(timeout=0.25)
            now = time.monotonic()
            if ready:
                line = process.stdout.readline()
                if line:
                    last_output = now
                    clean = line.strip()
                    if clean:
                        lines.append(clean)
                    update = _parse_download_line(clean)
                    if update:
                        if first_progress is None:
                            first_progress = now
                        if update["downloaded_bytes"] > 0:
                            last_byte_progress = now
                        _download_update(progress_callback, phase="downloading", **update)
                elif process.poll() is not None:
                    break
            elif process.poll() is not None:
                break
            if cancellation_callback and cancellation_callback():
                process.terminate()
                process.wait(timeout=5)
                raise TranscriptionCancelled("YouTube import cancelled")
            if first_progress is None:
                # Setup (player JS fetch, JS-challenge solving, PO-token minting)
                # is silent for long stretches and is a separate budget from the
                # per-socket read timeout; using the socket timeout here killed
                # healthy imports before the first byte.
                if now - max(started, last_output) > settings.ytdlp_setup_timeout:
                    process.kill(); process.wait()
                    _download_update(progress_callback, phase="stalled", message="Preparing the download timed out before any data arrived")
                    raise DownloadStalled("Preparing the YouTube download timed out before any data arrived")
            elif now - last_byte_progress > settings.ytdlp_inactivity_timeout:
                process.kill(); process.wait()
                _download_update(progress_callback, phase="stalled", message="The download stalled; no data arrived for several minutes")
                raise DownloadStalled("The download stalled; no data arrived for several minutes")
        output = process.returncode or 0
        if output:
            detail = "\n".join(lines[-8:])
            raise MediaError(redact(detail or "yt-dlp failed"))
    except TranscriptionCancelled:
        raise
    except DownloadStalled:
        raise
    except (OSError, subprocess.TimeoutExpired) as exc:
        if process and process.poll() is None:
            process.kill(); process.wait()
        raise MediaError(redact(str(exc))) from exc
    return [item for item in target_dir.glob("source-*") if item.suffix.casefold() in ALLOWED_VIDEO_SUFFIXES and item.is_file()]


def download_youtube(
    url: str, target_dir: Path, settings: Settings, *,
    progress_callback: DownloadCallback | None = None,
    cancellation_callback: Callable[[], bool] | None = None,
    resume: bool = True,
    max_seconds: int | None = None,
) -> Path:
    validate_youtube_url(url)
    target_dir.mkdir(parents=True, exist_ok=True)
    template = str(target_dir / "source-%(id)s.%(ext)s")
    common = [
        settings.ytdlp, "--no-playlist", "--no-warnings", "--restrict-filenames", "--write-info-json",
        "--newline", "--progress", "--progress-delta", "1", "--socket-timeout", str(settings.ytdlp_connect_timeout),
        "--retries", "3", "--fragment-retries", "3", "--max-filesize", str(settings.max_upload_bytes),
        "--format", YOUTUBE_FORMAT_SELECTOR,
        "--merge-output-format", "mp4", "--output", template,
        "--progress-template", "download:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s",
        "--print", "after_move:filepath",
    ]
    for extractor_args in YOUTUBE_EXTRACTOR_ARGS:
        common.extend(("--extractor-args", extractor_args))
    if resume:
        common.append("--continue")
    common.append(url)
    candidates = _run_ytdlp_download(common, target_dir, settings, progress_callback=progress_callback, cancellation_callback=cancellation_callback)
    if not candidates:
        _cleanup_partials(target_dir)
        retry = common.copy()
        retry[-1:-1] = ["--extractor-args", "youtube:player_client=android,web,web_music"]
        candidates = _run_ytdlp_download(retry, target_dir, settings, progress_callback=progress_callback, cancellation_callback=cancellation_callback)
    if not candidates:
        raise MediaError("YouTube import completed without a usable video file")
    source = candidates[-1].resolve()
    if target_dir.resolve() not in source.parents:
        raise MediaError("YouTube output escaped its job directory")
    probe(source, settings, max_seconds=max_seconds)
    _download_update(progress_callback, phase="complete", downloaded_bytes=source.stat().st_size, total_bytes=source.stat().st_size, percent=100.0, speed_bytes_per_second=None, eta_seconds=0.0, message="Download complete")
    return source


def youtube_import_title(source: Path) -> str | None:
    """Read yt-dlp's local metadata sidecar without exposing or retaining it as media."""
    info = source.with_suffix(".info.json")
    if not info.is_file():
        return None
    try:
        payload = json.loads(info.read_text(encoding="utf-8"))
        title = str(payload.get("title") or "").strip()
        return title[:200] or None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    finally:
        info.unlink(missing_ok=True)


def _media_duration(path: Path, settings: Settings) -> float:
    """Total media duration in seconds for progress normalisation.

    Prefers the audio stream (Whisper only consumes audio); falls back to the
    video container duration for silent or metadata-only inputs.
    """
    try:
        return float(probe_audio(path, settings)["duration"])
    except MediaError:
        return float(probe(path, settings)["duration"])


def extract_audio_16k(source: Path, settings: Settings, *, output: Path | None = None, start: float | None = None, duration: float | None = None, cancellation_callback: Callable[[], bool] | None = None) -> Path:
    """Extract a 16 kHz mono PCM WAV for Whisper consumption.

    Faster-Whisper decodes media with its own FFmpeg invocation; extracting a
    canonical 16 kHz mono WAV first makes decoding deterministic, enables
    duration-based progress, and lets callers reuse the audio across runs.

    Parameters
    ----------
    source : Path
        Any media file with an audio track.
    settings : Settings
        Engine runtime settings (FFmpeg binary reference).
    output : Path | None
        Explicit output path. When omitted, a unique file is created under
        ``S6_DATA_PATH/temp``. The caller owns cleanup of returned files.

    Returns
    -------
    Path
        The extracted WAV file (16 kHz, mono, PCM s16le).

    Raises
    ------
    MediaError
        When the source has no readable audio or extraction fails.
    """
    target = output or (settings.data_path / "temp" / f"whisper-{os.urandom(6).hex()}.wav")
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if start is not None:
        command.extend(["-ss", f"{max(0.0, start):.3f}"])
    command.extend(["-i", str(source)])
    if duration is not None:
        command.extend(["-t", f"{max(0.1, duration):.3f}"])
    command.extend(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)])
    run(command, timeout=900, cancellation_callback=cancellation_callback)
    if not target.is_file() or target.stat().st_size < 44:
        raise MediaError("Audio extraction did not produce a usable 16 kHz WAV")
    return target


# DO-NOT-CHANGE: Faster-Whisper with word timestamps REQUIRED (captions depend on them);
# S6_TEST_TRANSCRIPT_JSON env var is the test fixture hook — keep it
def transcribe(
    path: Path,
    settings: Settings,
    *,
    progress_callback: Callable[[float, str], object] | None = None,
    cancellation_callback: Callable[[], bool] | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    word_timestamps: bool | None = None,
) -> dict[str, Any]:
    """Transcribe media with Faster-Whisper and return word-level timing.

    Parameters
    ----------
    path : Path
        Source media file (video or audio).
    settings : Settings
        Engine runtime settings, including Whisper device/compute/beam defaults.
    progress_callback : Callable[[float, str], object] | None
        Invoked incrementally with ``(fraction, message)`` as real segments are
        decoded, where ``fraction`` is ``segment.end / total duration`` clamped
        to ``[0, 1]`` and ``message`` is the decoded segment text. Progress is
        always derived from actual segment boundaries — never simulated. The
        caller throttles/persists; this function calls back on every segment.
    cancellation_callback : Callable[[], bool] | None
        Polled between segments (and before model load/decoding). Returning
        ``True`` aborts transcription with :class:`TranscriptionCancelled`.
    device : str | None
        Override ``S6_WHISPER_DEVICE`` (cpu/auto/cuda).
    compute_type : str | None
        Override ``S6_WHISPER_COMPUTE_TYPE`` (int8/int8_float16/float16/float32/auto).
    beam_size : int | None
        Override ``S6_WHISPER_BEAM_SIZE`` (1..8). Lower beams are faster on CPU.
    word_timestamps : bool | None
        Override ``S6_WHISPER_WORD_TIMESTAMPS``; word timing is required for
        caption rendering, so callers disabling it must handle missing words.

    Returns
    -------
    dict[str, Any]
        ``{"language": str, "words": [...], "segments": [...]}`` compatible
        with the ``S6_TEST_TRANSCRIPT_JSON`` fixture shape. ``words`` carry
        ``text/start/end/confidence``; ``segments`` carry ``start/end/text``.
    """
    fixture = os.getenv("S6_TEST_TRANSCRIPT_JSON")
    if fixture:
        return json.loads(fixture)
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise MediaError("Local Whisper is not installed in this engine runtime") from exc

    run_device = device or settings.whisper_device
    run_compute = compute_type or settings.whisper_compute_type
    run_beam = settings.whisper_beam_size if beam_size is None else beam_size
    run_beam = max(1, min(int(run_beam), 8))
    run_words = settings.whisper_word_timestamps if word_timestamps is None else bool(word_timestamps)

    total_duration = 0.0
    if progress_callback is not None:
        total_duration = _media_duration(path, settings)
        if cancellation_callback is not None and cancellation_callback():
            raise TranscriptionCancelled("Transcription cancelled before model load")

    with _whisper_lock:
        model_key = f"{settings.whisper_model}:{run_device}:{run_compute}"
        model = _whisper_models.get(model_key)
        if model is None:
            if cancellation_callback is not None and cancellation_callback():
                raise TranscriptionCancelled("Transcription cancelled before model load")
            model = WhisperModel(
                settings.whisper_model,
                device=run_device,
                compute_type=run_compute,
                download_root=str(settings.data_path / "models"),
            )
            _whisper_models[model_key] = model

    if cancellation_callback is not None and cancellation_callback():
        raise TranscriptionCancelled("Transcription cancelled before decoding")

    segments, info = model.transcribe(
        str(path),
        word_timestamps=run_words,
        vad_filter=True,
        beam_size=run_beam,
    )
    words: list[dict[str, Any]] = []
    segment_records: list[dict[str, Any]] = []
    for segment in segments:
        if cancellation_callback is not None and cancellation_callback():
            raise TranscriptionCancelled("Transcription cancelled during decoding")
        segment_records.append({"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip()})
        for word in segment.words or []:
            text = str(word.word).strip()
            if text:
                words.append({"text": text, "start": float(word.start), "end": float(word.end), "confidence": float(word.probability or 0)})
        if progress_callback is not None and total_duration > 0:
            fraction = min(1.0, max(0.0, float(segment.end) / total_duration))
            progress_callback(fraction, f"Transcribing: {segment.text.strip()[:60]}")
    if not words:
        raise MediaError("No speech was detected. Automatic clips require a readable speech track; the source remains available for manual editing.")
    return {"language": getattr(info, "language", "unknown"), "words": words, "segments": segment_records}


def synthesize_local(text: str, output: Path, settings: Settings) -> Path:
    run([settings.local_tts, "-v", "en", "-s", "165", "-w", str(output), "--", text], timeout=900)
    if not output.exists() or output.stat().st_size < 1000:
        raise MediaError("The local narration engine did not produce playable audio")
    return output


def dimensions(aspect: str) -> tuple[int, int]:
    return {"1:1": (1080, 1080), "16:9": (1920, 1080), "4:5": (1080, 1350), "9:16": (1080, 1920)}.get(aspect, (1080, 1920))


# Reference caption metrics tuned against the canonical 9:16 canvas
# (1080x1920). Every other output aspect ratio scales these values so
# captions keep the same visual weight and safe margins, and so the ASS
# coordinate system always matches the final rendered frame.
_CAPTION_REFERENCE_HEIGHT = 1920
_CAPTION_REFERENCE_FONT = 72
_CAPTION_REFERENCE_OUTLINE = 5
_CAPTION_REFERENCE_SHADOW = 2
_CAPTION_REFERENCE_MARGIN_X = 80
_CAPTION_REFERENCE_MARGIN_V = 250
_CAPTION_WRAP_FRACTION = 0.85  # keep wrapped lines within 85% of the usable width
_CHAR_WIDTH_FACTOR = 0.55  # average Arial glyph width at 1em

# Data-driven treatments keep one renderer/timing foundation across modes.
_SUBTITLE_PRESETS = {
    "funny": {"font": 78, "outline": 6, "shadow": 3, "primary": "&H00F7F0E8&", "highlight": "&H0055B7FF&", "bold": -1, "group": 4},
    "serious": {"font": 68, "outline": 4, "shadow": 2, "primary": "&H00F4F5F7&", "highlight": "&H00D6A56A&", "bold": 0, "group": 5},
    "educational": {"font": 70, "outline": 5, "shadow": 2, "primary": "&H00F1F2F4&", "highlight": "&H0077D6FF&", "bold": -1, "group": 6},
    "hype": {"font": 82, "outline": 7, "shadow": 3, "primary": "&H00FFFFFF&", "highlight": "&H0048B8FF&", "bold": -1, "group": 3},
}


def _subtitle_preset(style: str) -> dict[str, Any]:
    return _SUBTITLE_PRESETS.get(style, _SUBTITLE_PRESETS["educational"])


def _ass_style_metrics(width: int, height: int) -> dict[str, int]:
    """Scale caption metrics from the 9:16 reference canvas.

    The font, outline, shadow, and vertical margin scale with the output
    height so captions look consistent across aspect ratios; the horizontal
    margin scales with the output width so the same mobile-safe edge band is
    kept. All values are therefore relative to the final render resolution,
    never to the source video.
    """
    scale = height / _CAPTION_REFERENCE_HEIGHT
    return {
        "fontsize": max(28, round(_CAPTION_REFERENCE_FONT * scale)),
        "outline": max(2, round(_CAPTION_REFERENCE_OUTLINE * scale)),
        "shadow": max(1, round(_CAPTION_REFERENCE_SHADOW * scale)),
        "margin_x": max(40, round(_CAPTION_REFERENCE_MARGIN_X * width / 1080)),
        "margin_v": max(60, round(_CAPTION_REFERENCE_MARGIN_V * scale)),
    }


def _wrap_caption_words(words: list[dict[str, Any]], max_chars: int) -> list[list[dict[str, Any]]]:
    # DO-NOT-CHANGE: greedy word-wrap at natural boundaries; never split a single word
    """Greedy word-wrap a caption group at natural word boundaries.

    Lines never exceed ``max_chars`` and words are never split. If a single
    word is itself longer than a line it is kept whole; ASS smart wrapping is
    the last line of defence for that edge case.
    """
    lines: list[list[dict[str, Any]]] = [[]]
    used = 0
    for word in words:
        width = len(str(word["text"])) + 1  # word plus one separating space
        if used + width > max_chars and lines[-1]:
            lines.append([])
            used = 0
        lines[-1].append(word)
        used += width
    return lines


def _caption_group_for_index(local: list[dict[str, Any]], index: int, desired: int, max_chars: int) -> list[dict[str, Any]]:
    """Choose a timed word group that always fits a maximum two-line block."""
    start = index - index % desired
    end = min(len(local), start + desired)
    while end - start > 1 and len(_wrap_caption_words(local[start:end], max_chars)) > 2:
        end -= 1
    if index >= end:
        start = max(0, index - 1)
        end = index + 1
    return local[start:end]


def _ass_time(seconds: float) -> str:
    value = max(0, seconds)
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = value % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


def _ass_escape(value: str) -> str:
    return value.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def caption_words_for_clip(words: Iterable[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    """Select source-time words and convert their timestamps to clip-local time."""
    clip_start, clip_end = float(start), float(end)
    if not math.isfinite(clip_start) or not math.isfinite(clip_end) or clip_end <= clip_start:
        return []
    selected: list[dict[str, Any]] = []
    for word in words:
        try:
            word_start, word_end = float(word["start"]), float(word["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(word_start) or not math.isfinite(word_end) or word_end <= word_start:
            continue
        overlap_start = max(clip_start, word_start)
        overlap_end = min(clip_end, word_end)
        if overlap_end <= overlap_start:
            continue
        item = dict(word)
        item["start"] = overlap_start - clip_start
        item["end"] = overlap_end - clip_start
        selected.append(item)
    return selected


# DO-NOT-CHANGE: PlayResX/Y must match the final render canvas; captions stay
# bottom-centre (Alignment=2) with symmetric margins; word-by-word highlight
# uses {\\c&H0077D6FF&}; wrapping at word boundaries via _wrap_caption_words
def _caption_cues(words: list[dict[str, Any]], offset: float, duration: float) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    for word in caption_words_for_clip(words, offset, offset + duration):
        text = " ".join(str(word.get("text", "")).split())
        start = max(0.0, min(duration, float(word["start"])))
        end = max(start + 0.05, min(duration, float(word["end"])))
        if text and end > start:
            cues.append((start, end, text))
    return cues


def _srt_time(seconds: float) -> str:
    milliseconds = round(max(0.0, seconds) * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_value, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_value:02d},{millis:03d}"


def write_caption_sidecars(path: Path, words: list[dict[str, Any]], *, offset: float, duration: float) -> None:
    cues = _caption_cues(words, offset, duration)
    srt = "\n\n".join(f"{index}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}" for index, (start, end, text) in enumerate(cues, 1)) + ("\n" if cues else "")
    path.with_suffix(".srt").write_text(srt, encoding="utf-8")
    vtt = "WEBVTT\n\n" + "\n\n".join(f"{_srt_time(start).replace(',', '.')} --> {_srt_time(end).replace(',', '.')}\n{text}" for start, end, text in cues) + ("\n" if cues else "")
    path.with_suffix(".vtt").write_text(vtt, encoding="utf-8")


def write_ass(path: Path, words: list[dict[str, Any]], *, offset: float, duration: float, visuals: Iterable[tuple[str, float, float]], width: int, height: int, style: str = "educational") -> None:
    preset = _subtitle_preset(style)
    metrics = _ass_style_metrics(width, height)
    scale = height / _CAPTION_REFERENCE_HEIGHT
    fontsize = max(28, round(preset["font"] * scale))
    outline = max(2, round(preset["outline"] * scale))
    shadow = max(1, round(preset["shadow"] * scale))
    margin_x = metrics["margin_x"]
    margin_v = metrics["margin_v"]
    visual_scale = height / _CAPTION_REFERENCE_HEIGHT
    usable = max(1, width - 2 * margin_x)
    max_chars = max(8, int(usable * _CAPTION_WRAP_FRACTION / (_CHAR_WIDTH_FACTOR * fontsize)))
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,Arial,{fontsize},{preset["primary"]},{preset["highlight"]},&H00000000,&H78000000,{preset["bold"]},0,0,0,100,100,0,0,1,{outline},{shadow},2,{margin_x},{margin_x},{margin_v},1
Style: Visual,Arial,{max(28, round(56 * visual_scale))},&H008FA8DD,&H000000FF,&H00110B0C,&HCC110B0C,-1,0,0,0,100,100,1,0,3,{max(1, round(2 * visual_scale))},0,8,{margin_x},{margin_x},{max(80, round(400 * visual_scale))},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events: list[str] = []
    local = caption_words_for_clip(words, offset, offset + duration)
    for index, word in enumerate(local):
        group_size = int(preset["group"])
        group = _caption_group_for_index(local, index, group_size, max_chars)
        lines = _wrap_caption_words(group, max_chars)[:2]
        line_bits = []
        for line in lines:
            bits = []
            for item in line:
                text = _ass_escape(str(item["text"]))
                bits.append(f"{{\\c{preset['highlight']}}}{text}{{\\c{preset['primary']}}}" if item is word else text)
            line_bits.append(" ".join(bits))
        start = max(0, float(word["start"]))
        end = min(duration, max(start + .05, float(word["end"])))
        event_text = r"\N".join(line_bits)
        events.append(f"Dialogue: 10,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{event_text}")
    for label, start, end in visuals:
        events.append(f"Dialogue: 5,{_ass_time(start)},{_ass_time(end)},Visual,,0,0,0,,{_ass_escape(label)}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def _overlay_inputs(command: list[str], overlays: list[tuple[Path, float, float]]) -> None:
    for path, _, _ in overlays:
        if path.suffix.casefold() in IMAGE_SUFFIXES:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(path)])
        else:
            command.extend(["-stream_loop", "-1", "-i", str(path)])


def _source_layout_filter(src_width: int, src_height: int, target_width: int, target_height: int) -> str:
    """Keep the complete source visible for materially different aspect ratios."""
    dimensions: list[int] = []
    for name, value in (("source width", src_width), ("source height", src_height), ("target width", target_width), ("target height", target_height)):
        try:
            numeric = float(value)
        except (TypeError, ValueError) as exc:
            raise MediaError(f"Invalid {name} for video layout") from exc
        if not math.isfinite(numeric) or numeric <= 0 or not numeric.is_integer():
            raise MediaError(f"Invalid {name} for video layout")
        dimensions.append(int(numeric))
    src_width, src_height, target_width, target_height = dimensions
    if target_width % 2 or target_height % 2:
        raise MediaError("Target video dimensions must be even for yuv420p")
    source_aspect = src_width / src_height
    target_aspect = target_width / target_height
    if abs(source_aspect / target_aspect - 1) <= 0.12:
        return f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase:flags=lanczos,crop={target_width}:{target_height},setsar=1[base]"
    return (
        "split=2[foreground][background];"
        f"[background]scale={target_width}:{target_height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={target_width}:{target_height},boxblur=luma_radius=10:luma_power=1,eq=brightness=-0.08,setsar=1[bg];"
        f"[foreground]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        "setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1[base]"
    )


def _filters(width: int, height: int, overlays: list[tuple[Path, float, float]], asset_start_index: int, ass_name: str, source_dimensions: tuple[int, int] | None = None) -> tuple[str, str]:
    if source_dimensions:
        filters = [f"[0:v]{_source_layout_filter(*source_dimensions, width, height)}"]
    else:
        filters = [f"[0:v]scale={width}:{height}:flags=lanczos,setsar=1[base]"]
    current = "base"
    overlay_width, overlay_height = int(width * .86), int(height * .58)
    for number, (_, start, end) in enumerate(overlays):
        input_index = asset_start_index + number
        filters.append(f"[{input_index}:v]scale={overlay_width}:{overlay_height}:force_original_aspect_ratio=decrease,pad={overlay_width}:{overlay_height}:(ow-iw)/2:(oh-ih)/2:color=0x08080a,format=rgba[ov{number}]")
        output = f"layer{number}"
        filters.append(f"[{current}][ov{number}]overlay=(W-w)/2:(H-h)/2:enable='between(t,{start:.3f},{end:.3f})':eof_action=pass[{output}]")
        current = output
    filters.append(f"[{current}]subtitles={ass_name}[outv]")
    return ";".join(filters), "outv"


# DO-NOT-CHANGE: atomic render (.partial.mp4 + os.replace) with structural output
# validation (dimensions/audio) before the output is publishable
def render_clip(source: Path, output: Path, *, start: float, end: float, aspect: str, words: list[dict[str, Any]], visuals: list[tuple[str, float, float]], overlays: list[tuple[Path, float, float]], settings: Settings, style: str = "educational", has_audio: bool = True, embed_subtitles: bool = False, subtitle_language: str = "und") -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    ass = output.parent / f"{output.stem}.ass"
    duration = end - start
    width, height = dimensions(aspect)
    source_meta = probe(source, settings)
    src_width, src_height = source_meta["width"], source_meta["height"]
    if source_meta["rotation"] % 180:
        src_width, src_height = src_height, src_width
    write_ass(ass, words, offset=start, duration=duration, visuals=visuals, width=width, height=height, style=style)
    write_caption_sidecars(output, words, offset=start, duration=duration)
    temp = output.with_suffix(".partial.mp4")
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}"]
    _overlay_inputs(command, overlays)
    subtitle_index = 1 + len(overlays)
    if embed_subtitles:
        command.extend(["-i", str(output.with_suffix(".srt"))])
    source_dimensions = (src_width, src_height)
    filters, mapped = _filters(width, height, overlays, 1, ass.name, source_dimensions)
    command.extend(["-filter_complex", filters, "-map", f"[{mapped}]"])
    if has_audio:
        command.extend(["-map", "0:a:0", "-c:a", DELIVERY_AUDIO_CODEC, "-b:a", DELIVERY_AUDIO_BITRATE, "-ar", DELIVERY_AUDIO_RATE])
    else:
        command.append("-an")
    if embed_subtitles:
        command.extend(["-map", f"{subtitle_index}:0", "-c:s", "mov_text", "-metadata:s:s:0", f"language={subtitle_language}"])
    command.extend(["-c:v", DELIVERY_VIDEO_CODEC, "-preset", DELIVERY_PRESET, "-crf", DELIVERY_CRF, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", "-t", f"{duration:.3f}", str(temp)])
    run(command, cwd=output.parent, timeout=7200)
    metadata = probe(temp, settings)
    if metadata["width"] != width or metadata["height"] != height or (has_audio and not metadata["audio"]):
        raise MediaError("Rendered clip failed structural output validation")
    os.replace(temp, output)


def plan_fast_windows(
    duration: float,
    count: int,
    min_duration: float,
    max_duration: float,
    guard_seconds: float = 0,
) -> tuple[list[tuple[float, float]], str]:
    """Partition a source timeline into non-overlapping deterministic windows.

    Parameters
    ----------
    duration : float
        Total duration of the source in seconds (positive).
    count : int
        Desired number of output windows (>= 1).
    min_duration : float
        Minimum window length in seconds (>= 0.1).
    max_duration : float
        Maximum window length in seconds (>= min_duration).
    guard_seconds : float
        Start/end guard kept away from source edges when the source is long enough.

    Returns
    -------
    tuple[list[tuple[float, float]], str]
        Ordered ``(start, end)`` windows in absolute source seconds, plus a
        single warning string (empty when the request is fully satisfied).

    The planner is deterministic: identical inputs always produce the same
    windows.  If the source cannot satisfy the requested count, the returned
    list is shorter and the warning explains why.
    """
    warning = ""
    if duration <= 0 or count < 1:
        return [], warning
    min_duration = max(0.1, min_duration)
    max_duration = max(min_duration, max_duration)
    guard_seconds = max(0.0, guard_seconds)
    requested = count
    if duration < min_duration:
        return [(0.0, round(duration, 6))], "Source is shorter than the minimum window duration; created one clip using the full source."

    guards_fit = duration >= requested * min_duration + guard_seconds * (requested + 1)
    applied_guard = guard_seconds if guards_fit else 0.0
    available = duration - applied_guard * (requested + 1)
    count = min(requested, max(1, int(available // min_duration)))
    if count < requested:
        warning = f"Reduced fast-cut windows from {requested} to {count} because the source is too short for non-overlapping clips."
        guards_fit = duration >= count * min_duration + guard_seconds * (count + 1)
        applied_guard = guard_seconds if guards_fit else 0.0

    available_for_windows = duration - applied_guard * (count + 1)
    window_size = min(max_duration, available_for_windows / count)
    unused = max(0.0, duration - (count * window_size + applied_guard * (count + 1)))
    shared_gap = unused / (count + 1)
    edge_gap = applied_guard + shared_gap
    internal_gap = applied_guard + shared_gap
    windows: list[tuple[float, float]] = []
    start = edge_gap
    for _ in range(count):
        end = min(start + window_size, duration - edge_gap)
        windows.append((round(start, 6), round(end, 6)))
        start = end + internal_gap

    if not warning and unused > 0.01:
        warning = (
            f"Planned {count} windows within {min_duration:g}s-{max_duration:g}s; "
            "unused source time is distributed evenly between clip windows."
        )

    return windows, warning


def plan_long_form_windows(
    duration: float,
    count: int,
    min_duration: float,
    max_duration: float,
    guard_seconds: float = 1.0,
) -> tuple[list[tuple[float, float]], str]:
    """Plan deterministic landscape scenes across the complete source timeline.

    Long-form sources are intentionally sampled across the whole movie rather
    than clustered near the beginning.  This lightweight fallback remains
    deterministic when scene detection or transcription is unavailable.
    """
    windows, warning = plan_fast_windows(duration, count, min_duration, max_duration, guard_seconds)
    if warning and "fast-cut" in warning:
        warning = warning.replace("fast-cut", "long-form")
    return windows, warning


def _fast_crop_scale_filter(
    src_width: int, src_height: int, target_width: int, target_height: int
) -> str:
    """Centre-crop to the requested aspect and always produce its canvas.

    Delivery dimensions are a contract, not a quality heuristic.  Small
    sources are deliberately upscaled; callers record that loss-of-detail
    warning separately.  Lanczos keeps the result clean when downscaling.
    """
    if src_width <= 0 or src_height <= 0:
        raise MediaError("Source dimensions are unavailable for fast rendering")
    if src_width * target_height >= src_height * target_width:
        # Source is wider (or equal) than the target aspect: crop the width.
        crop_w = round(src_height * target_width / target_height)
        crop_h = src_height
    else:
        # Source is taller than the target aspect: crop the height.
        crop_w = src_width
        crop_h = round(src_width * target_height / target_width)
    # The crop has the target aspect, so scaling directly to the canonical
    # canvas cannot distort the image.  Both target dimensions are even.
    return (
        f"crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,"
        f"scale={target_width}:{target_height}:flags=lanczos,setsar=1"
    )


# DO-NOT-CHANGE: deterministic fast-cut window planning — never make it random or stateful
def render_fast_clip(
    source: Path,
    output: Path,
    *,
    start: float,
    end: float,
    aspect: str,
    settings: Settings,
    has_audio: bool = True,
    words: list[dict[str, Any]] | None = None,
    style: str = "educational",
    subtitles_enabled: bool = True,
    embed_subtitles: bool = False,
    subtitle_language: str = "und",
) -> None:
    """Render a fast clip with optional captions and no overlays or visual beats.

    This is a lightweight render path that shares the ASS caption renderer
    while bypassing the overlay/visual-beat pipeline. It performs:

    * Efficient input seeking (``-ss`` before ``-i``).
    * Source-preserving aspect conversion without destructive landscape crops.
    * High-quality H.264 delivery encoding using the shared delivery profile.
    * AAC audio **only** when the source provides an audio track.
    * Optional word-timed ASS subtitles using the shared caption renderer.
    * Output validation (dimensions, audio presence).
    * Atomic publish via a temporary ``.partial.mp4`` then ``os.replace``.

    The output canvas always matches the canonical ``dimensions(aspect)``.
    When ``words`` are supplied, the same ASS renderer used by Smart and Script
    burns accurate, clip-relative captions into the output.

    Parameters
    ----------
    source : Path
        Source video file.
    output : Path
        Destination path for the finished clip (must not exist yet).
    start : float
        Seek position in seconds.
    end : float
        End position in seconds.
    aspect : str
        One of ``"9:16"``, ``"1:1"``, ``"16:9"``.
    settings : Settings
        Engine runtime settings.
    has_audio : bool
        Whether the source segment has an audio track to encode.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = dimensions(aspect)
    duration = max(0.1, end - start)
    temp = output.with_suffix(".partial.mp4")

    meta = probe(source, settings)
    if has_audio and not meta["audio"]:
        raise MediaError("Fast clip requested audio but the source has no audio track")
    # FFmpeg applies display-matrix autorotation before video filters. Probe
    # dimensions are encoded dimensions, so crop against the displayed frame.
    src_width, src_height = meta["width"], meta["height"]
    if meta["rotation"] % 180:
        src_width, src_height = src_height, src_width
    vf = _source_layout_filter(src_width, src_height, width, height).removesuffix("[base]")
    ass: Path | None = None
    if (subtitles_enabled or embed_subtitles) and words:
        write_caption_sidecars(output, words, offset=0, duration=duration)
    if subtitles_enabled and words:
        ass = output.parent / f"{output.stem}.ass"
        write_ass(ass, words, offset=0, duration=duration, visuals=[], width=width, height=height, style=style)
        vf = f"{vf},subtitles={ass.name}"
    command = [
        settings.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
    ]
    if embed_subtitles:
        command.extend(["-i", str(output.with_suffix(".srt"))])
    command.extend([
        "-vf",
        vf,
        "-map",
        "0:v",
        "-c:v",
        DELIVERY_VIDEO_CODEC,
        "-preset",
        DELIVERY_PRESET,
        "-crf",
        DELIVERY_CRF,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ])
    if has_audio:
        command.extend([
            "-map",
            "0:a:0",
            "-c:a",
            DELIVERY_AUDIO_CODEC,
            "-b:a",
            DELIVERY_AUDIO_BITRATE,
            "-ar",
            DELIVERY_AUDIO_RATE,
        ])
    else:
        command.append("-an")
    if embed_subtitles:
        command.extend(["-map", "1:0", "-c:s", "mov_text", "-metadata:s:s:0", f"language={subtitle_language}"])
    command.append(str(temp))

    run(command, cwd=output.parent, timeout=7200)

    result = probe(temp, settings)
    if result["width"] != width or result["height"] != height:
        raise MediaError(
            f"Fast clip failed delivery validation: expected {width}x{height}, "
            f"got {result['width']}x{result['height']}"
        )
    if has_audio and not result["audio"]:
        raise MediaError("Fast clip expected audio but the output has no audio track")
    if abs(float(result["duration"]) - duration) > max(0.75, duration * 0.05):
        raise MediaError("Fast clip failed duration validation")

    os.replace(temp, output)


# DO-NOT-CHANGE: script render with atomic .partial + os.replace and output validation
def render_script(output: Path, *, duration: float, aspect: str, narration: Path | None, words: list[dict[str, Any]], visuals: list[tuple[str, float, float]], overlays: list[tuple[Path, float, float]], settings: Settings, style: str = "educational") -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    ass = output.parent / f"{output.stem}.ass"
    width, height = dimensions(aspect)
    write_ass(ass, words, offset=0, duration=duration, visuals=visuals, width=width, height=height, style=style)
    write_caption_sidecars(output, words, offset=0, duration=duration)
    temp = output.with_suffix(".partial.mp4")
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x08080a:s={width}x{height}:r=30:d={duration:.3f}"]
    audio_index: int | None = None
    if narration:
        audio_index = 1
        command.extend(["-i", str(narration)])
    asset_start = 2 if narration else 1
    _overlay_inputs(command, overlays)
    filters, mapped = _filters(width, height, overlays, asset_start, ass.name)
    command.extend(["-filter_complex", filters, "-map", f"[{mapped}]"])
    if audio_index is not None:
        command.extend(["-map", f"{audio_index}:a:0", "-c:a", DELIVERY_AUDIO_CODEC, "-b:a", DELIVERY_AUDIO_BITRATE, "-ar", DELIVERY_AUDIO_RATE])
    else:
        command.append("-an")
    command.extend(["-c:v", DELIVERY_VIDEO_CODEC, "-preset", DELIVERY_PRESET, "-crf", DELIVERY_CRF, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{duration:.3f}", str(temp)])
    run(command, cwd=output.parent, timeout=7200)
    metadata = probe(temp, settings)
    if metadata["width"] != width or metadata["height"] != height or (narration and not metadata["audio"]):
        raise MediaError("Rendered script video failed structural output validation")
    os.replace(temp, output)
