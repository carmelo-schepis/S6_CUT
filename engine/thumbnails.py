from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from pathlib import Path

from .security import confined

TRANSFORM_VERSION = "v1"
_SAMPLE_TIMEOUT_SECONDS = 4
_FRAME_TIMEOUT_SECONDS = 12
_MAX_CONCURRENT = 2
_slots = asyncio.Semaphore(_MAX_CONCURRENT)
_flights: dict[str, asyncio.Task[Path]] = {}


def _is_jpeg(path: Path) -> bool:
    try:
        with path.open("rb") as image:
            return image.read(2) == b"\xff\xd8"
    except OSError:
        return False


def thumbnail_relative(blob_id: str) -> str:
    key = hashlib.sha256(f"{blob_id}\n{TRANSFORM_VERSION}".encode()).hexdigest()
    return f"cache/thumbnails/{TRANSFORM_VERSION}/{key[:2]}/{key}.jpg"


def prune_thumbnails(data_path: Path, retained_blob_ids: set[str]):
    """Remove cached stills that no longer belong to a Library video asset."""
    cache_parent = data_path / "cache"
    cache_path = cache_parent / "thumbnails"
    if cache_parent.is_symlink() or cache_path.is_symlink():
        return 0
    root = confined(data_path, "cache", "thumbnails")
    if not root.is_dir():
        return 0
    retained = {thumbnail_relative(blob_id) for blob_id in retained_blob_ids}
    removed = 0
    for path in root.rglob("*.jpg"):
        if path.name.endswith(".tmp.jpg"):
            continue
        relative = path.relative_to(data_path).as_posix()
        if path.is_symlink() or relative not in retained:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
    await process.wait()


async def _sample_luma(source: Path, point: float, ffmpeg: str) -> int | None:
    """Return a single-pixel, average-luma sample, bounded by a short timeout."""
    process = await asyncio.create_subprocess_exec(
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{point:.3f}",
        "-i", str(source), "-an", "-frames:v", "1", "-vf", "format=gray,scale=1:1:flags=area",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=_SAMPLE_TIMEOUT_SECONDS)
    except TimeoutError:
        await _stop_process(process)
        return None
    except BaseException:
        await _stop_process(process)
        raise
    return output[0] if process.returncode == 0 and output else None


async def _extract(source: Path, target: Path, duration: float | None, ffmpeg: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.stem}.{uuid.uuid4().hex}.tmp.jpg")
    # Probe four deterministic, duration-bounded samples. Prefer the first
    # perceptibly non-black frame; if the whole clip is dark, choose its
    # brightest sample. This handles black intros without making a black source
    # frame prevent thumbnail delivery, and stays safe for sub-second clips.
    upper = max(0.0, (duration or 3.0) - min(0.08, (duration or 3.0) / 4))
    points = sorted({min(upper, max(0.0, value)) for value in (0.5, upper * 0.12, upper * 0.4, upper * 0.75)})
    try:
        async with _slots:
            samples = [(await _sample_luma(source, point, ffmpeg), point) for point in points]
            usable = [(luma, point) for luma, point in samples if luma is not None]
            if not usable:
                raise RuntimeError("Could not decode a video frame for its thumbnail")
            representative = next((point for luma, point in usable if luma >= 18), max(usable)[1])
            proc = await asyncio.create_subprocess_exec(
                ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{representative:.3f}",
                "-i", str(source), "-an", "-frames:v", "1", "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black,format=yuvj420p",
                "-q:v", "4", "-y", str(temp), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=_FRAME_TIMEOUT_SECONDS)
            except TimeoutError:
                await _stop_process(proc)
                raise RuntimeError("Thumbnail frame extraction timed out")
            except BaseException:
                await _stop_process(proc)
                raise
            if proc.returncode != 0 or not temp.is_file() or temp.stat().st_size < 4 or not _is_jpeg(temp):
                raise RuntimeError("Could not extract a video thumbnail")
            os.replace(temp, target)
            return target
    finally:
        temp.unlink(missing_ok=True)


async def get_thumbnail(data_path: Path, blob_id: str, source_relative: str, duration: float | None, ffmpeg: str) -> Path:
    relative = thumbnail_relative(blob_id)
    target = confined(data_path, *relative.split("/"))
    if target.is_file() and target.stat().st_size >= 4 and _is_jpeg(target):
        return target
    task = _flights.get(relative)
    if task is None:
        source = confined(data_path, *source_relative.split("/"))
        task = asyncio.create_task(_extract(source, target, duration, ffmpeg))
        _flights[relative] = task
    try:
        return await task
    finally:
        if task.done() and _flights.get(relative) is task:
            _flights.pop(relative, None)
