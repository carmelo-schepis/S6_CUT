from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
# camelCase JSON contract with web/src/types.ts zod schemas; extra='forbid'
class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


ProcessingStepStatus = Literal["pending", "active", "complete", "skipped", "failed"]

Style = Literal["funny", "serious", "educational", "hype"]
JobState = Literal["queued", "active", "paused", "stalled", "partial", "failed", "recovered", "cancelled_kept", "complete"]
ProcessingMode = Literal["fast", "smart"]
ContentFormat = Literal["short", "long"]
BatchMode = Literal["standard", "high_volume"]
DownloadPhase = Literal["queued", "connecting", "downloading", "stalled", "retrying", "stopped_partial", "failed", "complete"]


class DownloadProgress(ApiModel):
    downloaded_bytes: int = Field(default=0, ge=0)
    total_bytes: int | None = Field(default=None, ge=0)
    percent: float | None = Field(default=None, ge=0, le=100)
    phase: DownloadPhase = "queued"
    last_progress_at: str = Field(default_factory=now_iso)
    speed_bytes_per_second: float | None = Field(default=None, ge=0)
    eta_seconds: float | None = Field(default=None, ge=0)
    message: str | None = Field(default=None, max_length=500)
    resumable: bool = True
UNSORTED_LIBRARY_FOLDER_ID = "00000000-0000-0000-0000-000000000001"


class PenaltyItem(ApiModel):
    kind: Literal["filler_words", "length_off_target"]
    points: float = Field(ge=0)
    filler_word_counts: dict[str, int] | None = None
    points_per_word: float | None = Field(default=None, ge=0)
    speech_seconds: float | None = Field(default=None, ge=0)
    target_seconds: float | None = Field(default=None, ge=0)


class ScoreBreakdown(ApiModel):
    hook: float = Field(ge=0, le=100)
    coherence: float = Field(ge=0, le=100)
    ending: float = Field(ge=0, le=100)
    energy: float = Field(ge=0, le=100)
    practical_value: float = Field(ge=0, le=100)
    visual_potential: float = Field(ge=0, le=100)
    completeness: float = Field(ge=0, le=100)
    penalties: float = Field(ge=0, le=100)
    penalty_items: list[PenaltyItem] | None = None
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


class CaptionDownload(ApiModel):
    format: Literal["ass", "srt", "vtt"]
    filename: str
    url: str


class CaptionCue(ApiModel):
    id: str
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)
    confidence: float | None = Field(default=None, ge=0, le=1)
    warnings: list[str] = Field(default_factory=list)


class MusicPresentationConfig(ApiModel):
    version: Literal[1] = 1
    subtitle_theme: Literal["clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif"] = "clean"


