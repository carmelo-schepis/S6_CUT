from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import time
from dataclasses import replace
from pathlib import Path

import pytest

from engine.config import settings as default_settings
from engine.media import MediaError, probe
from engine.security import MediaSigner
from engine.models import now_iso
from engine.video_downloads import VideoDownloadManager, VideoDownloadTask, prepare_video_mp4


def _media_settings(tmp_path: Path):
    return replace(default_settings, data_path=tmp_path / "data", max_long_source_seconds=3600)


def _generate_media(path: Path, settings, *, with_audio: bool) -> Path:
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("FFmpeg/FFprobe are required for genuine MP4 preparation tests")
    path.parent.mkdir(parents=True, exist_ok=True)
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2"]
    if with_audio:
        command.extend(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"])
    command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
    if with_audio:
        command.extend(["-c:a", "aac", "-shortest"])
    command.append(str(path))
    subprocess.run(command, check=True, capture_output=True)
    return path


def test_video_download_manager_rejects_storage_root_symlink_escape(tmp_path: Path):
    settings = _media_settings(tmp_path)
    settings.data_path.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (settings.data_path / "exports").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="escapes the configured data directory"):
        VideoDownloadManager(settings, MediaSigner(tmp_path / "signing.key", 30))


def test_prepare_video_mp4_remuxes_combined_source_preserving_audio(tmp_path: Path):
    settings = _media_settings(tmp_path)
    source = _generate_media(tmp_path / "input.mkv", settings, with_audio=True)
    before = source.read_bytes()
    output = tmp_path / "output.mp4"
    result = prepare_video_mp4(source, output, settings)
    verified = probe(output, settings)

    assert output.is_file() and output.stat().st_size > 0
    assert result["audio"] and verified["audio"]
    assert (verified["width"], verified["height"]) == (320, 180)
    assert verified["duration"] == pytest.approx(2, abs=0.15)
    assert source.read_bytes() == before
    decode = subprocess.run([settings.ffmpeg, "-v", "error", "-i", str(output), "-f", "null", "-"], capture_output=True)
    assert decode.returncode == 0, decode.stderr.decode(errors="replace")
    payload = json.loads(subprocess.check_output([settings.ffprobe, "-v", "error", "-show_format", "-of", "json", str(output)]))
    assert "mp4" in payload["format"]["format_name"].split(",")


def test_prepare_video_mp4_keeps_single_file_source_duration_and_dimensions(tmp_path: Path):
    settings = _media_settings(tmp_path)
    source = _generate_media(tmp_path / "video-only.mkv", settings, with_audio=False)
    output = tmp_path / "output.mp4"
    prepare_video_mp4(source, output, settings)
    result = probe(output, settings)

    assert (result["width"], result["height"]) == (320, 180)
    assert result["duration"] == pytest.approx(2, abs=0.15)
    assert result["audio"] is False


