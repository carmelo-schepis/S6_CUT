from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import struct
import selectors
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import Settings
from .emoji_assets import find_emoji_sequences, resolve_emoji
from .hook_text import remove_hook_em_dashes
from .recipes import CAPTION_REFERENCE_SHORT_EDGE, LookTreatment, caption_preset, known_styles, recipe_for
from . import music_typography
from .subscribe_animation import (
    ANIMATION_ASSET,
    ANIMATION_BUTTON_WIDTH,
    ANIMATION_CANVAS_HEIGHT,
    ANIMATION_CANVAS_WIDTH,
    ANIMATION_DURATION_SECONDS,
    ANIMATION_VISIBLE_BOTTOM,
    schedule_subscribe_animation,
)
from .security import redact, validate_youtube_url

ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_whisper_lock = threading.Lock()
_whisper_models: dict[str, Any] = {}

# Shared final-delivery profile: high quality, local, and browser compatible.
DELIVERY_VIDEO_CODEC = "libx264"
DELIVERY_PRESET = "slow"
# Long form carries the graded filter chain over minutes rather than seconds,
# and x264 `slow` roughly doubles what that costs. CRF is unchanged, so this
# trades ~8% bitrate for ~30% less CPU at the same visual quality — measured on
# a 10s 1920x1080 graded clip: 23.7s/11.4MB at `slow` against 16.2s/12.3MB at
# `medium`. Shorts stay on `slow`: they are the primary output and are cheap.
DELIVERY_PRESET_BY_FORMAT = {"long": "medium"}


def delivery_preset(content_format: str | None) -> str:
    return DELIVERY_PRESET_BY_FORMAT.get(content_format or "", DELIVERY_PRESET)

DELIVERY_CRF = "18"
SHORT_FORM_SUBTITLE_SIZE_MULTIPLIER = 1.15
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

# Product-level layout treatment for mismatched Shorts aspect ratios. FFmpeg
# exposes Gaussian blur as sigma rather than a percentage, so keep the product
# value and its rendering mapping together instead of scattering magic numbers
# across Fast and Smart paths.
BACKGROUND_BLUR_PERCENT = 30
BACKGROUND_BLUR_SIGMA = 30
BACKGROUND_BLUR_STEPS = 2
BACKGROUND_BLUR_FILTER = f"gblur=sigma={BACKGROUND_BLUR_SIGMA}:steps={BACKGROUND_BLUR_STEPS}"
BACKGROUND_OVERSCAN_FACTOR = 1.12
PARTIAL_FILL_VERTICAL_OCCUPANCY = 0.75
CREDIT_BOTTOM_INSET_RATIO = 0.0125
CREDIT_MIN_MARGIN = 12


logger = logging.getLogger(__name__)


class MediaError(RuntimeError):
    pass


class TranscriptionCancelled(MediaError):
    """Raised when a caller-provided cancellation callback reports True."""


class DownloadStalled(MediaError):
    """Raised after a YouTube download has made no measurable progress."""


DownloadCallback = Callable[[dict[str, Any]], None]


# Stable faster-whisper model-name → Hugging Face repo ID mapping. Only used to
# locate the on-disk cache; transcription itself keeps using the selected profile model.
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

_TRANSCRIPTION_CACHE_VERSION = "v3"
_TRANSCRIPTION_AUDIO_CONDITIONING = {
    "speech": "speech-unfiltered-v1",
    "music": "music-unfiltered-v1",
}

# Language codes supported by the pinned Faster-Whisper 1.2.1 tokenizer. Keep
# validation lightweight: importing the ML runtime in the API loads native libs.
WHISPER_LANGUAGE_CODES = frozenset(
    "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr "
    "gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt "
    "lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk "
    "sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh".split()
)

_MUSIC_LANGUAGE_DETECTION = {
    "language_detection_segments": 3,
    "language_detection_threshold": 0.8,
}


def _whisper_repo_id(model: str) -> str:
    """Hugging Face repo ID for a faster-whisper model name or explicit repo ID."""
    if "/" in model:
        return model
    return _WHISPER_MODEL_REPOS.get(model, model)


def whisper_model_for_profile(settings: Settings, profile: str = "speech"):
    """Return the model selected for an explicit transcription profile."""
    if profile not in _TRANSCRIPTION_AUDIO_CONDITIONING:
        raise ValueError(f"Unknown transcription profile: {profile}")
    return settings.music_whisper_model if profile == "music" else settings.whisper_model


def transcription_options(
    settings: Settings,
    *,
    profile: str = "speech",
    language: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    word_timestamps: bool | None = None,
):
    """Resolve the deterministic Faster-Whisper options for a profile.

    Music is deliberately opt-in: it selects its own model/beam defaults,
    disables speech VAD, and cannot turn off word timestamps needed by lyric
    clip boundaries and captions.  No vocal-isolation or other speculative
    audio conditioning is applied here.
    """
    model = whisper_model_for_profile(settings, profile)
    configured_beam = settings.music_whisper_beam_size if profile == "music" else settings.whisper_beam_size
    if profile == "music":
        resolved_words = True
    elif word_timestamps is None:
        resolved_words = settings.whisper_word_timestamps
    else:
        resolved_words = bool(word_timestamps)
    options = {
        "profile": profile,
        "model": model,
        "language": language,
        "device": device or settings.whisper_device,
        "compute_type": compute_type or settings.whisper_compute_type,
        "beam_size": max(1, min(int(configured_beam if beam_size is None else beam_size), 8)),
        "word_timestamps": resolved_words,
        "vad_filter": profile == "speech",
        "audio_conditioning": _TRANSCRIPTION_AUDIO_CONDITIONING[profile],
    }
    if profile == "music":
        # Slow songs can begin with 30+ seconds of instruments. Do not commit
        # to a low-confidence language guess from only that first window.
        # Include these settings in the cache identity as well as the decoder.
        options.update(_MUSIC_LANGUAGE_DETECTION)
    return options