class YouTubeMetadataUpdate(ApiModel):
    revision: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)

    @field_validator("title")
    @classmethod
    def clean_metadata_title(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Title contains unsupported control characters")
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("Title cannot be blank")
        if any(char in "<>" for char in cleaned):
            raise ValueError("Title contains unsupported angle brackets")
        return cleaned

    @field_validator("description")
    @classmethod
    def clean_metadata_description(cls, value: str) -> str:
        cleaned = value.strip()
        if any((ord(char) < 32 and char not in "\n\t") or ord(char) == 127 or char in "<>" for char in cleaned):
            raise ValueError("Description contains unsupported control characters or angle brackets")
        return cleaned


class MusicAudioMode(StrEnum):
    SONG_ONLY = "song_only"
    MIX_ORIGINAL = "mix_original"


class MusicTrackSnapshot(ApiModel):
    asset_id: str | None = None
    title: str = Field(min_length=1, max_length=200)
    source: Literal["upload", "youtube"]
    speed: Literal[0.75, 0.85, 1.0, 1.25, 1.5] = 1.0


class Clip(ApiModel):
    id: str
    index: int = Field(ge=1)
    state: Literal["queued", "rendering", "complete", "failed"]
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    duration: float = Field(gt=0)
    opening_line: str
    score: ScoreBreakdown | None = None
    selected: bool = True
    review_required: bool = False
    review_reason: str | None = None
    transcript_excerpt: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    caption_qa_warnings: list[str] = Field(default_factory=list)
    caption_downloads: list[CaptionDownload] = Field(default_factory=list)
    caption_cues: list[CaptionCue] = Field(default_factory=list)
    caption_revision: int = Field(default=0, ge=0)
    output_name: str | None = None
    blob_id: str | None = None
    # Exact attribution passed to the renderer and recorded only on publication.
    creator_credit: str | None = Field(default=None, max_length=140)
    music_top_text: str | None = Field(default=None, max_length=100)
    hook_text: str | None = Field(default=None, max_length=150)
    youtube_description: str | None = Field(default=None, max_length=500)
    youtube_metadata_revision: int = Field(default=0, ge=0)
    youtube_metadata_status: Literal["pending", "generated", "unavailable", "fallback"] | None = None
    youtube_metadata_reason: str | None = Field(default=None, max_length=300)
    youtube_metadata_model: str | None = Field(default=None, max_length=200)
    youtube_metadata_generated_at: str | None = None
    youtube_metadata_input_tokens: int | None = Field(default=None, ge=0)
    youtube_metadata_output_tokens: int | None = Field(default=None, ge=0)
    youtube_metadata_cost_usd: float | None = Field(default=None, ge=0)
    youtube_metadata_cost_kind: Literal["actual", "estimated"] | None = None
    music_treatment: Literal["color", "grayscale"] | None = None
    music_track: "MusicTrackSnapshot | None" = None
    music_audio_mode: MusicAudioMode = MusicAudioMode.SONG_ONLY
    music_song_gain: float = Field(default=1.0, ge=0, le=2)
    music_original_audio_gain: float = Field(default=1.0, ge=0, le=2)
    # DO-NOT-CHANGE: engine-set only, after the publication transaction commits —
    # the UI never displays this from optimistic state
    library_asset_id: str | None = None
    title: str | None = None
    # Who wrote the title: rule-based publication, an AI suggestion, or the
    # user. None means a legacy record (see seo_titles.clip_title_replaceable).
    title_source: Literal["auto", "ai", "user"] | None = None
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    folder_id: str | None = None
    published_at: str | None = None
    preview_url: str | None = None
    thumbnail_url: str | None = None
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


class ProcessingStep(ApiModel):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    status: ProcessingStepStatus = "pending"
    detail: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    current_item: int | None = Field(default=None, ge=0)
    total_items: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_timestamps_and_counts(self):
        if self.status in {"pending", "active"} and self.completed_at is not None:
            raise ValueError(f"{self.status} steps cannot have a completion timestamp")
        if self.status in {"complete", "skipped", "failed"} and self.completed_at is None:
            raise ValueError(f"{self.status} steps require a completion timestamp")
        if self.current_item is not None and self.total_items is not None and self.current_item > self.total_items:
            raise ValueError("current item cannot exceed total items")
        return self


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
    # Captured when the job is created; later project moves do not alter it.
    library_folder_id: str = UNSORTED_LIBRARY_FOLDER_ID
    source_blob_id: str | None = None
    mode: Literal["clip", "script"]
    state: JobState
    stage: str
    stage_label: str
    progress: float = Field(ge=0, le=100)
    download_progress: DownloadProgress | None = None
    current_item: int = Field(default=0, ge=0)
    total_items: int = Field(default=0, ge=0)
    style: Style
    processing_mode: ProcessingMode = "smart"
    execution_policy: Literal["auto", "engine_only"] = "auto"
    content_format: ContentFormat = "short"
    source_profile: Literal["speech", "music"] = "speech"
    # Automatic personal-library video composition is deliberately opt-in.
    library_overlays_enabled: bool = False
    requested_count: int = Field(default=1, ge=1, le=500)
    batch_mode: BatchMode = "standard"
    effective_target: int | None = Field(default=None, ge=0, le=500)
    cap_explanation: str | None = Field(default=None, max_length=500)
    planned_count: int = Field(default=0, ge=0, le=500)
    successful_count: int = Field(default=0, ge=0, le=500)
    music_presentation: MusicPresentationConfig | None = None
    music_top_text: str | None = Field(default=None, max_length=100)
    music_track: MusicTrackSnapshot | None = None
    music_audio_mode: MusicAudioMode = MusicAudioMode.SONG_ONLY
    music_song_gain: float = Field(default=1.0, ge=0, le=2)
    music_original_audio_gain: float = Field(default=1.0, ge=0, le=2)
    # Snapshot of the user's caption choice; legacy payloads default safely on.
    burn_subtitles: bool = True
    embed_subtitles: bool = False
    hook_text_enabled: bool = False
    youtube_metadata_enabled: bool = False
    youtube_metadata_model_id: str | None = Field(default=None, max_length=200)
    warnings: list[str] = Field(default_factory=list)
    queued_at: str | None = None
    queue_position: int | None = Field(default=None, ge=1)
    queued_elapsed_seconds: float | None = Field(default=None, ge=0)
    active_elapsed_seconds: float | None = Field(default=None, ge=0)
    blocker_summary: str | None = None
    cancellation_available: bool = False
    transcription_started_at: str | None = None
    last_heartbeat_at: str | None = None
    transcription_elapsed_seconds: float | None = Field(default=None, ge=0)
    transcription_processed_seconds: float | None = Field(default=None, ge=0)
    transcription_total_seconds: float | None = Field(default=None, ge=0)
    transcription_activity: str | None = None
    error: str | None = None
    # Computed for the public view (see public_job); the persisted value is not
    # read back. The Workspace renders Retry import from this rather than
    # guessing, so the offer and the engine's answer cannot disagree.
    can_retry_import: bool = False
    clips: list[Clip] = Field(default_factory=list)
    beats: list[Beat] = Field(default_factory=list)
    steps: list[ProcessingStep] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)

    @model_validator(mode="after")
    # DO-NOT-CHANGE: enforces at-most-one-active-step and ready-step completion;
    # all step transitions must go through JobManager.start/complete/skip/fail_step
    def valid_step_state(self):
        if sum(step.status == "active" for step in self.steps) > 1:
            raise ValueError("at most one processing step may be active")
        ready = next((step for step in self.steps if step.id == "ready"), None)
        if ready and ready.status == "complete" and self.state in {"queued", "active", "paused", "stalled", "recovered"}:
            raise ValueError("Project ready cannot complete while the job is still processing")
        return self


