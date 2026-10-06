from __future__ import annotations

import asyncio
import errno
import hashlib
import importlib.util
import json
import logging
import math
import os
import shutil
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Literal

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .config import settings
from .database import Database, MAX_FOLDER_DEPTH, UNSORTED_FOLDER_ID
from .jobs import JobManager, ProjectDeletingError, QueueFullError, SwitchFastError, can_retry_import, uses_fast_pipeline
from .library import LibraryRules
from .media import _SUBTITLE_PRESETS, MediaError, available, caption_font_mismatches, probe, validate_video_upload
from .models import (
    Asset, AssetDelete, AssetDeleteResult, AssetMove, AssetOrigin, AssetUpdate, AssetPage, CaptionCue, CaptionDownload, CaptionReviewInput, Clip, FolderCreate, FolderMove, FolderUpdate, Health, Job, LibraryPurgeInput, LibraryPurgeResult,
    LibraryFolder, MatchExplanation, RecentClipsPage, ContentFormat, ProcessingMode, ProfileInput, Project, ProjectFolderUpdate,
    OpenRouterModel, ProviderProfile, ScriptJobInput, SelectionInput, ShortsJobInput, SubscribeAnimationConfig, MusicPresentationConfig, TopicBeat, TopicVideoInput, TopicVideoPlan, now_iso,
)
from .providers import ProfileService, ProviderError
from .security import MediaSigner, SecretVault, confined, safe_filename, validate_youtube_url


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
creation_times: defaultdict[str, deque[float]] = defaultdict(deque)


logger = logging.getLogger(__name__)


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
    await manager.start()
    try:
        yield
    finally:
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
        return "smart" if smart_available else "fast"
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


