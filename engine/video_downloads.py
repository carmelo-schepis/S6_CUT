from __future__ import annotations

import asyncio
import json
import math
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from pydantic import Field

from .config import Settings
from .media import MediaError, download_youtube, probe, run
from .models import ApiModel, now_iso
from .security import MediaSigner, confined, redact, safe_filename, validate_youtube_url
from .source_preview import PREVIEW_NAME, ensure_preview, frame_preview, has_preview, read_info_title


class VideoDownloadTask(ApiModel):
    id: str
    url: str
    state: str
    phase: str
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    percent: float | None = None
    message: str | None = None
    filename: str | None = None
    download_url: str | None = None
    error: str | None = None
    # Read from yt-dlp's own metadata while the download runs. The signed poster
    # link is attached per response (like `download_url`) and never persisted.
    title: str | None = None
    thumbnail_url: str | None = None
    created_at: str
    updated_at: str


class VideoDownloadInput(ApiModel):
    url: str = Field(min_length=1, max_length=2048)


def _probe_container(path: Path, settings: Settings) -> tuple[dict[str, Any], str]:
    result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    try:
        payload = json.loads(result.stdout)
        container = str(payload.get("format", {}).get("format_name", ""))
        if not payload.get("format"):
            raise ValueError("missing format")
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe could not verify the prepared MP4 container") from exc
    return payload, container


def prepare_video_mp4(source: Path, destination: Path, settings: Settings) -> dict[str, Any]:
    """Prepare an unpublished, genuine MP4 while retaining the complete source.

    Try stream-copy first (including audio); if the audio codec is not accepted
    by MP4, transcode audio only. A final H.264/AAC fallback handles video codecs
    that cannot be muxed into MP4. The source is never modified.
    """
    original = probe(source, settings, max_seconds=settings.max_long_source_seconds)
    if not math.isfinite(original["duration"]) or original["duration"] <= 0:
        raise MediaError("FFprobe did not report a finite, positive source duration")
    if original["width"] <= 0 or original["height"] <= 0:
        raise MediaError("FFprobe did not report valid source dimensions")
    partial = destination.with_name(destination.stem + ".partial.mp4")
    partial.unlink(missing_ok=True)
    attempts = [
        ["-c:v", "copy", "-c:a", "copy"],
        ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
        ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k"],
    ]
    last_error = "The downloaded format could not be prepared as MP4"
    try:
        for codecs in attempts:
            partial.unlink(missing_ok=True)
            command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn", *codecs, "-movflags", "+faststart", "-f", "mp4", str(partial)]
            try:
                run(command, timeout=3600)
            except MediaError as exc:
                last_error = str(exc)
                continue
            if partial.is_file() and partial.stat().st_size > 0:
                try:
                    checked, container = _probe_container(partial, settings)
                    streams = checked.get("streams", [])
                    video = next((item for item in streams if item.get("codec_type") == "video"), None)
                    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
                    duration = float(checked.get("format", {}).get("duration") or (video or {}).get("duration") or 0)
                    format_names = set(container.split(","))
                    if "mp4" not in format_names or not video:
                        raise MediaError("FFprobe did not find a valid MP4 video stream")
                    if not math.isfinite(duration) or duration <= 0:
                        raise MediaError("FFprobe did not report a finite, positive MP4 duration")
                    if int(video.get("width") or 0) != original["width"] or int(video.get("height") or 0) != original["height"]:
                        raise MediaError("MP4 preparation changed the source video dimensions")
                    if abs(duration - original["duration"]) > max(1.0, original["duration"] * 0.005):
                        raise MediaError("MP4 preparation did not retain the complete source duration")
                    if original["audio"] and not audio:
                        raise MediaError("MP4 preparation did not retain the source audio")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(partial, destination)
                    return probe(destination, settings, max_seconds=settings.max_long_source_seconds)
                except (MediaError, OSError, ValueError) as exc:
                    last_error = str(exc)
                    # Structural loss (duration/dimensions/audio) is not repaired
                    # by another encoding attempt; only container/codec issues are.
                    if any(text in last_error for text in ("dimensions", "complete source duration", "finite")):
                        raise
            else:
                last_error = "FFmpeg did not produce a non-empty MP4 file"
        raise MediaError(f"Unable to prepare this source as MP4. Try another YouTube video or format. ({last_error})")
    finally:
        partial.unlink(missing_ok=True)