class Project(ApiModel):
    schema_version: Literal[1] = 1
    id: str
    name: str = Field(min_length=1, max_length=160)
    mode: Literal["clip", "script"]
    style: Style
    state: JobState
    source_name: str
    source_kind: Literal["upload", "youtube", "script"]
    # Extracted from the immutable YouTube import sidecar and persisted with
    # the project so attribution remains truthful after refresh/restart.
    source_title: str | None = Field(default=None, max_length=200)
    source_creator: str | None = Field(default=None, max_length=120)
    # True when the user left the project name blank, so the engine may replace
    # its placeholder once the real source title is known.
    name_is_auto: bool = False
    requested_count: int = Field(ge=1, le=500)
    batch_mode: BatchMode = "standard"
    effective_target: int | None = Field(default=None, ge=0, le=500)
    cap_explanation: str | None = Field(default=None, max_length=500)
    content_format: ContentFormat = "short"
    source_profile: Literal["speech", "music"] = "speech"
    music_track: MusicTrackSnapshot | None = None
    music_audio_mode: MusicAudioMode = MusicAudioMode.SONG_ONLY
    music_song_gain: float = Field(default=1.0, ge=0, le=2)
    music_original_audio_gain: float = Field(default=1.0, ge=0, le=2)
    latest_job_id: str | None = None
    library_folder_id: str = UNSORTED_LIBRARY_FOLDER_ID
    source_blob_id: str | None = None
    thumbnail_url: str | None = None
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
    data_path: str
    free_bytes: int
    configured_workers: int = Field(ge=1)
    active_workers: int
    queued_jobs: int
    fallbacks: dict[str, str]


# The iPhone/iPad status view polls every few seconds. The full job list carries
# every clip of every job (about 480 KB for 69 jobs), so these compact read-only
# views exist to keep that poll small. They are projections: nothing here is
# persisted or accepted as input.
class MobileClip(ApiModel):
    id: str
    index: int = Field(ge=1)
    title: str
    duration: float = Field(ge=0)
    thumbnail_url: str | None = None
    preview_url: str | None = None


class MobileJob(ApiModel):
    id: str
    project_id: str
    project_name: str
    mode: Literal["clip", "script"]
    state: JobState
    stage: str
    stage_label: str
    progress: float = Field(ge=0, le=100)
    current_item: int = Field(default=0, ge=0)
    total_items: int = Field(default=0, ge=0)
    style: Style
    content_format: ContentFormat = "short"
    download_progress: DownloadProgress | None = None
    # Only live jobs carry their steps; finished ones are summarised by `clips`.
    steps: list[ProcessingStep] = Field(default_factory=list)
    queue_position: int | None = Field(default=None, ge=1)
    active_elapsed_seconds: float | None = Field(default=None, ge=0)
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    source_title: str | None = None
    source_thumbnail_url: str | None = None
    clips_ready: int = Field(default=0, ge=0)
    clips: list[MobileClip] = Field(default_factory=list)
    created_at: str
    updated_at: str


