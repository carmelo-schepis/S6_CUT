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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from . import __version__
from .config import settings
from .database import Database
from .jobs import JobManager, QueueFullError
from .library import LibraryRules
from .media import MediaError, available, probe, validate_video_upload
from .models import (
    Asset, AssetUpdate, Health, Job, MatchExplanation, ProfileInput, Project,
    ProviderProfile, ScriptJobInput, SelectionInput, now_iso,
)
from .providers import ProfileService
from .security import MediaSigner, SecretVault, confined, safe_filename, validate_youtube_url


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


def _rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    now = time.monotonic()
    bucket = creation_times[client]
    while bucket and bucket[0] < now - 60:
        bucket.popleft()
    if len(bucket) >= 10:
        raise HTTPException(429, "Too many project creations. Wait one minute and try again.")
    bucket.append(now)


def _not_found(kind: str = "Record") -> HTTPException:
    return HTTPException(404, f"{kind} not found")


def _download_url(relative: str) -> str:
    expires, signature = signer.sign(relative)
    return f"/api/v1/files/{relative}?expires={expires}&signature={signature}"


def public_job(job: Job) -> Job:
    result = job.model_copy(deep=True)
    for clip in result.clips:
        if clip.state == "complete" and clip.output_name:
            clip.download_url = _download_url(f"jobs/{job.id}/clips/{clip.output_name}")
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


async def _stream_upload(upload: UploadFile, target: Path, max_bytes: int) -> int:
    temp = target.with_suffix(target.suffix + ".uploading")
    total = 0
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with temp.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(413, "Upload exceeds the configured source-size limit")
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if not total:
            raise HTTPException(422, "Uploaded file is empty")
        os.replace(temp, target)
        return total
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
    count: Annotated[int, Form(ge=1, le=30)] = 5,
    min_duration: Annotated[float, Form(ge=8, le=120)] = 20,
    max_duration: Annotated[float, Form(ge=10, le=180)] = 60,
    aspect_ratio: Annotated[Literal["9:16", "1:1", "16:9"], Form()] = "9:16",
) -> dict[str, object]:
    _rate_limit(request)
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    if bool(file) == bool(url and url.strip()):
        raise HTTPException(422, "Provide exactly one local video or supported YouTube URL")
    if min_duration >= max_duration:
        raise HTTPException(422, "Minimum duration must be shorter than maximum duration")
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    private: dict[str, object] = {"count": count, "min_duration": min_duration, "max_duration": max_duration, "aspect_ratio": aspect_ratio}
    if file:
        original = safe_filename(file.filename or "source.mp4", "source.mp4")
        suffix = Path(original).suffix.casefold()
        if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
            raise HTTPException(415, "Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
        source = settings.data_path / "jobs" / job_id / "source" / f"source{suffix}"
        await _stream_upload(file, source, settings.max_upload_bytes)
        try:
            await asyncio.to_thread(validate_video_upload, source, original, settings)
        except MediaError as exc:
            source.unlink(missing_ok=True)
            raise HTTPException(422, str(exc)) from exc
        private["source_path"] = str(source)
        source_name, source_kind = original, "upload"
    else:
        try:
            private["url"] = validate_youtube_url(str(url))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        source_name, source_kind = "YouTube import", "youtube"
    project = Project(id=project_id, name=Path(source_name).stem[:160], mode="clip", style=style, state="queued", source_name=source_name, source_kind=source_kind, requested_count=count, latest_job_id=job_id)
    job = Job(id=job_id, project_id=project_id, mode="clip", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=style)
    db.save_project(project)
    db.save_job(job, private)
    try:
        await manager.enqueue(job_id)
    except QueueFullError as exc:
        job.state, job.stage, job.stage_label, job.error = "failed", "queue", "Queue full", str(exc)
        manager._save(job)
        raise HTTPException(429, str(exc)) from exc
    return {"project": project, "job": public_job(job)}


@app.post("/api/v1/jobs/script", status_code=status.HTTP_202_ACCEPTED)
async def create_script_job(request: Request, value: ScriptJobInput) -> dict[str, object]:
    _rate_limit(request)
    if manager.queue.full():
        raise HTTPException(429, "The local processing queue is full. Try again after an active job completes.")
    project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    first_line = next((line.strip() for line in value.script.splitlines() if line.strip()), "Script project")
    name = value.name or first_line[:70]
    project = Project(id=project_id, name=name, mode="script", style=value.style, state="queued", source_name=f"{len(value.script)} character script", source_kind="script", requested_count=1, latest_job_id=job_id)
    job = Job(id=job_id, project_id=project_id, mode="script", state="queued", stage="queued", stage_label="Queued on this machine", progress=0, style=value.style)
    private = {"script": value.script, "aspect_ratio": value.aspect_ratio, "narration": value.narration}
    db.save_project(project)
    db.save_job(job, private)
    await manager.enqueue(job_id)
    return {"project": project, "job": public_job(job)}


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
async def job_control(job_id: str, action: Literal["pause", "resume", "stop-keep", "retry-failed"]) -> Job:
    try:
        return public_job(await manager.control(job_id, action))
    except KeyError as exc:
        raise _not_found("Job") from exc
    except QueueFullError as exc:
        raise HTTPException(429, str(exc)) from exc


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
    clip.state, clip.error, job.state, job.stage_label = "queued", None, "queued", "Retrying one failed clip"
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
async def download_file(relative_path: str, expires: int = Query(...), signature: str = Query(...)) -> FileResponse:
    if not (relative_path.startswith("jobs/") or relative_path.startswith("exports/")) or not signer.verify(relative_path, expires, signature):
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
        raise HTTPException(422, str(exc)) from exc


@app.delete("/api/v1/profiles/{profile_id}", status_code=204)
async def remove_profile(profile_id: str) -> None:
    if not db.get_profile(profile_id):
        raise _not_found("Profile")
    profiles.delete(profile_id)


def _csv(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in value.split(",") if item.strip()))[:100]


