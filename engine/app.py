from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import shutil
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, AsyncIterator, Literal

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .config import settings
from .database import Database, MAX_FOLDER_DEPTH, UNSORTED_FOLDER_ID
from .jobs import JobManager, QueueFullError, SwitchFastError
from .library import LibraryRules
from .media import MediaError, available, probe, validate_video_upload
from .models import (
    Asset, AssetMove, AssetOrigin, AssetUpdate, Clip, FolderCreate, FolderMove, FolderUpdate, Health, Job,
    LibraryFolder, MatchExplanation, ProcessingMode, ProfileInput, Project, ProjectFolderUpdate,
    ProviderProfile, ScriptJobInput, SelectionInput, TopicBeat, TopicVideoInput, TopicVideoPlan, now_iso,
)
from .providers import ProfileService
from .security import MediaSigner, SecretVault, confined, safe_filename, validate_youtube_url


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
# signed URLs, confined paths, rate-limited creation, camelCase API contract with frontend


settings.prepare()
db = Database(settings.data_path / "s6-cut.sqlite3")
vault = SecretVault(settings.data_path / "secrets" / "instance.key")
signer = MediaSigner(settings.data_path / "secrets" / "media-signing.key", settings.media_url_ttl)
rules = LibraryRules(db, settings.data_path / "library")
profiles = ProfileService(db, vault)
manager = JobManager(db, rules, profiles, settings)
creation_times: defaultdict[str, deque[float]] = defaultdict(deque)


@asynccontextmanager
async def lifespan(_: FastAPI):
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


# DO-NOT-CHANGE: signs f"jobs/{relative}" or f"exports/{relative}" — only these prefixes
# are allowed in download_file; never expose raw paths
def _download_url(relative: str) -> str:
    expires, signature = signer.sign(relative)
    return f"/api/v1/files/{relative}?expires={expires}&signature={signature}"


# DO-NOT-CHANGE: hides unpublished clips (rendering state), clears download_url for
# incomplete clips, only signs URLs for complete clip outputs
def public_job(job: Job) -> Job:
    result = job.model_copy(deep=True)
    for clip in result.clips:
        if clip.state == "complete" and not clip.library_asset_id:
            clip.state = "rendering"
            clip.selected = False
            clip.error = "Publication repair required before this output is ready"
        if clip.state == "complete" and clip.output_name:
            clip.download_url = _download_url(f"jobs/{job.id}/clips/{clip.output_name}")
            clip.preview_url = clip.download_url
    return result