class MobileDownload(ApiModel):
    id: str
    state: Literal["queued", "active", "complete", "failed"]
    phase: str
    downloaded_bytes: int = Field(default=0, ge=0)
    total_bytes: int | None = Field(default=None, ge=0)
    percent: float | None = Field(default=None, ge=0, le=100)
    message: str | None = None
    title: str | None = None
    thumbnail_url: str | None = None
    error: str | None = None
    created_at: str
    updated_at: str


class MobileOverview(ApiModel):
    generated_at: str = Field(default_factory=now_iso)
    running: list[MobileJob] = Field(default_factory=list)
    recent: list[MobileJob] = Field(default_factory=list)
    recent_total: int = Field(default=0, ge=0)
    downloads: list[MobileDownload] = Field(default_factory=list)
    clips_last_day: int = Field(default=0, ge=0)
    failed_last_day: int = Field(default=0, ge=0)


class SubscribeAnimationConfig(ApiModel):
    version: Literal[1] = 1
    enabled: bool = False
    short_form_lead_seconds: Literal[5, 10] = 5


class SelectionInput(ApiModel):
    clip_ids: list[str] = Field(max_length=500)


class CaptionReviewInput(ApiModel):
    revision: int = Field(ge=0)
    cues: list[CaptionCue] = Field(max_length=500)


class ShortsTextOverlay(ApiModel):
    id: str = Field(min_length=1, max_length=80)
    text: str = Field(max_length=500)
    color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    size: float = Field(default=48, ge=8, le=240)
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)
    start: float = Field(default=0, ge=0)
    duration: float = Field(default=1, gt=0)

    @field_validator("start", "duration")
    @classmethod
    def finite_overlay_times(cls, value: float) -> float:
        import math
        if not math.isfinite(value):
            raise ValueError("Overlay times must be finite")
        return value


class ShortsJobInput(ApiModel):
    name: str | None = Field(default=None, max_length=160)
    burn_subtitles: bool = True
    embed_subtitles: bool = False
    asset_id: str = Field(min_length=1, max_length=200)
    start: float = Field(ge=0)
    end: float | None = Field(default=None, gt=0)
    aspect_ratio: Literal["9:16", "16:9", "1:1", "4:5"] = "9:16"
    library_folder_id: str = UNSORTED_LIBRARY_FOLDER_ID
    subscribe_animation: SubscribeAnimationConfig = Field(default_factory=SubscribeAnimationConfig)
    muted: bool = False
    volume: float = Field(default=1.0, ge=0, le=2)
    filter_preset: Literal["none", "warm", "cool", "black_white", "tint", "monochrome"] = "none"
    filter_intensity: float = Field(default=1, ge=0, le=1)
    tint_color: str = Field(default="#d58a55", pattern=r"^#[0-9a-fA-F]{6}$")
    tint_opacity: int = Field(default=0, ge=0, le=100)
    text_overlays: list[ShortsTextOverlay] = Field(default_factory=list, max_length=20)

    @field_validator("start", "end")
    @classmethod
    def finite_trim(cls, value: float | None) -> float | None:
        import math
        if value is not None and not math.isfinite(value):
            raise ValueError("Trim values must be finite")
        return value

    @model_validator(mode="after")
    def valid_trim(self):
        if self.end is not None and self.end <= self.start:
            raise ValueError("End must be greater than start")
        return self


class ProjectFolderUpdate(ApiModel):
    folder_id: str
    move_existing_assets: bool = False


class ProfileInput(ApiModel):
    name: str = Field(min_length=1, max_length=100)
    text_model_id: str = Field(default="openai/gpt-4.1-mini", max_length=200)
    youtube_metadata_model_id: str | None = Field(default=None, max_length=200)
    auto_seo_titles: bool | None = None
    openrouter_key: str | None = Field(default=None, max_length=500)
    persistence: Literal["session", "encrypted"] = "encrypted"
    selected: bool = False


ProviderConnectionStatus = Literal[
    "not_configured", "configured", "connected", "invalid_credentials", "insufficient_balance",
    "rate_limited", "timeout_offline", "unavailable",
    "malformed_response", "provider_service_failure",
]


class OpenRouterModel(ApiModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=300)
    context_length: int | None = Field(default=None, ge=1)
    output_modalities: list[str] = Field(default_factory=list, max_length=10)
    supported_parameters: list[str] = Field(default_factory=list, max_length=100)
    free: bool = False
    pricing: dict[str, str] | None = None