@app.get("/api/v1/library/assets", response_model=list[Asset])
async def list_assets() -> list[Asset]:
    return db.list_assets()


@app.post("/api/v1/library/assets", response_model=Asset)
async def create_asset(
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=200)],
    tags: Annotated[str, Form()] = "",
    triggers: Annotated[str, Form()] = "",
    policy: Annotated[Literal["required", "prefer", "neutral", "never"], Form()] = "neutral",
    licence: Annotated[str, Form(max_length=500)] = "User supplied",
) -> Asset:
    name = safe_filename(file.filename or "asset", "asset")
    if not (file.content_type or "").startswith(("image/", "video/", "audio/")):
        raise HTTPException(415, "Library files must be an image, video, or audio asset")
    asset_id = str(uuid.uuid4())
    directory = settings.data_path / "library" / asset_id
    target = directory / name
    await _stream_upload(file, target, min(settings.max_upload_bytes, 2_000_000_000))
    digest = await asyncio.to_thread(_hash_file, target)
    existing = db.get_asset_by_hash(digest)
    if existing:
        target.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass
        return existing
    asset = Asset(id=asset_id, title=title, media_type=file.content_type or "application/octet-stream", filename=name, tags=_csv(tags), triggers=_csv(triggers), policy=policy, licence=licence, content_hash=digest)
    db.save_asset(asset)
    return asset


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@app.put("/api/v1/library/assets/{asset_id}", response_model=Asset)
async def update_asset(asset_id: str, value: AssetUpdate) -> Asset:
    asset = db.get_asset(asset_id)
    if not asset:
        raise _not_found("Asset")
    update = value.model_dump(exclude_unset=True)
    asset = asset.model_copy(update=update)
    db.save_asset(asset)
    return asset


@app.get("/api/v1/library/match", response_model=MatchExplanation)
async def match_asset(text: str = Query(min_length=1, max_length=10_000)) -> MatchExplanation:
    return rules.explain(text)


@app.get("/api/v1/storage")
async def storage_diagnostics() -> dict[str, object]:
    usage = shutil.disk_usage(settings.data_path)
    counts = {name: sum(1 for item in (settings.data_path / name).rglob("*") if item.is_file()) for name in ("jobs", "library", "cache", "exports")}
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
