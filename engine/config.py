from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    data_path: Path
    whisper_model: str
    job_workers: int
    max_queued_jobs: int
    max_upload_bytes: int
    max_source_seconds: int
    max_output_count: int
    retention_days: int
    max_retained_jobs: int
    media_url_ttl: int
    allowed_origins: tuple[str, ...]
    ffmpeg: str
    ffprobe: str
    ytdlp: str
    local_tts: str

    @classmethod
    def from_env(cls) -> "Settings":
        root = Path(os.getenv("S6_DATA_PATH", "data")).expanduser().resolve()
        origins = tuple(item.strip() for item in os.getenv(
            "S6_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173"
        ).split(",") if item.strip())
        return cls(
            data_path=root,
            whisper_model=os.getenv("S6_WHISPER_MODEL", "small"),
            job_workers=max(1, min(_int("S6_JOB_WORKERS", 1), 4)),
            max_queued_jobs=max(1, min(_int("S6_MAX_QUEUED_JOBS", 4), 20)),
            max_upload_bytes=max(50_000_000, _int("S6_MAX_UPLOAD_BYTES", 20_000_000_000)),
            max_source_seconds=max(60, _int("S6_MAX_SOURCE_SECONDS", 14_400)),
            max_output_count=max(1, min(_int("S6_MAX_OUTPUT_COUNT", 30), 60)),
            retention_days=max(1, _int("S6_JOB_RETENTION_DAYS", 30)),
            max_retained_jobs=max(5, _int("S6_MAX_RETAINED_JOBS", 100)),
            media_url_ttl=max(60, _int("S6_MEDIA_URL_TTL_SECONDS", 900)),
            allowed_origins=origins,
            ffmpeg=os.getenv("S6_FFMPEG_BIN", "ffmpeg"),
            ffprobe=os.getenv("S6_FFPROBE_BIN", "ffprobe"),
            ytdlp=os.getenv("S6_YTDLP_BIN", "yt-dlp"),
            local_tts=os.getenv("S6_LOCAL_TTS_BIN", "espeak-ng"),
        )

    def prepare(self) -> None:
        for name in ("jobs", "uploads", "library", "models", "cache", "exports", "temp", "secrets"):
            (self.data_path / name).mkdir(parents=True, exist_ok=True)


settings = Settings.from_env()
