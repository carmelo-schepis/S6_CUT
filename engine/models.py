from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Style = Literal["funny", "serious", "educational", "hype"]
JobState = Literal["queued", "active", "paused", "partial", "failed", "recovered", "cancelled_kept", "complete"]


class ScoreBreakdown(ApiModel):
    hook: float = Field(ge=0, le=100)
    coherence: float = Field(ge=0, le=100)
    ending: float = Field(ge=0, le=100)
    energy: float = Field(ge=0, le=100)
    practical_value: float = Field(ge=0, le=100)
    visual_potential: float = Field(ge=0, le=100)
    completeness: float = Field(ge=0, le=100)
    penalties: float = Field(ge=0, le=100)
    llm_contribution: float | None = Field(default=None, ge=0, le=100)
    total: float = Field(ge=0, le=100)
    explanation: str = Field(min_length=1, max_length=400)


class ProvenanceRecord(ApiModel):
    id: str
    provider: str
    creator: str | None = None
    original_url: str | None = None
    licence: str
    attribution: str
    query: str | None = None
    match_reason: str
    content_hash: str | None = None


class Clip(ApiModel):
    id: str
    index: int = Field(ge=1)
    state: Literal["queued", "rendering", "complete", "failed"]
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    duration: float = Field(gt=0)
    opening_line: str
    score: ScoreBreakdown
    selected: bool = True
    output_name: str | None = None
    download_url: str | None = None
    error: str | None = None
    fallback_used: bool = False
    visual_label: str | None = None
    provenance: list[ProvenanceRecord] = Field(default_factory=list)

    @field_validator("end")
    @classmethod
    def positive_end(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("end must be positive")
        return value


class Beat(ApiModel):
    id: str
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    char_start: int = Field(ge=0)
    char_end: int = Field(gt=0)
    text: str
    concept: str
    source: str
    confidence: float = Field(ge=0, le=1)
    rule_state: str | None = None
    match_reason: str
    asset_id: str | None = None


class Job(ApiModel):
    schema_version: Literal[1] = 1
    id: str
    project_id: str
    mode: Literal["clip", "script"]
    state: JobState
    stage: str
    stage_label: str
    progress: float = Field(ge=0, le=100)
    current_item: int = Field(default=0, ge=0)
    total_items: int = Field(default=0, ge=0)
    style: Style
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    clips: list[Clip] = Field(default_factory=list)
    beats: list[Beat] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Project(ApiModel):
    schema_version: Literal[1] = 1
    id: str
    name: str = Field(min_length=1, max_length=160)
    mode: Literal["clip", "script"]
    style: Style
    state: JobState
    source_name: str
    source_kind: Literal["upload", "youtube", "script"]
    requested_count: int = Field(ge=1, le=60)
    latest_job_id: str | None = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Health(ApiModel):
    status: Literal["ready", "degraded", "starting"]
    version: str
    database: bool
    ffmpeg: bool
    ffprobe: bool
    whisper: bool
    ytdlp: bool
    local_tts: bool
    data_path: str
    free_bytes: int
    active_workers: int
    queued_jobs: int
    fallbacks: dict[str, str]


class ScriptJobInput(ApiModel):
    script: str = Field(min_length=10, max_length=200_000)
    name: str | None = Field(default=None, max_length=160)
    style: Style = "educational"
    aspect_ratio: Literal["9:16", "1:1", "16:9"] = "9:16"
    narration: Literal["auto", "local", "silent"] = "auto"


class SelectionInput(ApiModel):
    clip_ids: list[str] = Field(max_length=60)


class ProfileInput(ApiModel):
    name: str = Field(min_length=1, max_length=100)
    model_id: str = Field(default="openai/gpt-4.1-mini", max_length=200)
    voice_id: str | None = Field(default=None, max_length=200)
    openrouter_key: str | None = Field(default=None, max_length=500)
    elevenlabs_key: str | None = Field(default=None, max_length=500)
    persistence: Literal["session", "encrypted"] = "encrypted"
    selected: bool = False


class ProviderProfile(ApiModel):
    id: str
    name: str
    model_id: str
    voice_id: str | None = None
    selected: bool
    persistence: Literal["session", "encrypted"]
    openrouter_configured: bool
    elevenlabs_configured: bool
    openrouter_masked: str | None = None
    elevenlabs_masked: str | None = None
    status: str
    capabilities: list[str]
    fallbacks: dict[str, str]


class Asset(ApiModel):
    id: str
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    media_type: str
    filename: str
    tags: list[str] = Field(default_factory=list)
    triggers: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    negative_triggers: list[str] = Field(default_factory=list)
    policy: Literal["required", "prefer", "neutral", "never"] = "neutral"
    protected: bool = False
    min_spacing_seconds: float = Field(default=8, ge=0, le=3600)
    max_uses_per_project: int = Field(default=3, ge=1, le=100)
    active_from: str | None = None
    active_until: str | None = None
    licence: str = Field(default="User supplied", max_length=500)
    attribution: str = Field(default="", max_length=1000)
    content_hash: str
    created_at: str = Field(default_factory=now_iso)


class AssetUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2_000)
    tags: list[str] | None = None
    triggers: list[str] | None = None
    aliases: list[str] | None = None
    negative_triggers: list[str] | None = None
    policy: Literal["required", "prefer", "neutral", "never"] | None = None
    protected: bool | None = None
    min_spacing_seconds: float | None = Field(default=None, ge=0, le=3600)
    max_uses_per_project: int | None = Field(default=None, ge=1, le=100)
    active_from: str | None = None
    active_until: str | None = None
    licence: str | None = Field(default=None, max_length=500)
    attribution: str | None = Field(default=None, max_length=1000)


class MatchExplanation(ApiModel):
    query: str
    selected: Asset | None
    matched_triggers: list[str]
    score: float
    reason: str
    rejected: list[dict[str, Any]]