def runtime_health() -> Health:
    ffmpeg = available(settings.ffmpeg)
    ffprobe = available(settings.ffprobe)
    whisper = importlib.util.find_spec("faster_whisper") is not None
    database = settings.data_path.joinpath("s6-cut.sqlite3").exists()
    return Health(
        status="ready" if ffmpeg and ffprobe and whisper and database else "degraded",
        version=__version__, database=database, ffmpeg=ffmpeg, ffprobe=ffprobe, whisper=whisper,
        ytdlp=available(settings.ytdlp), local_tts=available(settings.local_tts),
        data_path="/app/data" if str(settings.data_path).startswith("/app/") else "Local mounted data directory",
        free_bytes=shutil.disk_usage(settings.data_path).free, active_workers=manager.active_workers,
        queued_jobs=manager.queue.qsize(),
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
async def delete_project(project_id: str) -> None:
    try:
        db.delete_project(project_id)
    except KeyError as exc:
        raise _not_found("Project") from exc


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
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
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
    finally:
        await upload.close()
        if temp.exists():
            temp.unlink(missing_ok=True)


@app.post("/api/v1/jobs/clip", status_code=status.HTTP_202_ACCEPTED)
async def create_clip_job(
    request: Request,
    file: Annotated[UploadFile | None, File()] = None,
    url: Annotated[str | None, Form()] = None,
    style: Annotated[Literal["funny", "serious", "educational", "hype"], Form()] = "educational",
    processing_mode: Annotated[Literal["fast", "smart", "auto"], Form()] = "auto",
    count: Annotated[int, Form(ge=1, le=30)] = 5,
    min_duration: Annotated[float, Form(ge=8, le=120)] = 20,
    max_duration: Annotated[float, Form(ge=10, le=180)] = 60,
    aspect_ratio: Annotated[Literal["9:16", "1:1", "16:9"], Form()] = "9:16",
    library_folder_id: Annotated[str, Form()] = UNSORTED_FOLDER_ID,
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
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    smart_available = profiles.smart_available()
    mode = resolve_processing_mode(processing_mode, smart_available)
    private: dict[str, object] = {
        "count": count, "min_duration": min_duration, "max_duration": max_duration,
        "aspect_ratio": aspect_ratio, "processing_mode": mode,
        "use_openrouter": mode == "smart" and smart_available,
        "library_folder_id": library_folder_id,
    }
    if file:
        original = safe_filename(file.filename or "source.mp4", "source.mp4")
        suffix = Path(original).suffix.casefold()
        if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
            raise HTTPException(415, "Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
        source = settings.data_path / "jobs" / job_id / "source" / f"source{suffix}"
        _, source_hash = await _stream_upload(file, source, settings.max_upload_bytes)
        try:
            source_metadata = await asyncio.to_thread(validate_video_upload, source, original, settings)
        except MediaError as exc:
            source.unlink(missing_ok=True)
            raise HTTPException(422, str(exc)) from exc
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
    project = Project(id=project_id, name=Path(source_name).stem[:160], mode="clip", style=style, state="queued", source_name=source_name, source_kind=source_kind, requested_count=count, latest_job_id=job_id, library_folder_id=library_folder_id)
    steps = manager._fast_steps() if mode == "fast" else manager._smart_steps(bool(private["use_openrouter"]))
    if source_kind == "upload":
        checkpoint_time = now_iso()
        steps[0].status, steps[0].detail = "complete", "Upload atomically stored"
        steps[0].started_at = steps[0].completed_at = checkpoint_time
        if isinstance(source_metadata, dict):
            steps[1].status = "complete"
            steps[1].detail = f"Source validated - {float(source_metadata['duration']):.1f}s"
            steps[1].started_at = steps[1].completed_at = checkpoint_time
    job = Job(id=job_id, project_id=project_id, library_folder_id=library_folder_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=style, processing_mode=mode, steps=steps)
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
async def create_shorts_job(request: Request, value: dict[str, object]) -> dict[str, object]:
    _rate_limit(request)
    asset_id = str(value.get("assetId") or "")
    asset = db.get_asset(asset_id)
    if not asset or not asset.media_type.startswith("video/"):
        raise HTTPException(422, "Select an authorised Library video")
    relative = db.blob_relative_path(asset.blob_id)
    if not relative:
        raise _not_found("Media blob")
    source = confined(settings.data_path, *relative.split("/"))
    metadata = await asyncio.to_thread(probe, source, settings)
    start, end = float(value.get("start", 0)), float(value.get("end", metadata["duration"]))
    if end <= start or end > float(metadata["duration"]):
        raise HTTPException(422, "Invalid trim bounds")
    folder_id = str(value.get("libraryFolderId") or UNSORTED_FOLDER_ID)
    if not db.get_folder(folder_id):
        raise _not_found("Library folder")
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    project = Project(id=project_id, name=f"Short — {asset.title}"[:160], mode="clip", style="educational", state="queued", source_name=asset.filename, source_kind="upload", requested_count=1, latest_job_id=job_id, library_folder_id=folder_id)
    clip = Clip(id=str(uuid.uuid4()), index=1, state="queued", start=start, end=end, duration=end-start, opening_line="Shorts Editor cut")
    job = Job(id=job_id, project_id=project_id, library_folder_id=folder_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style="educational", processing_mode="fast", clips=[clip], total_items=1, steps=manager._fast_steps())
    private = {"source_path": str(source), "source_hash": asset.content_hash, "source_metadata": metadata, "aspect_ratio": str(value.get("aspectRatio") or "9:16"), "count": 1, "min_duration": end-start, "max_duration": end-start, "processing_mode": "fast", "library_folder_id": folder_id}
    db.save_project(project); db.save_job(job, private); await manager.enqueue(job_id)
    return {"project": project, "job": public_job(job)}


@app.post("/api/v1/ai/topic-plan", response_model=TopicVideoPlan)
async def topic_plan(value: TopicVideoInput) -> TopicVideoPlan:
    if value.custom_script.strip():
        narration = value.custom_script.strip()
        words = narration.split()
        chunk = max(1, len(words) // 6)
        beats = [TopicBeat(narration=" ".join(words[index:index + chunk]), seconds=max(1, value.duration_seconds / max(1, (len(words) + chunk - 1) // chunk)), keywords=[value.topic]) for index in range(0, len(words), chunk)][:30]
        return TopicVideoPlan(title=value.topic[:200], hook=words[0][:500], narration=narration, beats=beats, estimated_duration=value.duration_seconds)
    if not profiles.smart_available():
        raise HTTPException(503, "Configure a selected OpenRouter-compatible provider or enter a custom script.")
    schema = {"type": "object", "additionalProperties": False, "properties": {"title": {"type": "string"}, "hook": {"type": "string"}, "narration": {"type": "string"}, "beats": {"type": "array", "items": {"type": "object", "additionalProperties": False, "properties": {"narration": {"type": "string"}, "seconds": {"type": "number"}, "keywords": {"type": "array", "items": {"type": "string"}}}, "required": ["narration", "seconds", "keywords"]}}, "estimated_duration": {"type": "number"}, "description": {"type": "string"}, "hashtags": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "hook", "narration", "beats", "estimated_duration", "description", "hashtags"]}
    prompt = f"Create a concise video plan in {value.language} about {value.topic!r}. Audience: {value.audience}. Tone: {value.tone}. Target seconds: {value.duration_seconds}. CTA: {value.call_to_action}. Extra instructions: {value.instructions}. Return only JSON matching the schema; use local-library visual keywords and never claim licensing."
    try:
        result = await profiles.openrouter_json([{"role": "user", "content": prompt}], schema)
    except Exception as exc:
        raise HTTPException(502, "The configured script provider could not generate a validated plan") from exc
    if not result:
        raise HTTPException(503, "No selected script provider is available. Enter a custom script or configure a provider.")
    try:
        return TopicVideoPlan.model_validate(result)
    except Exception as exc:
        raise HTTPException(502, "The script provider returned an invalid plan. Try again or use a custom script.") from exc


@app.post("/api/v1/jobs/script", status_code=status.HTTP_202_ACCEPTED)
async def create_script_job(request: Request, value: ScriptJobInput) -> dict[str, object]:
    _rate_limit(request)
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    folder_id = value.library_folder_id or UNSORTED_FOLDER_ID
    selected_folder = db.get_folder(folder_id)
    if not selected_folder:
        raise _not_found("Library folder")
    if selected_folder.archived:
        raise HTTPException(409, "Archived folders cannot receive new projects")
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    first_line = next((line.strip() for line in value.script.splitlines() if line.strip()), "Script project")
    name = value.name or first_line[:70]
    project = Project(id=project_id, name=name, mode="script", style=value.style, state="queued", source_name=f"{len(value.script)} character script", source_kind="script", requested_count=1, latest_job_id=job_id, library_folder_id=folder_id)
    job = Job(id=job_id, project_id=project_id, library_folder_id=folder_id, mode="script", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=value.style, steps=manager._script_steps())
    private = {"script": value.script, "aspect_ratio": value.aspect_ratio, "narration": value.narration, "library_folder_id": folder_id}
    db.save_project(project)
    db.save_job(job, private)
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
    return [public_job(job) for job in db.list_jobs()]


@app.get("/api/v1/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str) -> Job:
    job = db.get_job(job_id)
    if not job:
        raise _not_found("Job")
    return public_job(job)


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
async def job_control(job_id: str, action: Literal["pause", "resume", "stop-keep", "retry-failed", "switch-fast"]) -> Job:
    try:
        return public_job(await manager.control(job_id, action))
    except KeyError as exc:
        raise _not_found("Job") from exc
    except QueueFullError as exc:
        raise HTTPException(429, str(exc)) from exc
    except SwitchFastError as exc:
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
async def download_file(relative_path: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    if not relative_path.startswith(("jobs/", "exports/")) or not signer.verify(relative_path, expires, signature):
        raise HTTPException(403, "Download link is invalid or expired")
    try:
        target = confined(settings.data_path, *relative_path.split("/"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid download path") from exc
    if not target.is_file():
        raise _not_found("File")
    return FileResponse(target, filename=safe_filename(target.name, "s6-cut-download"), media_type="application/zip" if target.suffix == ".zip" else "video/mp4")


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
def _public_asset(asset: Asset) -> Asset:
    token = f"library-asset:{asset.id}:{asset.blob_id}"
    expires, signature = signer.sign(token)
    return asset.model_copy(update={"preview_url": f"/api/v1/library/assets/{asset.id}/preview?expires={expires}&signature={signature}"})


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


@app.get("/api/v1/library/assets", response_model=list[Asset])
async def list_assets(folder_id: str | None = None, media_type: str | None = None, origin: AssetOrigin | None = None, search: str | None = Query(default=None, max_length=500), include_archived: bool = False) -> list[Asset]:
    if folder_id and not db.get_folder(folder_id):
        raise _not_found("Folder")
    return [_public_asset(asset) for asset in db.list_assets(folder_id=folder_id, media_type=media_type, origin=origin, search=search, include_archived=include_archived)]


@app.post("/api/v1/library/assets/move", response_model=dict[str, int])
async def move_library_assets(value: AssetMove) -> dict[str, int]:
    try:
        return {"moved": db.move_assets(value.asset_ids, value.folder_id)}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


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
    return FileResponse(target, filename=safe_filename(asset.filename, "library-media"), media_type=asset.media_type)


@app.delete("/api/v1/library/assets/{asset_id}", status_code=204)
async def delete_library_asset(asset_id: str) -> None:
    try:
        db.delete_asset(asset_id)
    except KeyError as exc:
        raise _not_found("Asset") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


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
    usage = shutil.disk_usage(settings.data_path)
    counts = {name: sum(1 for item in (settings.data_path / name).rglob("*") if item.is_file()) for name in ("jobs", "blobs", "library", "cache", "exports")}
    return {"freeBytes": usage.free, "totalBytes": usage.total, "files": counts, "retentionDays": settings.retention_days, "maxRetainedJobs": settings.max_retained_jobs}


@app.post("/api/v1/storage/cleanup")
async def cleanup_temporary_files() -> dict[str, int]:
    cutoff = time.time() - 24 * 3600
    removed = 0
    for root in (settings.data_path / "temp", settings.data_path / "jobs"):
        for path in root.rglob("*.partial.*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
    return {"removedTemporaryFiles": removed}
