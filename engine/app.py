from __future__ import annotations

import asyncio
import errno
import hashlib
import importlib.util
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Literal

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .config import settings
from .database import Database, MAX_FOLDER_DEPTH, MetadataGenerationClaimError, UNSORTED_FOLDER_ID
from .jobs import JobManager, ProjectDeletingError, QueueFullError, RetiredScriptJobError, SwitchFastError, can_retry_import, resolve_batch_target, uses_fast_pipeline
from .library import LibraryRules
from .media import _SUBTITLE_PRESETS, MediaError, available, caption_font_mismatches, probe, probe_audio, validate_audio_track, validate_video_upload
from .models import (
    Asset, AssetDelete, AssetDeleteResult, AssetMove, AssetOrigin, AssetUpdate, AssetPage, CaptionCue, CaptionDownload, CaptionReviewInput, Clip, FolderCreate, FolderMove, FolderUpdate, Health, Job, LibraryPurgeInput, LibraryPurgeResult,
    LibraryFolder, MatchExplanation, MobileClip, MobileDownload, MobileJob, MobileOverview, RecentClipsPage, ContentFormat, ProcessingMode, ProfileInput, Project, ProjectFolderUpdate,
    OpenRouterModel, ProviderProfile, SelectionInput, ShortsJobInput, SubscribeAnimationConfig, MusicPresentationConfig, YouTubeMetadataUpdate, now_iso,
)
from .providers import ProfileService, ProviderError
from .security import MediaSigner, SecretVault, confined, safe_filename, validate_youtube_url
from .seo_titles import SEO_PROMPT_VERSION, SEO_TITLE_RULES, normalize_seo_description, normalize_seo_title, source_context_title
from .source_preview import PREVIEW_NAME, ensure_preview, has_preview, read_info_title
from .thumbnails import get_thumbnail, prune_thumbnails
from .title_backfill import TitleApplyRequest, TitleApplyResponse, TitleBackfill, TitleSuggestionRequest, TitleSuggestionResponse
from .video_downloads import VideoDownloadInput, VideoDownloadManager, VideoDownloadTask


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
# signed URLs, confined paths, rate-limited creation, camelCase API contract with frontend


def _subscribe_animation_request(raw: str) -> SubscribeAnimationConfig:
    try:
        value = json.loads(raw)
        return SubscribeAnimationConfig.model_validate(value)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(422, "Subscribe animation config is invalid") from exc


def _music_presentation_request(raw: str) -> MusicPresentationConfig:
    try:
        return MusicPresentationConfig.model_validate(json.loads(raw))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(422, "Music presentation config is invalid") from exc


def _project_name(value: str | None, fallback: str) -> str:
    cleaned = " ".join((value or "").split())
    cleaned = "".join(char for char in cleaned if char.isprintable())[:160].rstrip()
    return cleaned or fallback[:160]


settings.prepare()
db = Database(settings.data_path / "s6-cut.sqlite3")
vault = SecretVault(settings.data_path / "secrets" / "instance.key")
signer = MediaSigner(settings.data_path / "secrets" / "media-signing.key", settings.media_url_ttl)
rules = LibraryRules(db, settings.data_path / "library")
profiles = ProfileService(db, vault)
manager = JobManager(db, rules, profiles, settings)
title_backfill = TitleBackfill(db, profiles, lambda job, private: manager._save(job, private))
video_downloads = VideoDownloadManager(settings, signer)
creation_times: defaultdict[str, deque[float]] = defaultdict(deque)


logger = logging.getLogger(__name__)