def test_video_download_manager_bounds_queue_and_marks_interrupted_tasks_retryable(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    signer = MediaSigner(tmp_path / "signing.key", 30)
    manager = VideoDownloadManager(settings, signer, max_pending=1)
    monkeypatch.setattr("engine.video_downloads.validate_youtube_url", lambda value: value)

    async def enqueue():
        await manager.create("https://www.youtube.com/watch?v=8xEuFQz4E4A")
        with pytest.raises(OverflowError, match="queue is full"):
            await manager.create("https://www.youtube.com/watch?v=KNVr5pHAygI")

    asyncio.run(enqueue())

    active_id = next(iter(manager.tasks))
    task = manager.tasks[active_id].model_copy(update={"state": "active"})
    manager._persist(task)
    async def recover():
        await manager.start()
        recovered_task = manager.get(active_id)
        await manager.stop()
        return recovered_task

    recovered = asyncio.run(recover())
    assert recovered is not None and recovered.state == "failed"
    assert "Start a new download" in (recovered.message or "")


def test_video_download_manager_persists_complete_task_and_refreshable_signed_file(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    signer = MediaSigner(tmp_path / "signing.key", 30)
    manager = VideoDownloadManager(settings, signer)
    task_id = "a" * 32
    directory = manager._directory(task_id)
    directory.mkdir(parents=True)
    final = directory / "youtube-video.mp4"
    source = _generate_media(tmp_path / "source.mp4", settings, with_audio=True)
    shutil.copyfile(source, final)
    relative = final.relative_to(settings.data_path).as_posix()
    task = VideoDownloadTask(id=task_id, url="https://www.youtube.com/watch?v=8xEuFQz4E4A", state="complete", phase="complete", filename=final.name, download_url="old-expired-link", created_at=now_iso(), updated_at=now_iso())
    manager._persist(task)
    async def restore():
        await manager.start()
        restored_task = manager.get(task_id)
        await manager.stop()
        return restored_task

    restored = asyncio.run(restore())
    assert restored is not None and restored.state == "complete"
    assert restored.filename == final.name
    expires, signature = signer.sign(relative)
    assert signer.verify(relative, expires, signature)
    assert not signer.verify(relative, expires - 100, signature)


def test_controlled_download_runs_task_mp4_and_signing_without_clip_pipeline(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    signer = MediaSigner(tmp_path / "signing.key", 60)
    manager = VideoDownloadManager(settings, signer)
    source = _generate_media(tmp_path / "controlled-source.mkv", settings, with_audio=True)
    monkeypatch.setattr("engine.video_downloads.validate_youtube_url", lambda value: value)

    def controlled_download(url, target_dir, _settings, *, progress_callback=None, **_kwargs):
        assert url == "https://www.youtube.com/watch?v=8xEuFQz4E4A"
        target_dir.mkdir(parents=True, exist_ok=True)
        downloaded = target_dir / "source-fixture.mkv"
        shutil.copyfile(source, downloaded)
        if progress_callback:
            progress_callback({"phase": "downloading", "downloaded_bytes": downloaded.stat().st_size, "total_bytes": downloaded.stat().st_size, "percent": 100})
        return downloaded

    def forbidden(*_args, **_kwargs):
        raise AssertionError("download-only must not enter the clip-processing pipeline")

    monkeypatch.setattr("engine.video_downloads.download_youtube", controlled_download)
    monkeypatch.setattr("engine.media.transcribe", forbidden)
    monkeypatch.setattr("engine.jobs.JobManager._process", forbidden)

    async def run_task():
        await manager.start()
        task, created = await manager.create("https://www.youtube.com/watch?v=8xEuFQz4E4A")
        assert created
        deadline = time.monotonic() + 20
        while manager.get(task.id).state in {"queued", "active"} and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        result = manager.get(task.id)
        await manager.stop()
        return result

    result = asyncio.run(run_task())
    assert result is not None and result.state == "complete", result.error if result else "missing task"
    final = manager._final_file(result)
    metadata = probe(final, settings)
    assert metadata["audio"]
    assert (metadata["width"], metadata["height"]) == (320, 180)
    relative = final.relative_to(settings.data_path).as_posix()
    expires, signature = signer.sign(relative)
    assert signer.verify(relative, expires, signature)


def test_status_renews_signed_link_and_marks_missing_file_retryable(tmp_path: Path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine import app as app_module

    settings = _media_settings(tmp_path)
    signer = MediaSigner(tmp_path / "route-signing.key", 60)
    manager = VideoDownloadManager(settings, signer)
    task_id = "b" * 32
    folder = manager._directory(task_id)
    folder.mkdir(parents=True)
    final = _generate_media(folder / "youtube-video.mp4", settings, with_audio=True)
    task = VideoDownloadTask(id=task_id, url="https://www.youtube.com/watch?v=8xEuFQz4E4A", state="complete", phase="complete", filename=final.name, download_url="expired", created_at=now_iso(), updated_at=now_iso())
    manager.tasks[task_id] = task
    monkeypatch.setattr(app_module, "settings", settings)
    monkeypatch.setattr(app_module, "signer", signer)
    monkeypatch.setattr(app_module, "video_downloads", manager)
    client = TestClient(app_module.app)

    first = client.get(f"/api/v1/video-downloads/{task_id}")
    second = client.get(f"/api/v1/video-downloads/{task_id}")
    assert first.status_code == second.status_code == 200
    signed = second.json()["downloadUrl"]
    assert "expires=" in signed and "signature=" in signed
    file_response = client.get(signed)
    assert file_response.status_code == 200
    assert file_response.headers["content-type"].startswith("video/mp4")
    assert "attachment" in file_response.headers["content-disposition"].lower()

    final.unlink()
    unavailable = client.get(f"/api/v1/video-downloads/{task_id}")
    assert unavailable.status_code == 200 and unavailable.json()["state"] == "failed"
    monkeypatch.setattr("engine.video_downloads.validate_youtube_url", lambda value: value)
    replacement, created = asyncio.run(manager.create(task.url))
    assert created and replacement.id != task_id


def test_failed_mp4_preparation_never_publishes_destination(tmp_path: Path):
    settings = _media_settings(tmp_path)
    source = tmp_path / "not-video.mkv"
    source.write_bytes(b"not a video")
    destination = tmp_path / "published.mp4"
    with pytest.raises(Exception):
        prepare_video_mp4(source, destination, settings)
    assert not destination.exists()
    assert not destination.with_name("published.partial.mp4").exists()


def test_prepare_video_mp4_rejects_non_finite_source_duration(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    source = tmp_path / "source.mkv"
    source.write_bytes(b"source")
    destination = tmp_path / "published.mp4"
    monkeypatch.setattr("engine.video_downloads.probe", lambda *_args, **_kwargs: {"duration": float("nan"), "width": 320, "height": 180})

    with pytest.raises(MediaError, match="finite, positive source duration"):
        prepare_video_mp4(source, destination, settings)
    assert not destination.exists()


def test_prepare_video_mp4_rejects_non_finite_output_duration(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    source = _generate_media(tmp_path / "source.mkv", settings, with_audio=True)
    destination = tmp_path / "published.mp4"

    def fake_ffmpeg(command, *, timeout):
        Path(command[-1]).write_bytes(b"partial output")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("engine.video_downloads.run", fake_ffmpeg)
    monkeypatch.setattr(
        "engine.video_downloads._probe_container",
        lambda *_args: ({"format": {"duration": "nan"}, "streams": [{"codec_type": "video", "width": 320, "height": 180}, {"codec_type": "audio"}]}, "mov,mp4,m4a,3gp,3g2,mj2"),
    )

    with pytest.raises(MediaError, match="finite, positive MP4 duration"):
        prepare_video_mp4(source, destination, settings)
    assert not destination.exists()
    assert not destination.with_name("published.partial.mp4").exists()


def test_startup_validation_rejects_non_finite_final_duration(tmp_path: Path, monkeypatch):
    settings = _media_settings(tmp_path)
    manager = VideoDownloadManager(settings, MediaSigner(tmp_path / "signing.key", 30))
    final = tmp_path / "final.mp4"
    final.write_bytes(b"verified path fixture")
    monkeypatch.setattr("engine.video_downloads._probe_container", lambda *_args: ({"format": {}}, "mov,mp4,m4a,3gp,3g2,mj2"))
    monkeypatch.setattr("engine.video_downloads.probe", lambda *_args, **_kwargs: {"duration": float("inf"), "width": 320, "height": 180})

    assert manager._is_valid_final(final) is False