def _clip_media(job_id: str, clip: Clip) -> tuple[str, str] | None:
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
            return url, url
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
                return url, url
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
            return download, f"{download}&inline=1"
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
                clip.download_url = clip.preview_url = None
                clip.caption_downloads = []
                continue
            clip.download_url, clip.preview_url = media
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
        ytdlp=available(settings.ytdlp), local_tts=available(settings.local_tts),
        data_path="Container data directory" if str(settings.data_path).startswith("/app/") else "Local mounted data directory",
        free_bytes=free_bytes, configured_workers=settings.job_workers,
        active_workers=manager.active_workers, queued_jobs=manager.queue.qsize(),
        fallbacks={
            "transcription": "Local Whisper is required for automatic clip timing",
            "planning": "Deterministic sentence-aware selection and beat planning",
            "voice": "Local espeak-ng, then silent render",
            "media": "Personal Library, then relevant text card",
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
    url: Annotated[str | None, Form()] = None,
    name: Annotated[str | None, Form()] = None,
    style: Annotated[Literal["funny", "serious", "educational", "hype"], Form()] = "educational",
    processing_mode: Annotated[Literal["fast", "smart", "auto"], Form()] = "auto",
    source_profile: Annotated[Literal["speech", "music"], Form()] = "speech",
    count: Annotated[int, Form(ge=1, le=30)] = 5,
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
    if min_duration >= max_duration:
        raise HTTPException(422, "Minimum duration must be shorter than maximum duration")
    if len(music_top_text) > 100:
        raise HTTPException(422, "Music top text must be 100 characters or fewer")
    music_config = _music_presentation_request(music_presentation)
    if source_profile != "music" and (music_top_text or music_presentation != "{}" or music_config.subtitle_theme != "clean"):
        raise HTTPException(422, "Music presentation options are only available for Music / sung vocals")
    if source_profile == "music" and content_format != "short":
        raise HTTPException(422, "Music / sung vocals is currently available for short clips only")
    if content_format == "short" and max_duration > 180:
        raise HTTPException(422, "Short form clips support a maximum duration of 180 seconds")
    if content_format == "long":
        aspect_ratio = "16:9"
    source_limit = settings.max_long_source_seconds if content_format == "long" else settings.max_source_seconds
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    smart_available = profiles.smart_available()
    mode = "smart" if source_profile == "music" else resolve_processing_mode(processing_mode, smart_available)
    private: dict[str, object] = {
        "count": count, "min_duration": min_duration, "max_duration": max_duration,
        "aspect_ratio": aspect_ratio, "content_format": content_format, "processing_mode": mode,
        "burn_subtitles": True if source_profile == "music" else burn_subtitles, "embed_subtitles": embed_subtitles,
        "use_openrouter": mode == "smart" and smart_available and source_profile == "speech",
        "library_folder_id": library_folder_id,
        "subscribe_animation": _subscribe_animation_request(subscribe_animation).model_dump(),
    }
    if source_profile == "music":
        private["music_presentation"] = music_config.model_dump()
        private["music_top_text"] = music_top_text if music_top_text.strip() else None
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
    project = Project(id=project_id, name=_project_name(name, Path(source_name).stem), mode="clip", style=style, state="queued", source_name=source_name, source_kind=source_kind, requested_count=count, content_format=content_format, source_profile=source_profile, latest_job_id=job_id, library_folder_id=library_folder_id)
    steps = manager._fast_steps() if uses_fast_pipeline(mode, content_format) else manager._smart_steps(bool(private["use_openrouter"]), source_profile)
    if source_kind == "upload":
        checkpoint_time = now_iso()
        steps[0].status, steps[0].detail = "complete", "Upload atomically stored"
        steps[0].started_at = steps[0].completed_at = checkpoint_time
        if isinstance(source_metadata, dict):
            steps[1].status = "complete"
            steps[1].detail = f"Source validated - {float(source_metadata['duration']):.1f}s"
            steps[1].started_at = steps[1].completed_at = checkpoint_time
    job = Job(id=job_id, project_id=project_id, library_folder_id=library_folder_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=style, processing_mode=mode, content_format=content_format, source_profile=source_profile, music_presentation=music_config if source_profile == "music" else None, music_top_text=(music_top_text if music_top_text.strip() else None) if source_profile == "music" else None, burn_subtitles=True if source_profile == "music" else burn_subtitles, embed_subtitles=embed_subtitles, steps=steps)
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
    subscribe_animation: SubscribeAnimationConfig | None = None,
) -> dict[str, object]:
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    selected_folder = db.get_folder(library_folder_id)
    if not selected_folder:
        raise _not_found("Library folder")
    if selected_folder.archived:
        raise HTTPException(409, "Archived folders cannot receive new projects")
    _validate_shorts_trim(start, end, float(source_metadata["duration"]) if source_metadata else None)
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
    private = {"source_path": str(source_path) if source_path else None, "source_hash": source_hash, "source_metadata": source_metadata, "url": url, "trim_start": start, "trim_end": end, "aspect_ratio": aspect_ratio, "count": 1, "min_duration": max(0.1, clip.duration), "max_duration": max(0.1, clip.duration), "processing_mode": processing_mode, "burn_subtitles": burn_subtitles, "embed_subtitles": embed_subtitles, "library_folder_id": library_folder_id, "subscribe_animation": (subscribe_animation or SubscribeAnimationConfig()).model_dump()}
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
    return await _queue_shorts_job(request=request, source_name=asset.filename, source_kind="upload", source_path=source, source_hash=asset.content_hash, source_metadata=metadata, url=None, start=value.start, end=value.end, aspect_ratio=value.aspect_ratio, library_folder_id=value.library_folder_id, name=value.name, burn_subtitles=value.burn_subtitles, embed_subtitles=value.embed_subtitles, subscribe_animation=value.subscribe_animation)


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
            result = await _queue_shorts_job(request=request, source_name=original, source_kind="upload", source_path=source, source_hash=source_hash, source_metadata=metadata, url=None, start=parsed_start, end=parsed_end, aspect_ratio=aspect_ratio, library_folder_id=library_folder_id, name=name, burn_subtitles=burn_subtitles, job_id=job_id, subscribe_animation=subscribe_animation)
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
    return await _queue_shorts_job(request=request, source_name="YouTube import", source_kind="youtube", source_path=None, source_hash=None, source_metadata=None, url=validated_url, start=parsed_start, end=parsed_end, aspect_ratio=aspect_ratio, library_folder_id=library_folder_id, name=name, burn_subtitles=burn_subtitles, subscribe_animation=subscribe_animation)


