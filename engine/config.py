from __future__ import annotations

# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md — env var defaults must match compose.yaml
# Changing a default or unit (bytes vs MB, seconds vs minutes) silently breaks deployments


import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().casefold() in {"1", "true", "yes", "on"}


def _str_choices(name: str, default: str, choices: tuple[str, ...]) -> str:
    value = os.getenv(name, default).strip().casefold()
    return value if value in choices else default


@dataclass(frozen=True)
class Settings:
    data_path: Path
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    whisper_beam_size: int
    whisper_word_timestamps: bool
    job_workers: int
    max_queued_jobs: int
    max_upload_bytes: int
    max_source_seconds: int
    max_output_count: int
    retention_days: int
    max_retained_jobs: int
    media_url_ttl: int
    fast_guard_seconds: float
    allowed_origins: tuple[str, ...]
    ffmpeg: str
    ffprobe: str
    ytdlp: str = "yt-dlp"
    ytdlp_connect_timeout: int = 45
    ytdlp_setup_timeout: int = 300
    ytdlp_inactivity_timeout: int = 300
    local_tts: str = "espeak-ng"
    transcription_stall_seconds: int = 180
    max_long_source_seconds: int = 28_800

    @classmethod
    def from_env(cls) -> Settings:
        root = Path(os.getenv("S6_DATA_PATH", "data")).expanduser().resolve()
        origins = tuple(item.strip() for item in os.getenv(
            "S6_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173"
        ).split(",") if item.strip())
        return cls(
            data_path=root,
            whisper_model=os.getenv("S6_WHISPER_MODEL", "base").strip() or "base",
            whisper_device=_str_choices("S6_WHISPER_DEVICE", "cpu", ("cpu", "auto", "cuda")),
            whisper_compute_type=_str_choices(
                "S6_WHISPER_COMPUTE_TYPE", "int8", ("int8", "int8_float16", "float16", "float32", "auto")
            ),
            whisper_beam_size=max(1, min(_int("S6_WHISPER_BEAM_SIZE", 1), 8)),
            whisper_word_timestamps=_bool("S6_WHISPER_WORD_TIMESTAMPS", True),
            job_workers=max(1, min(_int("S6_JOB_WORKERS", 1), 4)),
            max_queued_jobs=max(1, min(_int("S6_MAX_QUEUED_JOBS", 4), 20)),
            max_upload_bytes=max(50_000_000, _int("S6_MAX_UPLOAD_BYTES", 20_000_000_000)),
            max_source_seconds=max(60, _int("S6_MAX_SOURCE_SECONDS", 14_400)),
            max_long_source_seconds=max(60, _int("S6_MAX_LONG_SOURCE_SECONDS", 28_800)),
            max_output_count=max(1, min(_int("S6_MAX_OUTPUT_COUNT", 30), 60)),
            retention_days=max(1, _int("S6_JOB_RETENTION_DAYS", 30)),
            max_retained_jobs=max(5, _int("S6_MAX_RETAINED_JOBS", 100)),
            media_url_ttl=max(60, _int("S6_MEDIA_URL_TTL_SECONDS", 900)),
            fast_guard_seconds=max(0.1, min(_float("S6_FAST_GUARD_SECONDS", 1.0), 10.0)),
            allowed_origins=origins,
            ffmpeg=os.getenv("S6_FFMPEG_BIN", "ffmpeg"),
            ffprobe=os.getenv("S6_FFPROBE_BIN", "ffprobe"),
            ytdlp=os.getenv("S6_YTDLP_BIN", "yt-dlp"),
            ytdlp_connect_timeout=max(5, min(_int("S6_YTDLP_CONNECT_TIMEOUT", 45), 600)),
            ytdlp_setup_timeout=max(30, min(_int("S6_YTDLP_SETUP_TIMEOUT", 300), 3_600)),
            ytdlp_inactivity_timeout=max(30, min(_int("S6_YTDLP_INACTIVITY_TIMEOUT", 300), 86_400)),
            local_tts=os.getenv("S6_LOCAL_TTS_BIN", "espeak-ng"),
            transcription_stall_seconds=max(30, min(_int("S6_TRANSCRIPTION_STALL_SECONDS", 180), 86_400)),
        )

    def prepare(self) -> None:
        for name in ("jobs", "uploads", "library", "models", "cache", "exports", "temp", "secrets"):
            (self.data_path / name).mkdir(parents=True, exist_ok=True)
        self.prepare_model_cache()

    def prepare_model_cache(self) -> None:
        """Keep every Hugging Face cache inside the mounted data path.

        The Whisper download root is already ``data/models``, but the Hub client
        and its Xet transfer backend additionally write a chunk cache and logs
        under ``HF_HOME``, which defaults to ``$HOME/.cache/huggingface``. A
        deployment that runs the engine under a different UID than the image's
        own user — a NAS matching its dataset owner, or an isolated test stack —
        gets ``HOME=/`` and the model download dies with an opaque
        ``Permission denied (os error 13)``. Pinning the caches to the writable
        data path removes that dependency and keeps the downloaded model across
        container rebuilds. Values an operator already set always win.
        """
        root = self.data_path / "models"
        root.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(root))
        os.environ.setdefault("HF_XET_CACHE", str(root / "xet"))


settings = Settings.from_env()
