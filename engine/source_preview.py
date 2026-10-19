"""Preview stills and titles for sources that are still downloading.

A Library video asset gets its thumbnail from its immutable blob
(`engine/thumbnails.py`). A source that is still downloading has no blob yet, so
the iPhone/iPad status view would show an empty box exactly when the customer is
watching it. yt-dlp already fetches the title (`--write-info-json`) and, when
asked, the poster image (`--write-thumbnail`); this module only turns those
sidecars into one small, safe JPEG next to the work they belong to.

Nothing here feeds the processing pipeline: every failure simply means "no
preview yet", never a failed download.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .media import MediaError, _metadata_text, run

PREVIEW_NAME = "preview.jpg"
_RAW_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_PREVIEW_WIDTH = 640
# A raw still that ffmpeg could not read is retried only after it changes, so a
# corrupt thumbnail never makes every status poll spawn another ffmpeg.
_failed: dict[str, tuple[int, int]] = {}


def read_info_title(source_dir: Path) -> str | None:
    """Title from yt-dlp's info sidecar, normalised like every other import title."""
    try:
        sidecars = sorted(source_dir.glob("source-*.info.json"))
    except OSError:
        return None
    for sidecar in sidecars:
        try:
            payload = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        title = _metadata_text(payload.get("title"), 200) if isinstance(payload, dict) else None
        if title:
            return title
    return None


def _raw_still(source_dir: Path) -> Path | None:
    try:
        stills = [item for item in source_dir.glob("source-*") if item.suffix.casefold() in _RAW_SUFFIXES and item.is_file() and not item.is_symlink() and item.stat().st_size > 0]
    except OSError:
        return None
    return max(stills, key=lambda item: item.stat().st_mtime_ns, default=None)


def _is_jpeg(path: Path) -> bool:
    try:
        with path.open("rb") as image:
            return image.read(2) == b"\xff\xd8"
    except OSError:
        return False


def _encode(command_input: list[str], preview: Path, ffmpeg: str) -> bool:
    temp = preview.with_name(preview.stem + ".tmp.jpg")
    temp.unlink(missing_ok=True)
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *command_input,
               "-frames:v", "1", "-vf", f"scale='min({_PREVIEW_WIDTH},iw)':-2", "-q:v", "4", "-f", "image2", str(temp)]
    try:
        run(command, timeout=20)
        if not temp.is_file() or temp.stat().st_size <= 0 or not _is_jpeg(temp):
            return False
        os.replace(temp, preview)
        return True
    except (MediaError, OSError):
        return False
    finally:
        temp.unlink(missing_ok=True)


def has_preview(preview: Path) -> bool:
    try:
        return preview.is_file() and not preview.is_symlink() and preview.stat().st_size > 0
    except OSError:
        return False


def ensure_preview(source_dir: Path, preview: Path, ffmpeg: str) -> bool:
    """Make `preview` from yt-dlp's raw thumbnail when one has been written.

    Returns whether a preview exists afterwards. Cheap when it already does.
    """
    if has_preview(preview):
        return True
    raw = _raw_still(source_dir) if source_dir.is_dir() else None
    if raw is None:
        return False
    stat = raw.stat()
    fingerprint = (stat.st_mtime_ns, stat.st_size)
    key = str(preview)
    if _failed.get(key) == fingerprint:
        return False
    preview.parent.mkdir(parents=True, exist_ok=True)
    if _encode(["-i", str(raw)], preview, ffmpeg):
        _failed.pop(key, None)
        return True
    _failed[key] = fingerprint
    return False


def frame_preview(video: Path, preview: Path, ffmpeg: str) -> bool:
    """Fallback still from a finished video, for downloads whose poster never arrived."""
    if has_preview(preview):
        return True
    if not video.is_file():
        return False
    preview.parent.mkdir(parents=True, exist_ok=True)
    return _encode(["-ss", "1", "-i", str(video)], preview, ffmpeg) or _encode(["-i", str(video)], preview, ffmpeg)
