from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path
import pytest

from engine import thumbnails


@pytest.fixture(autouse=True)
def clear_inflight_tasks():
    thumbnails._flights.clear()
    yield
    thumbnails._flights.clear()


def test_thumbnail_extraction_is_real_jpeg_and_reuses_cache(tmp_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("real FFmpeg thumbnail extraction requires ffmpeg")
    source = tmp_path / "portrait.mp4"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=0xD02020:s=360x640:r=24:d=1.2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source),
    ], check=True)
    relative_source = "blobs/source.mp4"
    source_path = tmp_path / relative_source
    source_path.parent.mkdir(parents=True)
    source.replace(source_path)

    target = asyncio.run(thumbnails.get_thumbnail(tmp_path, "a" * 64, relative_source, 1.2, ffmpeg))
    assert target.is_file()
    image = target.read_bytes()
    assert image[:2] == b"\xff\xd8"
    assert len(image) >= 4
    first_mtime = target.stat().st_mtime_ns
    again = asyncio.run(thumbnails.get_thumbnail(tmp_path, "a" * 64, relative_source, 1.2, ffmpeg))
    assert again == target
    assert again.stat().st_mtime_ns == first_mtime
    assert not list(target.parent.glob("*.tmp.jpg"))


def test_extraction_publishes_only_complete_temp_file(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "cache" / "still.jpg"
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    observations: list[bool] = []

    class FakeProcess:
        returncode = 0

        def __init__(self, command):
            self.command = command

        async def communicate(self):
            return b"\x80", b""

        async def wait(self):
            temporary = Path(self.command[-1])
            temporary.write_bytes(b"\xff\xd8" + b"complete-frame" * 100)
            observations.append(target.exists())
            return 0

    captured: list[tuple[str, ...]] = []

    async def create_process(*command, **_kwargs):
        captured.append(command)
        return FakeProcess(command)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)
    result = asyncio.run(thumbnails._extract(source, target, 1, "ffmpeg"))
    assert result == target
    assert observations == [False]
    assert target.read_bytes().startswith(b"\xff\xd8")
    assert not list(target.parent.glob("*.tmp.jpg"))


def test_thumbnail_requests_share_one_inflight_extraction(tmp_path: Path, monkeypatch) -> None:
    started = 0
    release = asyncio.Event()

    async def fake_extract(source: Path, target: Path, duration: float | None, ffmpeg: str) -> Path:
        nonlocal started
        started += 1
        await release.wait()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\xff\xd8" + b"x" * 1100)
        return target

    monkeypatch.setattr(thumbnails, "_extract", fake_extract)

    async def run():
        first = asyncio.create_task(thumbnails.get_thumbnail(tmp_path, "b" * 64, "blobs/source.mp4", 2, "ffmpeg"))
        await asyncio.sleep(0)
        second = asyncio.create_task(thumbnails.get_thumbnail(tmp_path, "b" * 64, "blobs/source.mp4", 2, "ffmpeg"))
        await asyncio.sleep(0)
        assert started == 1
        release.set()
        a, b = await asyncio.gather(first, second)
        assert a == b
        assert started == 1
        assert not thumbnails._flights

    asyncio.run(run())


def test_thumbnail_cache_identity_is_blob_and_transform_scoped() -> None:
    first = thumbnails.thumbnail_relative("1" * 64)
    second = thumbnails.thumbnail_relative("2" * 64)
    assert first.startswith("cache/thumbnails/v1/")
    assert first.endswith(".jpg")
    assert first != second


def test_prune_removes_cached_stills_without_a_library_video(tmp_path: Path) -> None:
    retained = tmp_path / thumbnails.thumbnail_relative("1" * 64)
    orphaned = tmp_path / thumbnails.thumbnail_relative("2" * 64)
    retained.parent.mkdir(parents=True)
    orphaned.parent.mkdir(parents=True)
    retained.write_bytes(b"retained")
    orphaned.write_bytes(b"orphaned")

    removed = thumbnails.prune_thumbnails(tmp_path, {"1" * 64})

    assert removed == 1
    assert retained.is_file()
    assert not orphaned.exists()


def test_prune_preserves_inflight_thumbnail_temp_files(tmp_path: Path) -> None:
    temporary = tmp_path / "cache" / "thumbnails" / "v1" / "ab" / ".abc123.uuid.tmp.jpg"
    orphaned = tmp_path / "cache" / "thumbnails" / "v1" / "ab" / "orphan.jpg"
    temporary.parent.mkdir(parents=True)
    temporary.write_bytes(b"partial")
    orphaned.write_bytes(b"orphan")

    removed = thumbnails.prune_thumbnails(tmp_path, set())

    assert removed == 1
    assert temporary.is_file()
    assert not orphaned.exists()


def test_cancelling_thumbnail_sample_kills_and_reaps_ffmpeg(monkeypatch) -> None:
    class FakeProcess:
        returncode = None
        killed = False
        waited = False

        async def communicate(self):
            await asyncio.Event().wait()

        def kill(self):
            self.killed = True
            self.returncode = -9

        async def wait(self):
            self.waited = True
            return self.returncode

    process = FakeProcess()

    async def create_process(*_args, **_kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)

    async def run():
        task = asyncio.create_task(thumbnails._sample_luma(Path("source.mp4"), 0, "ffmpeg"))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert process.killed
    assert process.waited


def test_prune_does_not_follow_thumbnail_cache_symlink(tmp_path: Path) -> None:
    outside_cache = tmp_path / "other-cache"
    outside_cache.mkdir()
    image = outside_cache / "keep.jpg"
    image.write_bytes(b"do not remove")
    (tmp_path / "cache").mkdir()
    (tmp_path / "cache" / "thumbnails").symlink_to(outside_cache, target_is_directory=True)

    assert thumbnails.prune_thumbnails(tmp_path, set()) == 0
    assert image.is_file()


def test_thumbnail_source_and_cache_paths_are_confined(tmp_path: Path, monkeypatch) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (tmp_path / "blobs").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="escapes"):
        asyncio.run(thumbnails.get_thumbnail(tmp_path, "c" * 64, "blobs/source.mp4", 2, "ffmpeg"))