def transcription_cache_identity(
    settings: Settings,
    *,
    profile: str = "speech",
    language: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    word_timestamps: bool | None = True,
):
    """Return a stable identity for a transcript's decoding conditions."""
    options = transcription_options(
        settings,
        profile=profile,
        language=language,
        device=device,
        compute_type=compute_type,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
    )
    digest = hashlib.sha256(json.dumps(options, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return f"transcript:{_TRANSCRIPTION_CACHE_VERSION}:{digest}"


def transcription_cache_key(
    source_hash: str,
    settings: Settings,
    *,
    profile: str = "speech",
    language: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    word_timestamps: bool | None = True,
):
    """Return a source-specific transcript cache key."""
    identity = transcription_cache_identity(
        settings,
        profile=profile,
        language=language,
        device=device,
        compute_type=compute_type,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
    )
    return f"{identity}:{source_hash}"


def _whisper_model_cache_path(settings: Settings, model: str | None = None) -> Path | None:
    """Resolve the downloaded model directory, or None when it is not cached yet.

    Faster-Whisper stores models in the Hugging Face cache layout under
    ``S6_DATA_PATH/models``; a model counts as cached when one snapshot
    directory contains the CTranslate2 ``model.bin`` file. Local model paths
    (absolute or relative) are recognised directly.
    """
    model_name = model or settings.whisper_model
    candidate = Path(model_name)
    if (candidate / "model.bin").is_file():
        return candidate
    repo_id = _whisper_repo_id(model_name)
    snapshots = settings.data_path / "models" / f"models--{repo_id.replace('/', '--')}" / "snapshots"
    if not snapshots.is_dir():
        return None
    for revision in sorted(snapshots.iterdir()):
        if revision.is_dir() and (revision / "model.bin").is_file():
            return revision
    return None


def is_whisper_model_cached(settings: Settings, *, profile: str = "speech") -> bool:
    """True when the selected profile's Whisper model is already downloaded."""
    return _whisper_model_cache_path(settings, whisper_model_for_profile(settings, profile)) is not None


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
        "sample_aspect_ratio": _rational_to_float(str(video.get("sample_aspect_ratio") or "").replace(":", "/")) or 1.0,
    }


def probe_audio(path: Path, settings: Settings) -> dict[str, Any]:
    try:
        result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise MediaError("Audio inspection timed out; FFprobe or local storage did not respond") from exc
    try:
        payload = json.loads(result.stdout)
        audio = next((item for item in payload.get("streams", []) if item.get("codec_type") == "audio"), None)
        duration = float(payload.get("format", {}).get("duration") or (audio or {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe returned malformed audio metadata") from exc
    if not audio or duration <= 0:
        raise MediaError("Narration does not contain a readable audio stream")
    return {"duration": duration, "audio_codec": audio.get("codec_name")}


def validate_audio_track(path: Path, settings: Settings, *, max_seconds: int | None = None, cancellation_callback: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Probe and decode the full selected track so damaged frames are rejected."""
    metadata = probe_audio(path, settings)
    if metadata.get("audio_codec") != "mp3":
        raise MediaError("Background song uploads must contain MP3 audio")
    duration = float(metadata["duration"])
    if max_seconds is not None and duration > max_seconds:
        raise MediaError(f"Background song exceeds the {max_seconds}-second duration limit")
    timeout = max(120, min(7200, int(duration * 2 + 60)))
    run([settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode",
         "-i", str(path), "-map", "0:a:0", "-vn", "-f", "null", "-"], timeout=timeout, cancellation_callback=cancellation_callback)
    return metadata


def prepare_music_track(source: Path, target: Path, speed: float, settings: Settings, *, duration: float | None = None, cancellation_callback: Callable[[], bool] | None = None) -> Path:
    """Prepare the exact audible timeline shared by lyrics and video rendering.

    asetrate intentionally changes both pitch and tempo, matching the audible
    sped-up/slowed-down render option. The output timeline is video-time.
    """
    speed = min(1.5, max(0.75, float(speed)))
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".partial.mp3")
    temporary.unlink(missing_ok=True)
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if duration is not None:
        command.extend(["-stream_loop", "-1"])
    command.extend(["-i", str(source), "-vn", "-af", f"aresample=48000,asetrate=48000*{speed:.3f},aresample=48000"])
    if duration is not None:
        command.extend(["-t", f"{duration:.6f}"])
    command.extend(["-codec:a", "libmp3lame", "-q:a", "2", str(temporary)])
    run(command, timeout=7200, cancellation_callback=cancellation_callback)
    probe_audio(temporary, settings)
    os.replace(temporary, target)
    return target


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
    last_downloaded_bytes = 0
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
                        if update["downloaded_bytes"] > last_downloaded_bytes:
                            last_byte_progress = now
                            last_downloaded_bytes = update["downloaded_bytes"]
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
    write_thumbnail: bool = False,
) -> Path:
    url = validate_youtube_url(url)
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
    if write_thumbnail:
        # Poster image for the status views. Written next to the info sidecar
        # before any media bytes arrive, so a preview exists while downloading.
        common.append("--write-thumbnail")
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


def download_youtube_audio(
    url: str, target: Path, settings: Settings, *,
    progress_callback: DownloadCallback | None = None,
    cancellation_callback: Callable[[], bool] | None = None,
    max_seconds: int | None = None,
) -> Path:
    """Download and validate a public YouTube soundtrack as an MP3."""
    url = validate_youtube_url(url)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    command = [settings.ytdlp, "--no-playlist", "--no-warnings", "--restrict-filenames",
               "--newline", "--progress", "--progress-delta", "1", "--socket-timeout", str(settings.ytdlp_connect_timeout),
               "--retries", "3", "--fragment-retries", "3", "--max-filesize", str(settings.max_upload_bytes), "--write-info-json",
               "--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
               "--output", str(target.with_suffix(".%(ext)s")),
               "--progress-template", "download:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s", url]
    command[-1:-1] = ["--extractor-args", YOUTUBE_EXTRACTOR_ARGS[0], "--extractor-args", YOUTUBE_EXTRACTOR_ARGS[1]]
    _run_ytdlp_download(command, target.parent, settings, progress_callback=progress_callback, cancellation_callback=cancellation_callback)
    if not target.is_file():
        candidates = sorted(target.parent.glob(target.stem + ".*.mp3"))
        if candidates:
            candidates[-1].replace(target)
    if not target.is_file() or target.stat().st_size <= 0:
        raise MediaError("YouTube did not provide a usable background song")
    try:
        validate_audio_track(target, settings, max_seconds=max_seconds, cancellation_callback=cancellation_callback)
    except MediaError:
        target.unlink(missing_ok=True)
        raise
    _download_update(progress_callback, phase="complete", downloaded_bytes=target.stat().st_size, total_bytes=target.stat().st_size, percent=100.0, message="Background song downloaded and validated")
    return target


def downloaded_audio_title(path: Path) -> str | None:
    """Read a safely normalized title from yt-dlp's local info sidecar."""
    sidecar = path.with_suffix(".info.json")
    try:
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return _metadata_text(payload.get("title"), 200) if isinstance(payload, dict) else None


def _metadata_text(value: object, limit: int) -> str | None:
    """Normalise extractor text before it can become a title or ASS event."""
    if not isinstance(value, str):
        return None
    value = unicodedata.normalize("NFC", " ".join(value.split()))
    bidi_controls = {"\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u206a", "\u206b", "\u206c", "\u206d", "\u206e", "\u206f"}
    value = "".join(character for character in value if ord(character) >= 32 and ord(character) != 127 and not (127 < ord(character) <= 159 or character in bidi_controls))
    return value[:limit].rstrip() or None


def youtube_import_metadata(source: Path, *, consume: bool = True) -> dict[str, str] | None:
    """Read yt-dlp metadata needed for YouTube attribution.

    Callers that need crash-safe persistence should parse with ``consume=False``
    and remove the sidecar only after the durable source checkpoint commits.

    The displayed channel name is preferred over uploader IDs because it is the
    original creator-facing metadata and remains readable in a small overlay.
    """
    info = source.with_suffix(".info.json")
    if not info.is_file():
        return None
    try:
        payload = json.loads(info.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return None
        metadata: dict[str, str] = {}
        title = _metadata_text(payload.get("title"), 200)
        creator = None
        for key in ("channel", "uploader", "creator"):
            creator = _metadata_text(payload.get(key), 120)
            if creator:
                break
        if title:
            metadata["title"] = title
        if creator:
            metadata["creator"] = creator
        return metadata or None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    finally:
        if consume:
            try:
                info.unlink(missing_ok=True)
            except OSError:
                pass


def youtube_import_title(source: Path) -> str | None:
    """Read yt-dlp's local title sidecar without retaining it as media."""
    return (youtube_import_metadata(source) or {}).get("title")


def youtube_import_creator(source: Path) -> str | None:
    """Read yt-dlp's local channel/uploader name without retaining it as media."""
    return (youtube_import_metadata(source) or {}).get("creator")


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
    profile: str = "speech",
    language: str | None = None,
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
    profile : str
        Explicitly select ``speech`` (the default) or ``music``. Music uses
        the separate model/beam settings, disables speech VAD, and always
        requests word timestamps.
    language : str | None
        Optional language hint forwarded to Faster-Whisper.

    Returns
    -------
    dict[str, Any]
        ``{"language": str, "words": [...], "segments": [...]}`` compatible
        with the ``S6_TEST_TRANSCRIPT_JSON`` fixture shape. ``words`` carry
        ``text/start/end/confidence``; ``segments`` carry ``start/end/text``.
    """
    options = transcription_options(
        settings,
        profile=profile,
        language=language,
        device=device,
        compute_type=compute_type,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
    )
    fixture = os.getenv("S6_TEST_TRANSCRIPT_JSON")
    if fixture:
        return json.loads(fixture)
    # Transcription runs in a spawned worker process, and the Hub client reads
    # its cache locations at import time — so the data-path cache has to be
    # pinned before Faster-Whisper is imported here, not only at engine startup.
    settings.prepare_model_cache()
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise MediaError("Local Whisper is not installed in this engine runtime") from exc

    run_device = options["device"]
    run_compute = options["compute_type"]
    run_beam = options["beam_size"]
    run_words = options["word_timestamps"]
    run_model = options["model"]

    total_duration = 0.0
    if progress_callback is not None:
        total_duration = _media_duration(path, settings)
        if cancellation_callback is not None and cancellation_callback():
            raise TranscriptionCancelled("Transcription cancelled before model load")

    with _whisper_lock:
        model_key = f"{run_model}:{run_device}:{run_compute}"
        model = _whisper_models.get(model_key)
        if model is None:
            if cancellation_callback is not None and cancellation_callback():
                raise TranscriptionCancelled("Transcription cancelled before model load")
            model = WhisperModel(
                run_model,
                device=run_device,
                compute_type=run_compute,
                download_root=str(settings.data_path / "models"),
            )
            _whisper_models[model_key] = model

    if cancellation_callback is not None and cancellation_callback():
        raise TranscriptionCancelled("Transcription cancelled before decoding")

    transcribe_kwargs = {
        "word_timestamps": run_words,
        "vad_filter": options["vad_filter"],
        "beam_size": run_beam,
    }
    if profile == "music":
        transcribe_kwargs.update({key: options[key] for key in _MUSIC_LANGUAGE_DETECTION})
    if options["language"] is not None:
        transcribe_kwargs["language"] = options["language"]
    segments, info = model.transcribe(str(path), **transcribe_kwargs)
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
        if profile == "music":
            raise MediaError("No sung words with usable timestamps were detected. Instrumentals, buried vocals, and unclear mixes may not produce lyric clips; no audio was padded or duplicated.")
        raise MediaError("No speech was detected. Automatic clips require a readable speech track; the source remains available for manual editing.")
    return {"language": getattr(info, "language", "unknown"), "words": words, "segments": segment_records}


def dimensions(aspect: str) -> tuple[int, int]:
    return {"1:1": (1080, 1080), "16:9": (1920, 1080), "4:5": (1080, 1350), "9:16": (1080, 1920)}.get(aspect, (1080, 1920))


# Reference caption metrics tuned against the canonical 9:16 canvas
# (1080x1920). Every other output aspect ratio scales these values so
# captions keep the same visual weight and safe margins, and so the ASS
# coordinate system always matches the final rendered frame.
_CAPTION_REFERENCE_HEIGHT = 1920
# Type weight scales with the SHORT edge, not the height. A caption runs
# horizontally, so scaling it by height across a 90-degree change of aspect
# collapsed it: at 16:9 the same preset rendered ~2.5% of frame width against
# ~8% for a short, which is why long-form captions looked tiny. Vertical
# offsets (margin_v) still scale with height, and margin_x with width.
_CAPTION_REFERENCE_SHORT_EDGE = CAPTION_REFERENCE_SHORT_EDGE
_CAPTION_REFERENCE_FONT = 72
_CAPTION_REFERENCE_OUTLINE = 5
_CAPTION_REFERENCE_SHADOW = 2
_CAPTION_REFERENCE_MARGIN_X = 80
_CAPTION_REFERENCE_MARGIN_V = 250
_CAPTION_WRAP_FRACTION = 0.85  # keep wrapped lines within 85% of the usable width
_CHAR_WIDTH_FACTOR = 0.55  # average Arial glyph width at 1em

# Data-driven treatments keep one renderer/timing foundation across modes.
# ASS colours are written as &HAABBGGRR.  Each preset has a different semantic
# treatment rather than merely a different accent colour.
# Projected from the recipe table so a style has exactly one definition. The
# shape is unchanged: write_ass and the subtitle tests read a plain mapping.
_SUBTITLE_PRESETS = {style: caption_preset(style) for style in known_styles()}


@lru_cache(maxsize=64)
def _fontconfig_output(pattern: str, output_format: str) -> str:
    """Cache successful lookups; transient failures must remain retryable."""
    result = subprocess.run(["fc-match", "-f", output_format, pattern], capture_output=True, text=True, timeout=10, check=False)
    value = result.stdout.strip()
    if result.returncode or not value:
        raise OSError("Fontconfig did not return a usable font")
    return value


def resolve_font_family(fontname: str) -> str:
    """The family fontconfig hands libass, retrying after a lookup failure."""
    try:
        return _fontconfig_output(fontname, "%{family}")
    except (OSError, subprocess.SubprocessError):
        return ""


def resolve_font_face(fontname: str, style: str) -> str:
    """Resolve an exact fontconfig family/style pair used by a presentation."""
    try:
        return _fontconfig_output(f"{fontname}:style={style}", "%{family}|%{style}")
    except (OSError, subprocess.SubprocessError):
        return ""


# Exact (family, requested style, expected resolved style) for every face a Music
# theme or hook banner names. Roboto Condensed deliberately expects Light: a
# nominal-400 request resolves to the sole installed face, so adding a Regular
# under that family would silently change every existing reference render.
MUSIC_EXACT_FACES = (
    ("Barlow", "Regular", "Regular"), ("Barlow", "Bold", "Bold"), ("Lora", "Regular", "Regular"),
    ("Roboto Condensed", "Regular", "Light"), ("Bodoni Moda", "Regular", "Regular"),
    ("Oswald", "Regular", "Regular"), ("Gaegu", "Bold", "Bold"),
)


def caption_font_mismatches() -> dict[str, str]:
    """Caption families fontconfig cannot satisfy, as requested -> resolved.

    A missing display face is not a render error: libass quietly substitutes
    DejaVu Sans and emboldens it synthetically, which is indistinguishable from
    a badly tuned preset. Naming the substitution makes it a reportable fault.
    """
    mismatches: dict[str, str] = {}
    requested_families = {str(preset["fontname"]) for preset in _SUBTITLE_PRESETS.values()} | {"Barlow", "Archivo Black"}
    for requested in sorted(requested_families):
        resolved = resolve_font_family(requested)
        families = {part.strip().casefold() for part in resolved.split(",") if part.strip()}
        if requested.casefold() not in families:
            mismatches[requested] = resolved or "(fontconfig unavailable)"
    exact_face = resolve_font_face("Montserrat ExtraBold", "Bold Italic")
    face_parts = exact_face.split("|", 1)
    family_parts = {part.strip().casefold() for part in face_parts[0].split(",")} if face_parts else set()
    resolved_style = face_parts[1].split(",", 1)[0].strip().casefold() if len(face_parts) == 2 else ""
    if "montserrat extrabold" not in family_parts or resolved_style != "extrabold italic":
        mismatches["Montserrat ExtraBold Italic"] = exact_face or "(fontconfig unavailable)"
    for family, requested_style, expected_style in MUSIC_EXACT_FACES:
        exact_face = resolve_font_face(family, requested_style)
        face_parts = exact_face.split("|", 1)
        family_parts = {part.strip().casefold() for part in face_parts[0].split(",")} if face_parts else set()
        resolved_style = face_parts[1].split(",", 1)[0].strip().casefold() if len(face_parts) == 2 else ""
        if family.casefold() not in family_parts or resolved_style != expected_style.casefold():
            mismatches[f"{family} {expected_style}"] = exact_face or "(fontconfig unavailable)"
    return mismatches


# Deterministic fallback configuration used when local transcripts are rendered
# without an AI provider. If a future AI caption provider is added, these are
# the explicit constraints its prompt must preserve.
SUBTITLE_EMOJI_INSTRUCTIONS = (
    "Add emojis sparingly: only when they reinforce an emotion, reaction, punchline, "
    "or meaningful idea; never replace important words; use at most one emoji per cue; "
    "avoid repeated or decorative emoji strings; keep serious, educational, and neutral "
    "dialogue restrained, while allowing funny or energetic dialogue somewhat more."
)
_EMOJI_LIMITS = {"funny": .20, "hype": .16, "educational": .08, "serious": .05}
_EMOJI_RANGES = (
    (0x1F300, 0x1FAFF), (0x2600, 0x27BF), (0x2300, 0x23FF),
)
_EMOJI_CANDIDATES = {
    "funny": {
        "reaction": ("😂", "😅", "😮", "😬"), "positive": ("😎", "😄", "😊"),
        "negative": ("🙃", "😬", "😢"), "idea": ("😏", "😐"),
    },
    "hype": {
        "reaction": ("😮", "😲", "😱"), "positive": ("😎", "😄", "😁"),
        "negative": ("😤", "😬", "😠"), "idea": ("😏", "😐"),
    },
    "educational": {
        "reaction": ("😮",), "positive": ("🙂",), "negative": ("😕",),
        "idea": ("😐", "😌"),
    },
    "serious": {
        "reaction": ("😮",), "positive": ("🙂",), "negative": ("😕",),
        "idea": ("😐",),
    },
}
_EMOJI_KEYWORDS = {
    "reaction": {"wow", "whoa", "wait", "really", "seriously", "look", "watch"},
    "positive": {"amazing", "incredible", "perfect", "win", "wins", "won", "love", "best", "success", "breakthrough"},
    "negative": {"wrong", "fail", "fails", "failed", "mistake", "warning", "risk", "hate", "worst", "broken", "problem", "danger"},
    "idea": {"idea", "secret", "key", "important", "remember", "tip", "truth", "lesson", "point", "explain"},
}


def _subtitle_preset(style: str, content_format: str | None = None) -> dict[str, Any]:
    """Caption treatment for a mode, optionally tuned for the output format.

    `content_format` is passed explicitly rather than inferred from the aspect
    ratio: 16:9 is the long-form canvas, but a 16:9 short is still a short.
    """
    return caption_preset(style, content_format)


def _is_emoji(character: str) -> bool:
    """Recognize common emoji codepoint blocks, including unsupported assets."""
    codepoint = ord(character)
    if codepoint in {0x20E3, 0xFE0F} or 0x1F000 <= codepoint <= 0x1FAFF or 0x2600 <= codepoint <= 0x27FF:
        return True
    name_words = set(unicodedata.name(character, "").casefold().split())
    return bool(name_words & {"face", "hand", "heart", "emoji", "person", "woman", "man", "flag"})


def _has_emoji(text: str) -> bool:
    return bool(find_emoji_sequences(text)) or any(_is_emoji(character) for character in text)


def _emoji_kind(text: str) -> str | None:
    normalized = re.sub(r"[^\w']+", " ", text.casefold()).strip()
    words = set(normalized.split())
    for kind, keywords in _EMOJI_KEYWORDS.items():
        if words & keywords:
            return kind
    if "!" in text or "?" in text:
        return "reaction"
    return None


def _caption_words_with_emojis(words: list[dict[str, Any]], style: str) -> list[dict[str, Any]]:
    """Add sparse, deterministic emoji accents without changing word timing."""
    resolved_style = style if style in _SUBTITLE_PRESETS else "educational"
    candidates = _EMOJI_CANDIDATES[resolved_style]
    meaningful = any(_emoji_kind(str(word.get("text", ""))) for word in words)
    limit = max(0, math.floor(len(words) * _EMOJI_LIMITS[resolved_style]), 1 if meaningful else 0)
    if not limit:
        return [dict(word) for word in words]
    enriched: list[dict[str, Any]] = []
    used: list[str] = []
    for word in words:
        item = dict(word)
        text = str(item.get("text", ""))
        kind = _emoji_kind(text)
        if len(used) < limit and kind and not _has_emoji(text):
            emoji = next((value for value in candidates[kind] if value not in used), None)
            if emoji:
                item["text"] = f"{text} {emoji}"
                used.append(emoji)
        enriched.append(item)
    return enriched


def _ass_style_metrics(width: int, height: int) -> dict[str, int]:
    """Scale caption metrics from the 9:16 reference canvas.

    The font, outline, shadow, and vertical margin scale with the output
    height so captions look consistent across aspect ratios; the horizontal
    margin scales with the output width so the same mobile-safe edge band is
    kept. All values are therefore relative to the final render resolution,
    never to the source video.
    """
    type_scale = min(width, height) / _CAPTION_REFERENCE_SHORT_EDGE
    vertical_scale = height / _CAPTION_REFERENCE_HEIGHT
    return {
        "fontsize": max(28, round(_CAPTION_REFERENCE_FONT * type_scale)),
        "outline": max(2, round(_CAPTION_REFERENCE_OUTLINE * type_scale)),
        "shadow": max(1, round(_CAPTION_REFERENCE_SHADOW * type_scale)),
        "margin_x": max(40, round(_CAPTION_REFERENCE_MARGIN_X * width / 1080)),
        "margin_v": max(60, round(_CAPTION_REFERENCE_MARGIN_V * vertical_scale)),
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


def _music_caption_group(local: list[dict[str, Any]], index: int, max_chars: int) -> list[dict[str, Any]]:
    """Build a lyric phrase at pauses, punctuation and safe visual width."""
    start = index
    while start > 0:
        previous = local[start - 1]
        current = local[start]
        gap = float(current["start"]) - float(previous["end"])
        prior_text = str(previous["text"])
        if gap > 0.65 or prior_text.rstrip().endswith((".", "!", "?", ",", ";", ":")):
            break
        start -= 1
    end = start
    chars = 0
    while end < len(local):
        item = local[end]
        text = str(item["text"])
        proposed = chars + (1 if end > start else 0) + len(text)
        if end > start and (proposed > max_chars * 2 or str(local[end - 1]["text"]).rstrip().endswith((".", "!", "?", ",", ";", ":"))):
            break
        if end > start and float(item["start"]) - float(local[end - 1]["end"]) > 0.65:
            break
        chars = proposed
        end += 1
        if text.rstrip().endswith((".", "!", "?", ",", ";", ":")):
            break
    return local[start:max(index + 1, end)]


def _reference_music_groups(words: list[dict[str, Any]], max_words: int = 7) -> list[list[dict[str, Any]]]:
    """Split reference lyrics at natural boundaries into stable, bounded phrases."""
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for word in words:
        text = str(word["text"])
        if current and (
            float(word["start"]) - float(current[-1]["end"]) > 0.65
            or str(current[-1]["text"]).rstrip().endswith((".", "!", "?", ",", ";", ":"))
            or len(current) >= max_words
        ):
            groups.append(current)
            current = []
        current.append(word)
        if text.rstrip().endswith((".", "!", "?", ",", ";", ":")):
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


@lru_cache(maxsize=4)
def _font_advance_metrics(font_path: str) -> tuple[int, dict[int, int]]:
    """Read cmap and horizontal advance widths from a pinned TrueType face."""
    font = Path(font_path).read_bytes()
    table_count = struct.unpack_from(">H", font, 4)[0]
    tables = {}
    for index in range(table_count):
        record = 12 + index * 16
        tag = font[record:record + 4].decode("ascii")
        tables[tag] = struct.unpack_from(">II", font, record + 8)
    head = tables["head"][0]
    units_per_em = struct.unpack_from(">H", font, head + 18)[0]
    hhea = tables["hhea"][0]
    metric_count = struct.unpack_from(">H", font, hhea + 34)[0]
    glyph_count = struct.unpack_from(">H", font, tables["maxp"][0] + 4)[0]
    hmtx = tables["hmtx"][0]
    advances = [struct.unpack_from(">H", font, hmtx + index * 4)[0] for index in range(metric_count)]
    advances.extend([advances[-1]] * (glyph_count - metric_count))
    cmap_offset = tables["cmap"][0]
    cmap_count = struct.unpack_from(">H", font, cmap_offset + 2)[0]
    subtables = [cmap_offset + struct.unpack_from(">I", font, cmap_offset + 8 + index * 8)[0] for index in range(cmap_count)]
    glyph_map: dict[int, int] = {}
    for subtable in sorted(subtables, key=lambda offset: struct.unpack_from(">H", font, offset)[0], reverse=True):
        fmt = struct.unpack_from(">H", font, subtable)[0]
        if fmt == 12:
            groups = struct.unpack_from(">I", font, subtable + 12)[0]
            for index in range(groups):
                start, end, first_glyph = struct.unpack_from(">III", font, subtable + 16 + index * 12)
                for codepoint in range(start, end + 1):
                    glyph_map[codepoint] = first_glyph + codepoint - start
            break
        if fmt == 4:
            segments = struct.unpack_from(">H", font, subtable + 6)[0] // 2
            end_offset = subtable + 14
            start_offset = end_offset + segments * 2 + 2
            delta_offset = start_offset + segments * 2
            range_offset = delta_offset + segments * 2
            for index in range(segments):
                start = struct.unpack_from(">H", font, start_offset + index * 2)[0]
                end = struct.unpack_from(">H", font, end_offset + index * 2)[0]
                delta = struct.unpack_from(">h", font, delta_offset + index * 2)[0]
                range_position = range_offset + index * 2
                range_value = struct.unpack_from(">H", font, range_position)[0]
                for codepoint in range(start, min(end, 0xFFFE) + 1):
                    glyph = (codepoint + delta) & 0xFFFF if range_value == 0 else 0
                    if range_value:
                        glyph_position = range_position + range_value + (codepoint - start) * 2
                        glyph = struct.unpack_from(">H", font, glyph_position)[0]
                        if glyph:
                            glyph = (glyph + delta) & 0xFFFF
                    glyph_map[codepoint] = glyph
            break
    return units_per_em, {codepoint: advances[glyph] for codepoint, glyph in glyph_map.items() if glyph < len(advances)}


@lru_cache(maxsize=4)
def _libass_height_units(font_path: str) -> int:
    """Return the font-unit height libass maps to one ASS font-size unit.

    libass rescales the requested size by hhea/(usWinAscent + usWinDescent)
    before asking FreeType for hhea ascender-descender, so the OS/2 win metrics
    decide the rendered scale when present.
    """
    font = Path(font_path).read_bytes()
    table_count = struct.unpack_from(">H", font, 4)[0]
    tables = {}
    for index in range(table_count):
        record = 12 + index * 16
        tables[font[record:record + 4].decode("ascii")] = struct.unpack_from(">I", font, record + 8)[0]
    ascender, descender = struct.unpack_from(">hh", font, tables["hhea"] + 4)
    if "OS/2" in tables:
        win_ascent, win_descent = struct.unpack_from(">HH", font, tables["OS/2"] + 74)
        if win_ascent + win_descent:
            return win_ascent + win_descent
    return ascender - descender


def _reference_music_events(group: list[dict[str, Any]], theme: str, *, width: int, height: int, duration: float, content_format: str | None = None) -> list[str]:
    """Render independently positioned phrase rows with shared karaoke timing."""
    words = [str(word["text"]) for word in group]
    fonts = {
        "reference_white_sans": ("roboto_condensed/RobotoCondensed-Light.ttf", 135, 0.90),
        "reference_yellow_sans": ("roboto_condensed/RobotoCondensed-Light.ttf", 122, 1.15),
        "reference_white_serif": ("bodoni_moda/BodoniModa-Variable.ttf", 150, 0.85),
    }
    relative_font, design_size, scale_x = fonts[theme]
    type_scale = min(width, height) / _CAPTION_REFERENCE_SHORT_EDGE
    rendered_design_size = max(28, round(design_size * type_scale))
    if content_format == "short":
        rendered_design_size = round(rendered_design_size * SHORT_FORM_SUBTITLE_SIZE_MULTIPLIER)
    font_scale = rendered_design_size / design_size
    units_per_em, glyph_advances = _font_advance_metrics(str(Path(__file__).parent / "fonts" / relative_font))
    line_limit = width * 0.82
    lines: list[list[str]] = []
    space_advance = glyph_advances.get(ord(" "), units_per_em * 0.25)

    def measured_px(value: str) -> float:
        advance = sum(glyph_advances.get(ord(char), units_per_em * 0.55) for char in value)
        return advance * design_size * font_scale * scale_x / units_per_em

    if theme == "reference_white_sans":
        lines = [[word] for word in words]
    elif theme == "reference_white_serif":
        remaining = list(words)
        for row_limit in (4, 2, 1):
            if not remaining:
                break
            line = []
            while remaining and len(line) < row_limit:
                line.append(remaining.pop(0))
            lines.append(line)
        while remaining:
            lines.append([remaining.pop(0)])
    else:
        remaining = list(words)
        for row_limit in (3, 3, 1):
            if not remaining:
                break
            lines.append(remaining[:row_limit])
            remaining = remaining[row_limit:]

    def line_spacing(line: list[str], row_index: int) -> int:
        if len(line) < 2:
            return 0
        natural_width = sum(measured_px(word) for word in line) + space_advance * design_size * font_scale * scale_x / units_per_em * (len(line) - 1)
        space_px = space_advance * design_size * font_scale * scale_x / units_per_em
        if theme == "reference_white_serif":
            spacing_scale = (1, 6.5, 1)[min(row_index, 2)]
            minimum_spacing = (4, 1, 0)[min(row_index, 2)]
        else:
            spacing_scale = 1.8
            minimum_spacing = 1
        available_width = line_limit - natural_width
        requested = max(
            minimum_spacing, 1,
            min(64, round(available_width / (space_px * (len(line) - 1)) * spacing_scale)),
        )
        if content_format == "short":
            max_that_fits = max(
                1,
                1 + math.floor(available_width / (space_px * (len(line) - 1))),
            )
            return min(requested, max_that_fits)
        return requested

    start = max(0.0, float(group[0]["start"]))
    end = min(duration, max(start + 0.05, float(group[-1]["end"])))
    reference_left = theme == "reference_white_sans"
    if reference_left:
        x = round(width * 0.225)
        y0 = round(height * 0.3875)
        line_gap = round(height * 0.0833)
        position_tags = [f"{{\\an7\\pos({x},{y0 + index * line_gap})}}" for index in range(len(lines))]
    else:
        center_y = round(height * (0.5078 if theme == "reference_yellow_sans" else 0.492))
        line_gap = round(height * (0.0844 if theme == "reference_yellow_sans" else 0.0833))
        first_y = center_y - (len(lines) - 1) * line_gap // 2
        position_tags = []
        for index in range(len(lines)):
            if theme == "reference_white_serif" and index == 2:
                position_tags.append(f"{{\\an7\\pos({round(width * 0.125)},{round(height * 0.5255)})}}")
            else:
                position_tags.append(f"{{\\an5\\pos({width // 2},{first_y + index * line_gap})}}")

    # Row-level events allow libass to honor each independently measured position.
    # Karaoke colours match, so word timing remains in ASS without visible color jumps.
    events = []
    cursor = 0
    for line, position in zip(lines, position_tags):
        timed_line = []
        line_width = sum(measured_px(word) for word in line) + space_advance * rendered_design_size * scale_x / units_per_em * max(0, len(line) - 1)
        sizing_limit = line_limit * (1.25 if theme == "reference_white_serif" and len(line) > 1 else 1.0)
        size_ratio = min(1.0, sizing_limit / max(sizing_limit, line_width))
        for word_index, word in enumerate(line):
            item = group[cursor]
            karaoke = max(1, round(max(0.05, float(item["end"]) - float(item["start"])) * 100))
            word_offset = max(0, round((float(item["start"]) - float(group[0]["start"])) * 100))
            size_tag = f"{{\\fs{max(1, round(rendered_design_size * size_ratio))}}}" if word_index == 0 and size_ratio < 1 else ""
            timed_line.append(f"{size_tag}{{\\kt{word_offset}}}{{\\k{karaoke}}}{_ass_escape(word)}")
            cursor += 1
        text = position + (r"\h" * line_spacing(line, len(events))).join(timed_line)
        events.append(f"Dialogue: 10,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{text}")
    return events


MUSIC_SUBTITLE_THEMES = frozenset({
    "clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif",
    "condensed_black", "condensed_white", "handwritten_stack",
})
# New faces are separate families (Oswald, Gaegu) so no existing theme's
# resolved font can change. Black text carries a pale halo so it stays legible
# over dark footage; the white faces keep the dark stroke the other themes use.
_CONDENSED_AND_HAND_PRESETS = {
    "condensed_black": {"fontname": "Oswald", "font": 120, "primary": "&H00000000&", "outline_color": "&H40FFFFFF&", "outline": 3, "shadow": 0, "spacing": 0, "scale_x": 100},
    "condensed_white": {"fontname": "Oswald", "font": 120, "primary": "&H00FFFFFF&", "outline_color": "&H99000000&", "outline": 2, "shadow": 0, "spacing": 0, "scale_x": 100},
    "handwritten_stack": {"fontname": "Gaegu", "font": 104, "primary": "&H00FFFFFF&", "outline_color": "&H99000000&", "outline": 2, "shadow": 0, "spacing": 0, "scale_x": 100},
}
_MUSIC_THEME_FONT_FILES = {
    "clean": "barlow/Barlow-Regular.ttf", "warm": "lora/Lora.ttf", "serif": "lora/Lora.ttf",
    "reference_white_sans": "roboto_condensed/RobotoCondensed-Light.ttf",
    "reference_yellow_sans": "roboto_condensed/RobotoCondensed-Light.ttf",
    "reference_white_serif": "bodoni_moda/BodoniModa-Variable.ttf",
    "condensed_black": "oswald/Oswald-Regular.ttf", "condensed_white": "oswald/Oswald-Regular.ttf",
    "handwritten_stack": "gaegu/Gaegu-Bold.ttf",
}
_MUSIC_THEME_LAYOUTS = {
    "clean": music_typography.Layout(max_rows=2, max_words_per_row=8, width_fraction=0.78, max_words_per_block=12),
    "warm": music_typography.Layout(max_rows=2, max_words_per_row=8, width_fraction=0.78, max_words_per_block=12),
    "serif": music_typography.Layout(max_rows=2, max_words_per_row=8, width_fraction=0.78, max_words_per_block=12),
    "reference_white_sans": music_typography.Layout(max_rows=5, max_words_per_row=1, width_fraction=0.5, max_words_per_block=6, align="left"),
    "reference_yellow_sans": music_typography.Layout(max_rows=3, max_words_per_row=3, width_fraction=0.82, max_words_per_block=7),
    "reference_white_serif": music_typography.Layout(max_rows=3, max_words_per_row=4, width_fraction=0.82, max_words_per_block=7),
    "condensed_black": music_typography.Layout(max_rows=3, max_words_per_row=4, width_fraction=0.78, max_words_per_block=12),
    "condensed_white": music_typography.Layout(max_rows=3, max_words_per_row=4, width_fraction=0.78, max_words_per_block=12),
    "handwritten_stack": music_typography.Layout(max_rows=6, max_words_per_row=2, width_fraction=0.46, max_words_per_block=8),
}
# Fraction of the canvas height a lyric block may occupy before it shrinks or paginates.
_MUSIC_LYRIC_HEIGHT_FRACTION = 0.5


def _music_text_measure(relative_font: str, preset: dict[str, Any]) -> Callable[[str, float], float]:
    font_path = str(Path(__file__).parent / "fonts" / relative_font)
    units_per_em, advances = _font_advance_metrics(font_path)
    height_units = _libass_height_units(font_path)
    scale_x = float(preset.get("scale_x", 100)) / 100
    spacing = float(preset.get("spacing", 0))

    def measure(text: str, size: float) -> float:
        return sum(advances.get(ord(char), units_per_em * 0.55) for char in text) * size / height_units * scale_x + spacing * len(text)

    return measure


def _music_animated_events(words: list[dict[str, Any]], theme: str, preset: dict[str, Any], animation: str, *, width: int, height: int, fontsize: int, duration: float) -> list[str]:
    """Lyric events with real opacity motion: measured stable blocks plus display envelopes.

    Used only for Music with a non-legacy animation. libass multiplies ``\\fad``
    with inline alpha transforms, so one event per block keeps every word at its
    measured position while it fades or builds.
    """
    layout = _MUSIC_THEME_LAYOUTS[theme]
    measure = _music_text_measure(_MUSIC_THEME_FONT_FILES[theme], preset)
    blocks = music_typography.plan_blocks(
        words, layout=layout, base_size=fontsize, line_height=1.0, canvas_width=width,
        max_height=height * _MUSIC_LYRIC_HEIGHT_FRACTION, measure=measure,
    )
    envelopes = music_typography.plan_envelopes(blocks, animation, duration)
    x = round(width * 0.225) if layout.align == "left" else width // 2
    outline_alpha = int(str(preset["outline_color"])[2:4], 16)
    return [
        music_typography.block_event(
            envelope, animation=animation, ass_time=_ass_time, escape=_ass_escape, position=(x, round(height * 0.5)),
            align=layout.align, primary=str(preset["primary"]), highlight=str(preset["highlight"]), outline_alpha=outline_alpha,
        )
        for envelope in envelopes
    ]


def _subscribe_reserve_top(width: int, height: int, content_format: str | None) -> int:
    """Lowest y the subscribe animation's visible pixels can reach on this canvas."""
    landscape = width > height
    visible_button_fraction = 0.45 if landscape else 0.60
    overlay_width = max(2, round(width * visible_button_fraction * ANIMATION_CANVAS_WIDTH / ANIMATION_BUTTON_WIDTH / 2) * 2)
    overlay_height = max(2, round(overlay_width * ANIMATION_CANVAS_HEIGHT / ANIMATION_CANVAS_WIDTH / 2) * 2)
    return math.ceil(height * 0.08 + overlay_height * ANIMATION_VISIBLE_BOTTOM / ANIMATION_CANVAS_HEIGHT)


def _music_hook_banner_events(text: str, *, width: int, height: int, duration: float, source_dimensions: tuple[int, int] | None,
                              reserve_top: int | None, end_time: float | None) -> list[str]:
    """White strip + black centred text immediately above the fitted footage.

    Returns [] when there is no headroom, so the caller falls back to the plain
    top text instead of drawing an empty rectangle. With the subscribe animation
    enabled (``reserve_top``), the strip first tries to stay clear of it for the
    whole clip; if that leaves no readable room it yields at ``end_time`` (the
    first animation start), the same rule the speech hook uses.
    """
    _band, _scaled, footage_top = _music_layout_geometry(width, height, source_dimensions)
    font_path = str(Path(__file__).parent / "fonts" / "barlow" / "Barlow-Bold.ttf")
    units_per_em, advances = _font_advance_metrics(font_path)
    height_units = _libass_height_units(font_path)

    def measure(value: str, size: float) -> float:
        return sum(advances.get(ord(char), units_per_em * 0.55) for char in value) * size / height_units

    scale = width / 1080
    base_size, min_size = round(60 * scale), max(16, round(32 * scale))
    stop = duration
    plan = None
    if reserve_top is not None:
        plan = music_typography.plan_hook_banner(
            text, canvas_width=width, footage_top=footage_top, base_size=base_size, min_size=min_size, line_height=1.0,
            measure=measure, available_height=max(0, footage_top - reserve_top), strict=True,
        )
        if plan is None:
            stop = duration if end_time is None else max(0.0, min(duration, end_time))
    if plan is None:
        plan = music_typography.plan_hook_banner(
            text, canvas_width=width, footage_top=footage_top, base_size=base_size, min_size=min_size, line_height=1.0, measure=measure,
        )
    if plan is None or stop <= 0:
        return []
    body = r"\N".join(_ass_escape(line) for line in plan.lines)
    end = _ass_time(stop)
    rect = f"m 0 {plan.top} l {width} {plan.top} {width} {plan.bottom} 0 {plan.bottom}"
    return [
        f"Dialogue: 15,{_ass_time(0)},{end},HookScrim,,0,0,0,,{{\\p1\\an7\\pos(0,0)\\1c&HFFFFFF&\\1a&H00&\\bord0\\shad0}}{rect}{{\\p0}}",
        f"Dialogue: 20,{_ass_time(0)},{end},MusicTop,,0,0,0,,{{\\an5\\q2\\pos({width // 2},{round(plan.centre_y)})\\fnBarlow\\b1\\fs{plan.font_size}\\1c&H000000&\\1a&H00&\\bord0\\shad0}}{body}",
    ]


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
    safe = "".join(char for char in value if char in "\n\r\t" or unicodedata.category(char) != "Cc")
    return safe.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\r\n", r"\N").replace("\r", r"\N").replace("\n", r"\N")


def _shorts_grade_filter(preset: str, intensity: float, tint_color: str, tint_opacity: int) -> str:
    amount = max(0.0, min(1.0, float(intensity)))
    if preset == "warm":
        return f"colorbalance=rs={.05 * amount:.3f}:gs={.015 * amount:.3f}:bs={-.03 * amount:.3f}"
    if preset == "cool":
        return f"colorbalance=rs={-.03 * amount:.3f}:gs={.01 * amount:.3f}:bs={.05 * amount:.3f}"
    if preset in {"black_white", "monochrome"}:
        return f"hue=s={0 if preset == 'monochrome' else 1 - amount:.3f}"
    if preset == "tint":
        safe_color = tint_color if re.fullmatch(r"#[0-9a-fA-F]{6}", tint_color) else "#d58a55"
        # Tint opacity is transparent percent: 0 means fully opaque, 100 means invisible.
        opacity = max(0, min(100, int(tint_opacity)))
        strength = amount * (1 - opacity / 100)
        channels = [int(safe_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        # A zero-strength tint is the identity, while the maximum shifts each
        # midtone toward the requested RGB tint without replacing source luma.
        offsets = [max(-0.4, min(0.4, (channel - 0.5) * 0.8 * strength)) for channel in channels]
        red, green, blue = offsets
        return f"colorbalance=rm={red:.4f}:gm={green:.4f}:bm={blue:.4f}:pl=1"
    return "null"


def _append_text_overlays(path: Path, overlays: list[dict[str, Any]], duration: float, width: int, height: int) -> None:
    events = []
    for item in overlays[:20]:
        text = _ass_escape(str(item.get("text", "")))
        if not text:
            continue
        start = float(item.get("start", 0))
        item_duration = float(item.get("duration", 0))
        if not math.isfinite(start) or not math.isfinite(item_duration) or start < 0 or item_duration <= 0 or start + item_duration > duration + 1e-6:
            raise MediaError("Text overlay timing must be finite and fit inside the trimmed output")
        end = start + item_duration
        color = str(item.get("color", "#ffffff"))
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            color = "#ffffff"
        red, green, blue = color[1:3], color[3:5], color[5:7]
        size = max(8, min(240, round(float(item.get("size", 48)) * height / 1920)))
        x = round(max(0, min(1, float(item.get("x", .5))) * width))
        y = round(max(0, min(1, float(item.get("y", .5))) * height))
        tag = f"{{\\an5\\pos({x},{y})\\fs{size}\\1c&H{blue}{green}{red}&\\bord2\\shad1}}"
        events.append(f"Dialogue: 30,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{tag}{text}")
    if events:
        with path.open("a", encoding="utf-8") as output:
            output.write("\n" + "\n".join(events) + "\n")


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
def music_caption_cues(words: list[dict[str, Any]], offset: float, duration: float) -> list[dict[str, Any]]:
    """Expose accurate, clip-local Whisper words without speech-style embellishments."""
    cues: list[dict[str, Any]] = []
    for index, word in enumerate(caption_words_for_clip(words, offset, offset + duration), 1):
        text = " ".join(str(word.get("text", "")).split())
        if not text or len(text) > 500:
            continue
        confidence = word.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None
        if confidence is not None and not math.isfinite(confidence):
            confidence = None
        if confidence is not None:
            confidence = min(1.0, max(0.0, confidence))
        cues.append({"id": f"music-word-{index}", "start": word["start"], "end": word["end"], "text": text, "confidence": confidence})
    return cues


def _caption_cues(words: list[dict[str, Any]], offset: float, duration: float, style: str = "educational", *, music_presentation: bool = False, local_text_only: bool = False) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    selected = caption_words_for_clip(words, offset, offset + duration)
    local = selected if music_presentation or local_text_only else _caption_words_with_emojis(selected, style)
    for word in local:
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


def write_caption_sidecars(path: Path, words: list[dict[str, Any]], *, offset: float, duration: float, style: str = "educational", music_theme: str | None = None, presentation: str | None = None, reaction_policy: str | None = None) -> None:
    cues = _caption_cues(words, offset, duration, style, music_presentation=music_theme is not None, local_text_only=presentation in {"smart_speech_v1", "smart_speech_v2"} or reaction_policy == "ironic_v1")
    srt = "\n\n".join(f"{index}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}" for index, (start, end, text) in enumerate(cues, 1)) + ("\n" if cues else "")
    path.with_suffix(".srt").write_text(srt, encoding="utf-8")
    vtt = "WEBVTT\n\n" + "\n\n".join(f"{_srt_time(start).replace(',', '.')} --> {_srt_time(end).replace(',', '.')}\n{text}" for start, end, text in cues) + ("\n" if cues else "")
    path.with_suffix(".vtt").write_text(vtt, encoding="utf-8")


# Opening attribution, fully visible for the first 8 s, then a 1 s fade.
CREDIT_VISIBLE_SECONDS = 8.0
CREDIT_FADE_SECONDS = 1.0
# Legible at Workspace-player and phone sizes; still well below caption size.
CREDIT_REFERENCE_FONT_SIZE = 44


def _wrap_credit(value: str | None, max_chars: int) -> str:
    """Bound a creator credit to at most two readable, natural-word lines."""
    if not value:
        return ""
    words = str(value).split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and len(candidate) > max_chars:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    truncated = len(lines) > 2
    lines = lines[:2]
    if lines and (truncated or len(lines[-1]) > max_chars):
        limit = max(1, max_chars - 3)
        lines[-1] = lines[-1][:limit].rstrip() + "..."
    return "\n".join(lines)


def _credit_margin(height: int) -> int:
    return max(CREDIT_MIN_MARGIN, round(height * CREDIT_BOTTOM_INSET_RATIO))


_SCRIM_STEPS = 24


def _scrim_events(look: "LookTreatment", width: int, height: int, duration: float) -> tuple[str, list[str]]:
    """A bottom scrim drawn by libass, as a stepped alpha ramp.

    This is what replaces the opaque caption panel. Drawing it here rather
    than in the filter chain is deliberate:

    * ffmpeg's `gradients` source cannot be stopped from rotating (its speed
      has no zero), so a filter-built scrim would drift over a long clip and
      render non-deterministically;
    * it would also force the fast path onto `-filter_complex`, colliding with
      the subtitle stream mapping;
    * libass is already running, so the ramp is effectively free, is drawn in
      PlayRes coordinates so it scales with the canvas, and sits on a layer
      below the captions without touching the picture above it.

    The ramp is stepped rather than continuous; at this many steps the banding
    is below what the encoder preserves.
    """
    if not look.scrim:
        return "", []
    band = max(2, round(height * look.scrim_height))
    steps = _SCRIM_STEPS
    top = height - band
    events: list[str] = []
    for index in range(steps):
        # Transparent at the top of the band, `scrim` opacity at the frame edge.
        opacity = look.scrim * (index + 1) / steps
        alpha = max(0, min(255, round(255 * (1.0 - opacity))))
        y0 = top + round(band * index / steps)
        y1 = top + round(band * (index + 1) / steps)
        if y1 <= y0:
            continue
        draw = f"m 0 {y0} l {width} {y0} {width} {y1} 0 {y1}"
        events.append(
            f"Dialogue: 0,{_ass_time(0)},{_ass_time(duration)},Scrim,,0,0,0,,"
            f"{{\\p1\\an7\\pos(0,0)\\1a&H{alpha:02X}&\\bord0\\shad0}}{draw}{{\\p0}}"
        )
    style = "Style: Scrim,Arial,20,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1"
    return style, events


def _speech_layout_text(text: str, *, uppercase: bool = False) -> str:
    text = _emoji_layout_text(text)
    return text.upper() if uppercase else text


def _smart_speech_fontsize(group: list[dict[str, Any]], width: int, fontsize: int, font_path: str | None = None, *, uppercase: bool = False) -> int:
    """Shrink a phrase until advances from its actual bundled face fit the canvas."""
    size = fontsize
    max_width = width * .88 - 24  # outline, shadow, and italic overhang safety allowance
    font_path = font_path or str(Path(__file__).parent / "fonts" / "montserrat" / "Montserrat-ExtraBoldItalic.ttf")
    units_per_em, advances = _font_advance_metrics(font_path)
    height_units = _libass_height_units(font_path)
    while size > 20:
        text = " ".join(str(item["text"]).upper() if uppercase else str(item["text"]) for item in group)
        measured = sum(advances.get(ord(char), units_per_em * .6) for char in text) * size / height_units
        if measured <= max_width:
            break
        size -= 1
    return size


def _smart_speech_group(words: list[dict[str, Any]], index: int) -> list[dict[str, Any]]:
    start = (index // 3) * 3
    return words[start:start + 3]


def _speech_phrase_group(words: list[dict[str, Any]], index: int, max_words: int, max_chars: int, *, allow_backtrack: bool = True) -> list[dict[str, Any]]:
    """Build readable speech phrases at transcript punctuation and pauses."""
    start = index
    while allow_backtrack and start > 0 and index - start < max_words - 1:
        previous, current = words[start - 1], words[start]
        if (float(current["start"]) - float(previous["end"]) > .65
                or str(previous["text"]).rstrip().endswith((".", "!", "?", ",", ";", ":"))):
            break
        start -= 1
    end = start
    chars = 0
    while end < len(words) and end - start < max_words:
        item = words[end]
        text = str(item["text"])
        proposed = chars + (1 if end > start else 0) + len(text)
        if end > start and (proposed > max_chars * 2
                or float(item["start"]) - float(words[end - 1]["end"]) > .65
                or str(words[end - 1]["text"]).rstrip().endswith((".", "!", "?", ",", ";", ":"))):
            break
        chars = proposed
        end += 1
        if text.rstrip().endswith((".", "!", "?", ",", ";", ":")):
            break
    return words[start:max(index + 1, end)]


_SMART_SPEECH_EMOJI_SEQUENCES = {
    "laughter": "😂",
    "surprise": "😮",
    "success": "😎",
    "danger": "😬",
    "idea": "😏",
    "excitement": "😄",
}
_SMART_SPEECH_EMOJI_ASSETS = {
    kind: resolve_emoji(sequence)
    for kind, sequence in _SMART_SPEECH_EMOJI_SEQUENCES.items()
}
_SMART_SPEECH_EMOJI_WORDS = {
    "laughter": {"laugh", "laughing", "hilarious", "funny", "joke", "joking", "haha"},
    "surprise": {"wow", "surprise", "surprised", "unexpected", "shocked", "astonished"},
    "success": {"success", "successful", "win", "won", "goal", "achieved", "achievement"},
    "danger": {"danger", "dangerous", "risk", "risky", "warning", "injury", "fight", "fatal"},
    "idea": {"idea", "ideas", "imagine", "think", "thought", "learn", "learned", "learning", "creative", "invent"},
    "excitement": {"amazing", "awesome", "excited", "incredible", "fantastic", "brilliant"},
}


def _smart_speech_emoji_kind(texts: Iterable[str]) -> str | None:
    tokens = {token.casefold() for text in texts for token in re.findall(r"[\w'-]+", text)}
    if any(_has_emoji(text) for text in texts):
        return None
    for kind, triggers in _SMART_SPEECH_EMOJI_WORDS.items():
        if tokens & triggers:
            return kind
    return None


_UNSUPPORTED_EMOJI_WARNED: set[str] = set()

# Precedence is earliest phrase start, then longest phrase, then category order:
# punchline, foolish reasoning, deadpan confidence, twist/awkwardness, failure,
# suspicious excuse, rejection/defeat, impressive comeback.
# Keep rules explicit, contiguous, and phrase-level; never add single-token triggers.
_IRONIC_REACTION_PHRASES = (
    ("💀", ("that was hilarious", "that's hilarious", "what an absurd ending", "that killed me", "i am dead laughing")),
    ("🧠", ("galaxy brain move", "big brain move", "because that makes sense", "that is my logic")),
    ("🗿", ("nothing can go wrong", "could not possibly fail", "foolproof plan", "there is no way this fails")),
    ("🧍", ("plot twist", "i did not know what to say", "i had no idea what to do", "wait what just happened")),
    ("📉", ("that went wrong", "it did not work", "failed again", "that backfired", "the plan fell apart")),
    ("🤨", ("that does not add up", "you expect me to believe", "that excuse makes no sense", "are you serious")),
    ("🪦", ("we reject your offer", "application was rejected", "completely defeated", "no chance of recovery", "knocked out of the final")),
    ("🥶", ("came back stronger", "made an incredible comeback", "turned it all around", "that was a cold comeback")),
)
_IRONIC_REACTION_ASSETS = {emoji: resolve_emoji(emoji) for emoji, _ in _IRONIC_REACTION_PHRASES}
_IRONIC_REACTION_DURATION = 1.1
_IRONIC_REACTION_COOLDOWN = 5.0
_CLIP_REACTION_EMOJIS = {
    "funny": ("💀", "🗿", "🧠", "🧍"),
    "hype": ("🥶", "💀", "🗿"),
}
_CLIP_REACTION_INTERVAL = 3.5


def select_ironic_reactions(words: list[dict[str, Any]], offset: float, duration: float, *, style: str | None = None) -> list[tuple[str, float, float]]:
    """Select clip-local (emoji, start, end) cues from timed transcript words.

    Matching uses contiguous normalized word phrases; source text and timestamps
    are only read, never modified. Funny/Hype clips fill 3.5s speech slots with
    phrase matches or bundled fallbacks; other callers retain sparse matching.
    """
    clip_start, clip_duration = float(offset), float(duration)
    if not math.isfinite(clip_start) or not math.isfinite(clip_duration) or clip_duration <= 0:
        return []
    normalized = []
    manual_emoji_times = []
    for word in words:
        text = str(word.get("text", ""))
        tokens = re.findall(r"[\w']+", text.casefold())
        try:
            start, end = float(word["start"]), float(word["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(start) and math.isfinite(end) and end > start and _has_emoji(text):
            manual_emoji_times.append((start, end))
        if tokens and math.isfinite(start) and math.isfinite(end) and end > start:
            normalized.append((tokens, start, end, _has_emoji(text), bool(re.search(r"[.!?][\"')\]]*$", text))))
    stream = []
    for index, (tokens, start, end, _, _) in enumerate(normalized):
        for token in tokens:
            stream.append((token, index, start, end))
    matches = []
    for reaction_order, (emoji, phrases) in enumerate(_IRONIC_REACTION_PHRASES):
        for phrase in phrases:
            phrase_tokens = tuple(re.findall(r"[\w']+", phrase.casefold()))
            if len(phrase_tokens) < 2:
                continue
            for index in range(len(stream) - len(phrase_tokens) + 1):
                segment = stream[index:index + len(phrase_tokens)]
                if tuple(item[0] for item in segment) != phrase_tokens:
                    continue
                word_start, word_end = segment[0][1], segment[-1][1]
                phrase_start, phrase_end = normalized[word_start][1], normalized[word_end][2]
                if word_end - word_start + 1 != len({item[1] for item in segment}):
                    continue
                if any(normalized[index][3] for index in range(word_start, word_end + 1)):
                    continue
                if any(normalized[index][4] for index in range(word_start, word_end)):
                    continue
                if any(normalized[index + 1][1] - normalized[index][2] > 1.25 for index in range(word_start, word_end)):
                    continue
                if phrase_end <= clip_start or phrase_start >= clip_start + clip_duration:
                    continue
                matches.append((phrase_start, -len(phrase_tokens), reaction_order, phrase_end, emoji))
    if style in _CLIP_REACTION_EMOJIS:
        allowed = _CLIP_REACTION_EMOJIS[style]
        selected = []
        cadence_index = 0
        while cadence_index * _CLIP_REACTION_INTERVAL < clip_duration:
            window_start = cadence_index * _CLIP_REACTION_INTERVAL
            window_end = min(clip_duration, window_start + _CLIP_REACTION_INTERVAL)
            speech = [item for item in normalized if item[2] > clip_start + window_start and item[1] < clip_start + window_end]
            if speech:
                match = next((item for item in sorted(matches) if window_start <= item[0] - clip_start < window_end), None)
                if match:
                    emoji = match[4]
                    cue_start = max(0.0, match[3] - clip_start - .15)
                else:
                    emoji = allowed[cadence_index % len(allowed)]
                    cue_start = max(window_start, speech[0][1] - clip_start)
                cue_end = min(clip_duration, cue_start + _IRONIC_REACTION_DURATION)
                absolute_start, absolute_end = clip_start + cue_start, clip_start + cue_end
                if cue_end > cue_start and any(start < absolute_end and end > absolute_start for start, end in manual_emoji_times):
                    candidate = next((item for item in speech if not any(start < min(clip_start + window_end, item[2]) and end > max(clip_start + window_start, item[1]) for start, end in manual_emoji_times)), None)
                    if candidate is None:
                        cadence_index += 1
                        continue
                    cue_start = max(window_start, candidate[1] - clip_start)
                    cue_end = min(clip_duration, cue_start + _IRONIC_REACTION_DURATION)
                    if any(start < clip_start + cue_end and end > clip_start + cue_start for start, end in manual_emoji_times):
                        cadence_index += 1
                        continue
                if cue_end > cue_start:
                    selected.append((emoji, cue_start, cue_end))
            cadence_index += 1
        return selected

    selected = []
    cooldown_until = -math.inf
    for phrase_start, _, _, phrase_end, emoji in sorted(matches):
        cue_start = max(0.0, phrase_end - clip_start - .15)
        cue_end = min(clip_duration, cue_start + _IRONIC_REACTION_DURATION)
        absolute_cue_start, absolute_cue_end = clip_start + cue_start, clip_start + cue_end
        if cue_end <= cue_start or cue_start < cooldown_until:
            continue
        if any(start < absolute_cue_end and end > absolute_cue_start for start, end in manual_emoji_times):
            continue
        selected.append((emoji, cue_start, cue_end))
        cooldown_until = cue_start + _IRONIC_REACTION_COOLDOWN
    return selected


def _caption_emoji_plan(words: list[dict[str, Any]], width: int, height: int, duration: float, *, offset: float, style: str, presentation: str | None, music_theme: str | None, reaction_policy: str | None = None, source_profile: str = "speech") -> list[tuple[Path, float, float, int, int, int]]:
    """Plan phrase-level reaction overlays independently of caption layout."""
    local = caption_words_for_clip(words, offset, offset + duration)
    if not local:
        return []
    scale = min(width, height) / 1080
    size = min(round(112 * scale), width, height)
    smart_speech = presentation in {"smart_speech_v1", "smart_speech_v2"}
    if smart_speech:
        y = max(round(height * .34), round(height * .54 - 104 * scale - size - 18 * scale))
    else:
        metrics = _ass_style_metrics(width, height)
        y = max(0, min(height - size, height - metrics["margin_v"] - size - 2 * metrics["fontsize"] - round(24 * scale)))
    plan: list[tuple[Path, float, float, int, int, int]] = []
    if source_profile == "music" or (not smart_speech and reaction_policy != "ironic_v1"):
        return plan
    ironic = reaction_policy == "ironic_v1" and source_profile == "speech"
    enriched_local = local
    cooldown_until = -1.0
    for group_start in range(0, len(local), 3):
        group = local[group_start:group_start + 3]
        enriched_group = enriched_local[group_start:group_start + 3]
        sequences = [(sequence, asset) for word in enriched_group for _, _, sequence, asset in find_emoji_sequences(str(word.get("text", "")))] if smart_speech else []
        automatic = False
        if not sequences and not ironic and smart_speech:
            detected = _smart_speech_emoji_kind(str(word.get("text", "")) for word in group)
            sequence = _SMART_SPEECH_EMOJI_SEQUENCES.get(detected or "")
            asset = resolve_emoji(sequence) if sequence else None
            if sequence and asset:
                sequences = [(sequence, asset)]
                automatic = True
        if not sequences:
            for word in group:
                text = str(word.get("text", ""))
                if _has_emoji(text) and not find_emoji_sequences(text) and text not in _UNSUPPORTED_EMOJI_WARNED and len(_UNSUPPORTED_EMOJI_WARNED) < 8:
                    _UNSUPPORTED_EMOJI_WARNED.add(text)
                    logger.warning("Unsupported subtitle emoji sequence retained as text: %s", text[:24])
            continue
        start = max(0.0, float(group[0]["start"]))
        end = min(duration, float(group[-1]["end"]))
        if end <= start or (automatic and start < cooldown_until):
            continue
        if automatic:
            cooldown_until = end + 5.0
        intervals = [
            (max(0.0, float(word["start"])), min(duration, max(float(word["start"]) + .05, float(word["end"]))))
            for word in group
            if float(word.get("end", 0)) > float(word.get("start", 0))
        ]
        active_intervals: list[tuple[float, float]] = []
        for interval_start, interval_end in intervals:
            if interval_end <= interval_start:
                continue
            if active_intervals and interval_start <= active_intervals[-1][1] + .001:
                active_intervals[-1] = (active_intervals[-1][0], max(active_intervals[-1][1], interval_end))
            else:
                active_intervals.append((interval_start, interval_end))
        if not automatic:
            inline_slots = _smart_inline_emoji_slots(group, width, height, style=style, presentation=presentation)
            if inline_slots:
                plan.extend((asset, interval_start, interval_end, x, slot_y, slot_size) for asset, x, slot_y, slot_size in inline_slots for interval_start, interval_end in active_intervals)
                continue
        unique: list[tuple[str, Path]] = []
        for sequence, asset in sequences:
            if all(sequence != previous for previous, _ in unique):
                unique.append((sequence, asset))
        for index, (_, asset) in enumerate(unique[:2]):
            x = round(width / 2 - size / 2 - (len(unique[:2]) - 1) * size * .58 + index * size * 1.16)
            plan.extend((asset, interval_start, interval_end, x, y, size) for interval_start, interval_end in active_intervals)
    if ironic:
        for emoji, cue_start, cue_end in select_ironic_reactions(words, offset, duration, style=style):
            asset = _IRONIC_REACTION_ASSETS.get(emoji)
            if asset is not None:
                plan.append((asset, cue_start, cue_end, round(width / 2 - size / 2), y, size))
    return plan


def _smart_inline_emoji_slots(group: list[dict[str, Any]], width: int, height: int, *, style: str = "hype", presentation: str | None = None) -> list[tuple[Path, int, int, int]]:
    """Position image slots from the same pinned-font line layout as ASS."""
    relative_font = ({"hype": "montserrat/Montserrat-ExtraBoldItalic.ttf", "funny": "archivoblack/ArchivoBlack-Regular.ttf", "educational": "barlow/Barlow-Bold.ttf", "serious": "barlow/Barlow-Regular.ttf"}.get(style, "barlow/Barlow-Bold.ttf")
                     if presentation == "smart_speech_v2"
                     else "montserrat/Montserrat-ExtraBoldItalic.ttf")
    font_path = str(Path(__file__).parent / "fonts" / relative_font)
    units_per_em, advances = _font_advance_metrics(font_path)
    height_units = _libass_height_units(font_path)
    reference_size = {"hype": 104, "funny": 86, "educational": 68, "serious": 60}.get(style, 104) if presentation == "smart_speech_v2" else 104
    base_size = max(28, round(reference_size * min(width, height) / 1080))
    uppercase = False  # v2 is short form; retain its existing non-uppercase Hype casing.
    layout_group = [{**word, "_emoji_text": str(word.get("text", "")), "text": _speech_layout_text(str(word.get("text", "")), uppercase=uppercase)} for word in group]
    font_size = _smart_speech_fontsize(layout_group, width, base_size, font_path)
    lines = _smart_speech_lines(layout_group, width, font_size, font_path)
    space_width = advances.get(ord(" "), units_per_em * .25) * font_size / height_units
    line_height = font_size * 1.2
    block_center_y = height * (.54 if presentation == "smart_speech_v1" or style == "hype" else .78)
    output = []
    for row, line in enumerate(lines):
        uppercase = presentation == "smart_speech_v1"
        text_widths = [sum(advances.get(ord(char), units_per_em * .6) for char in _speech_layout_text(str(item.get("text", "")), uppercase=uppercase)) * font_size / height_units for item in line]
        line_width = sum(text_widths) + space_width * max(0, len(line) - 1)
        cursor = (width - line_width) / 2
        center_y = block_center_y + (row - (len(lines) - 1) / 2) * line_height
        for item, item_width in zip(line, text_widths):
            text = str(item.get("_emoji_text", item.get("text", "")))
            matches = find_emoji_sequences(text)
            for start, end, _, asset in matches:
                prefix = _speech_layout_text(text[:start], uppercase=uppercase)
                prefix_width = sum(advances.get(ord(char), units_per_em * .6) for char in prefix) * font_size / height_units
                slot_width = space_width * 4
                size = max(36, round(font_size * .92))
                output.append((asset, round(cursor + prefix_width + slot_width / 2 - size / 2), round(center_y - size / 2), size))
            cursor += item_width + space_width
    return output


def _emoji_layout_text(text: str) -> str:
    """Reserve four actual font-space advances for each verified image slot."""
    for start, end, _, _ in reversed(find_emoji_sequences(text)):
        text = text[:start] + "    " + text[end:]
    return text


def _emoji_ass_text(text: str) -> str:
    """Escape text while replacing verified glyphs with inline ASS space slots."""
    matches = find_emoji_sequences(text)
    if not matches:
        return _ass_escape(text)
    parts = []
    cursor = 0
    for start, end, _, _ in matches:
        parts.append(_ass_escape(text[cursor:start]))
        parts.append(r"\h\h\h\h")
        cursor = end
    parts.append(_ass_escape(text[cursor:]))
    return "".join(parts)


def _smart_speech_lines(group: list[dict[str, Any]], width: int, fontsize: int, font_path: str | None = None, *, uppercase: bool = False) -> list[list[dict[str, Any]]]:
    """Wrap a short phrase at word boundaries using its pinned bundled face."""
    font_path = font_path or str(Path(__file__).parent / "fonts" / "montserrat" / "Montserrat-ExtraBoldItalic.ttf")
    units_per_em, advances = _font_advance_metrics(font_path)
    height_units = _libass_height_units(font_path)
    max_width = width * .88 - 24  # outline, shadow, and italic overhang safety allowance
    lines: list[list[dict[str, Any]]] = []
    for word in group:
        candidate = (lines[-1] + [word]) if lines else [word]
        text = " ".join(str(item["text"]).upper() if uppercase else str(item["text"]) for item in candidate)
        measured = sum(advances.get(ord(char), units_per_em * .6) for char in text) * fontsize / height_units
        if lines and measured > max_width:
            lines.append([word])
        elif lines:
            lines[-1].append(word)
        else:
            lines.append([word])
    return lines


def write_ass(path: Path, words: list[dict[str, Any]], *, offset: float, duration: float, visuals: Iterable[tuple[str, float, float]], width: int, height: int, style: str = "educational", creator_credit: str | None = None, credit_alignment: int = 3, content_format: str | None = None, music_theme: str | None = None, music_top_text: str | None = None, hook_text: str | None = None, hook_end_time: float | None = None, presentation: str | None = None, reaction_policy: str | None = None, burn_emoji_images: bool = False, music_lyric_animation: str | None = None, music_hook_text_format: str | None = None, music_source_dimensions: tuple[int, int] | None = None, music_banner_reserve_top: int | None = None) -> None:
    # Unknown additive presentation values intentionally project to the legacy
    # renderer, keeping newer callers forward/backward compatible.
    smart_speech = presentation == "smart_speech_v1"
    styled_speech = presentation == "smart_speech_v2"
    speech_presentation = smart_speech or styled_speech
    preset = _subtitle_preset(style, content_format)
    if styled_speech:
        speech_presets = {
            "hype": {"fontname": "Montserrat ExtraBold", "font": 104, "bold": -1, "italic": -1, "primary": "&H00FFFFFF&", "highlight": "&H0000D7FF&", "outline_color": "&H00000000&", "outline": 6, "shadow": 2, "spacing": 0, "group": 3, "margin_v": 0, "border_style": 1},
            "funny": {"fontname": "Archivo Black", "font": 86, "bold": 0, "italic": 0, "primary": "&H00FFFFFF&", "highlight": "&H0000D7FF&", "outline_color": "&H00000000&", "outline": 6, "shadow": 2, "spacing": 0, "group": 3, "margin_v": 370, "border_style": 1},
            "educational": {"fontname": "Barlow", "font": 68, "bold": -1, "italic": 0, "primary": "&H00FFFFFF&", "highlight": "&H0000D7FF&", "outline_color": "&H00101010&", "outline": 3, "shadow": 1, "spacing": 0, "group": 4, "margin_v": 370, "border_style": 1},
            "serious": {"fontname": "Barlow", "font": 60, "bold": 0, "italic": 0, "primary": "&H00F4F5F7&", "highlight": "&H00F4F5F7&", "outline_color": "&H00201810&", "outline": 1, "shadow": 0, "spacing": 0, "group": 6, "margin_v": 370, "border_style": 1},
        }
        preset = {**preset, **speech_presets.get(style, speech_presets["educational"])}
    if smart_speech:
        # Use the bundled Montserrat face independently of recipe/style settings.
        # ASS applies synthetic bold/italic to this locally available face.
        preset = dict(preset)
        preset.update({"fontname": "Montserrat ExtraBold", "font": 104, "bold": -1, "italic": -1, "primary": "&H00FFFFFF&", "highlight": "&H00FFFFFF&", "outline_color": "&H00000000&", "outline": 6, "shadow": 2, "spacing": 0, "group": 3, "margin_v": 0, "border_style": 1})
    if music_theme in {"clean", "warm", "serif"}:
        preset = dict(preset)
        preset.update({"fontname": "Barlow" if music_theme == "clean" else "Lora", "font": 56, "bold": 0, "italic": 0, "outline": 1, "shadow": 0, "group": 1, "highlight": "&H0000D7FF&" if music_theme == "warm" else "&H00FFFFFF&", "primary": "&H00FFFFFF&", "outline_color": "&H80000000&"})
    reference_presets = {
        "reference_white_sans": {"fontname": "Roboto Condensed", "font": 135, "primary": "&H00FFFFFF&", "outline_color": "&H99000000&", "outline": 1, "shadow": 0, "spacing": 0, "scale_x": 90},
        "reference_yellow_sans": {"fontname": "Roboto Condensed", "font": 122, "primary": "&H00AAE8F5&", "outline_color": "&H99000000&", "outline": 1, "shadow": 0, "spacing": 1, "scale_x": 115},
        "reference_white_serif": {"fontname": "Bodoni Moda", "font": 150, "primary": "&H00FFFFFF&", "outline_color": "&H99000000&", "outline": 1, "shadow": 0, "spacing": 0, "scale_x": 85},
    }
    styled_music_presets = {**reference_presets, **_CONDENSED_AND_HAND_PRESETS}
    if music_theme in styled_music_presets:
        preset = dict(preset)
        preset.update({**styled_music_presets[music_theme], "bold": 0, "italic": 0, "group": 1, "highlight": styled_music_presets[music_theme]["primary"]})
    scrim_style, scrim_events = _scrim_events(recipe_for(style, content_format).look, width, height, duration)
    if speech_presentation:
        scrim_style, scrim_events = "", []
    if music_theme in styled_music_presets:
        scrim_style, scrim_events = "", []
    metrics = _ass_style_metrics(width, height)
    type_scale = min(width, height) / _CAPTION_REFERENCE_SHORT_EDGE
    vertical_scale = height / _CAPTION_REFERENCE_HEIGHT
    fontsize = max(28, round(preset["font"] * type_scale))
    if content_format == "short" and not speech_presentation:
        fontsize = round(fontsize * SHORT_FORM_SUBTITLE_SIZE_MULTIPLIER)
    if music_theme in styled_music_presets:
        outline = round(preset["outline"] * type_scale)
        shadow = round(preset["shadow"] * type_scale)
    elif styled_speech:
        outline = round(preset["outline"] * type_scale)
        shadow = round(preset["shadow"] * type_scale)
    else:
        outline = max(2, round(preset["outline"] * type_scale))
        shadow = max(1, round(preset["shadow"] * type_scale))
    margin_x = metrics["margin_x"]
    margin_v = max(60, round(int(preset["margin_v"]) * vertical_scale))
    if music_theme:
        band_height = min(height, round(width * 0.75 / 2) * 2)
        margin_v = round((height - band_height) / 2 + band_height * 0.08)
    visual_scale = vertical_scale
    usable = max(1, width - 2 * margin_x)
    max_chars = max(8, int(usable * _CAPTION_WRAP_FRACTION / (_CHAR_WIDTH_FACTOR * fontsize)))
    credit_fontsize = max(20, round((48 if smart_speech else CREDIT_REFERENCE_FONT_SIZE) * visual_scale))
    # Keep the credit anchored to the bottom edge with only a small inset for
    # glyphs, outlines, and the translucent panel.
    credit_margin = _credit_margin(height)
    credit_max_chars = max(12, int(usable * .92 / (_CHAR_WIDTH_FACTOR * credit_fontsize)))
    if speech_presentation:
        credit_alignment = 2
        credit_margin = max(1, round(height * .14))
        credit_max_chars = max(12, int(usable * .9 / (_CHAR_WIDTH_FACTOR * credit_fontsize)))
    hook_fontsize = max(1, round(72 * type_scale))
    hook_floor = max(1, round(60 * type_scale))
    hook_margin_x = max(1, round(60 * width / 1080))
    hook_outline = max(1, round(4 * width / 1080))
    hook_top_margin = round(height * .11)
    hook_lines: list[list[dict[str, Any]]] = []
    credit_label = creator_credit
    if speech_presentation and credit_label:
        credit_label = re.sub(r"^Source:\s*", "", credit_label, flags=re.IGNORECASE)
    credit_text = _wrap_credit(credit_label, credit_max_chars) if credit_label else ""
    # A translucent light face with a dark stroke stays legible over changing
    # footage without competing with the much larger caption treatment.
    credit_alignment = 2 if speech_presentation else (1 if credit_alignment == 1 else 3)
    credit_primary = "&H66F1F2F4" if speech_presentation else "&H22F1F2F4"
    credit_font = "Montserrat ExtraBold" if speech_presentation else "Arial"
    credit_bold, credit_italic = (-1, -1) if speech_presentation else (0, 0)
    credit_border = 1 if speech_presentation else 3
    credit_style = f"Style: Credit,{credit_font},{credit_fontsize},{credit_primary},{credit_primary},&H6608080A,&H9908080A,{credit_bold},{credit_italic},0,0,100,100,0,0,{credit_border},{max(1, round(2 * visual_scale))},{max(1, round(1 * visual_scale))},{credit_alignment},{margin_x},{margin_x},{credit_margin},1\n" if credit_text else ""
    visual_style = f"Style: Visual,Arial,{max(28, round(56 * visual_scale))},&H008FA8DD,&H000000FF,&H00110B0C,&HCC110B0C,-1,0,0,0,100,100,1,0,3,{max(1, round(2 * visual_scale))},0,8,{margin_x},{margin_x},{max(80, round(400 * visual_scale))},1" if not music_theme else ""
    caption_alignment = 5 if music_theme or smart_speech or (styled_speech and style == "hype") else 2
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,{preset["fontname"]},{fontsize},{preset["primary"]},{preset["highlight"]},{preset["outline_color"]},{preset["back_color"]},{preset["bold"]},{preset["italic"]},0,0,{preset.get("scale_x", 100)},100,{preset["spacing"]},0,{preset["border_style"]},{outline},{shadow},{caption_alignment},{margin_x},{margin_x},{margin_v},1
{visual_style}
Style: MusicTop,Barlow,{max(32, round(54 * visual_scale))},&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,8,{margin_x},{margin_x},{max(100, round(170 * visual_scale))},1
Style: Hook,Montserrat,{hook_fontsize},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,-1,0,0,0,100,100,0,0,1,{hook_outline},{max(1, round(3 * width / 1080))},8,{hook_margin_x},{hook_margin_x},{hook_top_margin},1
Style: HookScrim,Arial,20,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
{credit_style}
{scrim_style}
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events: list[str] = list(scrim_events)
    if music_theme and music_top_text:
        banner_events = _music_hook_banner_events(
            music_top_text, width=width, height=height, duration=duration, source_dimensions=music_source_dimensions,
            reserve_top=music_banner_reserve_top, end_time=hook_end_time,
        ) if music_hook_text_format == "white_banner" else []
        events.extend(banner_events or [f"Dialogue: 20,0,{_ass_time(duration)},MusicTop,,0,0,0,,{_ass_escape(music_top_text)}"])
    if hook_text:
        # A stepped top-edge ramp reaches at most 45% opacity and fades away
        # before the lower edge of the ~30% screen region.
        scrim_steps = 12
        scrim_end = round(height * .30)
        for index in range(scrim_steps):
            y0 = round(scrim_end * index / scrim_steps)
            y1 = round(scrim_end * (index + 1) / scrim_steps)
            opacity = .45 * (1 - index / scrim_steps)
            alpha = round(255 * (1 - opacity))
            polygon = f"m 0 {y0} l {width} {y0} {width} {y1} 0 {y1}"
            events.append(f"Dialogue: 0,0,{_ass_time(duration)},HookScrim,,0,0,0,,{{\\p1\\an7\\pos(0,0)\\1c&H000000&\\1a&H{alpha:02X}&\\bord0\\shad0}}{polygon}{{\\p0}}")
        tokens = [{"text": word} for word in " ".join(remove_hook_em_dashes(hook_text).split()).split()]
        usable_hook_width = max(1, width - 2 * hook_margin_x - 2 * hook_outline)
        hook_font = str(Path(__file__).parent / "fonts" / "montserrat" / "Montserrat-Bold.ttf")
        units_per_em, glyph_advances = _font_advance_metrics(hook_font)
        height_units = _libass_height_units(hook_font)

        def hook_wrap(size: int) -> list[list[dict[str, Any]]]:
            # Greedy word wrap on measured advances; an over-long word keeps its own line.
            def line_px(items: list[dict[str, Any]]) -> float:
                text = " ".join(str(item["text"]) for item in items)
                return sum(glyph_advances.get(ord(char), units_per_em * .6) for char in text) * size / height_units

            lines: list[list[dict[str, Any]]] = []
            for token in tokens:
                if lines and line_px(lines[-1] + [token]) <= usable_hook_width:
                    lines[-1].append(token)
                else:
                    lines.append([token])
            return lines

        hook_size = hook_fontsize
        hook_lines = hook_wrap(hook_size)
        while len(hook_lines) > 4 and hook_size > hook_floor:
            hook_size -= 1
            hook_lines = hook_wrap(hook_size)
        hook_body = r"\N".join(" ".join(_ass_escape(str(item["text"])) for item in line) for line in hook_lines)
        end_time = max(0, min(duration, duration if hook_end_time is None else hook_end_time))
        events.append(f"Dialogue: 5,0,{_ass_time(end_time)},Hook,,0,0,0,,{{\\fs{hook_size}}}{hook_body}")
    selected_words = caption_words_for_clip(words, offset, offset + duration)
    # Speech presentation intentionally suppresses recipe emoji and uses only
    # local text glyphs, so rendering remains deterministic and offline.
    local = selected_words if music_theme or speech_presentation or reaction_policy == "ironic_v1" else _caption_words_with_emojis(selected_words, style)
    if burn_emoji_images:
        local = [{**word, "_emoji_text": str(word.get("text", "")), "text": _emoji_layout_text(str(word.get("text", "")))} for word in local]
    music_animated = bool(music_theme) and music_lyric_animation in {"slow_fade", "line_crossfade", "word_build"}
    if music_animated:
        events.extend(_music_animated_events(local, str(music_theme), preset, str(music_lyric_animation), width=width, height=height, fontsize=fontsize, duration=duration))
    elif music_theme in reference_presets:
        for group in _reference_music_groups(local, max_words=3 if music_theme == "reference_white_sans" else 7):
            events.extend(_reference_music_events(group, music_theme, width=width, height=height, duration=duration, content_format=content_format))
    serious_next_index = 0
    for index, word in enumerate(local):
        if music_animated or music_theme in reference_presets:
            continue
        if music_theme:
            group = _music_caption_group(local, index, max_chars)
        else:
            group_size = int(preset["group"])
            group = _caption_group_for_index(local, index, group_size, max_chars)
        smart_fontsize = fontsize
        speech_font_path = None
        if styled_speech:
            speech_font_path = str(Path(__file__).parent / "fonts" / {"hype": "montserrat/Montserrat-ExtraBoldItalic.ttf", "funny": "archivoblack/ArchivoBlack-Regular.ttf", "educational": "barlow/Barlow-Bold.ttf", "serious": "barlow/Barlow-Regular.ttf"}.get(style, "barlow/Barlow-Bold.ttf"))
        phrase_start = phrase_end = None
        if speech_presentation:
            hype_uppercase = styled_speech and style == "hype" and bool(preset.get("uppercase"))
            if styled_speech and style != "hype":
                group = _speech_phrase_group(
                    local, index, int(preset["group"]), max_chars,
                    allow_backtrack=style != "serious",
                )
                if style == "serious":
                    if index < serious_next_index:
                        continue
                    serious_next_index = index + len(group)
                    phrase_start, phrase_end = float(group[0]["start"]), float(group[-1]["end"])
            else:
                group = _smart_speech_group(local, index) if smart_speech or style == "hype" else _caption_group_for_index(local, index, int(preset["group"]), max_chars)
            smart_fontsize = (_smart_speech_fontsize(group, width, fontsize, speech_font_path, uppercase=hype_uppercase)
                              if smart_speech or style == "hype" else min(
                                  (_smart_speech_fontsize([item], width, fontsize, speech_font_path) for item in group),
                                  default=fontsize,
                              ))
        lines = _wrap_caption_words(group, max_chars) if music_theme else _wrap_caption_words(group, max_chars)[:2]
        if speech_presentation:
            lines = _smart_speech_lines(group, width, smart_fontsize, speech_font_path, uppercase=hype_uppercase)
            while styled_speech and style != "hype" and len(lines) > 2 and smart_fontsize > 20:
                smart_fontsize -= 1
                lines = _smart_speech_lines(group, width, smart_fontsize, speech_font_path, uppercase=hype_uppercase)
        line_bits = []
        for line in lines:
            bits = []
            for item in line:
                # Casing is a burn-in treatment: write_caption_sidecars writes
                # the same words with their true casing, so a downloaded .srt
                # is never shouted at the reader.
                raw = str(item.get("_emoji_text", item["text"]))
                display_text = raw.upper() if preset.get("uppercase") else raw
                text = _emoji_ass_text(display_text) if burn_emoji_images else _ass_escape(display_text)
                bits.append(f"{{\\c{preset['highlight']}}}{text}{{\\c{preset['primary']}}}" if item is word and (not styled_speech or style != "serious") else text)
            line_bits.append(" ".join(bits))
        start = max(0, phrase_start if phrase_start is not None else float(word["start"]))
        end = min(duration, max(start + .05, phrase_end if phrase_end is not None else float(word["end"])))
        event_text = r"\N".join(line_bits)
        if smart_speech:
            event_text = f"{{\\fs{smart_fontsize}\\pos({width // 2},{round(height * .54)})}}" + event_text
        elif styled_speech and style == "hype":
            event_text = f"{{\\fs{smart_fontsize}\\pos({width // 2},{round(height * .54)})}}" + event_text
        elif styled_speech:
            event_text = f"{{\\fs{smart_fontsize}}}" + event_text
        events.append(f"Dialogue: 10,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{event_text}")
    for label, start, end in visuals:
        events.append(f"Dialogue: 5,{_ass_time(start)},{_ass_time(end)},Visual,,0,0,0,,{_ass_escape(label)}")
    if credit_text:
        # The renderer chooses the quieter lower corner when source frames are
        # available; either side stays outside the bottom-centred caption band.
        # The explicit wrap keeps long channel names inside the safe width.
        credit_end = min(duration, CREDIT_VISIBLE_SECONDS + CREDIT_FADE_SECONDS)
        fade_milliseconds = round(max(0.0, credit_end - CREDIT_VISIBLE_SECONDS) * 1000)
        fade_tag = f"{{\\fad(0,{fade_milliseconds})}}" if fade_milliseconds else ""
        events.append(f"Dialogue: 2,0,{_ass_time(credit_end)},Credit,,0,0,0,,{fade_tag}{_ass_escape(credit_text)}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def write_music_ass(
    path: Path, words: list[dict[str, Any]], *, offset: float, duration: float,
    width: int, height: int, top_text: str | None = None, subtitle_theme: str = "clean",
    lyric_animation: str | None = None, hook_text_format: str | None = None,
    source_dimensions: tuple[int, int] | None = None, banner_reserve_top: int | None = None,
    hook_end_time: float | None = None,
) -> None:
    if top_text is not None and len(top_text) > 100:
        raise ValueError("Music top text must be 100 characters or fewer")
    if subtitle_theme not in MUSIC_SUBTITLE_THEMES:
        raise ValueError("Unknown music subtitle theme")
    if lyric_animation not in {None, *music_typography.LYRIC_ANIMATIONS}:
        raise ValueError("Unknown music lyric animation")
    if hook_text_format not in {None, *music_typography.HOOK_TEXT_FORMATS}:
        raise ValueError("Unknown music hook text format")
    write_ass(
        path, words, offset=offset, duration=duration, visuals=[], width=width, height=height,
        style="educational", content_format="short", music_theme=subtitle_theme, music_top_text=top_text,
        hook_end_time=hook_end_time, music_lyric_animation=lyric_animation, music_hook_text_format=hook_text_format,
        music_source_dimensions=source_dimensions, music_banner_reserve_top=banner_reserve_top,
    )


def _overlay_inputs(command: list[str], overlays: list[tuple[Path, float, float]]) -> None:
    for path, _, _ in overlays:
        if path.suffix.casefold() in IMAGE_SUFFIXES:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(path)])
        else:
            command.extend(["-stream_loop", "-1", "-i", str(path)])


def _source_layout_filter(src_width: int, src_height: int, target_width: int, target_height: int, *, centered_partial_fill: bool = False, sample_aspect_ratio: float = 1.0) -> str:
    """Keep the complete source visible, optionally using a centered partial fill."""
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
    if centered_partial_fill and target_width == 1080 and target_height == 1920:
        try:
            sar = float(sample_aspect_ratio)
        except (TypeError, ValueError) as exc:
            raise MediaError("Invalid source sample aspect ratio") from exc
        if not math.isfinite(sar) or sar <= 0:
            raise MediaError("Invalid source sample aspect ratio")
        if abs((source_aspect * sar) / (16 / 9) - 1) <= 0.02:
            foreground_height = round(target_height * PARTIAL_FILL_VERTICAL_OCCUPANCY / 2) * 2
            background_width = max(target_width + 2, math.ceil(target_width * BACKGROUND_OVERSCAN_FACTOR / 2) * 2)
            background_height = max(target_height + 2, math.ceil(target_height * BACKGROUND_OVERSCAN_FACTOR / 2) * 2)
            normalize_sar = "setsar=1," if abs(sar - 1.0) < 1e-9 else "scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1,"
            return (
                f"{normalize_sar}split=2[foreground][background];"
                f"[background]scale={background_width}:{background_height}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={background_width}:{background_height},{BACKGROUND_BLUR_FILTER},"
                f"crop={target_width}:{target_height}:(iw-{target_width})/2:(ih-{target_height})/2,setsar=1[bg];"
                f"[foreground]scale=-2:{foreground_height}:flags=lanczos,"
                f"crop={target_width}:{foreground_height}:(iw-{target_width})/2:0,setsar=1[fg];"
                "[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1[base]"
            )
    if abs(source_aspect / target_aspect - 1) <= 0.12:
        return f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase:flags=lanczos,crop={target_width}:{target_height},setsar=1[base]"
    # Overscale the undarkened background before blurring and cropping so the
    # Gaussian edge softening stays outside the delivery canvas. The fitted
    # foreground remains a separate sharp branch; captions and later overlays
    # are applied after this composition by the shared render filters.
    background_width = max(target_width + 2, math.ceil(target_width * BACKGROUND_OVERSCAN_FACTOR / 2) * 2)
    background_height = max(target_height + 2, math.ceil(target_height * BACKGROUND_OVERSCAN_FACTOR / 2) * 2)
    return (
        "split=2[foreground][background];"
        f"[background]scale={background_width}:{background_height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={background_width}:{background_height},{BACKGROUND_BLUR_FILTER},"
        f"crop={target_width}:{target_height}:(iw-{target_width})/2:(ih-{target_height})/2,setsar=1[bg];"
        f"[foreground]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        "setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1[base]"
    )


def _corner_activity(frame: bytes, width: int, height: int, *, left: bool) -> float:
    """Estimate visual busyness in a lower corner from a grayscale frame."""
    x_start = 0 if left else round(width * 0.68)
    x_end = round(width * 0.32) if left else width
    y_start = round(height * 0.68)
    values: list[int] = []
    edge_total = 0
    for y in range(y_start, height):
        for x in range(x_start, x_end):
            index = y * width + x
            value = frame[index]
            values.append(value)
            if x + 1 < x_end:
                edge_total += abs(value - frame[index + 1])
            if y + 1 < height:
                edge_total += abs(value - frame[index + width])
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return edge_total / max(1, len(values) * 2 * 255) + min(1.0, math.sqrt(variance) / 64) * 0.25


def _credit_alignment(source: Path, *, start: float, end: float, width: int, height: int, settings: Settings) -> int:
    """Pick the quieter lower corner, falling back to the established right side.

    This is deliberately a small, best-effort heuristic: it samples the final
    crop at three points and compares lower-corner visual activity. If FFmpeg
    cannot provide a frame, the stable right-side safe zone is retained. The
    generated captions remain bottom-centred and therefore do not compete with
    either corner.
    """
    if not source.is_file() or width <= 0 or height <= 0:
        return 3
    sample_width = 160
    sample_height = max(64, round(sample_width * height / width))
    visible_end = min(end, start + CREDIT_VISIBLE_SECONDS)
    duration = max(0.1, visible_end - start)
    timestamps = (start, start + duration * 0.5, max(start, visible_end - 0.15))
    left_scores: list[float] = []
    right_scores: list[float] = []
    layout = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},scale={sample_width}:{sample_height},format=gray"
    for timestamp in timestamps:
        try:
            result = subprocess.run(
                [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, timestamp):.3f}", "-i", str(source), "-frames:v", "1", "-vf", layout, "-f", "rawvideo", "pipe:1"],
                capture_output=True,
                timeout=8,
                check=False,
            )
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
        expected = sample_width * sample_height
        if result.returncode != 0 or len(result.stdout) < expected:
            continue
        frame = result.stdout[:expected]
        left_scores.append(_corner_activity(frame, sample_width, sample_height, left=True))
        right_scores.append(_corner_activity(frame, sample_width, sample_height, left=False))
    if not left_scores or not right_scores:
        return 3
    left = sum(left_scores) / len(left_scores)
    right = sum(right_scores) / len(right_scores)
    return 1 if left + 0.05 < right else 3


def _subscribe_animation_inputs(
    command: list[str], config: dict[str, Any] | None, duration: float,
    content_format: str | None, width: int, height: int, first_input: int,
) -> list[tuple[int, float, float, float, float]]:
    """Append one independent local animation input per scheduled occurrence.

    Each QTRLE source contains straight alpha and exactly one four-second cycle.
    Independent inputs plus reset PTS make every occurrence begin at frame zero.
    """
    schedule = schedule_subscribe_animation(duration, content_format=content_format or "short", config=config)
    if not schedule:
        return []
    if not ANIMATION_ASSET.is_file():
        raise MediaError("Subscribe animation is enabled, but the bundled animation asset is unavailable")
    landscape = width > height
    visible_button_fraction = 0.45 if landscape else 0.60
    overlay_width = max(2, round(width * visible_button_fraction * ANIMATION_CANVAS_WIDTH / ANIMATION_BUTTON_WIDTH / 2) * 2)
    overlay_height = max(2, round(overlay_width * ANIMATION_CANVAS_HEIGHT / ANIMATION_CANVAS_WIDTH / 2) * 2)
    result = []
    for offset, (start, cycle_duration) in enumerate(schedule):
        command.extend(["-i", str(ANIMATION_ASSET)])
        result.append((first_input + offset, start, cycle_duration, overlay_width, overlay_height))
    return result


def _composite_subscribe_animations(
    filters: list[str], current: str,
    subscribe_animations: list[tuple[int, float, float, float, float]] | None,
) -> str:
    """Append scheduled transparent animation layers to a render graph."""
    for number, (input_index, start, cycle_duration, overlay_width, overlay_height) in enumerate(subscribe_animations or []):
        output = f"subscribe{number}"
        speed = cycle_duration / ANIMATION_DURATION_SECONDS
        filters.append(f"[{input_index}:v]format=rgba,setpts=(PTS-STARTPTS)*{speed:.6f}+{start:.3f}/TB,scale={overlay_width}:{overlay_height}:flags=lanczos[subscribe_layer{number}]")
        filters.append(f"[{current}][subscribe_layer{number}]overlay=x=(W-w)/2:y=H*0.08:format=auto:eof_action=pass:enable='between(t,{start:.3f},{start + cycle_duration:.3f})'[{output}]")
        current = output
    return current


def _music_layout_geometry(width: int, height: int, source_dimensions: tuple[int, int] | None) -> tuple[int, int, int]:
    """(band height, fitted footage height, footage top) shared by the filter and the hook banner."""
    band_height = min(height, round(width * 0.75 / 2) * 2)
    if source_dimensions is None:
        scaled_height = band_height
    else:
        source_width, source_height = source_dimensions
        scale = min(width / source_width, band_height / source_height)
        scaled_height = round(source_height * scale)
    pad_y = max(0, round((height - scaled_height) / 2 - height * 0.045))
    pad_y -= pad_y % 2
    return band_height, scaled_height, pad_y


def _music_source_layout_filter(width: int, height: int, source_dimensions: tuple[int, int], grayscale: bool) -> str:
    band_height, _scaled_height, pad_y = _music_layout_geometry(width, height, source_dimensions)
    treatment = ",format=gray,format=yuv420p" if grayscale else ""
    return (
        f"scale={width}:{band_height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:{pad_y}:color=black{treatment},setsar=1[base]"
    )


def _filters(
    width: int, height: int, overlays: list[tuple[Path, float, float]], asset_start_index: int,
    ass_name: str, source_dimensions: tuple[int, int] | None = None,
    subscribe_animations: list[tuple[int, float, float, float, float]] | None = None,
    music_treatment: str | None = None,
    centered_partial_fill: bool = False,
    sample_aspect_ratio: float = 1.0,
) -> tuple[str, str]:
    if source_dimensions:
        layout = _music_source_layout_filter(width, height, source_dimensions, music_treatment == "grayscale") if music_treatment else _source_layout_filter(*source_dimensions, width, height, centered_partial_fill=centered_partial_fill, sample_aspect_ratio=sample_aspect_ratio)
        filters = [f"[0:v]{layout}"]
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
    current = _composite_subscribe_animations(filters, current, subscribe_animations)
    filters.append(f"[{current}]subtitles={ass_name}[outv]")
    return ";".join(filters), "outv"


# DO-NOT-CHANGE: atomic render (.partial.mp4 + os.replace) with structural output
# validation (dimensions/audio) before the output is publishable
def _smart_speech_emoji_filters(plan: list[tuple[Path, float, float, int, int, int]], first_input: int, input_paths: list[Path] | None = None) -> str:
    filters = []
    current = "outv"
    paths = input_paths or list(dict.fromkeys(entry[0] for entry in plan))
    input_index = {path: first_input + index for index, path in enumerate(paths)}
    occurrences: dict[Path, list[int]] = {}
    for index, (path, *_rest) in enumerate(plan):
        occurrences.setdefault(path, []).append(index)
    for path, indices in occurrences.items():
        labels = [f"emoji_src{index}" for index in indices]
        split = f"split={len(labels)}" if len(labels) > 1 else "null"
        filters.append(f"[{input_index[path]}:v]{split}" + "".join(f"[{label}]" for label in labels))
    for index, (path, start, end, x, y, size) in enumerate(plan):
        label = f"emoji{index}"
        output = f"emojiout{index}"
        filters.append(f"[emoji_src{index}]format=rgba,scale={size}:{size}:flags=lanczos[{label}]")
        filters.append(f"[{current}][{label}]overlay={x}:{y}:format=auto:eof_action=pass:enable='gte(t,{start:.6f})*lt(t,{end:.6f})'[{output}]")
        current = output
    return ";".join(filters)


def _music_audio_filters(*, source_audio: bool, muted: bool, source_volume: float, mode: str, song_gain: float, original_gain: float, duration: float, song_input: int, speed: float) -> tuple[list[str], str, bool]:
    """Build the soundtrack audio graph; return filters, output label, mixed flag."""
    speed = min(1.5, max(0.75, float(speed)))
    song_gain = min(2.0, max(0.0, float(song_gain)))
    original_gain = min(2.0, max(0.0, float(original_gain)))
    original_active = mode == "mix_original" and source_audio and not muted
    filters = []
    filters.append(
        f"[{song_input}:a:0]asetpts=PTS-STARTPTS,aresample=48000,asetrate=48000*{speed:.3f},"
        f"aresample=48000,atrim=duration={duration:.6f},volume={song_gain:.6f}[songout]"
    )
    if not original_active:
        return filters, "songout", False
    original_level = min(2.0, max(0.0, float(source_volume) * original_gain))
    filters.append(
        f"[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,atrim=duration={duration:.6f},"
        f"volume={original_level:.6f}[originalaudio]"
    )
    filters.append(
        "[originalaudio][songout]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
        "alimiter=limit=0.95:level=false:latency=1,"
        f"atrim=duration={duration:.6f},asetpts=PTS-STARTPTS[mixedout]"
    )
    return filters, "mixedout", True


def render_clip(source: Path, output: Path, *, start: float, end: float, aspect: str, words: list[dict[str, Any]], visuals: list[tuple[str, float, float]], overlays: list[tuple[Path, float, float]], settings: Settings, style: str = "educational", has_audio: bool = True, embed_subtitles: bool = False, subtitle_language: str = "und", creator_credit: str | None = None, content_format: str | None = None, centered_partial_fill: bool = False, subscribe_animation: dict[str, Any] | None = None, music_theme: str | None = None, music_top_text: str | None = None, music_treatment: str | None = None, hook_text: str | None = None, presentation: str | None = None, reaction_policy: str | None = None, source_profile: str = "speech", subtitles_enabled: bool = True, muted: bool = False, volume: float = 1.0, filter_preset: str = "none", filter_intensity: float = 1.0, tint_color: str = "#d58a55", tint_opacity: int = 0, text_overlays: list[dict[str, Any]] | None = None, music_track: Path | None = None, music_track_speed: float = 1.0, music_audio_mode: str = "song_only", music_song_gain: float = 1.0, music_original_audio_gain: float = 1.0, music_lyric_animation: str | None = None, music_hook_text_format: str | None = None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    has_supported_emoji = presentation in {"smart_speech_v1", "smart_speech_v2"} and any(find_emoji_sequences(str(word.get("text", ""))) for word in words)
    separate_burn_script = bool(creator_credit or hook_text or not subtitles_enabled or has_supported_emoji)
    ass = output.parent / (f"{output.stem}.burn.ass" if separate_burn_script else f"{output.stem}.ass")
    duration = end - start
    width, height = dimensions(aspect)
    subscribe_schedule = schedule_subscribe_animation(duration, content_format=content_format or "short", config=subscribe_animation)
    hook_end_time = subscribe_schedule[0][0] if subscribe_schedule else duration
    source_meta = probe(source, settings)
    src_width, src_height = source_meta["width"], source_meta["height"]
    if source_meta["rotation"] % 180:
        src_width, src_height = src_height, src_width
    credit_alignment = _credit_alignment(source, start=start, end=end, width=width, height=height, settings=settings) if creator_credit else 3
    caption_words = words if subtitles_enabled else []
    write_ass(ass, caption_words, offset=start, duration=duration, visuals=visuals, width=width, height=height, style=style, creator_credit=creator_credit, credit_alignment=credit_alignment, content_format=content_format, music_theme=music_theme, music_top_text=music_top_text, hook_text=hook_text, hook_end_time=hook_end_time, presentation=presentation, reaction_policy=reaction_policy, burn_emoji_images=presentation in {"smart_speech_v1", "smart_speech_v2"}, music_lyric_animation=music_lyric_animation, music_hook_text_format=music_hook_text_format, music_source_dimensions=(src_width, src_height) if music_theme else None, music_banner_reserve_top=_subscribe_reserve_top(width, height, content_format) if music_theme and subscribe_schedule else None)
    _append_text_overlays(ass, text_overlays or [], duration, width, height)
    # Downloadable sidecars remain independent of the burn-in toggle; the
    # internal ASS and MP4 overlay receive no speech captions when disabled.
    write_caption_sidecars(output, words, offset=start, duration=duration, style=style, music_theme=music_theme, presentation=presentation, reaction_policy=reaction_policy)
    if separate_burn_script:
        # Downloadable ASS remains plain Unicode text. The internal burn script
        # can contain image-layout placeholders and is never substituted for it.
        write_ass(output.with_suffix(".ass"), words, offset=start, duration=duration, visuals=visuals, width=width, height=height, style=style, content_format=content_format, music_theme=music_theme, music_top_text=music_top_text, presentation=presentation, reaction_policy=reaction_policy, music_lyric_animation=music_lyric_animation, music_hook_text_format=music_hook_text_format, music_source_dimensions=(src_width, src_height) if music_theme else None)
    temp = output.with_suffix(".partial.mp4")
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", str(source)]
    _overlay_inputs(command, overlays)
    subscribe_animations = _subscribe_animation_inputs(command, subscribe_animation, duration, content_format, width, height, 1 + len(overlays))
    emoji_plan = _caption_emoji_plan(words, width, height, duration, offset=start, style=style, presentation=presentation, music_theme=music_theme, reaction_policy=reaction_policy, source_profile=source_profile) if subtitles_enabled and (presentation in {"smart_speech_v1", "smart_speech_v2"} or reaction_policy == "ironic_v1") else []
    emoji_inputs = list(dict.fromkeys(path for path, *_ in emoji_plan))
    _overlay_inputs(command, [(path, 0, duration) for path in emoji_inputs])
    subtitle_index = 1 + len(overlays) + len(subscribe_animations) + len(emoji_inputs)
    if embed_subtitles:
        command.extend(["-i", str(output.with_suffix(".srt"))])
    music_track_input = None
    if music_track is not None:
        music_track_input = 1 + len(overlays) + len(subscribe_animations) + len(emoji_inputs) + (1 if embed_subtitles else 0)
        command.extend(["-stream_loop", "-1", "-ss", f"{start * min(1.5, max(0.75, float(music_track_speed))):.3f}", "-i", str(music_track)])
    source_dimensions = (src_width, src_height)
    sample_aspect_ratio = float(source_meta.get("sample_aspect_ratio") or 1.0)
    if source_meta["rotation"] % 180:
        sample_aspect_ratio = 1.0 / sample_aspect_ratio
    filters, mapped = _filters(width, height, overlays, 1, ass.name, source_dimensions, subscribe_animations, music_treatment, centered_partial_fill, sample_aspect_ratio)
    if filter_preset != "none":
        filters = filters.replace("[0:v]", f"[0:v]{_shorts_grade_filter(filter_preset, filter_intensity, tint_color, tint_opacity)},")
    if emoji_plan:
        emoji_filters = _smart_speech_emoji_filters(emoji_plan, 1 + len(overlays) + len(subscribe_animations), emoji_inputs)
        filters = f"{filters};{emoji_filters}"
        mapped = f"emojiout{len(emoji_plan) - 1}"
    audio_output = None
    mixed_audio = False
    if music_track_input is not None:
        audio_filters, audio_output, mixed_audio = _music_audio_filters(
            source_audio=has_audio, muted=muted, source_volume=volume, mode=str(music_audio_mode),
            song_gain=music_song_gain, original_gain=music_original_audio_gain,
            duration=duration, song_input=music_track_input, speed=music_track_speed,
        )
        filters += ";" + ";".join(audio_filters)
    command.extend(["-t", f"{duration:.3f}", "-filter_complex", filters, "-map", f"[{mapped}]"])
    if audio_output is not None:
        command.extend(["-map", f"[{audio_output}]", "-c:a", DELIVERY_AUDIO_CODEC, "-b:a", DELIVERY_AUDIO_BITRATE, "-ar", DELIVERY_AUDIO_RATE])
    elif has_audio and not muted:
        command.extend(["-map", "0:a:0", "-af", f"volume={max(0.0, min(2.0, volume)):.3f}", "-c:a", DELIVERY_AUDIO_CODEC, "-b:a", DELIVERY_AUDIO_BITRATE, "-ar", DELIVERY_AUDIO_RATE])
    else:
        command.append("-an")
    if embed_subtitles:
        command.extend(["-map", f"{subtitle_index}:0", "-c:s", "mov_text", "-metadata:s:s:0", f"language={subtitle_language}"])
    command.extend(["-c:v", DELIVERY_VIDEO_CODEC, "-preset", DELIVERY_PRESET, "-crf", DELIVERY_CRF, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{duration:.3f}", str(temp)])
    run(command, cwd=output.parent, timeout=7200)
    metadata = probe(temp, settings)
    if metadata["width"] != width or metadata["height"] != height or ((music_track is not None or (has_audio and not muted)) and not metadata["audio"]):
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


def plan_high_volume_windows(
    duration: float,
    count: int,
    min_duration: float,
    max_duration: float,
) -> tuple[list[tuple[float, float]], str]:
    """Plan deterministic overlapping windows with distinct starts.

    Unlike the Standard planners, starts may overlap. Every output remains fully
    within the source and within the requested duration bounds.
    """
    if not all(math.isfinite(value) for value in (duration, min_duration, max_duration)):
        return [], ""
    if duration <= 0 or count < 1 or min_duration <= 0 or max_duration < min_duration:
        return [], ""
    if duration < min_duration:
        return [], "The source contains no window within the requested duration range."
    window_duration = min(max_duration, max(min_duration, duration / count))
    last_start = duration - window_duration
    possible_starts = math.floor((last_start + 1e-9) * 10) + 1
    actual_count = min(count, possible_starts)
    if actual_count == 1:
        start_indexes = [0]
    else:
        start_indexes = [round(index * (possible_starts - 1) / (actual_count - 1)) for index in range(actual_count)]
    starts = [index / 10 for index in start_indexes]
    windows = [(start, round(start + window_duration, 6)) for start in starts]
    warning = "" if len(windows) == count else f"Target: {count}. Planned: {len(windows)}. Source duration cannot provide more distinct valid window starts."
    return windows, warning


def plan_fast_high_volume_windows(duration: float, count: int, min_duration: float, max_duration: float, guard_seconds: float = 0) -> tuple[list[tuple[float, float]], str]:
    return plan_high_volume_windows(duration, count, min_duration, max_duration)


def plan_long_form_high_volume_windows(duration: float, count: int, min_duration: float, max_duration: float, guard_seconds: float = 0) -> tuple[list[tuple[float, float]], str]:
    return plan_high_volume_windows(duration, count, min_duration, max_duration)


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


# A punch-in is only worth applying when the source has resolution to spare:
# zooming a frame already scaled down to the canvas just softens it. Mirrors
# the upscale warning the job pipeline records for undersized sources.
_PUNCH_IN_HEADROOM = 1.0


def _look_stages(look: "LookTreatment") -> tuple[str, str]:
    """The look chain, split either side of the scrim overlay.

    Returns ``(before_scrim, after_scrim)``. Order is the whole point:

    * the grade runs in yuv444p — eq/curves applied directly in limited-range
      4:2:0 band badly — and the frame returns to yuv420p only at the very end;
    * the scrim sits between the grade and the grain, so grain lands on top of
      it rather than under it;
    * nothing follows the subtitles filter except the delivery pixel format,
      because grading or graining burned-in text is what makes captions look
      cheap. The caller appends ``subtitles=`` after both stages.
    """
    if not look.has_picture_filters():
        return "", ""
    before: list[str] = ["format=yuv444p"]
    if look.contrast != 1.0 or look.saturation != 1.0 or look.gamma != 1.0:
        before.append(f"eq=contrast={look.contrast:.3f}:saturation={look.saturation:.3f}:gamma={look.gamma:.3f}")
    if look.vignette is not None:
        before.append(f"vignette=angle={look.vignette:.4f}")
    after: list[str] = []
    if look.grain:
        # Light grain also dithers the gradients the grade can introduce.
        after.append(f"noise=alls={max(1, round(look.grain * 100))}:allf=t+u:all_seed={look.grain_seed}")
    return ",".join(before), ",".join(after)


def _look_filter(look: "LookTreatment") -> str:
    """The look chain as one linear string, for callers with no scrim.

    Kept so a graph without an overlay stays a simple ``-vf`` chain.
    """
    before, after = _look_stages(look)
    return ",".join(part for part in (before, after) if part)


def punch_in_has_headroom(punch_in: float, src_width: int, src_height: int, width: int, height: int) -> bool:
    """Whether the source can afford the zoom without being upscaled into it.

    A 6% punch on a frame already scaled to the canvas is a 6% upscale — it
    costs sharpness and buys nothing. The caller skips the move and records a
    warning instead, the same way an undersized source is reported.
    """
    if punch_in <= 1.0:
        return False
    return (min(src_width, src_height) >= min(width, height) * punch_in * _PUNCH_IN_HEADROOM)


def _punch_in_filter(punch_in: float, width: int, height: int, duration: float, frame_rate: float) -> str:
    """A slow zoom that preserves the frame count exactly.

    `zoompan` with `d=1` emits one frame per input frame, and pinning `fps`
    and `s` stops it resampling the timeline — render_fast_clip fails a clip
    whose duration drifts past max(0.75, duration * 0.05), and a filter that
    changes frame count is exactly how that happens.
    """
    rate = max(1, round(frame_rate or 30))
    frames = max(1, round(max(0.1, duration) * rate))
    return (
        f"zoompan=z='min(1+{punch_in - 1.0:.4f}*on/{frames},{punch_in:.4f})'"
        f":d=1:s={width}x{height}:fps={rate},setsar=1"
    )


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
    creator_credit: str | None = None,
    content_format: str | None = None,
    centered_partial_fill: bool = False,
    subscribe_animation: dict[str, Any] | None = None,
    music_theme: str | None = None,
    music_top_text: str | None = None,
    music_treatment: str | None = None,
    presentation: str | None = None,
    reaction_policy: str | None = None,
    source_profile: str = "speech",
    hook_text: str | None = None,
    muted: bool = False,
    volume: float = 1.0,
    filter_preset: str = "none",
    filter_intensity: float = 1.0,
    tint_color: str = "#d58a55",
    tint_opacity: int = 0,
    text_overlays: list[dict[str, Any]] | None = None,
    music_track: Path | None = None,
    music_track_speed: float = 1.0,
    music_audio_mode: str = "song_only",
    music_song_gain: float = 1.0,
    music_original_audio_gain: float = 1.0,
    music_lyric_animation: str | None = None,
    music_hook_text_format: str | None = None,
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
    When ``words`` are supplied, the shared ASS renderer burns accurate,
    clip-relative captions into the output.

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

    if presentation is not None or (reaction_policy == "ironic_v1" and subtitles_enabled and words):
        source_timed_words = [
            {**word, "start": start + float(word["start"]), "end": start + float(word["end"])}
            for word in (words or [])
        ]
        render_clip(
            source, output, start=start, end=end, aspect=aspect, words=source_timed_words,
            visuals=[], overlays=[], settings=settings, style=style, has_audio=has_audio,
            embed_subtitles=embed_subtitles, subtitle_language=subtitle_language,
            creator_credit=creator_credit, content_format=content_format,
            centered_partial_fill=centered_partial_fill, subscribe_animation=subscribe_animation,
            presentation=presentation, reaction_policy=reaction_policy, source_profile=source_profile,
            subtitles_enabled=subtitles_enabled, hook_text=hook_text,
            muted=muted, volume=volume, filter_preset=filter_preset, filter_intensity=filter_intensity,
            tint_color=tint_color, tint_opacity=tint_opacity, text_overlays=text_overlays,
            music_track=music_track, music_track_speed=music_track_speed,
            music_audio_mode=music_audio_mode, music_song_gain=music_song_gain,
            music_original_audio_gain=music_original_audio_gain,
        )
        return

    if music_theme:
        source_timed_words = [
            {**word, "start": start + float(word["start"]), "end": start + float(word["end"])}
            for word in (words or [])
        ]
        render_clip(
            source, output, start=start, end=end, aspect=aspect, words=source_timed_words,
            visuals=[], overlays=[], settings=settings, style=style, has_audio=has_audio,
            embed_subtitles=embed_subtitles, subtitle_language=subtitle_language,
            creator_credit=creator_credit, content_format=content_format,
            centered_partial_fill=centered_partial_fill, subscribe_animation=subscribe_animation, music_theme=music_theme,
            music_top_text=music_top_text, music_treatment=music_treatment,
            music_lyric_animation=music_lyric_animation, music_hook_text_format=music_hook_text_format,
            muted=muted, volume=volume, filter_preset=filter_preset, filter_intensity=filter_intensity,
            tint_color=tint_color, tint_opacity=tint_opacity, text_overlays=text_overlays,
            music_track=music_track, music_track_speed=music_track_speed,
            music_audio_mode=music_audio_mode, music_song_gain=music_song_gain,
            music_original_audio_gain=music_original_audio_gain,
        )
        return

    meta = probe(source, settings)
    if has_audio and not meta["audio"]:
        raise MediaError("Fast clip requested audio but the source has no audio track")
    # FFmpeg applies display-matrix autorotation before video filters. Probe
    # dimensions are encoded dimensions, so crop against the displayed frame.
    src_width, src_height = meta["width"], meta["height"]
    if meta["rotation"] % 180:
        src_width, src_height = src_height, src_width
    sample_aspect_ratio = float(meta.get("sample_aspect_ratio") or 1.0)
    if meta["rotation"] % 180:
        sample_aspect_ratio = 1.0 / sample_aspect_ratio
    vf = _source_layout_filter(src_width, src_height, width, height, centered_partial_fill=centered_partial_fill, sample_aspect_ratio=sample_aspect_ratio).removesuffix("[base]")
    look_treatment = recipe_for(style, content_format).look
    look_before, look_after = _look_stages(look_treatment)
    frame_rate = float(meta.get("frame_rate") or 0) or 30.0
    if look_treatment.punch_in > 1.0:
        if punch_in_has_headroom(look_treatment.punch_in, src_width, src_height, width, height):
            vf = f"{vf},{_punch_in_filter(look_treatment.punch_in, width, height, duration, frame_rate)}"
        else:
            # Skipped rather than applied as an upscale; the job pipeline
            # surfaces source-quality warnings for exactly this case.
            logger.info("Skipping punch-in for %s: source %dx%d has no headroom over %dx%d",
                        output.name, src_width, src_height, width, height)
    vf = f"{vf},{_shorts_grade_filter(filter_preset, filter_intensity, tint_color, tint_opacity)}" if filter_preset != "none" else vf
    if look_before:
        vf = f"{vf},{look_before}"
    if look_after:
        vf = f"{vf},{look_after}"
    ass: Path | None = None
    if (subtitles_enabled or embed_subtitles) and words:
        write_caption_sidecars(output, words, offset=0, duration=duration, style=style)
    if (subtitles_enabled and words) or creator_credit or text_overlays:
        ass = output.parent / (f"{output.stem}.burn.ass" if creator_credit else f"{output.stem}.ass")
        credit_alignment = _credit_alignment(source, start=start, end=end, width=width, height=height, settings=settings) if creator_credit else 3
        write_ass(ass, words if subtitles_enabled else [], offset=0, duration=duration, visuals=[], width=width, height=height, style=style, creator_credit=creator_credit, credit_alignment=credit_alignment, content_format=content_format)
        _append_text_overlays(ass, text_overlays or [], duration, width, height)
        if creator_credit:
            write_ass(output.with_suffix(".ass"), words or [], offset=0, duration=duration, visuals=[], width=width, height=height, style=style, content_format=content_format)
    if look_before or look_after:
        # Return to delivery format after grading and before alpha compositing.
        vf = f"{vf},format=yuv420p"
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
    ]
    subscribe_animations = _subscribe_animation_inputs(command, subscribe_animation, duration, content_format, width, height, 1)
    subtitle_index = 1 + len(subscribe_animations)
    if embed_subtitles:
        command.extend(["-i", str(output.with_suffix(".srt"))])
    if music_track is not None:
        speed = min(1.5, max(0.75, float(music_track_speed)))
        command.extend(["-stream_loop", "-1", "-ss", f"{start * speed:.3f}", "-i", str(music_track)])
    command.extend(["-t", f"{duration:.3f}"])
    graph_audio_output = None
    if music_track is not None:
        song_input = 1 + len(subscribe_animations) + (1 if embed_subtitles else 0)
        audio_filters, graph_audio_output, _ = _music_audio_filters(
            source_audio=has_audio, muted=muted, source_volume=volume, mode=str(music_audio_mode),
            song_gain=music_song_gain, original_gain=music_original_audio_gain,
            duration=duration, song_input=song_input, speed=music_track_speed,
        )
    else:
        audio_filters = []
    if subscribe_animations or music_track is not None:
        graph = [f"[0:v]{vf}[base]"]
        current = "base"
        current = _composite_subscribe_animations(graph, current, subscribe_animations)
        if ass:
            graph.append(f"[{current}]subtitles={ass.name}[outv]")
        else:
            graph.append(f"[{current}]null[outv]")
        graph.extend(audio_filters)
        command.extend(["-filter_complex", ";".join(graph), "-map", "[outv]"])
        if graph_audio_output:
            command.extend(["-map", f"[{graph_audio_output}]"])
    else:
        if ass:
            vf = f"{vf},subtitles={ass.name}"
        command.extend(["-vf", vf, "-map", "0:v"])
    command.extend([
        "-c:v",
        DELIVERY_VIDEO_CODEC,
        "-preset",
        delivery_preset(content_format),
        "-crf",
        DELIVERY_CRF,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ])
    if music_track is not None:
        command.extend(["-c:a", DELIVERY_AUDIO_CODEC, "-b:a", DELIVERY_AUDIO_BITRATE, "-ar", DELIVERY_AUDIO_RATE])
    elif has_audio and not muted:
        command.extend([
            "-map",
            "0:a:0",
            "-af",
            f"volume={max(0.0, min(2.0, volume)):.3f}",
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
        command.extend(["-map", f"{subtitle_index}:0", "-c:s", "mov_text", "-metadata:s:s:0", f"language={subtitle_language}"])
    command.append(str(temp))

    run(command, cwd=output.parent, timeout=7200)

    result = probe(temp, settings)
    if result["width"] != width or result["height"] != height:
        raise MediaError(
            f"Fast clip failed delivery validation: expected {width}x{height}, "
            f"got {result['width']}x{result['height']}"
        )
    if (music_track is not None or (has_audio and not muted)) and not result["audio"]:
        raise MediaError("Fast clip expected audio but the output has no audio track")
    if abs(float(result["duration"]) - duration) > max(0.75, duration * 0.05):
        raise MediaError("Fast clip failed duration validation")

    os.replace(temp, output)