@app.post("/api/v1/ai/topic-plan", response_model=TopicVideoPlan)
async def topic_plan(value: TopicVideoInput) -> TopicVideoPlan:
    if value.custom_script.strip():
        narration = value.custom_script.strip()
        words = narration.split()
        chunk = max(1, len(words) // 6)
        beats = [TopicBeat(narration=" ".join(words[index:index + chunk]), seconds=max(1, value.duration_seconds / max(1, (len(words) + chunk - 1) // chunk)), keywords=[value.topic]) for index in range(0, len(words), chunk)][:30]
        return TopicVideoPlan(title=value.topic[:200], hook=words[0][:500], narration=narration, beats=beats, estimated_duration=value.duration_seconds)
    schema = {"type": "object", "additionalProperties": False, "properties": {"title": {"type": "string"}, "hook": {"type": "string"}, "narration": {"type": "string"}, "beats": {"type": "array", "items": {"type": "object", "additionalProperties": False, "properties": {"narration": {"type": "string"}, "seconds": {"type": "number"}, "keywords": {"type": "array", "items": {"type": "string"}}}, "required": ["narration", "seconds", "keywords"]}}, "estimated_duration": {"type": "number"}, "description": {"type": "string"}, "hashtags": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "hook", "narration", "beats", "estimated_duration", "description", "hashtags"]}
    target_words = round(value.duration_seconds * 2.5)
    prompt = f"Create a concise video plan in {value.language} about {value.topic!r}. Audience: {value.audience}. Tone: {value.tone}. Target seconds: {value.duration_seconds}; write approximately {target_words} spoken words so narration duration matches the target at a natural pace. CTA: {value.call_to_action}. Extra instructions: {value.instructions}. Return only JSON matching the schema; use local-library visual keywords and never claim licensing."
    try:
        result = await profiles.openrouter_json([{"role": "user", "content": prompt}], schema, require_saved_profile=True, model_id=value.model_id)
    except ProviderError as exc:
        status_code = {"not_configured": 503, "invalid_credentials": 502, "rate_limited": 429, "timeout_offline": 503, "unavailable_model": 422, "unsupported_model_or_voice": 422, "malformed_response": 502}.get(exc.category, 502)
        raise HTTPException(status_code, exc.safe_message) from exc
    except sqlite3.Error as exc:
        raise HTTPException(503, "Local project storage is temporarily unavailable. Free disk space and try again.") from exc
    if not result:
        raise HTTPException(503, "OpenRouter is not configured. Add and test a provider in Settings, or enter a custom script.")
    try:
        return TopicVideoPlan.model_validate(result)
    except Exception as exc:
        raise HTTPException(502, "OpenRouter returned a plan that could not be validated.") from exc


@app.post("/api/v1/jobs/script", status_code=status.HTTP_202_ACCEPTED)
async def create_script_job(request: Request, value: ScriptJobInput) -> dict[str, object]:
    _rate_limit(request)
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    folder_id = value.library_folder_id or UNSORTED_FOLDER_ID
    try:
        selected_folder = db.get_folder(folder_id)
        if not selected_folder:
            raise _not_found("Library folder")
        if selected_folder.archived:
            raise HTTPException(409, "Archived folders cannot receive new projects")
        project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
        first_line = next((line.strip() for line in value.script.splitlines() if line.strip()), "Script project")
        name = _project_name(value.name, first_line[:70])
        project = Project(id=project_id, name=name, mode="script", style=value.style, content_format=value.content_format, state="queued", source_name=f"{len(value.script)} character script", source_kind="script", requested_count=1, latest_job_id=job_id, library_folder_id=folder_id)
        job = Job(id=job_id, project_id=project_id, library_folder_id=folder_id, mode="script", content_format=value.content_format, state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=value.style, steps=manager._script_steps())
        private = {"script": value.script, "aspect_ratio": value.aspect_ratio, "content_format": value.content_format, "narration": value.narration, "library_folder_id": folder_id, "subscribe_animation": value.subscribe_animation.model_dump()}
        db.save_project(project)
        db.save_job(job, private)
    except sqlite3.Error as exc:
        raise HTTPException(503, "Local project storage is temporarily unavailable. Free disk space and try again.") from exc
    await manager.enqueue(job_id)
    return {"project": project, "job": public_job(job)}


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


@app.put("/api/v1/jobs/{job_id}/clips/{clip_id}/captions", response_model=Job)
async def update_captions(job_id: str, clip_id: str, value: CaptionReviewInput) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    clip = next((item for item in job.clips if item.id == clip_id), None)
    if not clip:
        raise _not_found("Clip")
    if value.revision != clip.caption_revision:
        raise HTTPException(409, "Caption revision is stale")
    duration = clip.duration
    from .captions import normalize_and_validate
    cues, findings = normalize_and_validate([cue.model_dump() for cue in value.cues], duration)
    fatal = [item for item in findings if item["severity"] == "error"]
    if fatal:
        raise HTTPException(422, {"message": "Caption cues are invalid", "issues": fatal})
    clip.caption_cues = [CaptionCue.model_validate(item) for item in cues]
    clip.caption_revision += 1
    clip.caption_qa_warnings = [item["message"] for item in findings if item["severity"] == "warning"]
    clip.review_required = bool(clip.caption_qa_warnings)
    private = db.get_job_private(job_id)
    private.setdefault("caption_overrides", {})[clip_id] = {"revision": clip.caption_revision, "cues": cues}
    db.save_job(job, private)
    return public_job(job)


@app.post("/api/v1/jobs/{job_id}/clips/{clip_id}/captions/rerender", response_model=Job)
async def rerender_captions(job_id: str, clip_id: str, revision: int = Query(..., ge=1)) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
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
    if manager.queue.full():
        raise HTTPException(429, "The local render queue is full")
    private["caption_rerender"] = {"clip_id": clip_id, "revision": revision, "run_id": uuid.uuid4().hex}
    private.pop("caption_rerender_error", None)
    job.state, job.stage, job.stage_label = "queued", "render", f"Caption revision {revision} queued"
    db.save_job(job, private)
    await manager.enqueue(job.id)
    return public_job(job)


@app.get("/api/v1/jobs/{job_id}/clips/{clip_id}/captions/{format}")
async def download_caption(job_id: str, clip_id: str, format: Literal["ass", "srt", "vtt"], expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    job = db.get_job(job_id)
    clip = next((item for item in job.clips if item.id == clip_id), None) if job else None
    if not job or not clip or clip.state != "complete" or not clip.output_name:
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


@app.get("/api/v1/openrouter/models", response_model=list[OpenRouterModel])
async def list_openrouter_models(output_modalities: Annotated[str | None, Query(alias="outputModalities")] = None) -> list[OpenRouterModel]:
    if output_modalities not in {None, "text", "speech"}:
        raise HTTPException(422, "Unsupported OpenRouter output modality")
    try:
        return await profiles.openrouter_models(output_modalities)
    except ProviderError as exc:
        status_code = {"not_configured": 503, "invalid_credentials": 502, "insufficient_balance": 402, "rate_limited": 429, "timeout_offline": 503, "malformed_response": 502, "unsupported_model_or_voice": 422}.get(exc.category, 502)
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


def _public_asset(asset: Asset) -> Asset:
    return asset.model_copy(update={"preview_url": _asset_preview_url(asset)})


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
        return LibraryPurgeResult.model_validate(await manager.purge_library_content())
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


@app.delete("/api/v1/library/assets/{asset_id}", status_code=204)
async def delete_library_asset(asset_id: str) -> None:
    try:
        await _delete_asset_and_cleanup(asset_id)
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
    asset = asset.model_copy(update=update)
    db.save_asset(asset)
    return _public_asset(asset)


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