def _prune_orphaned_thumbnails():
    retained = {asset.blob_id for asset in db.list_assets(include_archived=True) if asset.media_type.startswith("video/")}
    try:
        prune_thumbnails(settings.data_path, retained)
    except (OSError, ValueError) as exc:
        logger.warning("Could not prune orphaned video thumbnails: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # A caption face that fontconfig cannot satisfy is silently replaced by
    # DejaVu Sans and synthetically emboldened, which looks like a bad preset
    # rather than a missing font. Say so at startup instead.
    mismatched = caption_font_mismatches()
    if mismatched:
        for requested, resolved in mismatched.items():
            logger.error("Caption font %r is not installed; fontconfig resolves it to %r. Captions will render in the wrong face.", requested, resolved)
    else:
        logger.info("Caption fonts resolved: %s", ", ".join(sorted({str(preset["fontname"]) for preset in _SUBTITLE_PRESETS.values()})))
    _prune_orphaned_thumbnails()
    await manager.start()
    await video_downloads.start()
    try:
        yield
    finally:
        await video_downloads.stop()
        await manager.stop()


app = FastAPI(title="S6_cut Media Engine", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_credentials=False, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"])


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    if request.url.path.startswith("/api/v1/profiles"):
        return JSONResponse(status_code=422, content={"detail": "Provider profile validation failed"})
    return await request_validation_exception_handler(request, exc)


def _rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    now = time.monotonic()
    bucket = creation_times[client]
    while bucket and bucket[0] < now - 60:
        bucket.popleft()
    if len(bucket) >= 10:
        raise HTTPException(429, "Too many project creations. Wait one minute and try again.")
    bucket.append(now)


def resolve_processing_mode(requested: Literal["fast", "smart", "auto"], smart_available: bool) -> ProcessingMode:
    if requested == "auto":
        return "smart"
    return requested


def _not_found(kind: str = "Record") -> HTTPException:
    return HTTPException(404, f"{kind} not found")


async def _delete_asset_and_cleanup(asset_id: str) -> str | None:
    """Delete an asset and clean its durable project relationship, if any.

    A project-source asset is the required input for its project. Removing it
    therefore uses the existing coordinated project deletion path, which
    removes the project, jobs, generated assets, durable references, job
    workspaces, and unreferenced immutable blobs in the same workflow. Ordinary
    Library assets retain their existing reference-counted deletion semantics.
    Returns the deleted source project id when the request cascaded a project.
    """
    asset = db.get_asset(asset_id)
    if asset and asset.origin == "project-source" and asset.source_project_id and db.get_project(asset.source_project_id):
        await manager.delete_project(asset.source_project_id, delete_assets=True)
        return asset.source_project_id

    _, relative, unreferenced = await asyncio.to_thread(db.delete_asset, asset_id)
    if unreferenced and relative:
        target = confined(settings.data_path, *relative.split("/"))
        target.unlink(missing_ok=True)
    return None


# DO-NOT-CHANGE: signs f"jobs/{relative}" or f"exports/{relative}" — only these prefixes
# are allowed in download_file; never expose raw paths
def _download_url(relative: str) -> str:
    expires, signature = signer.sign(relative)
    return f"/api/v1/files/{relative}?expires={expires}&signature={signature}"


def _clip_media(job_id: str, clip: Clip) -> tuple[str, str, str | None] | None:
    """Signed media URLs for a finished clip.

    Prefer the published Library copy: it is content-addressed and immutable,
    so it survives retention pruning the job's working directory, which would
    otherwise turn every finished clip into a dead link. The token is built
    from ids already on the clip, so listing jobs costs no extra database reads
    and no per-clip filesystem stats (bind-mount stats dominate on macOS).
    """
    asset_id, blob_id = clip.library_asset_id, clip.blob_id
    if asset_id and not blob_id:
        asset = db.get_asset(asset_id)
        blob_id = asset.blob_id if asset else None
    if asset_id and blob_id:
        asset = db.get_asset(asset_id)
        if asset and asset.blob_id == blob_id:
            expires, signature = signer.sign(f"library-asset:{asset_id}:{blob_id}")
            url = f"/api/v1/library/assets/{asset_id}/preview?expires={expires}&signature={signature}"
            return url, url, _thumbnail_url(asset)
    # A completed clip keeps its immutable clip-output blob reference even when
    # its Library record is removed. Serve that durable blob so deleting a
    # Library item never turns the project's ready output into a dead link.
    if blob_id:
        relative = db.blob_relative_path(blob_id)
        if relative:
            try:
                blob = confined(settings.data_path, *relative.split("/"))
            except ValueError:
                blob = None
            if blob and blob.is_file():
                expires, signature = signer.sign(f"library-blob:{blob_id}")
                url = f"/api/v1/library/blobs/{blob_id}/preview?expires={expires}&signature={signature}"
                return url, url, None
    # No published Library copy (an unusual, repairable state): fall back to the
    # job output, but only advertise it if the file is really there. This branch
    # is rare, so its filesystem check does not affect normal listings.
    if clip.output_name:
        try:
            output = confined(settings.data_path, "jobs", job_id, "clips", clip.output_name)
        except ValueError:
            return None
        if output.is_file():
            download = _download_url(f"jobs/{job_id}/clips/{clip.output_name}")
            return download, f"{download}&inline=1", None
    return None


# DO-NOT-CHANGE: hides unpublished clips (rendering state), clears download_url for
# incomplete clips, only signs URLs for complete clip outputs
def public_job(job: Job, *, include_caption_downloads: bool = True) -> Job:
    """Public view of a job.

    `include_caption_downloads` is disabled for the job *list*: reading each
    job's private payload opens its own database connection, which dominated
    the cost of listing a long history. Single-job responses keep the sidecars.
    """
    result = job.model_copy(deep=True)
    artifacts_state: list[dict[str, Any]] = []
    clip_dir_state: list[bool] = []

    def caption_artifacts() -> dict[str, Any]:
        """Loaded at most once per job, and only when a sidecar could apply."""
        if not artifacts_state:
            private = db.get_job_private(job.id).get("caption_artifacts", {})
            artifacts_state.append(private if isinstance(private, dict) else {})
        return artifacts_state[0]

    def clip_dir_exists() -> bool:
        """Checked at most once per job."""
        if not clip_dir_state:
            clip_dir_state.append((settings.data_path / "jobs" / job.id / "clips").is_dir())
        return clip_dir_state[0]

    result.queue_position = manager.queue_position(job.id) if job.state == "queued" else None
    result.cancellation_available = job.state in {"queued", "active", "paused", "recovered"}
    if result.queue_position:
        result.blocker_summary = f"Waiting for one of {settings.job_workers} configured worker(s)"
    for clip in result.clips:
        if clip.state == "complete" and not clip.library_asset_id:
            clip.state = "rendering"
            clip.selected = False
            clip.error = "Publication repair required before this output is ready"
        if clip.state == "complete" and clip.output_name:
            media = _clip_media(job.id, clip)
            if media is None:
                # Nothing serveable: advertise no links rather than a dead one.
                clip.download_url = clip.preview_url = clip.thumbnail_url = None
                clip.caption_downloads = []
                continue
            clip.download_url, clip.preview_url, clip.thumbnail_url = media
            sidecars: list[CaptionDownload] = []
            # Caption sidecars live beside the job output, so they disappear when
            # retention prunes the job directory even though the clip plays on.
            manifest = caption_artifacts().get(clip.id) if include_caption_downloads and clip_dir_exists() else None
            if isinstance(manifest, dict) and manifest.get("output_name") == clip.output_name:
                for extension in manifest.get("formats", []):
                    if extension not in {"ass", "srt", "vtt"}:
                        continue
                    filename = Path(clip.output_name).with_suffix(f".{extension}").name
                    relative = f"jobs/{job.id}/clips/{filename}"
                    expires, signature = signer.sign(relative)
                    sidecars.append(CaptionDownload(format=extension, filename=filename, url=f"/api/v1/jobs/{job.id}/clips/{clip.id}/captions/{extension}?expires={expires}&signature={signature}"))
            clip.caption_downloads = sidecars
    # Answered here, from the same predicate control() enforces, so the
    # Workspace never offers a retry the engine would refuse with a 409. Only
    # the single-job view reads the private payload; the list view leaves the
    # default, and the Workspace reads jobs singly.
    if include_caption_downloads:
        result.can_retry_import = can_retry_import(job, db.get_job_private(job.id))
    return result


def reject_retired_script(job: Job) -> None:
    if job.mode == "script":
        raise HTTPException(410, "Legacy jobs are read-only; existing records and outputs remain readable and exportable")


def runtime_health() -> Health:
    ffmpeg = available(settings.ffmpeg)
    ffprobe = available(settings.ffprobe)
    whisper = importlib.util.find_spec("faster_whisper") is not None
    database = settings.data_path.joinpath("s6-cut.sqlite3").exists()
    try:
        free_bytes = shutil.disk_usage(settings.data_path).free
    except OSError:
        # Docker Desktop file sharing can expose a mount without statvfs support.
        free_bytes = 0
    return Health(
        status="ready" if ffmpeg and ffprobe and whisper and database else "degraded",
        version=__version__, database=database, ffmpeg=ffmpeg, ffprobe=ffprobe, whisper=whisper,
        ytdlp=available(settings.ytdlp),
        data_path="Container data directory" if str(settings.data_path).startswith("/app/") else "Local mounted data directory",
        free_bytes=free_bytes, configured_workers=settings.job_workers,
        active_workers=manager.active_workers, queued_jobs=manager.queue.qsize(),
        fallbacks={
            "transcription": "Local Whisper is required for automatic clip timing",
            "planning": "Deterministic sentence-aware selection and beat planning",
            "media": "Personal Library overlays are optional"
        },
    )


@app.get("/api/health", response_model=Health)
@app.get("/api/v1/health", response_model=Health)
async def health() -> Health:
    return runtime_health()


@app.get("/api/v1/projects", response_model=list[Project])
async def list_projects() -> list[Project]:
    return db.list_projects()


@app.put("/api/v1/projects/{project_id}/folder", response_model=Project)
async def change_project_folder(project_id: str, value: ProjectFolderUpdate) -> Project:
    try:
        return db.update_project_folder(project_id, value.folder_id, value.move_existing_assets)
    except KeyError as exc:
        raise _not_found("Project") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.delete("/api/v1/projects/{project_id}", status_code=204)
async def delete_project(project_id: str, delete_assets: bool = False) -> None:
    try:
        await manager.delete_project(project_id, delete_assets=delete_assets)
        if delete_assets:
            _prune_orphaned_thumbnails()
    except KeyError as exc:
        raise _not_found("Project") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/v1/projects/{project_id}", response_model=Project)
async def get_project(project_id: str) -> Project:
    try:
        uuid.UUID(project_id)
    except ValueError as exc:
        raise _not_found("Project") from exc
    project = db.get_project(project_id)
    if not project:
        raise _not_found("Project")
    return project


async def _stream_upload(upload: UploadFile, target: Path, max_bytes: int) -> tuple[int, str]:
    temp = target.with_suffix(target.suffix + ".uploading")
    total = 0
    digest = hashlib.sha256()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with temp.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(413, "Upload exceeds the configured source-size limit")
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if not total:
            raise HTTPException(422, "Uploaded file is empty")
        os.replace(temp, target)
        return total, digest.hexdigest()
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise HTTPException(
                status.HTTP_507_INSUFFICIENT_STORAGE,
                "Not enough free storage to upload this video. Free space and try again.",
            ) from exc
        raise
    finally:
        await upload.close()
        if temp.exists():
            temp.unlink(missing_ok=True)


@app.post("/api/v1/jobs/clip", status_code=status.HTTP_202_ACCEPTED)
async def create_clip_job(
    request: Request,
    file: Annotated[UploadFile | None, File()] = None,
    music_track_file: Annotated[UploadFile | None, File()] = None,
    url: Annotated[str | None, Form()] = None,
    music_track_url: Annotated[str | None, Form()] = None,
    music_track_speed: Annotated[float, Form()] = 1.0,
    music_audio_mode: Annotated[Literal["song_only", "mix_original"], Form()] = "song_only",
    name: Annotated[str | None, Form()] = None,
    style: Annotated[Literal["funny", "serious", "educational", "hype"], Form()] = "educational",
    processing_mode: Annotated[Literal["fast", "smart", "auto"], Form()] = "auto",
    execution_policy: Annotated[Literal["auto", "engine_only"], Form()] = "auto",
    source_profile: Annotated[Literal["speech", "music"], Form()] = "speech",
    count: Annotated[int, Form(ge=1, le=500)] = 5,
    batch_mode: Annotated[Literal["standard", "high_volume"], Form()] = "standard",
    min_duration: Annotated[float, Form(ge=8, le=120)] = 20,
    max_duration: Annotated[float, Form(ge=10, le=1800)] = 60,
    content_format: Annotated[ContentFormat, Form()] = "short",
    aspect_ratio: Annotated[Literal["9:16", "1:1", "16:9", "4:5"], Form()] = "9:16",
    burn_subtitles: Annotated[bool, Form()] = True,
    embed_subtitles: Annotated[bool, Form()] = False,
    library_folder_id: Annotated[str, Form()] = UNSORTED_FOLDER_ID,
    subscribe_animation: Annotated[str, Form()] = "{}",
    music_presentation: Annotated[str, Form()] = "{}",
    music_top_text: Annotated[str, Form()] = "",
    hook_text: Annotated[bool, Form()] = False,
    manual_hook_text: Annotated[str, Form(max_length=150)] = "",
    youtube_metadata: Annotated[bool | None, Form()] = None,
    youtube_metadata_model_id: Annotated[str | None, Form(max_length=200)] = None,
) -> dict[str, object]:
    _rate_limit(request)
    selected_folder = db.get_folder(library_folder_id)
    if not selected_folder:
        raise _not_found("Library folder")
    if selected_folder.archived:
        raise HTTPException(409, "Archived folders cannot receive new projects")
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    if bool(file) == bool(url and url.strip()):
        raise HTTPException(422, "Provide exactly one local video or supported YouTube URL")
    if batch_mode == "standard" and count > 30:
        raise HTTPException(422, "Standard batches support at most 30 outputs. Choose High-volume mode for up to 500.")
    if min_duration >= max_duration:
        raise HTTPException(422, "Minimum duration must be shorter than maximum duration")
    if len(music_top_text) > 100:
        raise HTTPException(422, "Music top text must be 100 characters or fewer")
    music_config = _music_presentation_request(music_presentation)
    if source_profile != "music" and (music_top_text or music_presentation != "{}" or music_config.subtitle_theme != "clean"):
        raise HTTPException(422, "Music presentation options are only available for Music / sung vocals")
    if source_profile == "music" and batch_mode == "high_volume":
        raise HTTPException(422, "High-volume batches are available for Speech sources; Music keeps its existing non-overlapping planner.")
    if source_profile == "music" and content_format != "short":
        raise HTTPException(422, "Music / sung vocals is currently available for short clips only")
    if source_profile != "music" and (music_track_file or music_track_url):
        raise HTTPException(422, "Background songs are only available in Music mode")
    if music_track_file and music_track_url and music_track_url.strip():
        raise HTTPException(422, "Choose an MP3 upload or a YouTube song link, not both")
    if source_profile != "music" and music_audio_mode != "song_only":
        raise HTTPException(422, "Background song audio options are only available in Music mode")
    if music_track_speed not in {0.75, 0.85, 1.0, 1.25, 1.5}:
        raise HTTPException(422, "Song speed must be one of the available speed options")
    if content_format == "short" and max_duration > 180:
        raise HTTPException(422, "Short form clips support a maximum duration of 180 seconds")
    if content_format == "long":
        aspect_ratio = "16:9"
    source_limit = settings.max_long_source_seconds if content_format == "long" else settings.max_source_seconds
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    effective_target: int | None = None
    cap_explanation: str | None = None
    smart_available = profiles.smart_available()
    # Auto keeps local transcription available when the optional provider is absent.
    mode = "smart" if source_profile == "music" else resolve_processing_mode(processing_mode, smart_available)
    selected_profile = next((profile for profile in profiles.db.list_profiles() if profile.selected), None)
    if youtube_metadata is None:
        # Not specified by the client: SEO titles follow the profile's
        # "Auto-write SEO titles" setting for eligible Smart short jobs.
        youtube_metadata = bool(
            selected_profile and selected_profile.auto_seo_titles and smart_available
            and content_format == "short" and mode == "smart" and processing_mode != "fast" and batch_mode != "high_volume"
        )
    if youtube_metadata:
        if content_format != "short" or processing_mode == "fast" or mode != "smart":
            raise HTTPException(422, "YouTube metadata is unavailable in Fast or Long form jobs.")
        # The metadata model is an independent Settings profile preference. A
        # job snapshots it so a later profile edit cannot rewrite queued work.
        youtube_metadata_model_id = selected_profile.youtube_metadata_model_id if selected_profile else None
    manual_hook_text = manual_hook_text.strip()
    if manual_hook_text and not hook_text:
        raise HTTPException(422, "Enable Hook text before entering custom hook text.")
    if hook_text:
        if content_format != "short":
            raise HTTPException(422, "AI hook text is unavailable for Long form.")
        if source_profile == "music":
            raise HTTPException(422, "AI hook text is unavailable for Music; Music keeps its manual Top text.")
        if batch_mode == "high_volume":
            raise HTTPException(422, "AI hook text is unavailable for High-volume jobs.")
        if processing_mode == "fast":
            raise HTTPException(422, "AI hook text is unavailable in Fast mode.")
        if mode != "smart":
            raise HTTPException(422, "AI hook text is unavailable in Fast mode.")
    presentation = {
        "version": 2 if source_profile == "speech" and content_format == "short" and mode == "smart" else 1,
        "caption": "smart_speech_v2"
        if source_profile == "speech" and content_format == "short" and mode == "smart"
        else "legacy",
    }
    private: dict[str, object] = {
        "count": count, "batch_mode": batch_mode, "min_duration": min_duration, "max_duration": max_duration,
        "aspect_ratio": aspect_ratio, "content_format": content_format, "processing_mode": mode,
        "execution_policy": execution_policy,
        "provider_available": execution_policy == "auto" and smart_available,
        "presentation": presentation,
        "reaction_policy": {"version": 1, "name": "ironic_v1"} if source_profile == "speech" and burn_subtitles else None,
        "burn_subtitles": True if source_profile == "music" else burn_subtitles, "embed_subtitles": embed_subtitles,
        "hook_text": {"enabled": hook_text, "status": "pending" if hook_text else "disabled", **({"manual_text": manual_hook_text} if manual_hook_text else {})},
        "youtube_metadata": {"enabled": youtube_metadata, "model_id": youtube_metadata_model_id, "status": "pending" if youtube_metadata else "disabled"},
        "use_openrouter": execution_policy == "auto" and mode == "smart" and smart_available and source_profile == "speech" and batch_mode == "standard",
        "library_folder_id": library_folder_id,
        "subscribe_animation": _subscribe_animation_request(subscribe_animation).model_dump(),
    }
    if source_profile == "music":
        private["music_presentation"] = music_config.model_dump()
        private["music_top_text"] = music_top_text if music_top_text.strip() else None
        private["music_track_speed"] = music_track_speed
        private["music_audio_mode"] = music_audio_mode
        private["music_song_gain"] = 0.25 if music_audio_mode == "mix_original" else 1.0
        private["music_original_audio_gain"] = 1.0
        if music_track_url and music_track_url.strip():
            try:
                private["music_track_url"] = validate_youtube_url(music_track_url.strip())
            except ValueError as exc:
                raise HTTPException(422, "Only public HTTPS YouTube URLs are supported for the background song") from exc
    if file:
        original = safe_filename(file.filename or "source.mp4", "source.mp4")
        suffix = Path(original).suffix.casefold()
        if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
            raise HTTPException(415, "Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
        source = settings.data_path / "jobs" / job_id / "source" / f"source{suffix}"
        _, source_hash = await _stream_upload(file, source, settings.max_upload_bytes)
        try:
            source_metadata = await asyncio.to_thread(validate_video_upload, source, original, settings, max_seconds=source_limit)
        except MediaError as exc:
            source.unlink(missing_ok=True)
            raise HTTPException(422, str(exc)) from exc
        if source_profile == "music" and isinstance(source_metadata, dict):
            source_duration = float(source_metadata["duration"])
            feasible_count = math.floor((source_duration + 1e-9) / min_duration)
            if feasible_count < count:
                source.unlink(missing_ok=True)
                raise HTTPException(422, f"Cannot create {count} non-overlapping music clips of at least {min_duration:g}s from a {source_duration:.1f}s source; at most {feasible_count} can fit without padding or duplication.")
        private["source_path"] = str(source)
        private["source_hash"] = source_hash
        if isinstance(source_metadata, dict):
            private["source_metadata"] = source_metadata
        source_name, source_kind = original, "upload"
    else:
        try:
            private["url"] = validate_youtube_url(str(url))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        source_name, source_kind = "YouTube import", "youtube"
    music_track_snapshot = None
    if source_profile == "music" and music_track_file:
        original_track = safe_filename(music_track_file.filename or "background.mp3", "background.mp3")
        if Path(original_track).suffix.casefold() != ".mp3":
            if file:
                source.unlink(missing_ok=True)
            raise HTTPException(415, "Background song upload must be an MP3 file")
        track_path = settings.data_path / "jobs" / job_id / "source" / "background.mp3"
        try:
            _, track_hash = await _stream_upload(music_track_file, track_path, settings.max_upload_bytes)
            track_metadata = await asyncio.to_thread(validate_audio_track, track_path, settings, max_seconds=settings.max_source_seconds)
            asset = rules.register_file(track_path, title=Path(original_track).stem[:200] or "Background song", media_type="audio/mpeg", origin="manual-import", folder_id=library_folder_id, content_hash=track_hash, filename=original_track, metadata={"duration": track_metadata["duration"]})
        except HTTPException:
            track_path.unlink(missing_ok=True)
            if file:
                source.unlink(missing_ok=True)
            raise
        except (MediaError, ValueError) as exc:
            track_path.unlink(missing_ok=True)
            if file:
                source.unlink(missing_ok=True)
            raise HTTPException(422, "The uploaded MP3 could not be read") from exc
        private["music_track_path"] = str(track_path)
        private["music_track_hash"] = track_hash
        private["music_track_asset_id"] = asset.id
        private["music_track_title"] = asset.title
        private["music_track_source"] = "upload"
        music_track_snapshot = {"asset_id": asset.id, "title": asset.title, "source": "upload", "speed": music_track_speed}
    elif source_profile == "music" and private.get("music_track_url"):
        music_track_snapshot = {"title": "YouTube soundtrack", "source": "youtube", "speed": music_track_speed}
    private["source_kind"] = source_kind
    if isinstance(private.get("source_metadata"), dict):
        effective_target, cap_explanation = resolve_batch_target(count, batch_mode, float(private["source_metadata"]["duration"]))
        private["effective_target"] = effective_target
        private["cap_explanation"] = cap_explanation
    elif batch_mode == "high_volume":
        cap_explanation = "Effective target will be confirmed after YouTube download and FFprobe validation."
    project = Project(id=project_id, name=_project_name(name, Path(source_name).stem), name_is_auto=not _project_name(name, ""), mode="clip", style=style, state="queued", source_name=source_name, source_kind=source_kind, requested_count=count, batch_mode=batch_mode, effective_target=effective_target, cap_explanation=cap_explanation, content_format=content_format, source_profile=source_profile, music_track=music_track_snapshot, music_audio_mode=music_audio_mode if source_profile == "music" else "song_only", music_song_gain=float(private.get("music_song_gain", 1.0)), music_original_audio_gain=float(private.get("music_original_audio_gain", 1.0)), latest_job_id=job_id, library_folder_id=library_folder_id)
    high_volume_smart_landscape = batch_mode == "high_volume" and content_format == "long" and mode == "smart"
    steps = manager._fast_steps() if uses_fast_pipeline(mode, content_format) and not high_volume_smart_landscape else manager._smart_steps(bool(private["use_openrouter"]), source_profile, include_hook_text=hook_text)
    music_step = next((step for step in steps if step.id == "music_track"), None)
    if music_step:
        if music_track_snapshot is None:
            music_step.status, music_step.detail = "skipped", "No optional background song selected"
            music_step.started_at = music_step.completed_at = now_iso()
        elif music_track_snapshot.get("source") == "upload":
            music_step.status, music_step.detail = "complete", "Uploaded song decoded and saved to the Media Library"
            music_step.started_at = music_step.completed_at = now_iso()
    if batch_mode == "high_volume" and mode == "smart":
        provider_step = next((step for step in steps if step.id == "openrouter"), None)
        if provider_step:
            provider_step.label = "Provider bypassed for high-volume planning"
            provider_step.detail = "Large candidate searches are resolved locally from timed transcript windows"
    if source_kind == "upload":
        checkpoint_time = now_iso()
        steps[0].status, steps[0].detail = "complete", "Upload atomically stored"
        steps[0].started_at = steps[0].completed_at = checkpoint_time
        if isinstance(source_metadata, dict):
            steps[1].status = "complete"
            steps[1].detail = f"Source validated - {float(source_metadata['duration']):.1f}s"
            steps[1].started_at = steps[1].completed_at = checkpoint_time
    job = Job(id=job_id, project_id=project_id, library_folder_id=library_folder_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=style, processing_mode=mode, execution_policy=execution_policy, content_format=content_format, source_profile=source_profile, music_presentation=music_config if source_profile == "music" else None, music_top_text=(music_top_text if music_top_text.strip() else None) if source_profile == "music" else None, music_track=music_track_snapshot, music_audio_mode=music_audio_mode if source_profile == "music" else "song_only", music_song_gain=float(private.get("music_song_gain", 1.0)), music_original_audio_gain=float(private.get("music_original_audio_gain", 1.0)), requested_count=count, batch_mode=batch_mode, effective_target=effective_target, cap_explanation=cap_explanation, burn_subtitles=True if source_profile == "music" else burn_subtitles, embed_subtitles=embed_subtitles, hook_text_enabled=hook_text, youtube_metadata_enabled=youtube_metadata, youtube_metadata_model_id=youtube_metadata_model_id, steps=steps)
    db.save_project(project)
    db.save_job(job, private)
    try:
        await manager.enqueue(job_id)
    except QueueFullError as exc:
        job.state, job.stage, job.stage_label, job.error = "failed", "queue", "Queue full", str(exc)
        manager._save(job)
        raise HTTPException(429, str(exc)) from exc
    return {"project": project, "job": public_job(job)}


def _parse_shorts_form_float(raw: str | None, label: str, *, blank_is_none: bool = False) -> float | None:
    if raw is None or (blank_is_none and not raw.strip()):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, f"{label} must be a finite number") from exc
    if not math.isfinite(value):
        raise HTTPException(422, f"{label} must be a finite number")
    return value


def _validate_shorts_trim(start: float, end: float | None, duration: float | None = None) -> tuple[float, float | None]:
    if not math.isfinite(start) or start < 0:
        raise HTTPException(422, "Start seconds must be a finite number at least 0")
    if end is not None and (not math.isfinite(end) or end <= start):
        raise HTTPException(422, "End seconds must be blank or a finite number greater than start")
    if duration is not None and (start >= duration or (end is not None and end > duration)):
        raise HTTPException(422, f"Trim bounds must fall within the {duration:.2f}-second source")
    return start, end


async def _queue_shorts_job(
    *, request: Request, source_name: str, source_kind: Literal["upload", "youtube"], source_path: Path | None,
    source_hash: str | None, source_metadata: dict[str, object] | None, url: str | None,
    start: float, end: float | None, aspect_ratio: str, library_folder_id: str,
    name: str | None = None, burn_subtitles: bool = True, embed_subtitles: bool = False, job_id: str | None = None,
    subscribe_animation: SubscribeAnimationConfig | None = None, muted: bool = False,
    volume: float = 1.0, filter_preset: Literal["none", "warm", "cool", "black_white", "tint", "monochrome"] = "none",
    filter_intensity: float = 1.0, tint_color: str = "#d58a55", tint_opacity: int = 0, text_overlays: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    selected_folder = db.get_folder(library_folder_id)
    if not selected_folder:
        raise _not_found("Library folder")
    if selected_folder.archived:
        raise HTTPException(409, "Archived folders cannot receive new projects")
    source_duration = float(source_metadata["duration"]) if source_metadata else None
    _validate_shorts_trim(start, end, source_duration)
    output_duration = (end if end is not None else source_duration) - start if (end is not None or source_duration is not None) else None
    for overlay in text_overlays or []:
        try:
            overlay_start = float(overlay["start"])
            overlay_duration = float(overlay["duration"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(422, "Text overlay timing must be finite and positive") from exc
        if not math.isfinite(overlay_start) or not math.isfinite(overlay_duration) or overlay_start < 0 or overlay_duration <= 0:
            raise HTTPException(422, "Text overlay timing must be finite and positive")
        if output_duration is not None and overlay_start + overlay_duration > output_duration + 1e-6:
            raise HTTPException(422, "Text overlay timing must fit inside the trimmed output")
    project_id = str(uuid.uuid4())
    job_id = job_id or str(uuid.uuid4())
    project = Project(id=project_id, name=_project_name(name, f"Short — {Path(source_name).stem}"), mode="clip", style="educational", state="queued", source_name=source_name, source_kind=source_kind, requested_count=1, latest_job_id=job_id, library_folder_id=library_folder_id)
    clip_end = end if end is not None else max(start + 0.1, 0.1)
    clip = Clip(id=str(uuid.uuid4()), index=1, state="queued", start=start, end=clip_end, duration=clip_end-start, opening_line="Shorts Editor cut")
    processing_mode = "smart" if burn_subtitles or embed_subtitles else "fast"
    steps = manager._smart_steps() if processing_mode == "smart" else manager._fast_steps()
    job = Job(id=job_id, project_id=project_id, library_folder_id=library_folder_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style="educational", processing_mode=processing_mode, burn_subtitles=burn_subtitles, embed_subtitles=embed_subtitles, clips=[clip], total_items=1, steps=steps)
    timestamp = now_iso()
    if source_kind == "upload":
        manager._apply_step(job, job.steps[0], status="complete", detail="Source received and validated", completed_at=timestamp)
    if source_metadata is not None:
        manager._apply_step(job, job.steps[1], status="complete", detail="Source duration validated", completed_at=timestamp)
    if processing_mode == "fast":
        manager._apply_step(job, job.steps[2], status="skipped", detail="Trim supplied by Shorts Editor", completed_at=timestamp)
    private = {"source_path": str(source_path) if source_path else None, "source_kind": source_kind, "source_hash": source_hash, "source_metadata": source_metadata, "url": url, "trim_start": start, "trim_end": end, "aspect_ratio": aspect_ratio, "count": 1, "min_duration": max(0.1, clip.duration), "max_duration": max(0.1, clip.duration), "processing_mode": processing_mode, "burn_subtitles": burn_subtitles, "embed_subtitles": embed_subtitles, "library_folder_id": library_folder_id, "subscribe_animation": (subscribe_animation or SubscribeAnimationConfig()).model_dump(), "muted": muted, "volume": volume, "filter_preset": filter_preset, "filter_intensity": filter_intensity, "tint_color": tint_color, "tint_opacity": tint_opacity, "text_overlays": text_overlays or [], "reaction_policy": {"version": 1, "name": "ironic_v1"} if burn_subtitles else None}
    db.save_project(project)
    db.save_job(job, private)
    try:
        await manager.enqueue(job_id)
    except QueueFullError as exc:
        job.state, job.stage, job.stage_label, job.error = "failed", "queue", "Queue full", str(exc)
        manager._save(job)
        raise HTTPException(429, str(exc)) from exc
    return {"project": project, "job": public_job(job)}


@app.post("/api/v1/jobs/shorts", status_code=status.HTTP_202_ACCEPTED)
async def create_shorts_job(request: Request, value: ShortsJobInput) -> dict[str, object]:
    _rate_limit(request)
    asset = db.get_asset(value.asset_id)
    if not asset or not asset.media_type.casefold().startswith("video/"):
        raise HTTPException(422, "Select an authorised Library video")
    relative = db.blob_relative_path(asset.blob_id)
    if not relative:
        raise _not_found("Media blob")
    source = confined(settings.data_path, *relative.split("/"))
    try:
        metadata = await asyncio.to_thread(probe, source, settings)
    except MediaError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await _queue_shorts_job(request=request, source_name=asset.filename, source_kind="upload", source_path=source, source_hash=asset.content_hash, source_metadata=metadata, url=None, start=value.start, end=value.end, aspect_ratio=value.aspect_ratio, library_folder_id=value.library_folder_id, name=value.name, burn_subtitles=value.burn_subtitles, embed_subtitles=value.embed_subtitles, subscribe_animation=value.subscribe_animation, muted=value.muted, volume=value.volume, filter_preset=value.filter_preset, filter_intensity=value.filter_intensity, tint_color=value.tint_color, tint_opacity=value.tint_opacity, text_overlays=[item.model_dump() for item in value.text_overlays])


@app.post("/api/v1/jobs/shorts/source", status_code=status.HTTP_202_ACCEPTED)
async def create_shorts_source_job(
    request: Request,
    file: Annotated[UploadFile | None, File()] = None,
    url: Annotated[str | None, Form()] = None,
    start: Annotated[str, Form()] = "0",
    end: Annotated[str | None, Form()] = None,
    aspect_ratio: Annotated[Literal["9:16", "16:9", "1:1", "4:5"], Form()] = "9:16",
    library_folder_id: Annotated[str, Form()] = UNSORTED_FOLDER_ID,
    name: Annotated[str | None, Form()] = None,
    burn_subtitles: Annotated[bool, Form()] = True,
    subscribe_animation: Annotated[str, Form()] = "{}",
    muted: Annotated[bool, Form()] = False,
    volume: Annotated[float, Form(ge=0, le=2)] = 1.0,
    filter_preset: Annotated[Literal["none", "warm", "cool", "black_white", "tint", "monochrome"], Form()] = "none",
    filter_intensity: Annotated[float, Form(ge=0, le=1)] = 1,
    tint_color: Annotated[str, Form()] = "#d58a55",
    tint_opacity: Annotated[int, Form(ge=0, le=100)] = 0,
    text_overlays: Annotated[str, Form()] = "[]",
) -> dict[str, object]:
    _rate_limit(request)
    subscribe_animation = _subscribe_animation_request(subscribe_animation)
    if bool(file) == bool(url and url.strip()):
        raise HTTPException(422, "Provide exactly one local video or supported YouTube URL")
    parsed_start = _parse_shorts_form_float(start, "Start seconds")
    parsed_end = _parse_shorts_form_float(end, "End seconds", blank_is_none=True)
    if parsed_start is None:
        raise HTTPException(422, "Start seconds must be a finite number at least 0")
    _validate_shorts_trim(parsed_start, parsed_end)
    try:
        overlay_values = [item.model_dump() for item in ShortsJobInput.model_validate({
            "asset_id": "multipart-validation", "start": parsed_start, "end": parsed_end,
            "text_overlays": json.loads(text_overlays), "muted": muted, "volume": volume,
            "filter_preset": filter_preset, "filter_intensity": filter_intensity,
            "tint_color": tint_color, "tint_opacity": tint_opacity,
        }).text_overlays]
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "Invalid Shorts output or text-overlay settings") from exc
    if file:
        original = safe_filename(file.filename or "source.mp4", "source.mp4")
        suffix = Path(original).suffix.casefold()
        if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
            raise HTTPException(415, "Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
        job_id = str(uuid.uuid4())
        source = confined(settings.data_path, "jobs", job_id, "source", f"source{suffix}")
        try:
            _, source_hash = await _stream_upload(file, source, settings.max_upload_bytes)
            metadata = await asyncio.to_thread(validate_video_upload, source, original, settings)
            result = await _queue_shorts_job(request=request, source_name=original, source_kind="upload", source_path=source, source_hash=source_hash, source_metadata=metadata, url=None, start=parsed_start, end=parsed_end, aspect_ratio=aspect_ratio, library_folder_id=library_folder_id, name=name, burn_subtitles=burn_subtitles, job_id=job_id, subscribe_animation=subscribe_animation, muted=muted, volume=volume, filter_preset=filter_preset, filter_intensity=filter_intensity, tint_color=tint_color, tint_opacity=tint_opacity, text_overlays=overlay_values)
            return result
        except MediaError as exc:
            source.unlink(missing_ok=True)
            raise HTTPException(422, str(exc)) from exc
        except HTTPException:
            if source.exists() and not db.get_job_private(job_id):
                source.unlink(missing_ok=True)
            raise
    try:
        validated_url = validate_youtube_url(url or "")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await _queue_shorts_job(request=request, source_name="YouTube import", source_kind="youtube", source_path=None, source_hash=None, source_metadata=None, url=validated_url, start=parsed_start, end=parsed_end, aspect_ratio=aspect_ratio, library_folder_id=library_folder_id, name=name, burn_subtitles=burn_subtitles, subscribe_animation=subscribe_animation, muted=muted, volume=volume, filter_preset=filter_preset, filter_intensity=filter_intensity, tint_color=tint_color, tint_opacity=tint_opacity, text_overlays=overlay_values)


@app.post("/api/v1/jobs/{job_id}/repair-publication", response_model=Job)
async def repair_job_publication(job_id: str) -> Job:
    """Backfill missing Library assets for completed clips in a job.

    Idempotent repair operation: scans the job's completed clips, creates
    a Media Library asset for any clip that lacks ``library_asset_id``,
    and persists the updated job record.  Uses stable (origin, project,
    job, clip) identity so repeated calls never duplicate assets.
    """
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    reject_retired_script(job)
    job, backfilled, _ = db.backfill_missing_assets(job)
    if backfilled:
        manager._save(job)
    return public_job(job)


@app.get("/api/v1/jobs", response_model=list[Job])
async def list_jobs() -> list[Job]:
    return [public_job(job, include_caption_downloads=False) for job in db.list_jobs()]


@app.get("/api/v1/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    return public_job(job)


_LIVE_JOB_STATES = ("queued", "active", "paused", "stalled", "recovered")
_MOBILE_CLIPS_PER_JOB = 8
_MOBILE_DOWNLOADS = 30


def _job_source_paths(job_id: str) -> tuple[Path, Path]:
    source_dir = confined(settings.data_path, "jobs", job_id, "source")
    return source_dir, confined(source_dir, PREVIEW_NAME)


@app.get("/api/v1/jobs/{job_id}/source-thumbnail")
# Poster for a source that is still downloading; once the source is registered
# the Library thumbnail (from its immutable blob) is used instead.
async def job_source_thumbnail(job_id: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    if db.get_job(job_id) is None:
        raise _not_found("Job")
    if not signer.verify(f"job-source-thumbnail:{job_id}:v1", expires, signature):
        raise HTTPException(403, "Thumbnail link is invalid or expired")
    try:
        _, preview = _job_source_paths(job_id)
    except ValueError as exc:
        raise HTTPException(400, "Invalid job reference") from exc
    if not has_preview(preview):
        raise _not_found("Thumbnail")
    return FileResponse(preview, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


async def _early_job_poster(job: Job) -> tuple[str | None, str | None]:
    """Title and poster URL for a job whose source has not been registered yet."""
    try:
        source_dir, preview = _job_source_paths(job.id)
    except ValueError:
        return None, None
    title = await asyncio.to_thread(read_info_title, source_dir) if source_dir.is_dir() else None
    if not has_preview(preview) and not await asyncio.to_thread(ensure_preview, source_dir, preview, settings.ffmpeg):
        return title, None
    expires, signature = signer.sign(f"job-source-thumbnail:{job.id}:v1")
    return title, f"/api/v1/jobs/{job.id}/source-thumbnail?expires={expires}&signature={signature}"


def _mobile_job(job: Job, project: Project | None, source: Asset | None, early_title: str | None, early_poster: str | None, *, live: bool) -> MobileJob:
    public = public_job(job, include_caption_downloads=False)
    complete = [clip for clip in public.clips if clip.state == "complete"]
    shown = [clip for clip in complete if clip.preview_url or clip.thumbnail_url][:_MOBILE_CLIPS_PER_JOB]
    clips = [
        MobileClip(
            id=clip.id, index=clip.index, duration=clip.duration, thumbnail_url=clip.thumbnail_url, preview_url=clip.preview_url,
            title=" ".join((clip.title or clip.opening_line or "").split())[:120] or f"Clip {clip.index:02d}",
        )
        for clip in shown
    ]
    return MobileJob(
        id=job.id, project_id=job.project_id, project_name=project.name if project else f"Project {job.project_id[:8]}",
        mode=job.mode, state=job.state, stage=job.stage, stage_label=job.stage_label, progress=job.progress,
        current_item=job.current_item, total_items=job.total_items, style=job.style, content_format=job.content_format,
        download_progress=job.download_progress, steps=public.steps if live else [], queue_position=public.queue_position,
        active_elapsed_seconds=job.active_elapsed_seconds, error=job.error, warnings=job.warnings[:3],
        source_title=(project.source_title if project and project.source_title else None) or early_title,
        source_thumbnail_url=(_thumbnail_url(source) if source else None) or early_poster,
        clips_ready=len(complete), clips=clips, created_at=job.created_at, updated_at=job.updated_at,
    )


@app.get("/api/v1/mobile/overview", response_model=MobileOverview)
async def mobile_overview(history: Annotated[int, Query(ge=0, le=100)] = 20) -> MobileOverview:
    """Everything the iPhone/iPad status view shows, in one small read-only response.

    `/jobs` carries every clip of every job (hundreds of KB), which is too much to
    poll from a phone; this returns live jobs in full, a bounded page of finished
    jobs, and only the clip thumbnails a card can actually show.
    """
    live_jobs = sorted(db.list_jobs(states=_LIVE_JOB_STATES), key=lambda job: (job.state != "active", job.created_at))
    recent_jobs, recent_total = db.list_jobs_page(limit=history, exclude_states=_LIVE_JOB_STATES)
    project_ids = [job.project_id for job in (*live_jobs, *recent_jobs)]
    projects = {project_id: db.get_project(project_id) for project_id in set(project_ids)}
    sources = db.project_source_assets(project_ids)
    running: list[MobileJob] = []
    for job in live_jobs:
        early_title, early_poster = (None, None) if job.project_id in sources else await _early_job_poster(job)
        running.append(_mobile_job(job, projects.get(job.project_id), sources.get(job.project_id), early_title, early_poster, live=True))
    recent = [_mobile_job(job, projects.get(job.project_id), sources.get(job.project_id), None, None, live=False) for job in recent_jobs]
    downloads: list[MobileDownload] = []
    for task in video_downloads.list()[:_MOBILE_DOWNLOADS]:
        task = _public_download(task)
        downloads.append(MobileDownload(
            id=task.id, state=task.state, phase=task.phase, downloaded_bytes=task.downloaded_bytes, total_bytes=task.total_bytes,
            percent=None if task.percent is None else max(0.0, min(100.0, task.percent)), message=task.message, title=task.title,
            thumbnail_url=task.thumbnail_url, error=task.error, created_at=task.created_at, updated_at=task.updated_at,
        ))
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    return MobileOverview(
        running=running, recent=recent, recent_total=recent_total, downloads=downloads,
        clips_last_day=db.count_generated_clips_since(since), failed_last_day=db.count_jobs_since("failed", since),
    )


@app.put("/api/v1/jobs/{job_id}/clips/{clip_id}/captions", response_model=Job)
async def update_captions(job_id: str, clip_id: str, value: CaptionReviewInput) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    reject_retired_script(job)
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip:
        raise _not_found("Clip")
    if value.revision != clip.caption_revision:
        raise HTTPException(409, "Caption revision is stale")
    duration = clip.duration
    private = db.get_job_private(job_id)
    if (private.get("caption_rerender") or {}).get("clip_id") == clip_id:
        raise HTTPException(409, "Wait for the current caption rerender before editing this clip again")
    presentation_snapshot = private.get("presentation")
    presentation = presentation_snapshot.get("caption") if isinstance(presentation_snapshot, dict) and presentation_snapshot.get("version") in {1, 2} else None
    from .captions import normalize_and_validate
    cues, findings = normalize_and_validate(
        [cue.model_dump() for cue in value.cues], duration,
        aspect=str(private.get("aspect_ratio") or "9:16"),
        presentation=presentation if presentation in {"smart_speech_v1", "smart_speech_v2"} else None,
        style=job.style,
    )
    fatal = [item for item in findings if item["severity"] == "error"]
    if fatal:
        raise HTTPException(422, {"message": "Caption cues are invalid", "issues": fatal})
    clip.caption_cues = [CaptionCue.model_validate(item) for item in cues]
    clip.caption_revision += 1
    clip.caption_qa_warnings = [item["message"] for item in findings if item["severity"] == "warning"]
    clip.review_required = bool(clip.caption_qa_warnings)
    private.setdefault("caption_overrides", {})[clip_id] = {"revision": clip.caption_revision, "cues": cues}
    db.save_job(job, private)
    return public_job(job)


@app.put("/api/v1/jobs/{job_id}/clips/{clip_id}/youtube-metadata", response_model=Job)
async def update_youtube_metadata(job_id: str, clip_id: str, value: YouTubeMetadataUpdate) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip:
        raise _not_found("Clip")
    if clip.library_asset_id is None:
        raise HTTPException(409, "This completed clip has no linked Library asset")
    linked = db.get_asset(clip.library_asset_id)
    title, description = value.title, value.description
    if linked and title == (clip.title or "") and linked.title != title:
        # The Workspace draft was seeded from an older clip title (legacy data
        # where only the Library copy was edited); an unchanged field must not
        # revert the Library title.
        title = linked.title
    if linked and description == (clip.youtube_description or "") and linked.description and linked.description[:500] != description:
        description = linked.description[:500]
    try:
        asset, saved_job, _ = db.update_generated_clip_metadata(
            clip.library_asset_id, title, description, value.revision,
            title_source="user" if linked is None or title != linked.title else None,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    private = db.get_job_private(job_id)
    private.setdefault("youtube_metadata_generation", {})[clip_id] = {
        "status": "generated", "manual_edit": True, "updated_at": time.time(),
    }
    manager._save(saved_job, private)
    return public_job(saved_job)


def _record_youtube_metadata_failure(job_id: str, clip_id: str, revision: int, reason: str, excerpt: str = "") -> None:
    latest = db.get_job(job_id)
    clip = next((item for item in latest.clips if item.id == clip_id), None) if latest else None
    if not latest or not clip or clip.youtube_metadata_revision != revision:
        return
    private = db.get_job_private(job_id)
    state = private.setdefault("youtube_metadata_generation", {})
    if not isinstance(state, dict):
        state = private["youtube_metadata_generation"] = {}
    state[clip_id] = {"status": "unavailable", "reason": reason[:300], "updated_at": time.time()}
    fallback_description = clip.youtube_description or (excerpt[:500] if len(excerpt) >= 40 else "")
    if clip.library_asset_id:
        try:
            linked_asset = db.get_asset(clip.library_asset_id)
            # A failed generation records status only: the Library title and any
            # description already there (possibly hand-written) stay as they are.
            if linked_asset and linked_asset.description:
                fallback_description = linked_asset.description[:500]
            _, latest, clip = db.update_generated_clip_metadata(
                clip.library_asset_id, (linked_asset.title if linked_asset else None) or clip.title or "Suggested title", fallback_description,
                clip.youtube_metadata_revision, metadata_status="fallback" if fallback_description else "unavailable",
                metadata_reason=reason[:300],
            )
        except (ValueError, KeyError):
            clip.youtube_metadata_status = "unavailable"
            clip.youtube_metadata_reason = reason[:300]
    else:
        clip.youtube_metadata_status = "fallback" if fallback_description else "unavailable"
        clip.youtube_metadata_reason = reason[:300]
        clip.youtube_description = fallback_description
    manager._save(latest, private)


@app.post("/api/v1/jobs/{job_id}/clips/{clip_id}/youtube-metadata", response_model=Job)
async def generate_youtube_metadata(job_id: str, clip_id: str, regenerate: bool = Body(default=False, embed=True)) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip or clip.state != "complete":
        raise _not_found("Completed clip")
    if job.mode != "clip":
        raise HTTPException(409, "YouTube metadata generation is available only for Clip jobs")
    if job.processing_mode == "fast" or job.content_format != "short":
        raise HTTPException(409, "OpenRouter metadata generation is unavailable for Fast or Long form jobs")
    private = db.get_job_private(job_id)
    generation_state = private.setdefault("youtube_metadata_generation", {})
    if not isinstance(generation_state, dict):
        generation_state = private["youtube_metadata_generation"] = {}
    prior = generation_state.get(clip_id)
    if isinstance(prior, dict) and prior.get("status") == "in_flight":
        started_at = prior.get("started_at")
        if isinstance(started_at, (int, float)) and time.time() - started_at >= 120:
            generation_state[clip_id] = {"status": "unavailable", "reason": "A previous generation attempt timed out; explicitly retrying is now allowed.", "updated_at": time.time()}
            clip.youtube_metadata_status = "unavailable"
            clip.youtube_metadata_reason = "A previous generation attempt timed out; explicitly retrying is now allowed."
            manager._save(job, private)
        else:
            raise HTTPException(409, "Metadata generation is already in flight; wait for its result before retrying")
    if clip.youtube_metadata_status == "generated" and not regenerate:
        return public_job(job)
    # Existing clips are handled only through this explicit action. Require the
    # actual saved transcript excerpt; never infer clip content from the source title.
    excerpt = (clip.transcript_excerpt or "").strip()[:1600]
    if len(excerpt) < 20:
        clip.youtube_metadata_status = "unavailable"
        clip.youtube_metadata_reason = "Insufficient saved transcript context; no metadata was invented."
        job.updated_at = now_iso()
        manager._save(job, private)
        raise HTTPException(422, "This clip has insufficient saved transcript context for metadata generation")
    if job.execution_policy == "engine_only" or private.get("execution_policy") == "engine_only":
        if clip.library_asset_id is None:
            raise HTTPException(409, "The completed clip has no linked Library asset")
        try:
            _, saved_job, updated_clip = db.update_generated_clip_metadata(
                clip.library_asset_id, clip.title or f"Clip {clip.index}",
                normalize_seo_description(excerpt), clip.youtube_metadata_revision,
                metadata_status="fallback", metadata_reason="Transcript based local metadata",
                title_source=clip.title_source or "auto",
            )
        except ValueError as exc:
            raise HTTPException(409, "Metadata changed before the local suggestion could be applied") from exc
        local_private = db.get_job_private(job_id)
        local_private.setdefault("youtube_metadata_generation", {})[clip_id] = {
            "status": "fallback", "provider": "local", "updated_at": time.time(),
        }
        manager._save(saved_job, local_private)
        return public_job(saved_job)
    calls = private.get("youtube_metadata_generation_calls", 0)
    if type(calls) is not int or calls < 0 or calls >= 5:
        raise HTTPException(429, "This job has reached its five-request YouTube metadata generation limit")
    profile = next((item for item in db.list_profiles() if item.selected), None)
    model_id = job.youtube_metadata_model_id or (profile.youtube_metadata_model_id if profile else None)
    if not model_id:
        raise HTTPException(409, "Choose a title and description model in Settings")
    try:
        available_models = await profiles.openrouter_models()
    except ProviderError as exc:
        _record_youtube_metadata_failure(job_id, clip_id, clip.youtube_metadata_revision, exc.safe_message, excerpt)
        raise HTTPException(503, exc.safe_message) from exc
    model = next((item for item in available_models if item.id == model_id), None)
    if not model or not model.pricing:
        _record_youtube_metadata_failure(job_id, clip_id, clip.youtube_metadata_revision, "The selected metadata model is unavailable or has unknown pricing.", excerpt)
        raise HTTPException(409, "The selected metadata model is unavailable or has unknown pricing")
    if "response_format" not in model.supported_parameters:
        _record_youtube_metadata_failure(job_id, clip_id, clip.youtube_metadata_revision, "The selected metadata model does not support structured JSON output.", excerpt)
        raise HTTPException(409, "The selected metadata model does not support structured JSON output")
    try:
        input_rate = float(model.pricing["prompt"]) * 1_000_000
        output_rate = float(model.pricing["completion"]) * 1_000_000
    except (KeyError, ValueError, TypeError):
        _record_youtube_metadata_failure(job_id, clip_id, clip.youtube_metadata_revision, "The selected metadata model has unknown pricing.", excerpt)
        raise HTTPException(409, "The selected metadata model has unknown pricing") from None
    if not math.isfinite(input_rate) or not math.isfinite(output_rate) or input_rate > 0.10 or output_rate > 0.40:
        _record_youtube_metadata_failure(job_id, clip_id, clip.youtube_metadata_revision, "The selected metadata model exceeds the allowed price ceiling.", excerpt)
        raise HTTPException(409, "The selected metadata model exceeds the $0.10/$0.40 per-million-token price ceiling")
    system = SEO_TITLE_RULES
    project = db.get_project(job.project_id)
    language = str((private.get("transcript") or {}).get("language") or private.get("transcription_language") or "the transcript language")
    avoid_titles = _library_title_pool(exclude_asset_id=clip.library_asset_id)
    user = json.dumps({
        "output_format": job.content_format, "transcript_language": language,
        "source_title": source_context_title(project, private),
        "channel_name": str((project.source_creator if project else None) or private.get("youtube_creator") or "")[:120],
        "user_topic": str(private.get("topic") or "")[:200], "avoid_titles": avoid_titles,
        "clips": [{"clip_id": clip.id, "start_seconds": round(clip.start, 2), "end_seconds": round(clip.end, 2), "transcript": excerpt}],
    }, ensure_ascii=False)
    cache_key = hashlib.sha256(json.dumps({
        "range": [round(clip.start, 3), round(clip.end, 3)], "text": excerpt,
        "language": language, "model": model_id, "prompt": SEO_PROMPT_VERSION,
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    metadata_cache = private.setdefault("youtube_metadata_cache", {})
    cached = metadata_cache.get(cache_key) if isinstance(metadata_cache, dict) else None
    if not regenerate and isinstance(cached, dict) and isinstance(cached.get("title"), str) and isinstance(cached.get("description"), str):
        if clip.library_asset_id is None:
            raise HTTPException(409, "The completed clip has no linked Library asset")
        try:
            asset, saved_job, updated_clip = db.update_generated_clip_metadata(clip.library_asset_id, cached["title"], cached["description"], clip.youtube_metadata_revision, title_source="ai")
        except ValueError as exc:
            raise HTTPException(409, "Metadata changed before the cached suggestion could be applied") from exc
        updated_clip.youtube_metadata_status = "generated"
        updated_clip.youtube_metadata_model = model_id
        updated_clip.youtube_metadata_generated_at = cached.get("generated_at")
        updated_clip.youtube_metadata_cost_usd = cached.get("cost_usd")
        updated_clip.youtube_metadata_cost_kind = cached.get("cost_kind", "estimated")
        saved_job.clips = [updated_clip if item.id == clip_id else item for item in saved_job.clips]
        latest_private = db.get_job_private(job_id)
        latest_state = latest_private.setdefault("youtube_metadata_generation", {})
        if isinstance(latest_state, dict):
            latest_state[clip_id] = {"status": "generated", "cache_key": cache_key, "updated_at": time.time()}
        manager._save(saved_job, latest_private)
        return public_job(saved_job)
    schema = {"type": "object", "additionalProperties": False, "properties": {
        "clip_id": {"type": "string", "enum": [clip.id]},
        "title": {"type": "string", "minLength": 1, "maxLength": 100},
        "description": {"type": "string", "maxLength": 500},
    }, "required": ["clip_id", "title", "description"]}
    estimate_input = max(1, (len(system) + len(user) + 3) // 4)
    estimate_output = 200
    reserve = 2 * (estimate_input * 0.10 + estimate_output * 0.40) / 1_000_000
    snapshot_revision = clip.youtube_metadata_revision
    try:
        job, private, clip = db.claim_youtube_metadata_generation(job_id, clip_id, snapshot_revision, model_id, reserve)
        metadata_cache = private.setdefault("youtube_metadata_cache", {})
        generation_state = private.setdefault("youtube_metadata_generation", {})
        if not isinstance(generation_state, dict):
            generation_state = private["youtube_metadata_generation"] = {}
    except MetadataGenerationClaimError as exc:
        code = 429 if exc.category in {"limit", "budget"} else 409
        raise HTTPException(code, str(exc)) from exc
    try:
        result = await profiles.openrouter_json(
            [{"role": "system", "content": system}, {"role": "user", "content": user}], schema,
            require_saved_profile=True, model_id=model_id, temperature=0.2, max_tokens=200,
            provider={"require_parameters": True, "max_price": {"prompt": 0.10, "completion": 0.40}},
            reasoning={"enabled": False}, include_usage=True,
        )
        if not result or not isinstance(result, tuple):
            raise ProviderError("not_configured", "Connect and test the selected OpenRouter profile before generating metadata")
        payload, usage = result
        if payload.get("clip_id") != clip.id:
            raise ValueError("Provider returned a missing or unknown clip identifier")
        clean_title = normalize_seo_title(payload.get("title"))
        if not clean_title:
            raise ValueError("Provider returned an unusable title")
        metadata = YouTubeMetadataUpdate(revision=snapshot_revision, title=clean_title, description=normalize_seo_description(payload.get("description")))
        if any(item.id != clip_id and item.title and item.title.casefold() == metadata.title.casefold() for item in job.clips) or metadata.title.casefold() in {title.casefold() for title in avoid_titles}:
            raise ValueError("Provider returned a repetitive title already used in the Library")
        latest = db.get_job(job_id)
        latest_clip = next((item for item in latest.clips if item.id == clip_id), None) if latest else None
        if not latest_clip or latest_clip.youtube_metadata_revision != snapshot_revision:
            raise HTTPException(409, "Metadata changed while generation was running; the newer edit was preserved")
        if latest_clip.library_asset_id is None:
            raise HTTPException(409, "The completed clip has no linked Library asset")
        input_tokens = usage.get("prompt_tokens") if isinstance(usage.get("prompt_tokens"), int) else estimate_input
        output_tokens = usage.get("completion_tokens") if isinstance(usage.get("completion_tokens"), int) else estimate_output
        actual = usage.get("cost")
        has_actual_cost = isinstance(actual, (int, float)) and actual >= 0
        if not has_actual_cost:
            actual = input_tokens * float(model.pricing["prompt"]) + output_tokens * float(model.pricing["completion"])
        generated_at = now_iso()
        cost_usd = float(actual)
        cost_kind = "actual" if has_actual_cost else "estimated"
        asset, saved_job, updated_clip = db.update_generated_clip_metadata(
            latest_clip.library_asset_id, metadata.title, metadata.description, snapshot_revision,
            model_id=model_id, generated_at=generated_at, input_tokens=input_tokens,
            output_tokens=output_tokens, cost_usd=cost_usd, cost_kind=cost_kind, title_source="ai",
        )
        saved_job.clips = [updated_clip if item.id == clip_id else item for item in saved_job.clips]
        if isinstance(metadata_cache, dict):
            metadata_cache[cache_key] = {"title": metadata.title, "description": metadata.description, "generated_at": updated_clip.youtube_metadata_generated_at, "cost_usd": updated_clip.youtube_metadata_cost_usd, "cost_kind": updated_clip.youtube_metadata_cost_kind, "model": model_id}
        generation_state[clip_id] = {"status": "generated", "model": model_id, "cache_key": cache_key, "updated_at": time.time()}
        manager._save(saved_job, private)
        return public_job(saved_job)
    except HTTPException:
        raise
    except ProviderError as exc:
        _record_youtube_metadata_failure(job_id, clip_id, snapshot_revision, exc.safe_message, excerpt)
        raise HTTPException(503, exc.safe_message) from exc
    except (ValueError, TypeError, KeyError) as exc:
        reason = "Provider returned invalid metadata; transcript-based description is shown."
        _record_youtube_metadata_failure(job_id, clip_id, snapshot_revision, reason, excerpt)
        raise HTTPException(502, "OpenRouter returned invalid YouTube metadata; the playable clip was preserved") from exc


@app.post("/api/v1/jobs/{job_id}/clips/{clip_id}/captions/rerender", response_model=Job)
async def rerender_captions(job_id: str, clip_id: str, revision: int = Query(..., ge=1)) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    reject_retired_script(job)
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip:
        raise _not_found("Clip")
    private = db.get_job_private(job_id)
    override = (private.get("caption_overrides") or {}).get(clip_id)
    if not isinstance(override, dict) or override.get("revision") != revision:
        raise HTTPException(409, "Caption revision is stale or unavailable")
    running = private.get("caption_rerender")
    if isinstance(running, dict) and running.get("clip_id") == clip_id:
        raise HTTPException(409, "Caption rerender is already queued or active")
    if job.state not in {"complete", "partial", "failed", "cancelled_kept"} or running:
        raise HTTPException(409, "Wait for this job's current work to finish before rerendering captions")
    if clip.state != "complete" or not clip.output_name:
        raise HTTPException(409, "Only a completed clip can rerender reviewed captions")
    if manager.queue.full():
        raise HTTPException(429, "The local render queue is full")
    previous_job = job.model_copy(deep=True)
    private["caption_rerender"] = {
        "clip_id": clip_id, "revision": revision, "run_id": uuid.uuid4().hex,
        "previous_state": job.state, "previous_error": job.error,
    }
    private.pop("caption_rerender_error", None)
    manager._reset_steps_for_retry(job)
    job.state, job.stage, job.stage_label = "queued", "render", f"Caption revision {revision} queued"
    db.save_job(job, private)
    try:
        await manager.enqueue(job.id)
    except QueueFullError as exc:
        private.pop("caption_rerender", None)
        db.save_job(previous_job, private)
        raise HTTPException(429, str(exc)) from exc
    return public_job(job)


@app.get("/api/v1/jobs/{job_id}/clips/{clip_id}/captions/{format}")
async def download_caption(job_id: str, clip_id: str, format: Literal["ass", "srt", "vtt"], expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    job = db.get_job(job_id)
    clip = next((item for item in job.clips if item.id == clip_id), None) if job else None
    if not job:
        raise _not_found("Job")
    if not clip or clip.state != "complete" or not clip.output_name:
        raise _not_found("Caption")
    manifest = db.get_job_private(job_id).get("caption_artifacts", {}).get(clip_id)
    if not isinstance(manifest, dict) or manifest.get("output_name") != clip.output_name or format not in manifest.get("formats", []):
        raise _not_found("Caption")
    filename = Path(clip.output_name).with_suffix(f".{format}").name
    relative = f"jobs/{job_id}/clips/{filename}"
    if not signer.verify(relative, expires, signature):
        raise HTTPException(403, "Download link is invalid or expired")
    try:
        path = confined(settings.data_path, "jobs", job_id, "clips", filename)
    except ValueError as exc:
        raise HTTPException(403, "Caption path is invalid") from exc
    if not path.is_file() or path.is_symlink():
        raise _not_found("Caption")
    media_types = {"ass": "text/x-ass", "srt": "application/x-subrip", "vtt": "text/vtt"}
    return FileResponse(path, media_type=media_types[format], filename=filename)


@app.get("/api/v1/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    if not db.get_job(job_id):
        raise _not_found("Job")

    async def stream() -> AsyncIterator[str]:
        last = ""
        keepalive = 0
        while not await request.is_disconnected():
            job = db.get_job(job_id)
            if not job:
                break
            fingerprint = job.updated_at
            if fingerprint != last:
                last = fingerprint
                yield f"data: {public_job(job).model_dump_json(by_alias=True)}\n\n"
            else:
                keepalive += 1
                if keepalive % 15 == 0:
                    yield ": keepalive\n\n"
            if job.state in {"complete", "failed", "partial", "cancelled_kept"}:
                await asyncio.sleep(.25)
                break
            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/v1/jobs/{job_id}/control/{action}", response_model=Job)
async def job_control(job_id: str, action: Literal["pause", "resume", "stop-keep", "retry-failed", "retry-import", "switch-fast"]) -> Job:
    try:
        return public_job(await manager.control(job_id, action))
    except RetiredScriptJobError as exc:
        raise HTTPException(410, str(exc)) from exc
    except KeyError as exc:
        raise _not_found("Job") from exc
    except QueueFullError as exc:
        raise HTTPException(429, str(exc)) from exc
    except (ProjectDeletingError, SwitchFastError) as exc:
        raise HTTPException(409, str(exc)) from exc
    except MediaError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/v1/jobs/{job_id}/clips/{clip_id}/retry", response_model=Job)
async def retry_clip(job_id: str, clip_id: str) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    reject_retired_script(job)
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip:
        raise _not_found("Clip")
    if clip.state != "failed":
        raise HTTPException(409, "Only failed clips can be retried")
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try the clip retry again shortly.")
    clip.state, clip.error, job.state, job.stage_label = "queued", None, "queued", "Retrying one failed clip"
    manager._reset_steps_for_retry(job)
    manager._save(job)
    await manager.enqueue(job.id)
    return public_job(job)


@app.put("/api/v1/jobs/{job_id}/selection", response_model=Job)
async def update_selection(job_id: str, value: SelectionInput) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    reject_retired_script(job)
    selected = set(value.clip_ids)
    if not selected.issubset({clip.id for clip in job.clips}):
        raise HTTPException(422, "Selection contains a clip outside this job")
    for clip in job.clips:
        clip.selected = clip.id in selected and clip.state == "complete"
    manager._save(job)
    return public_job(job)


@app.post("/api/v1/jobs/{job_id}/export")
async def export_job(job_id: str, value: SelectionInput) -> dict[str, str]:
    try:
        output = await asyncio.to_thread(manager.build_export, job_id, value.clip_ids)
    except KeyError as exc:
        raise _not_found("Job") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    relative = output.relative_to(settings.data_path).as_posix()
    return {"downloadUrl": _download_url(relative), "filename": output.name}


@app.get("/api/v1/files/{relative_path:path}")
# DO-NOT-CHANGE: only serves jobs/ and exports/ prefixes; HMAC-verified; confined path
async def download_file(relative_path: str, expires: int = Query(...), signature: str = Query(...), inline: bool = Query(False)) -> FileResponse:
    if not relative_path.startswith(("jobs/", "exports/")) or Path(relative_path).suffix.casefold() not in {".mp4", ".zip"} or not signer.verify(relative_path, expires, signature):
        raise HTTPException(403, "Download link is invalid or expired")
    try:
        target = confined(settings.data_path, *relative_path.split("/"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid download path") from exc
    if not target.is_file():
        raise _not_found("File")
    media_type = "application/zip" if target.suffix == ".zip" else "video/mp4"
    if inline and media_type == "video/mp4":
        return FileResponse(target, media_type=media_type)
    download_name = target.name if media_type == "application/zip" else safe_filename(target.name, "s6-cut-download")
    return FileResponse(target, filename=download_name, media_type=media_type)


@app.post("/api/v1/video-downloads", response_model=VideoDownloadTask, status_code=202)
async def create_video_download(value: VideoDownloadInput, request: Request) -> VideoDownloadTask:
    _rate_limit(request)
    try:
        task, created = await video_downloads.create(value.url)
    except OverflowError as exc:
        raise HTTPException(429, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    # Reused tasks distinguish duplicates without changing the durable task contract.
    if not created:
        response = task.model_copy()
        response.message = "An identical download already exists" if task.state != "complete" else "This video was already downloaded"
        if response.state == "complete" and response.filename:
            if safe_filename(response.filename, "") != response.filename or not response.filename.endswith(".mp4"):
                response = video_downloads.mark_unavailable(task.id) or response
            else:
                relative = f"exports/video-downloads/{task.id}/{response.filename}"
                try:
                    target = confined(settings.data_path, *relative.split("/"))
                except ValueError:
                    target = settings.data_path / "missing-video-download.mp4"
                if target.is_file():
                    expires, signature = signer.sign(relative)
                    response.download_url = f"/api/v1/files/{relative}?expires={expires}&signature={signature}"
                else:
                    response = video_downloads.mark_unavailable(task.id) or response
        return response
    return task


def _public_download(task: VideoDownloadTask) -> VideoDownloadTask:
    """A response copy carrying a short-lived signed poster link, when a still exists."""
    result = task.model_copy()
    if video_downloads.has_preview(task.id):
        expires, signature = signer.sign(f"video-download-thumbnail:{task.id}:v1")
        result.thumbnail_url = f"/api/v1/video-downloads/{task.id}/thumbnail?expires={expires}&signature={signature}"
    return result


@app.get("/api/v1/video-downloads", response_model=list[dict[str, Any]])
async def list_video_downloads() -> list[dict[str, Any]]:
    # Existing clients may still renew a signed URL through the by-id endpoint.
    return [_public_download(task).model_dump(by_alias=True, exclude={"download_url"}) for task in video_downloads.list()]


@app.get("/api/v1/video-downloads/{task_id}/thumbnail")
# Own token and own route: /files only serves .mp4/.zip and must stay that way.
async def video_download_thumbnail(task_id: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    if not re.fullmatch(r"[0-9a-f]{32}", task_id) or video_downloads.get(task_id) is None:
        raise _not_found("Video download")
    if not signer.verify(f"video-download-thumbnail:{task_id}:v1", expires, signature):
        raise HTTPException(403, "Thumbnail link is invalid or expired")
    if not video_downloads.has_preview(task_id):
        raise _not_found("Thumbnail")
    return FileResponse(video_downloads.preview_path(task_id), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@app.get("/api/v1/video-downloads/{task_id}", response_model=VideoDownloadTask)
async def get_video_download(task_id: str) -> VideoDownloadTask:
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        raise _not_found("Video download")
    task = video_downloads.get(task_id)
    if not task:
        raise _not_found("Video download")
    result = task.model_copy()
    if result.download_url and result.state == "complete" and result.filename:
        if safe_filename(result.filename, "") != result.filename or not result.filename.endswith(".mp4"):
            result = video_downloads.mark_unavailable(task_id) or result
        else:
            relative = f"exports/video-downloads/{task_id}/{result.filename}"
            try:
                target = confined(settings.data_path, *relative.split("/"))
            except ValueError:
                target = settings.data_path / "missing-video-download.mp4"
            if target.is_file():
                expires, signature = signer.sign(relative)
                result.download_url = f"/api/v1/files/{relative}?expires={expires}&signature={signature}"
            else:
                result = video_downloads.mark_unavailable(task_id) or result
    return _public_download(result)


@app.get("/api/v1/openrouter/models", response_model=list[OpenRouterModel], response_model_exclude_none=True)
async def list_openrouter_models(output_modalities: Annotated[str | None, Query(alias="outputModalities")] = None) -> list[OpenRouterModel]:
    if output_modalities not in {None, "text"}:
        raise HTTPException(422, "Unsupported OpenRouter output modality")
    try:
        return await profiles.openrouter_models(output_modalities)
    except ProviderError as exc:
        status_code = {"not_configured": 503, "invalid_credentials": 502, "insufficient_balance": 402, "rate_limited": 429, "timeout_offline": 503, "malformed_response": 502}.get(exc.category, 502)
        raise HTTPException(status_code, exc.safe_message) from exc


@app.get("/api/v1/profiles", response_model=list[ProviderProfile])
async def list_profiles() -> list[ProviderProfile]:
    return db.list_profiles()


@app.post("/api/v1/profiles", response_model=ProviderProfile)
async def create_profile(value: ProfileInput) -> ProviderProfile:
    return profiles.save(value)


@app.put("/api/v1/profiles/{profile_id}", response_model=ProviderProfile)
async def update_profile(profile_id: str, value: ProfileInput) -> ProviderProfile:
    if not db.get_profile(profile_id):
        raise _not_found("Profile")
    return profiles.save(value, profile_id)


@app.post("/api/v1/profiles/{profile_id}/duplicate", response_model=ProviderProfile)
async def duplicate_profile(profile_id: str) -> ProviderProfile:
    try:
        return profiles.duplicate(profile_id)
    except KeyError as exc:
        raise _not_found("Profile") from exc


@app.post("/api/v1/profiles/{profile_id}/test", response_model=ProviderProfile)
async def test_profile(profile_id: str) -> ProviderProfile:
    try:
        return await profiles.test(profile_id)
    except KeyError as exc:
        raise _not_found("Profile") from exc
    except Exception as exc:
        raise HTTPException(422, "Provider test could not be completed safely") from exc


@app.delete("/api/v1/profiles/{profile_id}", status_code=204)
async def remove_profile(profile_id: str) -> None:
    if not db.get_profile(profile_id):
        raise _not_found("Profile")
    profiles.delete(profile_id)


def _csv(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in value.split(",") if item.strip()))[:100]


# DO-NOT-CHANGE: signs preview URL with token library-asset:{id}:{blob_id};
# preview_asset verifies token + confined path
def _asset_preview_url(asset: Asset) -> str:
    token = f"library-asset:{asset.id}:{asset.blob_id}"
    expires, signature = signer.sign(token)
    return f"/api/v1/library/assets/{asset.id}/preview?expires={expires}&signature={signature}"


def _thumbnail_url(asset: Asset) -> str | None:
    if not asset.media_type.startswith("video/") or not asset.blob_id:
        return None
    token = f"library-thumbnail:{asset.blob_id}:v1"
    expires, signature = signer.sign(token)
    return f"/api/v1/library/assets/{asset.id}/thumbnail?expires={expires}&signature={signature}"


def _public_asset(asset: Asset) -> Asset:
    return asset.model_copy(update={"preview_url": _asset_preview_url(asset), "thumbnail_url": _thumbnail_url(asset)})


@app.get("/api/v1/library/folders", response_model=list[LibraryFolder])
async def list_library_folders(include_archived: bool = False) -> list[LibraryFolder]:
    return db.list_folders(include_archived)


@app.post("/api/v1/library/folders", response_model=LibraryFolder, status_code=201)
async def create_library_folder(value: FolderCreate) -> LibraryFolder:
    if value.parent_id:
        parent = db.get_folder(value.parent_id)
        if not parent:
            raise _not_found("Parent folder")
        depth, cursor = 2, parent
        while cursor.parent_id:
            depth += 1
            cursor = db.get_folder(cursor.parent_id) or cursor.model_copy(update={"parent_id": None})
        if depth > MAX_FOLDER_DEPTH:
            raise HTTPException(409, f"Folders may be at most {MAX_FOLDER_DEPTH} levels deep")
    folder = LibraryFolder(id=str(uuid.uuid4()), **value.model_dump())
    try:
        return db.save_folder(folder)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.put("/api/v1/library/folders/{folder_id}", response_model=LibraryFolder)
async def update_library_folder(folder_id: str, value: FolderUpdate) -> LibraryFolder:
    folder = db.get_folder(folder_id)
    if not folder:
        raise _not_found("Folder")
    if folder.system and value.name is not None:
        raise HTTPException(409, "System folders cannot be renamed")
    try:
        return db.save_folder(folder.model_copy(update={**value.model_dump(exclude_unset=True), "updated_at": now_iso()}))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/v1/library/folders/{folder_id}/move", response_model=LibraryFolder)
async def move_library_folder(folder_id: str, value: FolderMove) -> LibraryFolder:
    try:
        return db.move_folder(folder_id, value.parent_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/v1/library/folders/{folder_id}/archive", response_model=LibraryFolder)
async def archive_library_folder(folder_id: str, archived: bool = True) -> LibraryFolder:
    folder = db.get_folder(folder_id)
    if not folder:
        raise _not_found("Folder")
    if folder.system:
        raise HTTPException(409, "System folders cannot be archived")
    return db.save_folder(folder.model_copy(update={"archived": archived, "updated_at": now_iso()}))


@app.delete("/api/v1/library/folders/{folder_id}", status_code=204)
async def remove_library_folder(folder_id: str, destination_folder_id: str = UNSORTED_FOLDER_ID, confirmed: bool = False) -> None:
    if not confirmed:
        raise HTTPException(409, "Confirm removal; assets and child folders will be moved to the destination")
    try:
        db.remove_folder(folder_id, destination_folder_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/v1/library/purge", response_model=LibraryPurgeResult)
async def purge_library(value: LibraryPurgeInput) -> LibraryPurgeResult:
    if value.confirmation != "DELETE ALL CONTENT":
        raise HTTPException(409, "Type DELETE ALL CONTENT exactly to confirm this permanent action.")
    try:
        result = LibraryPurgeResult.model_validate(await manager.purge_library_content())
        _prune_orphaned_thumbnails()
        return result
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/v1/library/assets", response_model=list[Asset])
async def list_assets(folder_id: str | None = None, media_type: str | None = None, origin: AssetOrigin | None = None, search: str | None = Query(default=None, max_length=500), include_archived: bool = False) -> list[Asset]:
    if folder_id and not db.get_folder(folder_id):
        raise _not_found("Folder")
    return [_public_asset(asset) for asset in db.list_assets(folder_id=folder_id, media_type=media_type, origin=origin, search=search, include_archived=include_archived)]


@app.get("/api/v1/library/assets/page", response_model=AssetPage)
async def list_assets_page(folder_id: str | None = None, media_type: str | None = None, origin: AssetOrigin | None = None, search: str | None = Query(default=None, max_length=500), include_archived: bool = False, page: int = Query(1, ge=1), page_size: int = Query(40, ge=1, le=100)) -> AssetPage:
    if folder_id and not db.get_folder(folder_id):
        raise _not_found("Folder")
    assets, has_more = db.list_assets_page(folder_id=folder_id, media_type=media_type, origin=origin, search=search, include_archived=include_archived, page=page, page_size=page_size)
    return AssetPage(items=[_public_asset(asset) for asset in assets], page=page, page_size=page_size, has_more=has_more)


@app.get("/api/v1/library/recent-clips", response_model=RecentClipsPage)
async def recent_clips(search: str | None = Query(default=None, max_length=500), page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=100)) -> RecentClipsPage:
    def playable_file(relative: str) -> bool:
        try:
            target = confined(settings.data_path, *relative.split("/"))
        except (ValueError, OSError):
            return False
        return target.is_file()

    assets, total = db.recent_clip_assets(search=search, page=page, page_size=page_size, file_exists=playable_file)
    return RecentClipsPage(
        items=[_public_asset(asset) for asset in assets], page=page, page_size=page_size,
        has_more=page * page_size < total, total=total,
    )


@app.post("/api/v1/library/assets/move", response_model=dict[str, int])
async def move_library_assets(value: AssetMove) -> dict[str, int]:
    try:
        return {"moved": db.move_assets(value.asset_ids, value.folder_id)}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/v1/library/assets/bulk-delete", response_model=AssetDeleteResult)
async def delete_library_assets(value: AssetDelete) -> AssetDeleteResult:
    """Delete only explicitly selected, unprotected library records.

    The database resolves each blob reference; clients never submit paths. A
    blob is removed only after the transactional reference check says it is no
    longer shared. Missing, protected, and invalid IDs are returned per item so
    a mixed selection can be retried without losing failed cards.
    """
    deleted: list[str] = []
    failed: dict[str, str] = {}
    requested_ids = list(dict.fromkeys(value.asset_ids))
    source_projects = {
        asset_id: asset.source_project_id
        for asset_id in requested_ids
        if (asset := db.get_asset(asset_id)) and asset.origin == "project-source" and asset.source_project_id
    }
    cascaded_projects: set[str] = set()
    for asset_id in requested_ids:
        if source_projects.get(asset_id) in cascaded_projects:
            deleted.append(asset_id)
            continue
        if not asset_id.strip():
            failed[asset_id] = "Invalid media ID"
            continue
        try:
            project_id = await _delete_asset_and_cleanup(asset_id)
            if project_id:
                cascaded_projects.add(project_id)
            deleted.append(asset_id)
        except KeyError:
            failed[asset_id] = "Media item was already deleted"
        except ValueError as exc:
            failed[asset_id] = str(exc)
        except OSError as exc:
            failed[asset_id] = f"Storage error: {exc}"
    if deleted:
        _prune_orphaned_thumbnails()
    return AssetDeleteResult(deleted=deleted, failed=failed)


@app.post("/api/v1/library/assets", response_model=Asset)
async def create_asset(
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=200)],
    tags: Annotated[str, Form()] = "",
    triggers: Annotated[str, Form()] = "",
    policy: Annotated[Literal["required", "prefer", "neutral", "never"], Form()] = "neutral",
    licence: Annotated[str, Form(max_length=500)] = "User supplied",
    folder_id: Annotated[str, Form()] = UNSORTED_FOLDER_ID,
) -> Asset:
    selected_folder = db.get_folder(folder_id)
    if not selected_folder:
        raise _not_found("Folder")
    if selected_folder.archived:
        raise HTTPException(409, "Archived folders cannot receive new assets")
    name = safe_filename(file.filename or "asset", "asset")
    if not (file.content_type or "").startswith(("image/", "video/", "audio/")):
        raise HTTPException(415, "Library files must be an image, video, or audio asset")
    asset_id = str(uuid.uuid4())
    directory = settings.data_path / "temp" / "library-imports" / asset_id
    target = directory / name
    _, digest = await _stream_upload(file, target, min(settings.max_upload_bytes, 2_000_000_000))
    try:
        metadata = None
        if (file.content_type or "").startswith("video/"):
            try:
                metadata = await asyncio.to_thread(validate_video_upload, target, name, settings)
            except MediaError as exc:
                raise HTTPException(422, str(exc)) from exc
        asset = await asyncio.to_thread(
            rules.register_file, target, title=title, media_type=file.content_type or "application/octet-stream",
            origin="manual-import", folder_id=folder_id, metadata=metadata, content_hash=digest,
            filename=name, tags=_csv(tags), triggers=_csv(triggers), policy=policy, licence=licence,
        )
        return _public_asset(asset)
    finally:
        target.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass


@app.get("/api/v1/library/blobs/{blob_id}/preview")
# DO-NOT-CHANGE: verifies token library-blob:{id}, serves only a durable clip-output blob
async def preview_clip_blob(blob_id: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    if not signer.verify(f"library-blob:{blob_id}", expires, signature):
        raise HTTPException(403, "Preview link is invalid or expired")
    relative = db.blob_relative_path(blob_id)
    if not relative:
        raise _not_found("Media blob")
    try:
        target = confined(settings.data_path, *relative.split("/"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid media blob") from exc
    if not target.is_file():
        raise _not_found("Media blob")
    return FileResponse(target, media_type="video/mp4")


@app.get("/api/v1/library/assets/{asset_id}/preview")
# DO-NOT-CHANGE: verifies token library-asset:{id}:{blob_id}, serves from confined path
async def preview_asset(asset_id: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    asset = db.get_asset(asset_id)
    if not asset:
        raise _not_found("Asset")
    token = f"library-asset:{asset.id}:{asset.blob_id}"
    if not signer.verify(token, expires, signature):
        raise HTTPException(403, "Preview link is invalid or expired")
    relative = db.blob_relative_path(asset.blob_id)
    if not relative:
        raise _not_found("Media blob")
    try:
        target = confined(settings.data_path, *relative.split("/"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid media reference") from exc
    if not target.is_file():
        raise _not_found("Media blob")
    return FileResponse(target, media_type=asset.media_type)


@app.get("/api/v1/library/assets/{asset_id}/thumbnail-url")
async def asset_thumbnail_url(asset_id: str) -> dict[str, str]:
    asset = db.get_asset(asset_id)
    url = _thumbnail_url(asset) if asset else None
    if not url:
        raise _not_found("Video asset")
    return {"thumbnailUrl": url}


@app.get("/api/v1/library/assets/{asset_id}/thumbnail")
async def asset_thumbnail(asset_id: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    asset = db.get_asset(asset_id)
    if not asset or not asset.media_type.startswith("video/"):
        raise _not_found("Video asset")
    token = f"library-thumbnail:{asset.blob_id}:v1"
    if not signer.verify(token, expires, signature):
        raise HTTPException(403, "Thumbnail link is invalid or expired")
    source_relative = db.blob_relative_path(asset.blob_id)
    if not source_relative:
        raise _not_found("Media blob")
    try:
        source = confined(settings.data_path, *source_relative.split("/"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid media reference") from exc
    if not source.is_file():
        raise _not_found("Media blob")
    try:
        target = await get_thumbnail(settings.data_path, asset.blob_id, source_relative, asset.duration_seconds, settings.ffmpeg)
    except (OSError, RuntimeError, TimeoutError) as exc:
        logger.warning("Thumbnail extraction failed for asset %s: %s", asset.id, exc)
        raise HTTPException(503, "Thumbnail is temporarily unavailable") from exc
    except ValueError as exc:
        raise HTTPException(400, "Invalid media reference") from exc
    return FileResponse(target, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@app.delete("/api/v1/library/assets/{asset_id}", status_code=204)
async def delete_library_asset(asset_id: str) -> None:
    try:
        await _delete_asset_and_cleanup(asset_id)
        _prune_orphaned_thumbnails()
    except KeyError as exc:
        raise _not_found("Asset") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, "Media record was deleted, but blob cleanup failed") from exc


@app.put("/api/v1/library/assets/{asset_id}", response_model=Asset)
async def update_asset(asset_id: str, value: AssetUpdate) -> Asset:
    asset = db.get_asset(asset_id)
    if not asset:
        raise _not_found("Asset")
    update = value.model_dump(exclude_unset=True)
    if update.get("folder_id"):
        destination = db.get_folder(update["folder_id"])
        if not destination:
            raise _not_found("Folder")
        if destination.archived:
            raise HTTPException(409, "Archived folders cannot receive assets")
    metadata_update = asset.origin == "generated-clip" and ({"title", "description"} & update.keys())
    if metadata_update:
        job = db.get_job(asset.source_job_id or "")
        clip = next((item for item in job.clips if item.id == asset.source_clip_id), None) if job else None
        if not job or not clip:
            raise HTTPException(409, "The linked generated clip is unavailable")
        title = str(update.get("title", asset.title))
        description = str(update.get("description", asset.description))
        try:
            asset, saved_job, _ = db.update_generated_clip_metadata(
                asset.id, title, description, clip.youtube_metadata_revision,
                title_source="user" if title != asset.title else None,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        other_updates = {key: value for key, value in update.items() if key not in {"title", "description"}}
        if other_updates:
            asset = asset.model_copy(update=other_updates)
            db.save_asset(asset)
        manager._save(saved_job, db.get_job_private(saved_job.id))
    else:
        if "title" in update and update["title"] != asset.title:
            update["title_source"] = "user"
        asset = asset.model_copy(update=update)
        db.save_asset(asset)
    return _public_asset(asset)


def _library_title_pool(*, exclude_asset_id: str | None = None) -> list[str]:
    """Existing Library titles the AI must not repeat (bounded prompt size)."""
    return sorted({asset.title for asset in db.list_assets(include_archived=True) if asset.id != exclude_asset_id and asset.title})[:200]


@app.post("/api/v1/library/title-suggestions", response_model=TitleSuggestionResponse)
async def suggest_library_titles(value: TitleSuggestionRequest) -> TitleSuggestionResponse:
    """Suggest SEO titles for existing Library items. Writes nothing."""
    if not value.asset_ids and value.scope != "auto-titled":
        raise HTTPException(422, "Choose Library items or the auto-titled scope")
    try:
        return await title_backfill.suggest(value)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/v1/library/title-suggestions/apply", response_model=TitleApplyResponse)
async def apply_library_titles(value: TitleApplyRequest) -> TitleApplyResponse:
    return await asyncio.to_thread(title_backfill.apply, value)


@app.get("/api/v1/library/match", response_model=MatchExplanation)
async def match_asset(text: str = Query(min_length=1, max_length=10_000)) -> MatchExplanation:
    return rules.explain(text)


@app.get("/api/v1/storage")
async def storage_diagnostics() -> dict[str, object]:
    try:
        usage = shutil.disk_usage(settings.data_path)
        free_bytes, total_bytes = usage.free, usage.total
    except OSError:
        # Some mounted Docker volumes do not implement statvfs. Keep cleanup and
        # file diagnostics available when their capacity cannot be inspected.
        free_bytes = total_bytes = 0
    counts = {name: sum(1 for item in (settings.data_path / name).rglob("*") if item.is_file()) for name in ("jobs", "blobs", "library", "cache", "exports")}
    return {"freeBytes": free_bytes, "totalBytes": total_bytes, "files": counts, "retentionDays": settings.retention_days, "maxRetainedJobs": settings.max_retained_jobs}


@app.post("/api/v1/storage/cleanup")
async def cleanup_temporary_files() -> dict[str, int]:
    cutoff = time.time() - 24 * 3600
    removed = 0
    for root in (settings.data_path / "temp", settings.data_path / "jobs"):
        for path in root.rglob("*.partial.*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
    pruned = await asyncio.to_thread(manager.prune_retained_jobs)
    return {"removedTemporaryFiles": removed, "prunedJobDirectories": pruned}