class VideoDownloadManager:
    def __init__(self, settings: Settings, signer: MediaSigner, max_pending: int = 3):
        self.settings = settings
        self.signer = signer
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=max_pending)
        self.tasks: dict[str, VideoDownloadTask] = {}
        self.workers: list[asyncio.Task] = []
        self.lock = threading.RLock()
        self.root = confined(settings.data_path, "exports", "video-downloads")

    async def start(self):
        self.root.mkdir(parents=True, exist_ok=True)
        for folder in self.root.iterdir():
            if not folder.is_dir() or not re.fullmatch(r"[0-9a-f]{32}", folder.name):
                continue
            try:
                state_path = confined(self.settings.data_path, "exports", "video-downloads", folder.name, "state.json")
            except ValueError:
                continue
            if not state_path.is_file():
                continue
            try:
                task = VideoDownloadTask.model_validate_json(state_path.read_text(encoding="utf-8"))
                if task.id != folder.name:
                    continue
            except (OSError, ValueError):
                continue
            if task.state in {"queued", "active"}:
                # A crash after atomically publishing the validated file but before
                # persisting the complete state is recoverable without another fetch.
                recovered_file = confined(self.settings.data_path, "exports", "video-downloads", folder.name, "youtube-video.mp4")
                if self._is_valid_final(recovered_file):
                    expires, signature = self.signer.sign(recovered_file.relative_to(self.settings.data_path).as_posix())
                    task = task.model_copy(update={"state": "complete", "phase": "complete", "filename": recovered_file.name, "download_url": f"/api/v1/files/{recovered_file.relative_to(self.settings.data_path).as_posix()}?expires={expires}&signature={signature}", "percent": 100.0, "message": "MP4 ready", "error": None, "updated_at": now_iso()})
                else:
                    recovered_file.unlink(missing_ok=True)
                    task = task.model_copy(update={"state": "failed", "phase": "failed", "filename": None, "download_url": None, "error": "The engine restarted before this download finished.", "message": "Download interrupted. Start a new download to retry.", "updated_at": now_iso()})
                self._persist(task)
            elif task.state == "complete":
                try:
                    final = self._final_file(task)
                except ValueError:
                    final = confined(self.settings.data_path, "exports", "video-downloads", folder.name, "missing.mp4")
                if not self._is_valid_final(final):
                    task = task.model_copy(update={"state": "failed", "phase": "failed", "filename": None, "download_url": None, "error": "The completed MP4 is no longer available or is invalid.", "message": "Download unavailable. Start a new download to retry.", "updated_at": now_iso()})
                    self._persist(task)
            self.tasks[task.id] = task
        self._prune_retained(keep_slots=0)
        self.workers = [asyncio.create_task(self._worker())]

    async def stop(self):
        for worker in self.workers:
            worker.cancel()
        await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers.clear()

    def _directory(self, task_id: str) -> Path:
        return confined(self.settings.data_path, "exports", "video-downloads", task_id)

    def _final_file(self, task: VideoDownloadTask) -> Path:
        if not task.filename or safe_filename(task.filename, "") != task.filename or not task.filename.endswith(".mp4"):
            raise ValueError("Invalid stored filename")
        return confined(self._directory(task.id), task.filename)

    def _is_valid_final(self, path: Path) -> bool:
        try:
            if not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > self.settings.max_upload_bytes:
                return False
            _, container = _probe_container(path, self.settings)
            metadata = probe(path, self.settings, max_seconds=self.settings.max_long_source_seconds)
            return "mp4" in container.split(",") and math.isfinite(metadata["duration"]) and metadata["duration"] > 0 and metadata["width"] > 0 and metadata["height"] > 0
        except (MediaError, OSError, ValueError):
            return False

    def _prune_retained(self, *, keep_slots: int = 0):
        maximum = max(5, min(self.settings.max_retained_jobs, 100))
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.settings.retention_days)
        terminal = sorted((task for task in self.tasks.values() if task.state in {"complete", "failed"}), key=lambda item: item.created_at)
        for task in terminal:
            try:
                created = datetime.fromisoformat(task.created_at.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                created = datetime.min.replace(tzinfo=timezone.utc)
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created < cutoff or len(self.tasks) + keep_slots > maximum:
                shutil.rmtree(self._directory(task.id), ignore_errors=True)
                self.tasks.pop(task.id, None)

    def mark_unavailable(self, task_id: str):
        with self.lock:
            task = self.tasks.get(task_id)
            if task is None:
                return None
            failed = task.model_copy(update={"state": "failed", "phase": "failed", "filename": None, "download_url": None, "error": "The downloaded MP4 is no longer available.", "message": "Download unavailable. Start a new download to retry.", "updated_at": now_iso()})
            self.tasks[task_id] = failed
            self._persist(failed)
            return failed

    def _persist(self, task: VideoDownloadTask):
        directory = self._directory(task.id)
        directory.mkdir(parents=True, exist_ok=True)
        temp = confined(directory, "state.json.tmp")
        target = confined(directory, "state.json")
        with temp.open("w", encoding="utf-8") as stream:
            stream.write(task.model_dump_json(by_alias=True))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)

    def _update(self, task_id: str, **values: Any):
        with self.lock:
            task = self.tasks[task_id].model_copy(update={**values, "updated_at": now_iso()})
            self.tasks[task_id] = task
            self._persist(task)

    def get(self, task_id: str):
        with self.lock:
            return self.tasks.get(task_id)

    def preview_path(self, task_id: str) -> Path:
        return confined(self._directory(task_id), PREVIEW_NAME)

    def has_preview(self, task_id: str) -> bool:
        try:
            return has_preview(self.preview_path(task_id))
        except ValueError:
            return False

    def list(self):
        with self.lock:
            return sorted(self.tasks.values(), key=lambda task: (task.created_at, task.id), reverse=True)

    async def create(self, raw_url: str):
        url = await asyncio.to_thread(validate_youtube_url, raw_url)
        with self.lock:
            self._prune_retained(keep_slots=1)
            for existing in self.tasks.values():
                if existing.url == url and existing.state in {"queued", "active", "complete"}:
                    return existing, False
            if len(self.tasks) >= max(5, min(self.settings.max_retained_jobs, 100)):
                raise OverflowError("Download history is full. Remove older downloads before starting another.")
            if self.queue.full():
                raise OverflowError("The video download queue is full. Wait for a download to finish and try again.")
            task_id = uuid.uuid4().hex
            now = now_iso()
            task = VideoDownloadTask(id=task_id, url=url, state="queued", phase="queued", message="Waiting to download", created_at=now, updated_at=now)
            self.tasks[task_id] = task
            self._persist(task)
            self.queue.put_nowait(task_id)
            return task, True

    async def _worker(self):
        while True:
            task_id = await self.queue.get()
            try:
                await asyncio.to_thread(self._run, task_id)
            finally:
                self.queue.task_done()

    def _run(self, task_id: str):
        task = self.get(task_id)
        if task is None:
            return
        directory = self._directory(task_id)
        self._update(task_id, state="active", phase="connecting", message="Connecting to YouTube", error=None)

        source_dir = confined(directory, "source")
        preview = confined(directory, PREVIEW_NAME)
        last_capture = 0.0
        capture_lock = threading.Lock()

        def capture(force: bool = False):
            """Title and poster appear before the first byte; pick them up once."""
            nonlocal last_capture
            with capture_lock:
                now = time.monotonic()
                if not force and now - last_capture < 1.0:
                    return
                last_capture = now
                current = self.get(task_id)
                if current is None:
                    return
                if not current.title:
                    title = read_info_title(source_dir)
                    if title:
                        self._update(task_id, title=title)
                ensure_preview(source_dir, preview, self.settings.ffmpeg)

        # yt-dlp prints nothing while it prepares the download, which can take a
        # minute, yet it writes the title and poster as soon as it has them. A
        # watcher makes them visible then instead of at the first progress line.
        finished = threading.Event()

        def watch():
            while not finished.wait(1.0):
                try:
                    capture()
                except Exception:  # a status preview must never disturb the download
                    pass

        threading.Thread(target=watch, name=f"video-download-preview-{task_id[:8]}", daemon=True).start()

        def progress(value: dict[str, Any]):
            capture()
            phase = value.get("phase", "downloading")
            message = value.get("message")
            if phase == "complete":
                phase = "preparing"
                message = "Preparing MP4"
            self._update(task_id, phase=phase, downloaded_bytes=value.get("downloaded_bytes", 0), total_bytes=value.get("total_bytes"), percent=value.get("percent"), message=message)

        try:
            source = download_youtube(task.url, source_dir, self.settings, progress_callback=progress, max_seconds=self.settings.max_long_source_seconds, write_thumbnail=True)
            capture(force=True)
            self._update(task_id, phase="preparing", percent=None, message="Preparing MP4")
            filename = safe_filename("youtube-video.mp4", "video.mp4")
            final = confined(directory, filename)
            prepare_video_mp4(source, final, self.settings)
            if not final.is_file() or final.stat().st_size <= 0 or final.stat().st_size > self.settings.max_upload_bytes:
                final.unlink(missing_ok=True)
                raise MediaError("Prepared MP4 is empty or exceeds the configured media size limit")
            if not has_preview(preview):
                frame_preview(final, preview, self.settings.ffmpeg)
            relative = final.relative_to(self.settings.data_path).as_posix()
            expires, signature = self.signer.sign(relative)
            url = f"/api/v1/files/{relative}?expires={expires}&signature={signature}"
            self._update(task_id, state="complete", phase="complete", downloaded_bytes=final.stat().st_size, total_bytes=final.stat().st_size, percent=100.0, filename=filename, download_url=url, message="MP4 ready", error=None)
        except Exception as exc:
            with self.lock:
                current = self.tasks[task_id]
                if current.filename:
                    self._final_file(current).unlink(missing_ok=True)
                confined(directory, "youtube-video.mp4").unlink(missing_ok=True)
            message = redact(str(exc)).replace(str(self.settings.data_path), "media storage")
            message = message.replace(str(directory), "download workspace")
            self._update(task_id, state="failed", phase="failed", filename=None, download_url=None, error=message[:500], message="MP4 download failed. You can retry.")
        finally:
            finished.set()