class ProviderProfile(ApiModel):
    id: str
    name: str
    text_model_id: str
    youtube_metadata_model_id: str = "google/gemini-2.5-flash-lite"
    auto_seo_titles: bool = True
    selected: bool
    persistence: Literal["session", "encrypted"]
    openrouter_configured: bool
    openrouter_masked: str | None = None
    text_status: ProviderConnectionStatus = "not_configured"
    text_message: str | None = None
    text_last_checked_at: str | None = None
    status: str
    capabilities: list[str]
    fallbacks: dict[str, str]


AssetOrigin = Literal["manual-import", "project-source", "generated-clip", "script-output"]


class LibraryFolder(ApiModel):
    id: str
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = None
    description: str = Field(default="", max_length=500)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    archived: bool = False
    deleted: bool = False
    system: bool = False
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class FolderCreate(ApiModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = None
    description: str = Field(default="", max_length=500)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class FolderUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class FolderMove(ApiModel):
    parent_id: str | None = None


class AssetMove(ApiModel):
    asset_ids: list[str] = Field(min_length=1, max_length=500)
    folder_id: str


class AssetDelete(ApiModel):
    asset_ids: list[str] = Field(min_length=1, max_length=500)


class AssetDeleteResult(ApiModel):
    deleted: list[str] = Field(default_factory=list)
    failed: dict[str, str] = Field(default_factory=dict)


class LibraryPurgeInput(ApiModel):
    confirmation: str = Field(min_length=1, max_length=64)


class LibraryPurgeResult(ApiModel):
    assets_deleted: int = Field(ge=0)
    projects_deleted: int = Field(ge=0)
    blobs_deleted: int = Field(ge=0)
    bytes_reclaimed: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)


class Asset(ApiModel):
    id: str
    title: str = Field(min_length=1, max_length=200)
    title_source: Literal["auto", "ai", "user"] | None = None
    description: str = Field(default="", max_length=2_000)
    media_type: str
    filename: str
    tags: list[str] = Field(default_factory=list)
    brands: list[str] = Field(default_factory=list)
    people: list[str] = Field(default_factory=list)
    triggers: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    negative_triggers: list[str] = Field(default_factory=list)
    policy: Literal["required", "prefer", "neutral", "never"] = "neutral"
    protected: bool = False
    starred: bool = False
    min_spacing_seconds: float = Field(default=8, ge=0, le=3600)
    max_uses_per_project: int = Field(default=3, ge=1, le=100)
    active_from: str | None = None
    active_until: str | None = None
    licence: str = Field(default="User supplied", max_length=500)
    attribution: str = Field(default="", max_length=1000)
    content_hash: str
    folder_id: str = UNSORTED_LIBRARY_FOLDER_ID
    origin: AssetOrigin = "manual-import"
    # Only explicitly approved manual assets may be used as automatic B-roll.
    video_overlay_eligible: bool = False
    blob_id: str = ""
    source_project_id: str | None = None
    source_job_id: str | None = None
    source_clip_id: str | None = None
    duration_seconds: float | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    preview_url: str | None = None
    thumbnail_url: str | None = None
    aspect_ratio: str | None = None
    published_at: str = Field(default_factory=now_iso)
    created_at: str = Field(default_factory=now_iso)

    @model_validator(mode="after")
    def default_blob_id(self):
        if not self.blob_id:
            self.blob_id = self.content_hash
        return self


class AssetUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2_000)
    tags: list[str] | None = None
    brands: list[str] | None = None
    people: list[str] | None = None
    triggers: list[str] | None = None
    aliases: list[str] | None = None
    negative_triggers: list[str] | None = None
    policy: Literal["required", "prefer", "neutral", "never"] | None = None
    video_overlay_eligible: bool | None = None
    protected: bool | None = None
    starred: bool = False
    min_spacing_seconds: float | None = Field(default=None, ge=0, le=3600)
    max_uses_per_project: int | None = Field(default=None, ge=1, le=100)
    active_from: str | None = None
    active_until: str | None = None
    licence: str | None = Field(default=None, max_length=500)
    attribution: str | None = Field(default=None, max_length=1000)
    folder_id: str | None = None


class SourceOnlyRegenerationRequest(ApiModel):
    clip_ids: list[str] = Field(min_length=1, max_length=500)


class AssetPage(ApiModel):
    items: list[Asset]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    has_more: bool


class RecentClipsPage(ApiModel):
    items: list[Asset]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    has_more: bool
    total: int = Field(ge=0)


class MatchExplanation(ApiModel):
    query: str
    selected: Asset | None
    matched_triggers: list[str]
    score: float
    reason: str
    rejected: list[dict[str, Any]]
